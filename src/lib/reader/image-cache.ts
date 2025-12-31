/**
 * Image cache for preloading and decoding manga pages
 * Maintains a windowed cache: previous 2 + current + next 3 pages
 *
 * Public API is index-based for clean caller usage.
 * Uses fuzzy matching to align files with pages when paths don't match exactly.
 */

import type { Page } from '$lib/types';
import { getBasename, normalizeFilename, removeExtension } from '$lib/util/misc';

export interface CachedImage {
  bitmap: ImageBitmap; // Pre-decoded bitmap ready to draw
  loading: Promise<ImageBitmap | null> | null;
}

/**
 * Natural sort comparator for filenames
 */
function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Match files to pages using fuzzy matching strategies
 * Returns an indexed array of Files aligned with page order
 *
 * Strategy order:
 * 1. Exact path match - all page.img_path values match file keys exactly
 * 2. Basename match - match just the filename portion without directories
 * 3. Path without extension - full path match ignoring extension (e.g., dir/page.png -> dir/page.webp)
 * 4. Basename without extension - handles format conversions (e.g., png->webp, jpg->avif)
 * 5. Page order fallback - sort files naturally and align by index
 */
function matchFilesToPages(files: Record<string, File>, pages: Page[]): File[] {
  const fileKeys = Object.keys(files);
  const result: File[] = new Array(pages.length);

  // Build a normalized path -> original key mapping for lookups
  const normalizedToKey = new Map<string, string>();
  for (const key of fileKeys) {
    normalizedToKey.set(normalizeFilename(key), key);
  }

  // Strategy 1: Try exact path matching (with normalization)
  let allExactMatches = true;
  for (let i = 0; i < pages.length; i++) {
    const imgPath = pages[i].img_path;
    const normalizedImgPath = normalizeFilename(imgPath);

    // Try direct match first, then normalized match
    if (files[imgPath]) {
      result[i] = files[imgPath];
    } else if (normalizedToKey.has(normalizedImgPath)) {
      result[i] = files[normalizedToKey.get(normalizedImgPath)!];
    } else {
      allExactMatches = false;
      break;
    }
  }

  if (allExactMatches) {
    return result;
  }

  // Strategy 2: Try basename matching (with normalization)
  // Build a map of normalized basename -> file for all files
  const basenameToFile = new Map<string, File>();
  const basenameConflicts = new Set<string>();

  for (const key of fileKeys) {
    const basename = normalizeFilename(getBasename(key));
    if (basenameToFile.has(basename)) {
      basenameConflicts.add(basename);
    } else {
      basenameToFile.set(basename, files[key]);
    }
  }

  let allBasenameMatches = true;
  for (let i = 0; i < pages.length; i++) {
    const imgPath = pages[i].img_path;
    const basename = normalizeFilename(getBasename(imgPath));

    if (basenameConflicts.has(basename)) {
      allBasenameMatches = false;
      break;
    }

    const file = basenameToFile.get(basename);
    if (file) {
      result[i] = file;
    } else {
      allBasenameMatches = false;
      break;
    }
  }

  if (allBasenameMatches) {
    return result;
  }

  // Strategy 3: Try exact path without extension (handles format conversions with same path)
  const pathNoExtToFile = new Map<string, File>();
  const pathNoExtConflicts = new Set<string>();

  for (const key of fileKeys) {
    const pathNoExt = normalizeFilename(removeExtension(key));
    if (pathNoExtToFile.has(pathNoExt)) {
      pathNoExtConflicts.add(pathNoExt);
    } else {
      pathNoExtToFile.set(pathNoExt, files[key]);
    }
  }

  let allPathNoExtMatches = true;
  for (let i = 0; i < pages.length; i++) {
    const imgPath = pages[i].img_path;
    const pathNoExt = normalizeFilename(removeExtension(imgPath));

    if (pathNoExtConflicts.has(pathNoExt)) {
      allPathNoExtMatches = false;
      break;
    }

    const file = pathNoExtToFile.get(pathNoExt);
    if (file) {
      result[i] = file;
    } else {
      allPathNoExtMatches = false;
      break;
    }
  }

  if (allPathNoExtMatches) {
    return result;
  }

  // Strategy 4: Try basename without extension (handles format conversions like png->webp)
  const basenameNoExtToFile = new Map<string, File>();
  const basenameNoExtConflicts = new Set<string>();

  for (const key of fileKeys) {
    const basenameNoExt = normalizeFilename(removeExtension(getBasename(key)));
    if (basenameNoExtToFile.has(basenameNoExt)) {
      basenameNoExtConflicts.add(basenameNoExt);
    } else {
      basenameNoExtToFile.set(basenameNoExt, files[key]);
    }
  }

  let allBasenameNoExtMatches = true;
  for (let i = 0; i < pages.length; i++) {
    const imgPath = pages[i].img_path;
    const basenameNoExt = normalizeFilename(removeExtension(getBasename(imgPath)));

    if (basenameNoExtConflicts.has(basenameNoExt)) {
      allBasenameNoExtMatches = false;
      break;
    }

    const file = basenameNoExtToFile.get(basenameNoExt);
    if (file) {
      result[i] = file;
    } else {
      allBasenameNoExtMatches = false;
      break;
    }
  }

  if (allBasenameNoExtMatches) {
    return result;
  }

  // Strategy 5: Fall back to page order (sort files naturally)
  const sortedKeys = fileKeys.sort(naturalSort);
  for (let i = 0; i < pages.length && i < sortedKeys.length; i++) {
    result[i] = files[sortedKeys[i]];
  }

  return result;
}

