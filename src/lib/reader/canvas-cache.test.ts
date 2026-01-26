import { describe, it, expect } from 'vitest';
import {
  getPagesToEvict,
  getPagesToLoad,
  getPreloadPageIndices,
  updateCacheStrategy
} from './canvas-cache';

describe('getPagesToEvict', () => {
  it('should return empty array when cache is under limit', () => {
    const cached = [0, 1, 2];
    const result = getPagesToEvict(cached, 1, 6);
    expect(result).toEqual([]);
  });

  it('should return empty array when cache is at limit', () => {
    const cached = [0, 1, 2, 3, 4, 5];
    const result = getPagesToEvict(cached, 2, 6);
    expect(result).toEqual([]);
  });

  it('should evict furthest pages when over limit', () => {
    const cached = [0, 1, 2, 3, 4, 5, 6, 7];
    const result = getPagesToEvict(cached, 3, 6);
    // Distances from 3: 0→3, 1→2, 2→1, 3→0, 4→1, 5→2, 6→3, 7→4
    // Sorted by distance: [3, 2, 4, 1, 5, 0, 6, 7]
    // Keep first 6: [3, 2, 4, 1, 5, 0]
    // Evict: [6, 7]
    expect(result).toHaveLength(2);
    expect(result).toContain(6);
    expect(result).toContain(7);
  });

  it('should evict based on distance from center', () => {
    const cached = [0, 5, 10, 15, 20, 25, 30];
    const result = getPagesToEvict(cached, 15, 4);
    // Distances from 15: 0→15, 5→10, 10→5, 15→0, 20→5, 25→10, 30→15
    // Sorted by distance: [15, 10, 20, 5, 25, 0, 30]
    // Keep first 4: [15, 10, 20, 5]
    // Evict: [25, 0, 30]
    expect(result).toHaveLength(3);
    expect(result).toContain(0);
    expect(result).toContain(25);
    expect(result).toContain(30);
  });

  it('should handle center at edge of cache', () => {
    const cached = [0, 1, 2, 3, 4, 5, 6, 7];
    const result = getPagesToEvict(cached, 0, 4);
    // Keep 0, 1, 2, 3 (closest to 0)
    // Evict 4, 5, 6, 7
    expect(result).toHaveLength(4);
    expect(result).toContain(4);
    expect(result).toContain(5);
    expect(result).toContain(6);
    expect(result).toContain(7);
  });

  it('should handle empty cache', () => {
    const result = getPagesToEvict([], 5, 6);
    expect(result).toEqual([]);
  });
});

describe('getPagesToLoad', () => {
  it('should return pages not in cache', () => {
    const needed = [3, 4, 5];
    const cached = [3];
    const result = getPagesToLoad(needed, cached, 4, 6);
    expect(result).toEqual([4, 5]);
  });

  it('should prioritize pages closest to center', () => {
    const needed = [0, 1, 2, 3, 4, 5];
    const cached: number[] = [];
    const result = getPagesToLoad(needed, cached, 3, 4);
    // Should load 3, 2, 4, 1 (sorted by distance from 3, limited to 4)
    expect(result).toHaveLength(4);
    expect(result[0]).toBe(3);
    expect(result).toContain(2);
    expect(result).toContain(4);
  });

  it('should limit to available slots', () => {
    const needed = [0, 1, 2, 3, 4, 5];
    const cached = [10, 11, 12, 13]; // 4 already cached
    const result = getPagesToLoad(needed, cached, 2, 6);
    // Only 2 slots available (6 - 4)
    expect(result).toHaveLength(2);
  });

  it('should return empty when cache is full', () => {
    const needed = [0, 1, 2];
    const cached = [10, 11, 12, 13, 14, 15];
    const result = getPagesToLoad(needed, cached, 1, 6);
    expect(result).toEqual([]);
  });

  it('should return empty when all needed pages are cached', () => {
    const needed = [3, 4, 5];
    const cached = [3, 4, 5];
    const result = getPagesToLoad(needed, cached, 4, 6);
    expect(result).toEqual([]);
  });

  it('should handle empty needed list', () => {
    const result = getPagesToLoad([], [1, 2, 3], 2, 6);
    expect(result).toEqual([]);
  });
});

