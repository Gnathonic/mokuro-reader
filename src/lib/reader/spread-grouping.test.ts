import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  groupPagesIntoSpreads,
  findSpreadForPage,
  getSpreadFirstPage,
  getSpreadPageNumbers,
  detectSpreadBreakpoints,
  toggleBreakpoint,
  type PageSpread
} from './spread-grouping';
import type { Page } from '$lib/types';

// Helper to create minimal page data
function createPage(width: number, height: number, path = 'test.jpg'): Page {
  return {
    version: '0.2.0',
    img_width: width,
    img_height: height,
    img_path: path,
    blocks: []
  };
}

// Standard portrait page (typical manga page)
function portraitPage(path = 'test.jpg'): Page {
  return createPage(1000, 1500, path);
}

// Wide spread page (double-page spread in manga)
function wideSpreadPage(path = 'test.jpg'): Page {
  return createPage(2000, 1500, path);
}

describe('detectSpreadBreakpoints', () => {
  it('should return empty array for empty pages', () => {
    expect(detectSpreadBreakpoints([])).toEqual([]);
  });

  it('should return empty array when no wide spreads', () => {
    const pages = [portraitPage(), portraitPage(), portraitPage()];
    expect(detectSpreadBreakpoints(pages)).toEqual([]);
  });

  it('should add page 1 as breakpoint when page 0 is wide (dust cover)', () => {
    const pages = [wideSpreadPage(), portraitPage(), portraitPage()];
    const breakpoints = detectSpreadBreakpoints(pages);
    expect(breakpoints).toEqual([0, 1]); // Dust cover + first content page
  });

  it('should detect spreads in dust cover zone without inferring cover', () => {
    // Spreads at positions 0-3 are in the dust cover zone, not reliable references
    const pages = Array(10)
      .fill(null)
      .map(() => portraitPage());
    pages[2] = wideSpreadPage();
    const breakpoints = detectSpreadBreakpoints(pages);
    expect(breakpoints).toEqual([2]); // Just the wide spread, no inference
  });

  it('should infer cover when page count before spread is odd', () => {
    // Spread at position 5: 5 pages before (0-4)
    // 5 is odd → need cover at page 0
    const pages = Array(10)
      .fill(null)
      .map(() => portraitPage());
    pages[5] = wideSpreadPage();
    const breakpoints = detectSpreadBreakpoints(pages);
    expect(breakpoints).toEqual([0, 5]); // Cover + spread
  });

  it('should not infer cover when page count before spread is even', () => {
    // Spread at position 4: 4 pages before (0-3)
    // 4 is even → no cover needed
    const pages = Array(10)
      .fill(null)
      .map(() => portraitPage());
    pages[4] = wideSpreadPage();
    const breakpoints = detectSpreadBreakpoints(pages);
    expect(breakpoints).toEqual([4]); // Just the spread
  });

  it('should handle dust cover + reference spread correctly', () => {
    // Dust cover at 0, spread at 5
    // Content starts at 1, 4 pages before spread (1-4)
    // 4 is even → no extra cover needed
    const pages = Array(10)
      .fill(null)
      .map(() => portraitPage());
    pages[0] = wideSpreadPage(); // dust cover
    pages[5] = wideSpreadPage(); // reference spread
    const breakpoints = detectSpreadBreakpoints(pages);
    expect(breakpoints).toEqual([0, 1, 5]); // Dust cover, first content, spread
  });

  it('should add cover after dust cover when page count is odd', () => {
    // Dust cover at 0, spread at 6
    // Content starts at 1, 5 pages before spread (1-5)
    // 5 is odd → page 1 should be single (but already is from dust cover rule)
    const pages = Array(10)
      .fill(null)
      .map(() => portraitPage());
    pages[0] = wideSpreadPage(); // dust cover
    pages[6] = wideSpreadPage(); // reference spread
    const breakpoints = detectSpreadBreakpoints(pages);
    expect(breakpoints).toEqual([0, 1, 6]); // Dust cover, first content (already single), spread
  });

  it('should skip inconsistent-width pages when counting', () => {
    // Normal pages are 1000px wide, but page 2 is 500px (dust cover insert)
    const pages = Array(10)
      .fill(null)
      .map(() => portraitPage()); // 1000x1500
    pages[2] = createPage(500, 750, 'insert.jpg'); // Half-width insert (skipped)
    pages[5] = wideSpreadPage(); // reference spread
    // Pages 0,1,3,4 are consistent width = 4 pages
    // 4 is even → no cover
    const breakpoints = detectSpreadBreakpoints(pages);
    expect(breakpoints).toEqual([5]); // Just the spread
  });

  it('should detect multiple reference spreads', () => {
    const pages = Array(15)
      .fill(null)
      .map(() => portraitPage());
    pages[5] = wideSpreadPage();
    pages[10] = wideSpreadPage();
    // First reference is at 5: 5 pages before (0-4)
    // 5 is odd → add cover
    const breakpoints = detectSpreadBreakpoints(pages);
    expect(breakpoints).toEqual([0, 5, 10]); // Cover + both spreads
  });
});

