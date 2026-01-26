/**
 * Canvas cache management for the PureCanvasReader.
 * Handles pre-rendering pages at target zoom levels and LRU-style eviction.
 */

export interface CachedPage {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  scale: number; // The effective scale this was rendered at
}

export interface CanvasCacheOptions {
  maxCachedPages: number;
  preloadBuffer: number;
}

/**
 * Determine which pages should be evicted based on distance from center.
 * Returns page indices that should be removed.
 */
export function getPagesToEvict(
  cachedPageIndices: number[],
  centerPageIdx: number,
  maxCachedPages: number
): number[] {
  if (cachedPageIndices.length <= maxCachedPages) {
    return [];
  }

  // Sort by distance from center (closest first)
  const sorted = [...cachedPageIndices].sort(
    (a, b) => Math.abs(a - centerPageIdx) - Math.abs(b - centerPageIdx)
  );

  // Return pages beyond the max (furthest from center)
  return sorted.slice(maxCachedPages);
}

/**
 * Determine which pages should be loaded, prioritized by distance from center.
 * Only returns pages that fit within available cache slots.
 */
export function getPagesToLoad(
  neededPageIndices: number[],
  cachedPageIndices: number[],
  centerPageIdx: number,
  maxCachedPages: number
): number[] {
  // Filter to only pages not already cached
  const uncached = neededPageIndices.filter((idx) => !cachedPageIndices.includes(idx));

  if (uncached.length === 0) {
    return [];
  }

  // Sort by distance from center (closest first)
  const sorted = [...uncached].sort(
    (a, b) => Math.abs(a - centerPageIdx) - Math.abs(b - centerPageIdx)
  );

  // Only take what fits in available slots
  const availableSlots = maxCachedPages - cachedPageIndices.length;
  return sorted.slice(0, Math.max(0, availableSlots));
}

/**
 * Get page indices in the preload window around a spread index.
 */
export function getPreloadPageIndices(
  spreadPageIndices: number[][], // Array of page indices per spread
  currentSpreadIndex: number,
  preloadBuffer: number
): number[] {
  const result: number[] = [];
  const startIdx = Math.max(0, currentSpreadIndex - preloadBuffer);
  const endIdx = Math.min(spreadPageIndices.length - 1, currentSpreadIndex + preloadBuffer);

  for (let i = startIdx; i <= endIdx; i++) {
    const pageIndices = spreadPageIndices[i];
    if (pageIndices) {
      result.push(...pageIndices);
    }
  }

  return result;
}

/**
 * Orchestrates the cache update: evict distant pages to make room, then load needed pages.
 * Returns { toEvict, toLoad } page indices.
 */
export function updateCacheStrategy(
  cachedPageIndices: number[],
  spreadPageIndices: number[][],
  currentSpreadIndex: number,
  centerPageIdx: number,
  options: CanvasCacheOptions
): { toEvict: number[]; toLoad: number[] } {
  // Get pages in preload window
  const neededPages = getPreloadPageIndices(
    spreadPageIndices,
    currentSpreadIndex,
    options.preloadBuffer
  );

  // Find which needed pages are not cached
  const uncachedNeeded = neededPages.filter((idx) => !cachedPageIndices.includes(idx));

  if (uncachedNeeded.length === 0) {
    // All needed pages are cached, just evict if over limit
    const toEvict = getPagesToEvict(cachedPageIndices, centerPageIdx, options.maxCachedPages);
    return { toEvict, toLoad: [] };
  }

  // Sort uncached by distance from center (closest first)
  const sortedUncached = [...uncachedNeeded].sort(
    (a, b) => Math.abs(a - centerPageIdx) - Math.abs(b - centerPageIdx)
  );

  // Calculate how many we need to evict to make room
  const currentSize = cachedPageIndices.length;
  const wantToLoad = Math.min(sortedUncached.length, options.maxCachedPages);
  const needToEvict = Math.max(0, currentSize + wantToLoad - options.maxCachedPages);

  // Find pages to evict (furthest from center, but not pages we need)
  const evictCandidates = cachedPageIndices
    .filter((idx) => !neededPages.includes(idx))
    .sort((a, b) => Math.abs(b - centerPageIdx) - Math.abs(a - centerPageIdx)); // Furthest first

  const toEvict = evictCandidates.slice(0, needToEvict);

  // Calculate how many slots we have after eviction
  const availableSlots = options.maxCachedPages - (currentSize - toEvict.length);
  const toLoad = sortedUncached.slice(0, Math.max(0, availableSlots));

  return { toEvict, toLoad };
}
