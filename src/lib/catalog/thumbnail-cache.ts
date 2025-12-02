/**
 * LRU cache for thumbnail ImageBitmaps
 * Provides GPU-ready bitmaps for canvas rendering with 50MB memory limit
 */

export interface CacheEntry {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  size: number; // decoded bytes (w * h * 4)
}

class ThumbnailCache {
  private cache = new Map<string, CacheEntry>(); // volume_uuid -> entry
  private pending = new Map<string, Promise<CacheEntry>>(); // coalesce concurrent requests
  private totalBytes = 0;
  private readonly maxBytes = 50 * 1024 * 1024; // 50MB

  /**
   * Get or load a thumbnail bitmap
   * Coalesces concurrent requests for the same thumbnail
   */
  async get(volumeUuid: string, file: File): Promise<CacheEntry> {
    // Check cache first
    const existing = this.cache.get(volumeUuid);
    if (existing) {
      this.touch(volumeUuid);
      return existing;
    }

    // Join existing load if in progress
    const pendingLoad = this.pending.get(volumeUuid);
    if (pendingLoad) {
      return pendingLoad;
    }

    // Start new load
    const loadPromise = this.load(volumeUuid, file);
    this.pending.set(volumeUuid, loadPromise);

    try {
      return await loadPromise;
    } finally {
      this.pending.delete(volumeUuid);
    }
  }

  /**
   * Check if a thumbnail is cached (without loading)
   */
  has(volumeUuid: string): boolean {
    return this.cache.has(volumeUuid);
  }

  /**
   * Get cached entry synchronously (returns undefined if not cached)
   */
  getSync(volumeUuid: string): CacheEntry | undefined {
    const entry = this.cache.get(volumeUuid);
    if (entry) {
      this.touch(volumeUuid);
    }
    return entry;
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    for (const entry of this.cache.values()) {
      entry.bitmap.close();
    }
    this.cache.clear();
    this.totalBytes = 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): { count: number; totalBytes: number; maxBytes: number; utilization: string } {
    return {
      count: this.cache.size,
      totalBytes: this.totalBytes,
      maxBytes: this.maxBytes,
      utilization: ((this.totalBytes / this.maxBytes) * 100).toFixed(1) + '%'
    };
  }

  /**
   * Load and decode a thumbnail
   */
  private async load(volumeUuid: string, file: File): Promise<CacheEntry> {
    const bitmap = await createImageBitmap(file);
    const size = bitmap.width * bitmap.height * 4; // RGBA

    // Evict if needed before adding
    while (this.totalBytes + size > this.maxBytes && this.cache.size > 0) {
      this.evictLRU();
    }

    const entry: CacheEntry = {
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
      size
    };

    this.cache.set(volumeUuid, entry);
    this.totalBytes += size;

    return entry;
  }

  /**
   * Move entry to end of Map (most recently used)
   */
  private touch(volumeUuid: string): void {
    const entry = this.cache.get(volumeUuid);
    if (entry) {
      this.cache.delete(volumeUuid);
      this.cache.set(volumeUuid, entry);
    }
  }

  /**
   * Evict least recently used entry (first in Map)
   */
  private evictLRU(): void {
    const firstKey = this.cache.keys().next().value;
    if (firstKey) {
      const entry = this.cache.get(firstKey);
      if (entry) {
        entry.bitmap.close(); // Release GPU memory
        this.totalBytes -= entry.size;
        this.cache.delete(firstKey);
      }
    }
  }
}

export const thumbnailCache = new ThumbnailCache();