describe('toggleBreakpoint', () => {
  it('should add breakpoint if not present', () => {
    const result = toggleBreakpoint(5, [0, 3]);
    expect(result).toEqual([0, 3, 5]);
  });

  it('should remove breakpoint if present', () => {
    const result = toggleBreakpoint(3, [0, 3, 5]);
    expect(result).toEqual([0, 5]);
  });

  it('should maintain sorted order when adding', () => {
    const result = toggleBreakpoint(2, [0, 5, 10]);
    expect(result).toEqual([0, 2, 5, 10]);
  });
});

describe('groupPagesIntoSpreads', () => {
  describe('empty and edge cases', () => {
    it('should return empty array for empty pages', () => {
      expect(groupPagesIntoSpreads([], 'auto', true, false)).toEqual([]);
    });

    it('should return empty array for null/undefined pages', () => {
      expect(groupPagesIntoSpreads(null as unknown as Page[], 'auto', true, false)).toEqual([]);
      expect(groupPagesIntoSpreads(undefined as unknown as Page[], 'auto', true, false)).toEqual(
        []
      );
    });

    it('should handle single page volume', () => {
      const pages = [portraitPage()];
      const spreads = groupPagesIntoSpreads(pages, 'auto', true, false);

      expect(spreads).toHaveLength(1);
      expect(spreads[0].type).toBe('single');
      expect(spreads[0].pageIndices).toEqual([0]);
    });
  });

  describe('single page mode', () => {
    it('should create all single spreads in single mode', () => {
      const pages = [portraitPage(), portraitPage(), portraitPage(), portraitPage()];
      const spreads = groupPagesIntoSpreads(pages, 'single', true, false);

      expect(spreads).toHaveLength(4);
      spreads.forEach((spread, i) => {
        expect(spread.type).toBe('single');
        expect(spread.pageIndices).toEqual([i]);
        expect(spread.pages).toHaveLength(1);
      });
    });
  });

  describe('dual page mode', () => {
    it('should create dual spreads for even number of pages', () => {
      const pages = [portraitPage(), portraitPage(), portraitPage(), portraitPage()];
      const spreads = groupPagesIntoSpreads(pages, 'dual', true, false);

      expect(spreads).toHaveLength(2);
      expect(spreads[0].type).toBe('dual');
      expect(spreads[0].pageIndices).toEqual([0, 1]);
      expect(spreads[1].type).toBe('dual');
      expect(spreads[1].pageIndices).toEqual([2, 3]);
    });

    it('should handle odd number of pages with single at end', () => {
      const pages = [portraitPage(), portraitPage(), portraitPage()];
      const spreads = groupPagesIntoSpreads(pages, 'dual', true, false);

      expect(spreads).toHaveLength(2);
      expect(spreads[0].type).toBe('dual');
      expect(spreads[0].pageIndices).toEqual([0, 1]);
      expect(spreads[1].type).toBe('single');
      expect(spreads[1].pageIndices).toEqual([2]);
    });

    it('should respect breakpoints even in dual mode', () => {
      const pages = [portraitPage(), portraitPage(), portraitPage(), portraitPage()];
      // Page 0 is a breakpoint (like a cover)
      const spreads = groupPagesIntoSpreads(pages, 'dual', true, false, [0]);

      expect(spreads[0].type).toBe('single'); // Breakpoint
      expect(spreads[0].pageIndices).toEqual([0]);
      expect(spreads[1].type).toBe('dual'); // Remaining pages pair
      expect(spreads[1].pageIndices).toEqual([1, 2]);
      expect(spreads[2].type).toBe('single'); // Odd page out
      expect(spreads[2].pageIndices).toEqual([3]);
    });
  });

  describe('breakpoints', () => {
    it('should make breakpoint pages single', () => {
      const pages = [portraitPage(), portraitPage(), portraitPage(), portraitPage()];
      const spreads = groupPagesIntoSpreads(pages, 'auto', true, false, [0]);

      expect(spreads[0].type).toBe('single');
      expect(spreads[0].pageIndices).toEqual([0]);
      // Remaining pages should pair up
      expect(spreads[1].type).toBe('dual');
      expect(spreads[1].pageIndices).toEqual([1, 2]);
    });

    it('should pair pages normally when no breakpoints', () => {
      const pages = [portraitPage(), portraitPage(), portraitPage(), portraitPage()];
      const spreads = groupPagesIntoSpreads(pages, 'auto', true, false, []);

      expect(spreads[0].type).toBe('dual');
      expect(spreads[0].pageIndices).toEqual([0, 1]);
    });

    it('should handle multiple breakpoints', () => {
      const pages = [
        portraitPage(), // 0: breakpoint
        portraitPage(), // 1
        portraitPage(), // 2
        portraitPage(), // 3: breakpoint
        portraitPage(), // 4
        portraitPage() // 5
      ];
      const spreads = groupPagesIntoSpreads(pages, 'auto', true, false, [0, 3]);

      expect(spreads[0].type).toBe('single'); // breakpoint 0
      expect(spreads[0].pageIndices).toEqual([0]);
      expect(spreads[1].type).toBe('dual'); // 1-2 pair
      expect(spreads[1].pageIndices).toEqual([1, 2]);
      expect(spreads[2].type).toBe('single'); // breakpoint 3
      expect(spreads[2].pageIndices).toEqual([3]);
      expect(spreads[3].type).toBe('dual'); // 4-5 pair
      expect(spreads[3].pageIndices).toEqual([4, 5]);
    });
  });

  describe('auto mode with wide spreads', () => {
    it('should make wide spread pages single automatically', () => {
      const pages = [portraitPage(), wideSpreadPage(), portraitPage(), portraitPage()];
      const spreads = groupPagesIntoSpreads(pages, 'auto', true, false);

      // First page should be single (next page is wide)
      expect(spreads[0].type).toBe('single');
      expect(spreads[0].pageIndices).toEqual([0]);

      // Wide spread should be single
      expect(spreads[1].type).toBe('single');
      expect(spreads[1].pageIndices).toEqual([1]);

      // Pages after wide spread can pair
      expect(spreads[2].type).toBe('dual');
      expect(spreads[2].pageIndices).toEqual([2, 3]);
    });

    it('should pair pages after a wide spread', () => {
      const pages = [
        portraitPage(),
        wideSpreadPage(),
        portraitPage(),
        portraitPage(),
        portraitPage()
      ];
      const spreads = groupPagesIntoSpreads(pages, 'auto', true, false);

      expect(spreads[0].type).toBe('single'); // before wide
      expect(spreads[1].type).toBe('single'); // wide spread
      expect(spreads[2].type).toBe('dual'); // pages 2-3 pair
      expect(spreads[2].pageIndices).toEqual([2, 3]);
      expect(spreads[3].type).toBe('single'); // page 4 (no next)
    });

    it('should handle consecutive wide spreads', () => {
      const pages = [wideSpreadPage(), wideSpreadPage(), portraitPage()];
      const spreads = groupPagesIntoSpreads(pages, 'auto', true, false);

      expect(spreads).toHaveLength(3);
      expect(spreads[0].type).toBe('single');
      expect(spreads[1].type).toBe('single');
      expect(spreads[2].type).toBe('single');
    });
  });

  describe('auto mode in portrait orientation', () => {
    it('should create all single spreads in portrait orientation', () => {
      const pages = [portraitPage(), portraitPage(), portraitPage()];
      // isPortrait = true
      const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

      expect(spreads).toHaveLength(3);
      spreads.forEach((spread) => {
        expect(spread.type).toBe('single');
      });
    });

    it('should pair pages in landscape orientation', () => {
      const pages = [portraitPage(), portraitPage(), portraitPage(), portraitPage()];
      // isPortrait = false
      const spreads = groupPagesIntoSpreads(pages, 'auto', true, false);

      expect(spreads).toHaveLength(2);
      expect(spreads[0].type).toBe('dual');
      expect(spreads[1].type).toBe('dual');
    });
  });

  describe('page references', () => {
    it('should include correct page objects in spreads', () => {
      const page1 = createPage(1000, 1500, 'page1.jpg');
      const page2 = createPage(1000, 1500, 'page2.jpg');
      const pages = [page1, page2];

      const spreads = groupPagesIntoSpreads(pages, 'dual', true, false);

      expect(spreads[0].pages[0]).toBe(page1);
      expect(spreads[0].pages[1]).toBe(page2);
    });
  });

  describe('RTL handling', () => {
    it('should store pages in reading order regardless of RTL setting', () => {
      // RTL affects visual rendering, not storage order
      const pages = [portraitPage(), portraitPage()];

      const spreadsRTL = groupPagesIntoSpreads(pages, 'dual', true, false);
      const spreadsLTR = groupPagesIntoSpreads(pages, 'dual', false, false);

      // Storage order should be the same
      expect(spreadsRTL[0].pageIndices).toEqual([0, 1]);
      expect(spreadsLTR[0].pageIndices).toEqual([0, 1]);
    });
  });

  describe('complex volume scenarios', () => {
    it('should handle typical manga volume with cover and wide spread in middle', () => {
      const pages = [
        portraitPage(), // 0: Cover - breakpoint
        portraitPage(), // 1: Page 1
        portraitPage(), // 2: Page 2
        wideSpreadPage(), // 3: Color spread - auto breakpoint
        portraitPage(), // 4: Page 4
        portraitPage(), // 5: Page 5
        portraitPage(), // 6: Page 6
        portraitPage() // 7: Page 7
      ];

      // Cover is a breakpoint
      const spreads = groupPagesIntoSpreads(pages, 'auto', true, false, [0]);

      // Cover is single (breakpoint)
      expect(spreads[0].type).toBe('single');
      expect(spreads[0].pageIndices).toEqual([0]);

      // Pages 1-2 pair
      expect(spreads[1].type).toBe('dual');
      expect(spreads[1].pageIndices).toEqual([1, 2]);

      // Wide spread is single (auto-detected)
      expect(spreads[2].type).toBe('single');
      expect(spreads[2].pageIndices).toEqual([3]);

      // Pages 4-5 pair
      expect(spreads[3].type).toBe('dual');
      expect(spreads[3].pageIndices).toEqual([4, 5]);

      // Pages 6-7 pair
      expect(spreads[4].type).toBe('dual');
      expect(spreads[4].pageIndices).toEqual([6, 7]);
    });

    it('should handle volume without cover', () => {
      const pages = [
        portraitPage(), // 0
        portraitPage(), // 1
        portraitPage(), // 2
        portraitPage() // 3
      ];

      const spreads = groupPagesIntoSpreads(pages, 'auto', true, false, []);

      expect(spreads).toHaveLength(2);
      expect(spreads[0].type).toBe('dual');
      expect(spreads[0].pageIndices).toEqual([0, 1]);
      expect(spreads[1].type).toBe('dual');
      expect(spreads[1].pageIndices).toEqual([2, 3]);
    });
  });
});

