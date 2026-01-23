/**
 * LRU cache for thumbnail ImageBitmaps
 * Provides GPU-ready bitmaps for canvas rendering with 50MB memory limit
 * Throttled loading to prevent overwhelming the browser
 */

export interface CacheEntry {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  size: number; // decoded bytes (w * h * 4)
}

interface QueuedLoad {
  volumeUuid: string;
  file: File;
  resolve: (entry: CacheEntry) => void;
  reject: (error: Error) => void;
}

class ThumbnailCache {
  private cache = new Map<string, CacheEntry>(); // volume_uuid -> entry
  private pending = new Map<string, Promise<CacheEntry>>(); // coalesce concurrent requests
  private totalBytes = 0;
  private readonly maxBytes = 50 * 1024 * 1024; // 50MB

  // Throttling
  private queue: QueuedLoad[] = [];
  private activeLoads = 0;
  private readonly maxConcurrent = 6; // Limit concurrent createImageBitmap calls

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

    // Create promise and queue the load
    const loadPromise = new Promise<CacheEntry>((resolve, reject) => {
      this.queue.push({ volumeUuid, file, resolve, reject });
    });

    this.pending.set(volumeUuid, loadPromise);
    this.processQueue();

    try {
      return await loadPromise;
    } finally {
      this.pending.delete(volumeUuid);
    }
  }

  /**
   * Process queued loads with concurrency limit
   * Uses FILO (stack) ordering - most recent requests processed first
   * This prioritizes currently visible items over items that scrolled past
   */
  private processQueue(): void {
    while (this.queue.length > 0 && this.activeLoads < this.maxConcurrent) {
      const item = this.queue.pop()!; // FILO: pop from end (most recent)
      this.activeLoads++;

      this.load(item.volumeUuid, item.file)
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.activeLoads--;
          this.processQueue();
        });
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
   * Invalidate a specific cache entry (e.g., when cover is edited)
   */
  invalidate(volumeUuid: string): void {
    const entry = this.cache.get(volumeUuid);
    if (entry) {
      entry.bitmap.close();
      this.totalBytes -= entry.size;
      this.cache.delete(volumeUuid);
    }
    // Also remove from pending if in progress
    this.pending.delete(volumeUuid);
    // Remove from queue if waiting
    this.queue = this.queue.filter((item) => item.volumeUuid !== volumeUuid);
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
