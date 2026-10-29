import { writable } from 'svelte/store';
import type { CacheAddMetadata, CloudCache } from '../../cloud-cache-interface';
import type { CloudFileMetadata } from '../../provider-interface';
import { CoalescedCacheStore } from '../../coalesced-cache-store';
import { megaProvider } from './mega-provider';

/** Dedup-triggered refetches in a row before the cache stops asking (see runDeduplication). */
const MAX_DEDUP_REFETCHES = 2;

/**
 * MEGA Cache Wrapper
 *
 * Returns Map<seriesTitle, CloudFileMetadata[]> for efficient series-based operations.
 * Cache is grouped by series folder names extracted from file paths.
 */
class MegaCacheManager implements CloudCache<CloudFileMetadata> {
  // State split from emission: `read()` is synchronous and never lagged,
  // subscribers get incremental mutations coalesced — see CoalescedCacheStore.
  private cache = new CoalescedCacheStore<CloudFileMetadata[]>();
  private isFetchingStore = writable<boolean>(false);
  /** The fetch in flight, and whether it reloads the tree (a full fetch). */
  private running: Promise<void> | null = null;
  private runningReloads = false;
  private loadedFlag = false;
  /** Refetches in a row that a dedup run asked for (see runDeduplication). */
  private dedupRefetches = 0;

  get store() {
    // Return Map grouped by series for efficient series-based operations
    return this.cache;
  }

  get isFetchingState() {
    return this.isFetchingStore;
  }

  /**
   * Fetch cloud volumes from MEGA provider
   * This queries MEGA's internal cache (storage.files)
   * @param skipReinitialize If true, skip reinitializing MEGA connection (use for post-operation refreshes)
   */
  async fetch(skipReinitialize = false): Promise<void> {
    if (this.running) {
      // Join it rather than return at once: callers read the cache (or
      // upload against the tree) next, and resuming before the listing lands
      // reads an empty or stale one. A caller that asked for a reload gets
      // one after a listing-only fetch.
      const reloads = this.runningReloads;
      await this.running;
      if (skipReinitialize || reloads) return;
      return this.fetch(false);
    }

    if (!megaProvider.isAuthenticated()) {
      console.log('MEGA not authenticated, skipping cache fetch');
      return;
    }

    this.runningReloads = !skipReinitialize;
    this.running = this.load(skipReinitialize);
    return this.running;
  }

  private async load(skipReinitialize: boolean): Promise<void> {
    this.isFetchingStore.set(true);
    try {
      // Query MEGA provider (which reads from its internal storage.files cache)
      const volumes = await megaProvider.listCloudVolumes(skipReinitialize);

      // Group by series title (extracted from path: "SeriesTitle/VolumeTitle.cbz")
      const cacheMap = new Map<string, CloudFileMetadata[]>();
      for (const volume of volumes) {
        // Extract series title from path
        const seriesTitle = volume.path.split('/')[0];

        const existing = cacheMap.get(seriesTitle);
        if (existing) {
          existing.push(volume);
        } else {
          cacheMap.set(seriesTitle, [volume]);
        }
      }

      // Replace entire cache atomically (clears optimistic/fake entries)
      // This prevents duplicates from fake entries added during uploads
      this.cache.set(cacheMap);
      this.loadedFlag = true;
      console.log(
        `✅ MEGA cache populated with ${volumes.length} files in ${cacheMap.size} series`
      );
    } catch (error) {
      console.error('Failed to fetch MEGA cache:', error);
    } finally {
      this.running = null;
      this.isFetchingStore.set(false);

      // Run folder deduplication after cache load (incremental - one pass per call).
      // Not awaited: its own refetch joins whatever fetch is running then.
      this.runDeduplication();
    }
  }