describe('findSpreadForPage', () => {
  const spreads: PageSpread[] = [
    { type: 'single', pages: [], pageIndices: [0] },
    { type: 'dual', pages: [], pageIndices: [1, 2] },
    { type: 'single', pages: [], pageIndices: [3] },
    { type: 'dual', pages: [], pageIndices: [4, 5] }
  ];

  it('should find spread index for single page spread', () => {
    expect(findSpreadForPage(spreads, 0)).toBe(0);
    expect(findSpreadForPage(spreads, 3)).toBe(2);
  });

  it('should find spread index for first page of dual spread', () => {
    expect(findSpreadForPage(spreads, 1)).toBe(1);
    expect(findSpreadForPage(spreads, 4)).toBe(3);
  });

  it('should find spread index for second page of dual spread', () => {
    expect(findSpreadForPage(spreads, 2)).toBe(1);
    expect(findSpreadForPage(spreads, 5)).toBe(3);
  });

  it('should return -1 for page not in any spread', () => {
    expect(findSpreadForPage(spreads, 6)).toBe(-1);
    expect(findSpreadForPage(spreads, 100)).toBe(-1);
    expect(findSpreadForPage(spreads, -1)).toBe(-1);
  });

  it('should handle empty spreads array', () => {
    expect(findSpreadForPage([], 0)).toBe(-1);
  });
});