export class ImageCache {
  private cache = new Map<number, CachedImage>(); // Keyed by page index
  private files: File[] = []; // Indexed array aligned with pages
  private pages: Page[] = [];
  private currentIndex = 0;
  private windowSize: { prev: number; next: number };
  private onBitmapReady: ((index: number) => void) | null = null;

  /**
   * Create an ImageCache with configurable window size
   * @param windowSize - How many pages to cache before/after current. Default: prev 2, next 3
   */
  constructor(windowSize: { prev: number; next: number } = { prev: 2, next: 3 }) {
    this.windowSize = windowSize;
  }

  /**
   * Set a callback to be notified when a bitmap finishes loading
   * This allows immediate redraw instead of polling
   */
  setOnBitmapReady(callback: ((index: number) => void) | null): void {
    this.onBitmapReady = callback;
  }

  /**
   * Initialize or update the cache with new files and current page
   * Returns immediately - all preloading happens in the background
   */
  updateCache(files: Record<string, File>, pages: Page[], currentIndex: number): void {
    // Detect if we have new files by checking reference and length
    const fileCount = Object.keys(files).length;
    const filesChanged = this.files.length !== fileCount || this.pages !== pages;

    // Clear old cache and build indexed files array if files changed
    if (filesChanged) {
      this.cleanup();
      this.files = matchFilesToPages(files, pages);
      this.pages = pages;
    }

    this.currentIndex = currentIndex;

    // Calculate window range
    const startIndex = Math.max(0, currentIndex - this.windowSize.prev);
    const endIndex = Math.min(pages.length - 1, currentIndex + this.windowSize.next);

    // Get indices in the window
    const windowIndices = new Set<number>();
    for (let i = startIndex; i <= endIndex; i++) {
      windowIndices.add(i);
    }

    // Remove items outside the window
    for (const [index] of this.cache.entries()) {
      if (!windowIndices.has(index)) {
        this.removeFromCache(index);
      }
    }

    // Preload all items in the window (non-blocking)
    for (let i = startIndex; i <= endIndex; i++) {
      this.preloadImage(i).catch((err) => {
        console.error(`Failed to preload image at index ${i}:`, err);
      });
    }
  }

  /**
   * Get the File for a page index (for fallback rendering)
   */
  getFile(index: number): File | undefined {
    return this.files[index];
  }

  /**
   * Get a cached ImageBitmap synchronously if it's ready, null otherwise
   */
  getBitmapSync(index: number): ImageBitmap | null {
    const cached = this.cache.get(index);
    if (cached && cached.bitmap && !cached.loading) {
      return cached.bitmap;
    }
    return null;
  }

  /**
   * Get a cached ImageBitmap, waiting for it to be ready if necessary
   */
  async getBitmap(index: number): Promise<ImageBitmap | null> {
    const cached = this.cache.get(index);
    if (cached) {
      // Wait for bitmap to be decoded if it's still loading
      if (cached.loading) {
        return await cached.loading;
      }
      return cached.bitmap;
    }

    // Image not in cache, load it now
    return await this.preloadImage(index);
  }

  /**
   * Preload and decode an image by its page index using createImageBitmap
   * This decodes asynchronously in the background, off the main thread
   */
  private async preloadImage(index: number): Promise<ImageBitmap | null> {
    // Already cached or loading
    if (this.cache.has(index)) {
      const cached = this.cache.get(index)!;
      if (cached.loading) {
        return await cached.loading;
      }
      return cached.bitmap;
    }

    const file = this.files[index];
    if (!file) {
      return null;
    }

    // Create loading promise using createImageBitmap (async, off main thread)
    const loading = createImageBitmap(file).catch((err) => {
      console.error(`Failed to decode image at index ${index}:`, err);
      return null;
    });

    // Add to cache immediately with loading promise
    this.cache.set(index, {
      bitmap: null as unknown as ImageBitmap, // Will be set when loaded
      loading
    });

    // Wait for decode
    const bitmap = await loading;

    // Update cache with decoded bitmap
    const cached = this.cache.get(index);
    if (cached && bitmap) {
      cached.bitmap = bitmap;
      cached.loading = null;
    } else if (cached && !bitmap) {
      // Failed to decode, remove from cache
      this.cache.delete(index);
    }

    return bitmap;
  }

  /**
   * Remove an image from cache
   * Note: We don't call bitmap.close() because components may still hold references.
   * The browser's GC will clean up when all references are released.
   */
  private removeFromCache(index: number): void {
    this.cache.delete(index);
  }

  /**
   * Clean up all cached images (call on component destroy)
   */
  cleanup(): void {
    for (const [, cached] of this.cache) {
      if (cached.bitmap) {
        cached.bitmap.close(); // Release ImageBitmap memory
      }
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
      fileCount: this.files.length,
      cached: Array.from(this.cache.keys()),
      ready: Array.from(this.cache.entries())
        .filter(([_, v]) => v.bitmap && !v.loading)
        .map(([k]) => k)
    };
  }
}