  /**
   * Run folder deduplication asynchronously after a cache fetch completes.
   * If duplicates were merged, refetch the cache so it reflects the merged state.
   */
  private runDeduplication(): void {
    // Dynamic import to avoid circular dependency (mega-cache <-> mega-provider).
    import('../../folder-deduplicator')
      .then(async ({ folderDeduplicator }) => {
        if (!megaProvider.isAuthenticated()) return;

        const ops = megaProvider.getFolderOperations();
        const result = await folderDeduplicator.deduplicateAll('mega', ops);

        if (result.groupsMerged === 0) {
          this.dedupRefetches = 0;
          return;
        }
        // Each refetch runs dedup again. A duplicate that never empties (a
        // device still writing there) would make that a loop of full
        // fetches; the next fetch from elsewhere tries again.
        if (this.dedupRefetches >= MAX_DEDUP_REFETCHES) {
          console.warn('[MegaCache] Dedup still finds duplicates after refetching; leaving them');
          this.dedupRefetches = 0;
          return;
        }
        this.dedupRefetches++;
        console.log('[MegaCache] Dedup merged folders, refetching cache...');
        await this.fetch(true);
      })
      .catch((err) => {
        console.error('[MegaCache] Deduplication failed:', err);
      });
  }

  has(path: string): boolean {
    const currentCache = this.cache.read();

    // Extract series title from path and find within that series
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.some((f) => f.path === path) || false;
  }

  get(path: string): CloudFileMetadata | null {
    const currentCache = this.cache.read();

    // Extract series title from path and find within that series
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.find((f) => f.path === path) || null;
  }

  getAll(path: string): CloudFileMetadata[] {
    const currentCache = this.cache.read();

    // Extract series title from path and find all matches within that series
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.filter((f) => f.path === path) || [];
  }

  getBySeries(seriesTitle: string): CloudFileMetadata[] {
    const currentCache = this.cache.read();

    const result: CloudFileMetadata[] = [];
    for (const files of currentCache.values()) {
      result.push(...files.filter((file) => file.path.startsWith(`${seriesTitle}/`)));
    }
    return result;
  }

  getAllFiles(): CloudFileMetadata[] {
    const currentCache = this.cache.read();

    const result: CloudFileMetadata[] = [];
    for (const files of currentCache.values()) {
      result.push(...files);
    }
    return result;
  }

  clear(): void {
    this.cache.set(new Map());
    this.loadedFlag = false;
  }

  isFetching(): boolean {
    return this.running !== null;
  }

  isLoaded(): boolean {
    return this.loadedFlag;
  }

  // Optional methods for cache updates
  add(path: string, metadata: CacheAddMetadata<CloudFileMetadata>): void {
    this.cache.update((cache) => {
      const newCache = new Map(cache);

      // Extract series title from path (e.g., "SeriesTitle/VolumeTitle.cbz" -> "SeriesTitle")
      // This matches how fetch() groups files by series title
      const seriesTitle = path.split('/')[0];
      const existing = newCache.get(seriesTitle);

      if (existing) {
        // Check if this file ID already exists, replace it
        const index = existing.findIndex((f) => f.fileId === metadata.fileId);
        if (index >= 0) {
          // Create new array with replacement (immutable)
          newCache.set(seriesTitle, [
            ...existing.slice(0, index),
            metadata,
            ...existing.slice(index + 1)
          ]);
        } else {
          // Create new array with addition (immutable)
          newCache.set(seriesTitle, [...existing, metadata]);
        }
      } else {
        newCache.set(seriesTitle, [metadata]);
      }

      return newCache;
    });
  }

  removeById(fileId: string): void {
    this.cache.update((cache) => {
      const newCache = new Map(cache);

      for (const [path, files] of newCache.entries()) {
        const filtered = files.filter((f) => f.fileId !== fileId);
        if (filtered.length === 0) {
          newCache.delete(path);
        } else if (filtered.length !== files.length) {
          newCache.set(path, filtered);
        }
      }

      return newCache;
    });
  }

  update(fileId: string, updates: Partial<CloudFileMetadata>): void {
    this.cache.update((cache) => {
      const newCache = new Map(cache);

      for (const [path, files] of newCache.entries()) {
        const updated = files.map((file) =>
          file.fileId === fileId ? { ...file, ...updates } : file
        );
        newCache.set(path, updated);
      }

      return newCache;
    });
  }
}

export const megaCache = new MegaCacheManager();
