import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isWideSpread,
  haveSimilarWidths,
  isPortraitOrientation,
  shouldShowSinglePage
} from './page-mode-detection';
import type { Page } from '$lib/types';

// Helper to create minimal page data
function createPage(width: number, height: number): Page {
  return {
    version: '0.2.0',
    img_width: width,
    img_height: height,
    img_path: 'test-image.jpg',
    blocks: []
  };
}

describe('isWideSpread', () => {
  it('should return true for landscape pages with aspect ratio > 1.2', () => {
    // 1200x1000 = aspect ratio 1.2, should be false (not > 1.2)
    // 1201x1000 = aspect ratio 1.201, should be true
    expect(isWideSpread(createPage(1300, 1000))).toBe(true); // 1.3
    expect(isWideSpread(createPage(1500, 1000))).toBe(true); // 1.5
    expect(isWideSpread(createPage(2000, 1000))).toBe(true); // 2.0
  });

  it('should return false for portrait pages', () => {
    expect(isWideSpread(createPage(1000, 1500))).toBe(false); // 0.67
    expect(isWideSpread(createPage(800, 1200))).toBe(false); // 0.67
  });

  it('should return false for near-square pages', () => {
    expect(isWideSpread(createPage(1000, 1000))).toBe(false); // 1.0
    expect(isWideSpread(createPage(1100, 1000))).toBe(false); // 1.1
    expect(isWideSpread(createPage(1200, 1000))).toBe(false); // 1.2 (not > 1.2)
  });

  it('should handle edge case at threshold', () => {
    // Exactly 1.2 should be false
    expect(isWideSpread(createPage(1200, 1000))).toBe(false);
    // Just over 1.2 should be true
    expect(isWideSpread(createPage(1201, 1000))).toBe(true);
  });
});

describe('haveSimilarWidths', () => {
  it('should return true for pages with same width', () => {
    const page1 = createPage(1000, 1500);
    const page2 = createPage(1000, 1400);
    expect(haveSimilarWidths(page1, page2)).toBe(true);
  });

  it('should return true for pages within 20% width difference', () => {
    const page1 = createPage(1000, 1500);
    const page2 = createPage(1200, 1500); // 20% larger
    expect(haveSimilarWidths(page1, page2)).toBe(true);

    const page3 = createPage(1000, 1500);
    const page4 = createPage(800, 1500); // 20% smaller
    expect(haveSimilarWidths(page3, page4)).toBe(true);
  });

  it('should return false for pages with > 20% width difference', () => {
    const page1 = createPage(1000, 1500);
    const page2 = createPage(1300, 1500); // 30% difference
    expect(haveSimilarWidths(page1, page2)).toBe(false);

    const page3 = createPage(1000, 1500);
    const page4 = createPage(700, 1500); // 30% smaller
    expect(haveSimilarWidths(page3, page4)).toBe(false);
  });

  it('should return false if either page is undefined', () => {
    const page = createPage(1000, 1500);
    expect(haveSimilarWidths(undefined, page)).toBe(false);
    expect(haveSimilarWidths(page, undefined)).toBe(false);
    expect(haveSimilarWidths(undefined, undefined)).toBe(false);
  });

  it('should handle edge case at 20% threshold', () => {
    // Exactly 20% difference should be similar
    const page1 = createPage(1000, 1500);
    const page2 = createPage(1250, 1500); // (1250-1000)/1250 = 0.2
    expect(haveSimilarWidths(page1, page2)).toBe(true);

    // Just over 20% should not be similar
    const page3 = createPage(1000, 1500);
    const page4 = createPage(1251, 1500); // (1251-1000)/1251 > 0.2
    expect(haveSimilarWidths(page3, page4)).toBe(false);
  });
});

describe('isPortraitOrientation', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it('should return false when window is undefined (SSR)', () => {
    // @ts-expect-error - testing undefined window for SSR
    globalThis.window = undefined;
    expect(isPortraitOrientation()).toBe(false);
  });

  it('should return true when height > width', () => {
    globalThis.window = {
      ...globalThis.window,
      innerWidth: 800,
      innerHeight: 1200
    } as Window & typeof globalThis;
    expect(isPortraitOrientation()).toBe(true);
  });

  it('should return true when height = width', () => {
    globalThis.window = {
      ...globalThis.window,
      innerWidth: 1000,
      innerHeight: 1000
    } as Window & typeof globalThis;
    expect(isPortraitOrientation()).toBe(true);
  });

  it('should return false when width > height', () => {
    globalThis.window = {
      ...globalThis.window,
      innerWidth: 1920,
      innerHeight: 1080
    } as Window & typeof globalThis;
    expect(isPortraitOrientation()).toBe(false);
  });
});

