import { writable } from 'svelte/store';
import type { CacheAddMetadata, CloudCache } from '../../cloud-cache-interface';
import type { CloudFileMetadata } from '../../provider-interface';
import { CoalescedCacheStore } from '../../coalesced-cache-store';
import { addMutations, removeMutations } from '../../listing-mutations';
import { onedriveProvider } from './onedrive-provider';

class OneDriveCacheManager implements CloudCache<CloudFileMetadata> {
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
    if (!onedriveProvider.isAuthenticated()) return Promise.resolve();

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
      const volumes = await onedriveProvider.listCloudVolumes();
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
        `✅ OneDrive cache populated with ${volumes.length} files in ${cacheMap.size} series`
      );
    } catch (error) {
      console.error('Failed to fetch OneDrive cache:', error);
    } finally {
      listing.abandon();
    }
  }

  has(path: string): boolean {
    const current = this.cache.read();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.some((f) => f.path === path) || false;
  }

  get(path: string): CloudFileMetadata | null {
    const current = this.cache.read();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.find((f) => f.path === path) || null;
  }

  getAll(path: string): CloudFileMetadata[] {
    const current = this.cache.read();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.filter((f) => f.path === path) || [];
  }

  getBySeries(seriesTitle: string): CloudFileMetadata[] {
    const current = this.cache.read();
    const result: CloudFileMetadata[] = [];
    for (const files of current.values()) {
      result.push(...files.filter((file) => file.path.startsWith(`${seriesTitle}/`)));
    }
    return result;
  }

  getAllFiles(): CloudFileMetadata[] {
    const current = this.cache.read();
    const result: CloudFileMetadata[] = [];
    for (const files of current.values()) result.push(...files);
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
    this.cache.update(...addMutations(path, metadata));
  }

  removeById(fileId: string): void {
    this.cache.update(...removeMutations(fileId));
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

export const onedriveCache = new OneDriveCacheManager();
