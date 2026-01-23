/**
 * LRU cache for thumbnail ImageBitmaps
 * Provides GPU-ready bitmaps for canvas rendering with 50MB memory limit
 * Uses Web Workers for off-main-thread decoding
 *
 * Priority system:
 * - Base priority: stack position (0 = front/visible, higher = behind)
 * - Sub-priority: FILO timestamp (recent requests first within same priority)
 * - Visibility check: skip off-screen items before dispatch
 */

import type {
  DecodeRequest,
  DecodeResponse
} from '$lib/workers/thumbnail-decode-worker';

export interface CacheEntry {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  size: number; // decoded bytes (w * h * 4)
}

interface QueuedLoad {
  volumeUuid: string;
  file: File;
  priority: number; // Stack position: 0 = front (highest), 1, 2... = behind
  timestamp: number; // For FILO within same priority
  element: HTMLElement | null; // For visibility check before dispatch
  resolve: (entry: CacheEntry) => void;
  reject: (error: Error) => void;
}

interface PendingDecode {
  resolve: (bitmap: ImageBitmap) => void;
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

  // Worker pool
  private workers: Worker[] = [];
  private workerIndex = 0;
  private nextRequestId = 0;
  private pendingDecodes = new Map<number, PendingDecode>();
  private workersReady = false;

  constructor() {
    this.initWorkers();
  }

  /**
   * Initialize decode workers (one per CPU core)
   */
  private initWorkers(): void {
    // Only initialize in browser environment
    if (typeof window === 'undefined') return;

    const numWorkers = Math.max((navigator.hardwareConcurrency || 4) * 2, 4);

    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(
        new URL('$lib/workers/thumbnail-decode-worker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
        const { id, bitmap, error } = event.data;
        const pending = this.pendingDecodes.get(id);

        if (pending) {
          this.pendingDecodes.delete(id);
          if (bitmap) {
            pending.resolve(bitmap);
          } else {
            pending.reject(new Error(error || 'Decode failed'));
          }
        }
      };

      worker.onerror = (error) => {
        console.error('Thumbnail decode worker error:', error);
      };

      this.workers.push(worker);
    }

    this.workersReady = true;
  }

  /**
   * Decode an image using a worker (off-main-thread)
   */
  private decodeInWorker(file: File): Promise<ImageBitmap> {
    return new Promise((resolve, reject) => {
      // Fallback to main thread if workers not available
      if (!this.workersReady || this.workers.length === 0) {
        createImageBitmap(file).then(resolve).catch(reject);
        return;
      }

      const id = this.nextRequestId++;
      this.pendingDecodes.set(id, { resolve, reject });

      // Round-robin worker selection
      const worker = this.workers[this.workerIndex];
      this.workerIndex = (this.workerIndex + 1) % this.workers.length;

      worker.postMessage({ id, file } satisfies DecodeRequest);
    });
  }

  /**
   * Get or load a thumbnail bitmap
   * Coalesces concurrent requests for the same thumbnail
   * @param priority Stack position (0 = front/top, higher = further back)
   * @param element Canvas element for visibility check before dispatch
   */
  async get(
    volumeUuid: string,
    file: File,
    priority: number = 0,
    element: HTMLElement | null = null
  ): Promise<CacheEntry> {
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
      this.queue.push({
        volumeUuid,
        file,
        priority,
        timestamp: Date.now(),
        element,
        resolve,
        reject
      });
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
   * Check if an element is currently visible in the viewport
   */
  private isVisible(element: HTMLElement | null): boolean {
    if (!element) return true; // If no element provided, assume visible

    const rect = element.getBoundingClientRect();
    const buffer = 200; // Same as IntersectionObserver rootMargin

    return (
      rect.bottom >= -buffer &&
      rect.top <= window.innerHeight + buffer &&
      rect.right >= -buffer &&
      rect.left <= window.innerWidth + buffer
    );
  }

  /**
   * Process queued loads with concurrency limit
   * Two-tier priority: base priority (stack position) + sub-priority (FILO timestamp)
   * Checks visibility before dispatch, skips off-screen items
   */
  private processQueue(): void {
    const maxConcurrent = this.workers.length || 4;
    while (this.queue.length > 0 && this.activeLoads < maxConcurrent) {
      // Sort by priority (ascending), then by timestamp (descending = FILO)
      // Result: [priority 0 newest, priority 0 older, priority 1 newest, ...]
      this.queue.sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority - b.priority; // Lower priority number = higher priority
        }
        return b.timestamp - a.timestamp; // Newer first (FILO)
      });

      // Find first visible item (from start = highest priority first)
      let itemIndex = -1;
      for (let i = 0; i < this.queue.length; i++) {
        if (this.isVisible(this.queue[i].element)) {
          itemIndex = i;
          break;
        }
      }

      // No visible items - take the highest priority item anyway
      if (itemIndex === -1) {
        itemIndex = 0;
      }

      const item = this.queue.splice(itemIndex, 1)[0];
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
   * Load and decode a thumbnail using worker
   */
  private async load(volumeUuid: string, file: File): Promise<CacheEntry> {
    const bitmap = await this.decodeInWorker(file);
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

  /**
   * Terminate workers (for cleanup)
   */
  destroy(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.workersReady = false;
  }
}

export const thumbnailCache = new ThumbnailCache();