describe('shouldShowSinglePage', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    // Default to landscape orientation
    globalThis.window = {
      ...globalThis.window,
      innerWidth: 1920,
      innerHeight: 1080
    } as Window & typeof globalThis;
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  describe('explicit mode overrides', () => {
    it('should always return true for single mode', () => {
      const current = createPage(1000, 1500);
      const next = createPage(1000, 1500);
      expect(shouldShowSinglePage('single', current, next, undefined)).toBe(true);
    });

    it('should always return false for dual mode', () => {
      const current = createPage(1000, 1500);
      const next = createPage(1000, 1500);
      expect(shouldShowSinglePage('dual', current, next, undefined)).toBe(false);
    });
  });

  describe('auto mode', () => {
    it('should return true when on first page with cover', () => {
      const current = createPage(1000, 1500);
      const next = createPage(1000, 1500);
      expect(shouldShowSinglePage('auto', current, next, undefined, true, true)).toBe(true);
    });

    it('should return true in portrait orientation', () => {
      globalThis.window = {
        ...globalThis.window,
        innerWidth: 800,
        innerHeight: 1200
      } as Window & typeof globalThis;

      const current = createPage(1000, 1500);
      const next = createPage(1000, 1500);
      expect(shouldShowSinglePage('auto', current, next, undefined)).toBe(true);
    });

    it('should return true when current page is wide spread', () => {
      const current = createPage(2000, 1000); // Wide spread
      const next = createPage(1000, 1500);
      expect(shouldShowSinglePage('auto', current, next, undefined)).toBe(true);
    });

    it('should return true when next page is wide spread', () => {
      const current = createPage(1000, 1500);
      const next = createPage(2000, 1000); // Wide spread
      expect(shouldShowSinglePage('auto', current, next, undefined)).toBe(true);
    });

    it('should return false for normal portrait pages in landscape', () => {
      const current = createPage(1000, 1500);
      const next = createPage(1000, 1500);
      expect(shouldShowSinglePage('auto', current, next, undefined)).toBe(false);
    });

    it('should return true when pages have different widths', () => {
      const current = createPage(1000, 1500);
      const next = createPage(1400, 1500); // Different width (40% larger)
      expect(shouldShowSinglePage('auto', current, next, undefined)).toBe(true);
    });

    it('should return true when previous page has different width', () => {
      const previous = createPage(1500, 2000); // Different width
      const current = createPage(1000, 1500);
      const next = createPage(1000, 1500);
      expect(shouldShowSinglePage('auto', current, next, previous)).toBe(true);
    });

    it('should return false when all pages have similar widths', () => {
      const previous = createPage(1000, 1500);
      const current = createPage(1050, 1500); // Within 20%
      const next = createPage(1000, 1500);
      expect(shouldShowSinglePage('auto', current, next, previous)).toBe(false);
    });

    it('should handle undefined current page', () => {
      expect(shouldShowSinglePage('auto', undefined, undefined, undefined)).toBe(false);
    });

    it('should handle first page without cover', () => {
      const current = createPage(1000, 1500);
      const next = createPage(1000, 1500);
      // First page but no cover should follow normal auto logic
      expect(shouldShowSinglePage('auto', current, next, undefined, true, false)).toBe(false);
    });

    describe('landscape vs portrait page content', () => {
      it('should pair similar portrait pages', () => {
        const current = createPage(1000, 1500); // Portrait
        const next = createPage(1000, 1500); // Portrait
        expect(shouldShowSinglePage('auto', current, next, undefined)).toBe(false);
      });

      it('should not check width similarity for landscape page content', () => {
        // When pages themselves are landscape (not spreads - aspect ratio <= 1.2)
        const current = createPage(1100, 1000); // Landscape content (1.1 < 1.2)
        const next = createPage(900, 800); // Different width landscape (1.125 < 1.2)
        // Both are landscape content, width check only applies to portrait content
        expect(shouldShowSinglePage('auto', current, next, undefined)).toBe(false);
      });
    });
  });
});
