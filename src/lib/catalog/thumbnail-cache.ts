/**
 * LRU cache for thumbnail ImageBitmaps
 * Provides GPU-ready bitmaps for canvas rendering
 * Uses Web Workers for off-main-thread decoding
 *
 * Memory management:
 * - Soft limit of 100MB tracked by cache
 * - Evicted entries are NOT closed - components may hold references
 * - GC cleans up bitmaps when all references are gone
 * - This prevents "detached" errors when cache evicts actively-displayed bitmaps
 *
 * Priority system:
 * - Base priority: stack position (0 = front/visible, higher = behind)
 * - Sub-priority: FIFO timestamp (older requests first within same priority)
 * - Visibility check: prefer on-screen items before dispatch
 */

import type { DecodeRequest, DecodeResponse } from '$lib/workers/thumbnail-decode-worker';

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
  private readonly maxBytes = 100 * 1024 * 1024; // 100MB

  // Throttling
  private queue: QueuedLoad[] = [];
  private activeLoads = 0;

  // Worker pool
  private workers: Worker[] = [];
  private workerIndex = 0;
  private nextRequestId = 0;
  private pendingDecodes = new Map<number, PendingDecode>();
  private workersReady = false;
  private maxConcurrentLoads = 4;
  // Worker cold-start can stall early catalog paints.
  // Use a short main-thread warm-up burst, then hand off to workers.
  private mainThreadWarmupDecodesRemaining = 12;
  private workerWarmupUntil = 0;

  constructor() {
    this.initWorkers();
  }

  /**
   * Initialize decode workers (one per CPU core)
   */
  private initWorkers(): void {
    // Only initialize in browser environment
    if (typeof window === 'undefined') return;

    const userAgent = navigator.userAgent.toLowerCase();
    const isFirefox = userAgent.includes('firefox');

    // Firefox tends to thrash with large decode queues; keep it tighter.
    const maxWorkers = isFirefox ? 3 : 6;
    this.maxConcurrentLoads = isFirefox ? 3 : 6;

    // Keep worker count bounded to avoid decode storms in very large catalogs.
    const numWorkers = Math.min(Math.max(navigator.hardwareConcurrency || 4, 2), maxWorkers);
    this.workerWarmupUntil = Date.now() + 3000;

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
   * Compare queue priority for dispatch order.
   * Lower priority number wins; older timestamp wins within same priority.
   */
  private isHigherPriority(a: QueuedLoad, b: QueuedLoad): boolean {
    if (a.priority !== b.priority) {
      return a.priority < b.priority;
    }
    return a.timestamp < b.timestamp;
  }

  /**
   * Pick next queue item index, preferring currently visible items.
   */
  private pickNextItemIndex(): number {
    if (this.queue.length === 0) return -1;

    let bestVisibleIndex = -1;
    let bestAnyIndex = 0;

    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];

      if (this.isHigherPriority(item, this.queue[bestAnyIndex])) {
        bestAnyIndex = i;
      }

      if (this.isVisible(item.element)) {
        if (bestVisibleIndex === -1 || this.isHigherPriority(item, this.queue[bestVisibleIndex])) {
          bestVisibleIndex = i;
        }
      }
    }

    return bestVisibleIndex !== -1 ? bestVisibleIndex : bestAnyIndex;
  }

  /**
   * Process queued loads with concurrency limit.
   */
  private processQueue(): void {
    const maxConcurrent = Math.min(this.workers.length || 4, this.maxConcurrentLoads);
    while (this.queue.length > 0 && this.activeLoads < maxConcurrent) {
      const itemIndex = this.pickNextItemIndex();
      if (itemIndex === -1) return;

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
   * Does not close bitmap - components may still hold references.
   */
  invalidate(volumeUuid: string): void {
    const entry = this.cache.get(volumeUuid);
    if (entry) {
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
   * Does not close bitmaps - components may still hold references.
   */
  clear(): void {
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
    const useMainThreadWarmup =
      this.mainThreadWarmupDecodesRemaining > 0 || Date.now() < this.workerWarmupUntil;
    const bitmap = useMainThreadWarmup
      ? await createImageBitmap(file)
      : await this.decodeInWorker(file);
    if (useMainThreadWarmup && this.mainThreadWarmupDecodesRemaining > 0) {
      this.mainThreadWarmupDecodesRemaining--;
    }
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
   * Evict least recently used entry from cache.
   * Does NOT call bitmap.close() - components may still hold references.
   * GC will clean up the bitmap when all references are gone.
   */
  private evictLRU(): void {
    const firstKey = this.cache.keys().next().value;
    if (firstKey) {
      const entry = this.cache.get(firstKey);
      if (entry) {
        // Don't close bitmap - components may still reference it
        // GC will clean up when all refs are gone
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
