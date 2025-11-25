/**
 * Image cache for preloading and decoding manga pages
 * Maintains a windowed cache: previous 2 + current + next 3 pages
 */

export interface CachedImage {
  image: HTMLImageElement; // Image element holds decoded bitmap and blob URL (in img.src)
  decoded: boolean;
  loading: Promise<void> | null;
}

export class ImageCache {
  private cache = new Map<number, CachedImage>();
  private files: File[] = [];
  private currentIndex = 0;
  private windowSize = { prev: 2, next: 3 };

  /**
   * Initialize or update the cache with new files and current page
   * Returns immediately - all preloading happens in the background
   */
  updateCache(files: File[], currentIndex: number): void {
    const filesChanged = this.files !== files;

    // Clear old cache if files changed
    if (filesChanged) {
      this.cleanup();
      this.files = files;
    }

    this.currentIndex = currentIndex;

    // Calculate window range
    const startIndex = Math.max(0, currentIndex - this.windowSize.prev);
    const endIndex = Math.min(files.length - 1, currentIndex + this.windowSize.next);

    // Remove items outside the window
    for (const [index, cached] of this.cache.entries()) {
      if (index < startIndex || index > endIndex) {
        this.removeFromCache(index);
      }
    }

    // Preload all items in the window (non-blocking)
    for (let i = startIndex; i <= endIndex; i++) {
      this.preloadImage(i).catch((err) => {
        console.error(`Failed to preload image ${i}:`, err);
      });
    }
  }

  /**
   * Get a cached image URL synchronously if it's ready, null otherwise
   */
  getImageSync(index: number): string | null {
    if (index < 0 || index >= this.files.length) {
      return null;
    }

    const cached = this.cache.get(index);
    if (cached && cached.decoded) {
      return cached.image.src;
    }

    return null;
  }

  /**
   * Get a cached image URL, waiting for it to be ready if necessary
   */
  async getImage(index: number): Promise<string | null> {
    if (index < 0 || index >= this.files.length) {
      return null;
    }

    const cached = this.cache.get(index);
    if (cached) {
      // Wait for image to be decoded if it's still loading
      if (cached.loading) {
        await cached.loading;
      }
      return cached.image.src;
    }

    // Image not in cache, load it now
    await this.preloadImage(index);
    const newCached = this.cache.get(index);
    return newCached?.image.src || null;
  }

  /**
   * Preload and decode an image at the given index
   */
  private async preloadImage(index: number): Promise<void> {
    // Already cached
    if (this.cache.has(index)) {
      const cached = this.cache.get(index)!;
      if (cached.loading) {
        await cached.loading;
      }
      return;
    }

    const file = this.files[index];
    if (!file) {
      return;
    }

    // Create blob URL
    const url = URL.createObjectURL(file);

    // Create Image element
    const img = new Image();

    // Create loading promise
    const loading = this.decodeImage(img, url);

    // Add to cache with Image element (img.src will hold the blob URL)
    this.cache.set(index, {
      image: img,
      decoded: false,
      loading
    });

    // Wait for decode
    await loading;

    // Mark as decoded
    const cached = this.cache.get(index);
    if (cached) {
      cached.decoded = true;
      cached.loading = null;
    }
  }

  /**
   * Decode an image using the browser's image decoder
   * Keeps the Image element alive in memory to prevent browser from evicting decoded data
   */
  private async decodeImage(img: HTMLImageElement, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      img.onload = () => {
        // Use decode() API for better performance
        if ('decode' in img) {
          img
            .decode()
            .then(() => resolve())
            .catch(() => resolve()); // Fallback if decode fails
        } else {
          resolve();
        }
      };

      img.onerror = () => {
        reject(new Error(`Failed to load image: ${url}`));
      };

      img.src = url;
    });
  }

  /**
   * Remove an image from cache and revoke its blob URL
   */
  private removeFromCache(index: number): void {
    const cached = this.cache.get(index);
    if (cached) {
      URL.revokeObjectURL(cached.image.src);
      this.cache.delete(index);
    }
  }

  /**
   * Clean up all cached images
   */
  cleanup(): void {
    for (const [index] of this.cache) {
      this.removeFromCache(index);
    }
    this.cache.clear();
  }

  /**
   * Get cache statistics for debugging
   */
  getStats() {
    return {
      size: this.cache.size,
      currentIndex: this.currentIndex,
      cached: Array.from(this.cache.keys()).sort((a, b) => a - b),
      decoded: Array.from(this.cache.entries())
        .filter(([_, v]) => v.decoded)
        .map(([k]) => k)
        .sort((a, b) => a - b)
    };
  }
}
