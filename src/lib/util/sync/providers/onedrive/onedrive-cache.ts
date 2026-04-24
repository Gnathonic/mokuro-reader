import { writable } from 'svelte/store';
import type { CloudCache } from '../../cloud-cache-interface';
import type { CloudFileMetadata } from '../../provider-interface';
import { onedriveProvider } from './onedrive-provider';

class OneDriveCacheManager implements CloudCache<CloudFileMetadata> {
  private cache = writable<Map<string, CloudFileMetadata[]>>(new Map());
  private isFetchingStore = writable<boolean>(false);
  private fetchingFlag = false;
  private loadedFlag = false;

  get store() {
    return this.cache;
  }

  get isFetchingState() {
    return this.isFetchingStore;
  }

  async fetch(): Promise<void> {
    if (this.fetchingFlag) return;
    if (!onedriveProvider.isAuthenticated()) return;

    this.fetchingFlag = true;
    this.isFetchingStore.set(true);
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
      this.cache.set(cacheMap);
      this.loadedFlag = true;
      console.log(
        `✅ OneDrive cache populated with ${volumes.length} files in ${cacheMap.size} series`
      );
    } catch (error) {
      console.error('Failed to fetch OneDrive cache:', error);
    } finally {
      this.fetchingFlag = false;
      this.isFetchingStore.set(false);
    }
  }

  has(path: string): boolean {
    let current: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((v) => {
      current = v;
    })();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.some((f) => f.path === path) || false;
  }

  get(path: string): CloudFileMetadata | null {
    let current: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((v) => {
      current = v;
    })();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.find((f) => f.path === path) || null;
  }

  getAll(path: string): CloudFileMetadata[] {
    let current: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((v) => {
      current = v;
    })();
    const seriesTitle = path.split('/')[0];
    return current.get(seriesTitle)?.filter((f) => f.path === path) || [];
  }

  getBySeries(seriesTitle: string): CloudFileMetadata[] {
    let current: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((v) => {
      current = v;
    })();
    const result: CloudFileMetadata[] = [];
    for (const files of current.values()) {
      result.push(...files.filter((file) => file.path.startsWith(`${seriesTitle}/`)));
    }
    return result;
  }

  getAllFiles(): CloudFileMetadata[] {
    let current: Map<string, CloudFileMetadata[]> = new Map();
    this.cache.subscribe((v) => {
      current = v;
    })();
    const result: CloudFileMetadata[] = [];
    for (const files of current.values()) result.push(...files);
    return result;
  }

  clear(): void {
    this.cache.set(new Map());
    this.loadedFlag = false;
  }

  isFetching(): boolean {
    return this.fetchingFlag;
  }

  isLoaded(): boolean {
    return this.loadedFlag;
  }

  add(path: string, metadata: CloudFileMetadata): void {
    this.cache.update((cache) => {
      const newCache = new Map(cache);
      const seriesTitle = path.split('/')[0];
      const existing = newCache.get(seriesTitle);
      if (existing) {
        const index = existing.findIndex((f) => f.fileId === metadata.fileId);
        if (index >= 0) {
          newCache.set(seriesTitle, [
            ...existing.slice(0, index),
            metadata,
            ...existing.slice(index + 1)
          ]);
        } else {
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
        if (filtered.length === 0) newCache.delete(path);
        else if (filtered.length !== files.length) newCache.set(path, filtered);
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

export const onedriveCache = new OneDriveCacheManager();