describe('getPreloadPageIndices', () => {
  // Each spread contains page indices
  const spreadPageIndices = [
    [0], // spread 0: single page
    [1, 2], // spread 1: dual
    [3, 4], // spread 2: dual
    [5], // spread 3: single
    [6, 7], // spread 4: dual
    [8, 9] // spread 5: dual
  ];

  it('should return pages within buffer range', () => {
    const result = getPreloadPageIndices(spreadPageIndices, 2, 1);
    // Spreads 1, 2, 3 (buffer of 1 around spread 2)
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('should clamp to start of array', () => {
    const result = getPreloadPageIndices(spreadPageIndices, 0, 2);
    // Spreads 0, 1, 2 (can't go before 0)
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it('should clamp to end of array', () => {
    const result = getPreloadPageIndices(spreadPageIndices, 5, 2);
    // Spreads 3, 4, 5 (can't go past 5)
    expect(result).toEqual([5, 6, 7, 8, 9]);
  });

  it('should handle buffer of 0', () => {
    const result = getPreloadPageIndices(spreadPageIndices, 2, 0);
    // Only spread 2
    expect(result).toEqual([3, 4]);
  });

  it('should handle single-page spreads', () => {
    const singlePageSpreads = [[0], [1], [2], [3]];
    const result = getPreloadPageIndices(singlePageSpreads, 1, 1);
    expect(result).toEqual([0, 1, 2]);
  });

  it('should handle empty spreads array', () => {
    const result = getPreloadPageIndices([], 0, 2);
    expect(result).toEqual([]);
  });
});

describe('updateCacheStrategy', () => {
  const spreadPageIndices = [
    [0, 1], // spread 0
    [2, 3], // spread 1
    [4, 5], // spread 2
    [6, 7], // spread 3
    [8, 9], // spread 4
    [10, 11] // spread 5
  ];

  const options = { maxCachedPages: 6, preloadBuffer: 1 };

  it('should evict and load when navigating forward', () => {
    // Currently cached pages 0-5
    const cached = [0, 1, 2, 3, 4, 5];
    const result = updateCacheStrategy(cached, spreadPageIndices, 2, 4, options);

    // Moving to spread 2 (center page 4)
    // Preload window: spreads 1, 2, 3 = pages 2, 3, 4, 5, 6, 7
    // Need to load: 6, 7
    // Need to evict to make room: 0, 1 (furthest from 4, not in needed set)
    expect(result.toEvict).toHaveLength(2);
    expect(result.toEvict).toContain(0);
    expect(result.toEvict).toContain(1);

    // Should load 6, 7 (newly needed)
    expect(result.toLoad).toHaveLength(2);
    expect(result.toLoad).toContain(6);
    expect(result.toLoad).toContain(7);
  });

  it('should not evict when cache has room', () => {
    const cached = [2, 3, 4, 5];
    const result = updateCacheStrategy(cached, spreadPageIndices, 2, 4, options);

    expect(result.toEvict).toEqual([]);
    // Should load 6, 7 (needed but not cached)
    expect(result.toLoad).toContain(6);
    expect(result.toLoad).toContain(7);
  });

  it('should not load when all needed pages are cached', () => {
    // At spread 2, all needed pages already cached
    const cached = [2, 3, 4, 5, 6, 7];
    const result = updateCacheStrategy(cached, spreadPageIndices, 2, 4, options);

    expect(result.toEvict).toEqual([]);
    expect(result.toLoad).toEqual([]);
  });

  it('should handle being at the start', () => {
    // Cache is at limit with pages far from spread 0
    const cached = [4, 5, 6, 7, 8, 9];
    const result = updateCacheStrategy(cached, spreadPageIndices, 0, 0, options);

    // At spread 0, need pages 0, 1, 2, 3 (spreads 0, 1)
    // None of cached pages are in needed set, so evict furthest to make room
    // Should evict [9, 8, 7, 6] (furthest from 0) to load [0, 1, 2, 3]
    expect(result.toEvict).toHaveLength(4);
    expect(result.toEvict).toContain(6);
    expect(result.toEvict).toContain(7);
    expect(result.toEvict).toContain(8);
    expect(result.toEvict).toContain(9);

    // Should load all needed pages
    expect(result.toLoad).toHaveLength(4);
    expect(result.toLoad).toContain(0);
    expect(result.toLoad).toContain(1);
    expect(result.toLoad).toContain(2);
    expect(result.toLoad).toContain(3);
  });

  it('should handle being at the end', () => {
    // Cache is at limit with pages far from spread 5
    const cached = [0, 1, 2, 3, 4, 5];
    const result = updateCacheStrategy(cached, spreadPageIndices, 5, 10, options);

    // At spread 5, need pages 8, 9, 10, 11 (spreads 4, 5)
    // None of cached pages are in needed set, so evict furthest to make room
    // Should evict [0, 1, 2, 3] (furthest from 10) to load [8, 9, 10, 11]
    expect(result.toEvict).toHaveLength(4);
    expect(result.toEvict).toContain(0);
    expect(result.toEvict).toContain(1);
    expect(result.toEvict).toContain(2);
    expect(result.toEvict).toContain(3);

    // Should load all needed pages
    expect(result.toLoad).toHaveLength(4);
    expect(result.toLoad).toContain(8);
    expect(result.toLoad).toContain(9);
    expect(result.toLoad).toContain(10);
    expect(result.toLoad).toContain(11);
  });

  it('should evict when cache is over limit and at start', () => {
    // Cache is OVER limit (8 pages, max is 6)
    const cached = [4, 5, 6, 7, 8, 9, 10, 11];
    const result = updateCacheStrategy(cached, spreadPageIndices, 0, 0, options);

    // At spread 0, need pages 0, 1, 2, 3 (spreads 0, 1)
    // Need to evict: 8 (current) + 4 (to load) - 6 (max) = 6 pages
    // Evict candidates sorted by distance from 0 (furthest first): [11, 10, 9, 8, 7, 6]
    expect(result.toEvict).toHaveLength(6);
    expect(result.toEvict).toContain(6);
    expect(result.toEvict).toContain(7);
    expect(result.toEvict).toContain(8);
    expect(result.toEvict).toContain(9);
    expect(result.toEvict).toContain(10);
    expect(result.toEvict).toContain(11);

    // Should load all 4 needed pages
    expect(result.toLoad).toHaveLength(4);
    expect(result.toLoad).toContain(0);
    expect(result.toLoad).toContain(1);
    expect(result.toLoad).toContain(2);
    expect(result.toLoad).toContain(3);
  });

  it('should evict when cache is over limit and at end', () => {
    // Cache is OVER limit (8 pages, max is 6)
    const cached = [0, 1, 2, 3, 4, 5, 6, 7];
    const result = updateCacheStrategy(cached, spreadPageIndices, 5, 10, options);

    // At spread 5, need pages 8, 9, 10, 11 (spreads 4, 5)
    // Need to evict: 8 (current) + 4 (to load) - 6 (max) = 6 pages
    // Evict candidates sorted by distance from 10 (furthest first): [0, 1, 2, 3, 4, 5]
    expect(result.toEvict).toHaveLength(6);
    expect(result.toEvict).toContain(0);
    expect(result.toEvict).toContain(1);
    expect(result.toEvict).toContain(2);
    expect(result.toEvict).toContain(3);
    expect(result.toEvict).toContain(4);
    expect(result.toEvict).toContain(5);

    // Should load all 4 needed pages
    expect(result.toLoad).toHaveLength(4);
    expect(result.toLoad).toContain(8);
    expect(result.toLoad).toContain(9);
    expect(result.toLoad).toContain(10);
    expect(result.toLoad).toContain(11);
  });

  it('should handle empty cache', () => {
    const result = updateCacheStrategy([], spreadPageIndices, 2, 4, options);

    expect(result.toEvict).toEqual([]);
    // Should load up to maxCachedPages
    expect(result.toLoad.length).toBeLessThanOrEqual(options.maxCachedPages);
    expect(result.toLoad).toContain(4);
    expect(result.toLoad).toContain(5);
  });

  it('should respect maxCachedPages limit when loading', () => {
    const cached = [0, 1];
    const largePreloadOptions = { maxCachedPages: 4, preloadBuffer: 3 };
    const result = updateCacheStrategy(cached, spreadPageIndices, 2, 4, largePreloadOptions);

    // Even with large preload buffer, should only load up to limit
    const totalAfterLoad = cached.length - result.toEvict.length + result.toLoad.length;
    expect(totalAfterLoad).toBeLessThanOrEqual(largePreloadOptions.maxCachedPages);
  });
});

describe('integration: cache sliding window behavior', () => {
  it('should maintain cache at or below max as user navigates', () => {
    const spreadPageIndices = Array.from({ length: 20 }, (_, i) => [i * 2, i * 2 + 1]);
    const options = { maxCachedPages: 6, preloadBuffer: 1 };

    // Simulate navigating from spread 0 to spread 10
    let cached: number[] = [];

    for (let spread = 0; spread <= 10; spread++) {
      const centerPage = spread * 2;
      const { toEvict, toLoad } = updateCacheStrategy(
        cached,
        spreadPageIndices,
        spread,
        centerPage,
        options
      );

      // Apply evictions
      cached = cached.filter((p) => !toEvict.includes(p));
      // Apply loads
      cached = [...cached, ...toLoad];

      // Cache should never exceed max
      expect(cached.length).toBeLessThanOrEqual(options.maxCachedPages);
    }

    // After navigation, cache should contain pages near spread 10
    // Center is page 20, so nearby pages should be cached
    const hasNearbyPages = cached.some((p) => p >= 16 && p <= 23);
    expect(hasNearbyPages).toBe(true);
  });

  it('should prioritize loading current spread pages first', () => {
    const spreadPageIndices = Array.from({ length: 10 }, (_, i) => [i * 2, i * 2 + 1]);
    const options = { maxCachedPages: 6, preloadBuffer: 2 };

    // Empty cache, at spread 3 (pages 6, 7)
    const { toLoad } = updateCacheStrategy([], spreadPageIndices, 3, 6, options);

    // Page 6 (center page) should be first
    expect(toLoad[0]).toBe(6);
    // Page 7 (same spread) should be in top 3 (after 6, possibly after 5 due to distance tie)
    // Distance from 6: 6=0, 5=1, 7=1 - ties resolved by original order, so 5 may come before 7
    expect(toLoad.slice(0, 3)).toContain(7);
  });

  it('should not thrash (repeatedly evict and load same pages)', () => {
    const spreadPageIndices = Array.from({ length: 10 }, (_, i) => [i * 2, i * 2 + 1]);
    const options = { maxCachedPages: 6, preloadBuffer: 1 };

    // Start at spread 3 with optimal cache
    let cached: number[] = [4, 5, 6, 7, 8, 9]; // Pages for spreads 2, 3, 4
    const spread = 3;
    const centerPage = 6;

    // Run strategy multiple times at same position
    for (let i = 0; i < 5; i++) {
      const { toEvict, toLoad } = updateCacheStrategy(
        cached,
        spreadPageIndices,
        spread,
        centerPage,
        options
      );

      // Should not evict or load anything when stable
      expect(toEvict).toEqual([]);
      expect(toLoad).toEqual([]);
    }
  });

  it('should handle rapid forward navigation without thrashing', () => {
    const spreadPageIndices = Array.from({ length: 20 }, (_, i) => [i * 2, i * 2 + 1]);
    const options = { maxCachedPages: 6, preloadBuffer: 1 };

    let cached: number[] = [0, 1, 2, 3, 4, 5];
    let totalEvictions = 0;
    let totalLoads = 0;

    // Navigate forward rapidly
    for (let spread = 0; spread <= 15; spread++) {
      const centerPage = spread * 2;
      const { toEvict, toLoad } = updateCacheStrategy(
        cached,
        spreadPageIndices,
        spread,
        centerPage,
        options
      );

      totalEvictions += toEvict.length;
      totalLoads += toLoad.length;

      cached = cached.filter((p) => !toEvict.includes(p));
      cached = [...cached, ...toLoad];
    }

    // We navigated 15 spreads (30 pages worth)
    // With cache of 6 and buffer of 1, we should load ~30 pages total
    // But we shouldn't have excessive churn
    expect(totalLoads).toBeGreaterThan(0);
    expect(totalLoads).toBeLessThan(50); // Reasonable upper bound
  });
});
