import { writable } from 'svelte/store';
import type { CacheAddMetadata, CloudCache } from '../../cloud-cache-interface';
import type { CloudFileMetadata } from '../../provider-interface';
import { CoalescedCacheStore } from '../../coalesced-cache-store';
import { addMutations, removeMutations, replaceFolderInStore } from '../../listing-mutations';
import { filesystemProvider } from './filesystem-provider';
import { listedCopies, listedEntry, resolveListedPath } from '#lib/util/sync/listed-spelling.js';

/**
 * Filesystem Cache Wrapper
 *
 * Returns Map<seriesTitle, CloudFileMetadata[]> for efficient series-based operations.
 * Cache is grouped by series folder names extracted from file paths.
 */
class FilesystemCacheManager implements CloudCache<CloudFileMetadata> {
  // State split from emission: `read()` is synchronous and never lagged,
  // subscribers get incremental mutations coalesced — see CoalescedCacheStore.
  private cache = new CoalescedCacheStore<CloudFileMetadata[]>();
  private isFetchingStore = writable<boolean>(false);
  /** The listing in flight; every fetch() meanwhile joins it. */
  private fetchPromise: Promise<void> | null = null;
  private loadedFlag = false;

  get store() {
    return this.cache;
  }

  get isFetchingState() {
    return this.isFetchingStore;
  }

  fetch(): Promise<void> {
    // Join a listing in flight: every caller reads the cache next, and one
    // that returned at once would read the listing from before it. A joined
    // listing is as fresh as when it BEGAN: writes made since ride it via the
    // replay, but a remote change after that waits for the next listing.
    if (this.fetchPromise) return this.fetchPromise;
    if (!filesystemProvider.isAuthenticated()) {
      console.log('Filesystem not authenticated, skipping cache fetch');
      return Promise.resolve();
    }

    this.isFetchingStore.set(true);
    const run: Promise<void> = this.load().finally(() => {
      if (this.fetchPromise !== run) return; // cleared meanwhile
      this.fetchPromise = null;
      this.isFetchingStore.set(false);
    });
    this.fetchPromise = run;
    return run;
  }

  private async load(): Promise<void> {
    // Uploads and deletes made while the walk runs are replayed onto its map.
    const listing = this.cache.beginListing();
    try {
      const volumes = await filesystemProvider.listCloudVolumes();

      const cacheMap = new Map<string, CloudFileMetadata[]>();
      for (const volume of volumes) {
        const seriesTitle = volume.path.split('/')[0];
        const existing = cacheMap.get(seriesTitle);
        if (existing) {
          existing.push(volume);
        } else {
          cacheMap.set(seriesTitle, [volume]);
        }
      }

      // A clear() meanwhile (sign-out): this listing is a dead account's.
      if (!listing.install(cacheMap)) return;
      this.loadedFlag = true;
      console.log(
        `✅ Filesystem cache populated with ${volumes.length} files in ${cacheMap.size} series`
      );
    } catch (error) {
      console.error('Failed to fetch filesystem cache:', error);
    } finally {
      listing.abandon();
    }
  }

  has(path: string): boolean {
    // Any spelling of the path's fold is that entry (R1: `listed-spelling.ts`).
    return listedEntry(this.cache.read(), path, this.cache.revision()) !== null;
  }

  get(path: string): CloudFileMetadata | null {
    // The exact spelling, else the listed one of that fold (R6 among several).
    return listedEntry(this.cache.read(), path, this.cache.revision());
  }

  getAll(path: string): CloudFileMetadata[] {
    // Every copy of the entry, in every spelling of its fold: the exact first.
    return listedCopies(this.cache.read(), path, this.cache.revision());
  }

  listedPath(path: string): string {
    return resolveListedPath(this.cache.read(), path, this.cache.revision());
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

  revision(): object {
    return this.cache.revision();
  }

  clear(): void {
    this.cache.set(new Map());
    this.loadedFlag = false;
    this.fetchPromise = null;
    this.isFetchingStore.set(false);
  }

  isFetching(): boolean {
    return this.fetchPromise !== null;
  }

  isLoaded(): boolean {
    return this.loadedFlag;
  }

  add(path: string, metadata: CacheAddMetadata<CloudFileMetadata>): void {
    // Where the write went: the listed spelling (the provider resolved it so).
    const listed = this.listedPath(path);
    if (listed !== path) {
      path = listed;
      metadata = { ...metadata, path: listed };
    }
    this.cache.update(...addMutations(path, metadata));
  }

  removeById(fileId: string): void {
    this.cache.update(...removeMutations(fileId));
  }

  replaceFolderEntries(folder: string, list: () => Promise<CloudFileMetadata[]>): Promise<boolean> {
    return replaceFolderInStore(this.cache, this.isLoaded(), folder, list);
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

export const filesystemCache = new FilesystemCacheManager();