describe('getSpreadFirstPage', () => {
  it('should return 1-indexed first page for single spread', () => {
    const spread: PageSpread = { type: 'single', pages: [], pageIndices: [0] };
    expect(getSpreadFirstPage(spread)).toBe(1);
  });

  it('should return 1-indexed first page for dual spread', () => {
    const spread: PageSpread = { type: 'dual', pages: [], pageIndices: [2, 3] };
    expect(getSpreadFirstPage(spread)).toBe(3);
  });

  it('should handle spreads not starting at 0', () => {
    const spread: PageSpread = { type: 'single', pages: [], pageIndices: [10] };
    expect(getSpreadFirstPage(spread)).toBe(11);
  });
});

describe('getSpreadPageNumbers', () => {
  it('should return 1-indexed page numbers for single spread', () => {
    const spread: PageSpread = { type: 'single', pages: [], pageIndices: [0] };
    expect(getSpreadPageNumbers(spread)).toEqual([1]);
  });

  it('should return 1-indexed page numbers for dual spread', () => {
    const spread: PageSpread = { type: 'dual', pages: [], pageIndices: [2, 3] };
    expect(getSpreadPageNumbers(spread)).toEqual([3, 4]);
  });

  it('should return all pages in a spread', () => {
    const spread: PageSpread = { type: 'dual', pages: [], pageIndices: [10, 11] };
    expect(getSpreadPageNumbers(spread)).toEqual([11, 12]);
  });
});
