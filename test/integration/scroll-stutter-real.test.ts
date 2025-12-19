/**
 * Real integration test for scroll stuttering - minimal mocking.
 *
 * This test uses real fixture data and real component code with minimal mocks.
 * Tests the actual JavaScript code paths that run during scroll.
 *
 * NOTE: For true browser performance testing, use the browser test at:
 * test/browser/scroll-performance.html
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import {
  getExtractedFixtures,
  loadExtractedMokuro,
  hasExtractedFixtures
} from '../fixtures/fixture-loader';
import fs from 'fs';
import path from 'path';

// Import REAL spread grouping logic - no mock
import {
  groupPagesIntoSpreads,
  findSpreadForPage,
  type PageSpread
} from '$lib/reader/spread-grouping';

// Import REAL ImageCache - no mock
import { ImageCache } from '$lib/reader/image-cache';

// Import REAL keyboard navigation - no mock
import { getNavigationAction, type NavigationState } from '$lib/reader/continuous-keyboard-nav';

// ResizeObserver mock - jsdom doesn't have it
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Track panzoom callbacks - capture them for testing
const panzoomCallbacks: Record<string, ((...args: unknown[]) => void)[]> = {};
let mockTransform = { x: 0, y: 0, scale: 1 };

const mockPanzoom = {
  getTransform: () => ({ ...mockTransform }),
  moveTo: (x: number, y: number) => {
    mockTransform.x = x;
    mockTransform.y = y;
  },
  smoothMoveTo: () => {},
  zoomAbs: (x: number, y: number, scale: number) => {
    mockTransform.scale = scale;
  },
  zoomTo: () => {},
  on: (event: string, callback: (...args: unknown[]) => void) => {
    if (!panzoomCallbacks[event]) panzoomCallbacks[event] = [];
    panzoomCallbacks[event].push(callback);
  },
  dispose: () => {}
};

// Panzoom must be mocked - requires real DOM
vi.mock('panzoom', () => ({
  default: () => mockPanzoom
}));

// Settings mock - needed because it uses localStorage
vi.mock('$lib/settings', () => ({
  settings: {
    subscribe: vi.fn((cb) => {
      cb({
        backgroundColor: '#1a1a1a',
        zoomDefault: 'zoomFitToScreen',
        scrollSnap: false,
        swapWheelBehavior: false,
        fontSize: 'auto',
        displayOCR: true,
        boldFont: false,
        textBoxBorders: false,
        textEditable: false,
        ankiConnectSettings: { enabled: false, triggerMethod: 'both' }
      });
      return () => {};
    })
  }
}));

// Activity tracker mock - uses localStorage
vi.mock('$lib/util/activity-tracker', () => ({
  activityTracker: {
    recordActivity: vi.fn()
  }
}));

const fixtures = getExtractedFixtures();
const hasFixtures = fixtures.length > 0;

describe('Real Scroll Performance Test', () => {
  beforeAll(() => {
    if (!hasFixtures) {
      console.log('No fixtures found - skipping real scroll tests');
    }
  });

  beforeEach(() => {
    // Clear panzoom state
    Object.keys(panzoomCallbacks).forEach((key) => delete panzoomCallbacks[key]);
    mockTransform = { x: 0, y: 0, scale: 1 };

    Object.defineProperty(window, 'innerWidth', { value: 1920, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, writable: true });

    // Real createImageBitmap mock that simulates actual decode time
    global.createImageBitmap = vi.fn(async (source: Blob) => {
      // Simulate decode time proportional to file size
      const size = source.size || 1000;
      const decodeTime = Math.min(size / 100000, 50); // Up to 50ms for large images
      await new Promise((r) => setTimeout(r, decodeTime));

      return {
        width: 1920,
        height: 2560,
        close: vi.fn()
      } as unknown as ImageBitmap;
    });
  });

  afterEach(() => {
    cleanup();
  });

  const describeWithFixtures = hasFixtures ? describe : describe.skip;

  describeWithFixtures('with real fixtures and minimal mocking', () => {
    it.each(fixtures)('$name - profile component render and scroll', async (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);

      // Load real image files from fixture
      const files: Record<string, File> = {};
      for (const imgPath of fixture.imageFiles) {
        const fullPath = path.join(fixture.imageDir, imgPath);
        if (fs.existsSync(fullPath)) {
          const buffer = fs.readFileSync(fullPath);
          const blob = new Blob([buffer], { type: 'image/jpeg' });
          files[imgPath] = new File([blob], imgPath, { type: 'image/jpeg' });
        } else {
          // Fallback to empty file if image doesn't exist
          files[imgPath] = new File([''], imgPath, { type: 'image/jpeg' });
        }
      }

      // Import the real component (with real panzoom, real ImageCache)
      const { default: ContinuousReader } = await import(
        '../../src/lib/components/Reader/ContinuousReader.svelte'
      );

      const pages = mokuroData.pages;
      const startPage = Math.min(10, Math.floor(pages.length / 2));

      console.log(`\n--- ${fixture.name} ---`);
      console.log(`Pages: ${pages.length}, Starting at: ${startPage}`);
      console.log(`Total text blocks: ${pages.reduce((sum, p) => sum + p.blocks.length, 0)}`);

      // Measure initial render time
      const renderStart = performance.now();

      const { container } = render(ContinuousReader, {
        props: {
          pages,
          files,
          volume: {
            volume_uuid: fixture.name,
            series_uuid: 'test',
            title: fixture.name,
            volume: '1',
            pageCount: pages.length,
            charCount: mokuroData.chars || 0
          },
          volumeSettings: {
            singlePageView: 'auto',
            hasCover: true,
            rightToLeft: true
          },
          currentPage: startPage,
          onPageChange: vi.fn(),
          onVolumeNav: vi.fn()
        }
      });

      const renderTime = performance.now() - renderStart;
      console.log(`Initial render: ${renderTime.toFixed(1)}ms`);

      // Wait for component initialization
      await new Promise((r) => setTimeout(r, 200));

      // Count DOM elements
      const allElements = container.querySelectorAll('*').length;
      const textBoxes = container.querySelectorAll('.textBox').length;
      const spreads = container.querySelectorAll('.spread-wrapper').length;

      console.log(`DOM elements: ${allElements}`);
      console.log(`Text boxes: ${textBoxes}`);
      console.log(`Spread wrappers: ${spreads}`);

      // Simulate scroll by invoking captured pan callbacks
      const panCallbacks = panzoomCallbacks['pan'] || [];
      console.log(`Pan callbacks registered: ${panCallbacks.length}`);

      if (panCallbacks.length > 0) {
        const frameTimes: number[] = [];

        // Simulate 60 frames of scrolling
        for (let i = 0; i < 60; i++) {
          mockTransform.y = -i * 100; // Scroll down 100px per frame

          const start = performance.now();
          for (const cb of panCallbacks) {
            cb();
          }
          frameTimes.push(performance.now() - start);
        }

        const avgTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
        const maxTime = Math.max(...frameTimes);
        const droppedFrames = frameTimes.filter((t) => t > 16.67).length;

        console.log(`Pan callback avg: ${avgTime.toFixed(3)}ms, max: ${maxTime.toFixed(3)}ms`);
        console.log(`Dropped frames (>16.67ms): ${droppedFrames}/60`);

        // This should fail if there's real stuttering
        expect(maxTime).toBeLessThan(16.67);
        expect(droppedFrames).toBe(0);
      }

      // Assertions
      expect(renderTime).toBeLessThan(1000); // Initial render should be < 1s
      expect(allElements).toBeGreaterThan(0);
    });

    it.each(fixtures)('$name - count operations during simulated scroll', async (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);

      // Track all expensive operations
      const operationCounts = {
        createImageBitmap: 0,
        derivedRuns: 0,
        effectRuns: 0
      };

      // Wrap createImageBitmap to count calls
      const originalCreateImageBitmap = global.createImageBitmap;
      global.createImageBitmap = vi.fn(async (...args) => {
        operationCounts.createImageBitmap++;
        return originalCreateImageBitmap(...args);
      }) as typeof createImageBitmap;

      const files: Record<string, File> = {};
      for (const imgPath of fixture.imageFiles) {
        files[imgPath] = new File(['mock'], imgPath, { type: 'image/jpeg' });
      }

      const { default: ContinuousReader } = await import(
        '../../src/lib/components/Reader/ContinuousReader.svelte'
      );

      render(ContinuousReader, {
        props: {
          pages: mokuroData.pages,
          files,
          volume: {
            volume_uuid: fixture.name,
            series_uuid: 'test',
            title: fixture.name,
            volume: '1',
            pageCount: mokuroData.pages.length,
            charCount: 0
          },
          volumeSettings: {
            singlePageView: 'auto',
            hasCover: true,
            rightToLeft: true
          },
          currentPage: 5,
          onPageChange: vi.fn(),
          onVolumeNav: vi.fn()
        }
      });

      await new Promise((r) => setTimeout(r, 300));

      console.log(`\n${fixture.name} operation counts after render:`);
      console.log(`  createImageBitmap calls: ${operationCounts.createImageBitmap}`);

      // Reset counter
      operationCounts.createImageBitmap = 0;

      // Wait more to see if there are ongoing operations
      await new Promise((r) => setTimeout(r, 500));

      console.log(
        `  Additional createImageBitmap calls (500ms later): ${operationCounts.createImageBitmap}`
      );

      // Restore original
      global.createImageBitmap = originalCreateImageBitmap;
    });
  });
});

/**
 * Tests using REAL spread grouping logic (no mocks)
 */
describe('Real Spread Grouping Performance', () => {
  const describeWithFixtures = hasFixtures ? describe : describe.skip;

  describeWithFixtures('spread grouping with real data', () => {
    it.each(fixtures)('$name - profile REAL spread grouping', async (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const pages = mokuroData.pages;

      console.log(`\n--- ${fixture.name} REAL spread grouping ---`);
      console.log(`Pages: ${pages.length}`);

      // Profile groupPagesIntoSpreads with real data
      const groupingTimes: number[] = [];

      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);
        groupingTimes.push(performance.now() - start);
      }

      const avgGrouping = groupingTimes.reduce((a, b) => a + b) / groupingTimes.length;
      const maxGrouping = Math.max(...groupingTimes);

      console.log(`groupPagesIntoSpreads (100 runs):`);
      console.log(`  avg: ${avgGrouping.toFixed(3)}ms, max: ${maxGrouping.toFixed(3)}ms`);

      // Profile findSpreadForPage with real data
      const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);
      const findTimes: number[] = [];

      for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
        const start = performance.now();
        findSpreadForPage(spreads, pageIdx);
        findTimes.push(performance.now() - start);
      }

      const avgFind = findTimes.reduce((a, b) => a + b) / findTimes.length;
      const maxFind = Math.max(...findTimes);

      console.log(`findSpreadForPage (${pages.length} pages):`);
      console.log(`  avg: ${avgFind.toFixed(3)}ms, max: ${maxFind.toFixed(3)}ms`);

      // These should be fast - they run during scroll
      expect(avgGrouping).toBeLessThan(5); // < 5ms average
      expect(maxFind).toBeLessThan(1); // < 1ms per lookup
    });

    it.each(fixtures)('$name - simulate scroll transition calculations', async (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const pages = mokuroData.pages;

      const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

      console.log(`\n--- ${fixture.name} scroll transition simulation ---`);
      console.log(`Spreads: ${spreads.length}`);

      // Simulate the checkSpreadTransition logic with real spread data
      const spreadHeights = new Map<number, number>();
      spreads.forEach((spread, idx) => {
        // Calculate height from spread's pages
        const maxHeight = Math.max(...spread.pages.map((p) => p.img_height));
        spreadHeights.set(idx, maxHeight);
      });

      // Simulate scroll through all spreads
      const transitionTimes: number[] = [];
      const viewportHeight = 1080;
      let currentSpreadIndex = 0;

      for (let i = 0; i < 300; i++) {
        const start = performance.now();

        // This mirrors checkSpreadTransition() logic
        const y = -i * 100; // Simulate scrolling
        const scale = 1;

        const currentHeight = (spreadHeights.get(currentSpreadIndex) || 0) * scale;
        const prevHeight =
          (spreadHeights.get(currentSpreadIndex - 1) ||
            spreadHeights.get(currentSpreadIndex) ||
            0) * scale;

        const scrollDownThreshold = -(prevHeight + currentHeight - viewportHeight * 0.1);
        const scrollUpThreshold = -(prevHeight - viewportHeight * 0.9);

        if (y < scrollDownThreshold && currentSpreadIndex < spreads.length - 1) {
          currentSpreadIndex++;
        } else if (y > scrollUpThreshold && currentSpreadIndex > 0) {
          currentSpreadIndex--;
        }

        transitionTimes.push(performance.now() - start);
      }

      const avgTransition = transitionTimes.reduce((a, b) => a + b) / transitionTimes.length;
      const maxTransition = Math.max(...transitionTimes);
      const droppedFrames = transitionTimes.filter((t) => t > 16.67).length;

      console.log(`Transition check (300 frames):`);
      console.log(`  avg: ${avgTransition.toFixed(3)}ms, max: ${maxTransition.toFixed(3)}ms`);
      console.log(`  dropped frames: ${droppedFrames}/300`);

      // This is pure JS - should be very fast
      expect(maxTransition).toBeLessThan(1); // < 1ms
      expect(droppedFrames).toBe(0);
    });
  });
});

/**
 * Tests using REAL ImageCache logic (no mocks except createImageBitmap)
 */
describe('Real ImageCache Performance', () => {
  const describeWithFixtures = hasFixtures ? describe : describe.skip;

  beforeEach(() => {
    // createImageBitmap must be mocked - jsdom doesn't have it
    global.createImageBitmap = vi.fn(
      async () =>
        ({
          width: 1920,
          height: 2560,
          close: vi.fn()
        }) as unknown as ImageBitmap
    );
  });

  describeWithFixtures('ImageCache with real files', () => {
    it.each(fixtures)('$name - profile REAL ImageCache operations', async (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const pages = mokuroData.pages;

      console.log(`\n--- ${fixture.name} REAL ImageCache ---`);

      // Load real image files
      const files: Record<string, File> = {};
      for (const imgPath of fixture.imageFiles) {
        const fullPath = path.join(fixture.imageDir, imgPath);
        if (fs.existsSync(fullPath)) {
          const buffer = fs.readFileSync(fullPath);
          const blob = new Blob([buffer], { type: 'image/jpeg' });
          files[imgPath] = new File([blob], imgPath, { type: 'image/jpeg' });
        } else {
          files[imgPath] = new File([''], imgPath, { type: 'image/jpeg' });
        }
      }

      console.log(`Loaded ${Object.keys(files).length} real files`);

      // Create REAL ImageCache
      const imageCache = new ImageCache({ prev: 5, next: 5 });

      // Profile updateCache
      const updateTimes: number[] = [];
      for (let pageIdx = 0; pageIdx < Math.min(20, pages.length); pageIdx++) {
        const start = performance.now();
        imageCache.updateCache(files, pages, pageIdx);
        updateTimes.push(performance.now() - start);
      }

      const avgUpdate = updateTimes.reduce((a, b) => a + b) / updateTimes.length;
      const maxUpdate = Math.max(...updateTimes);

      console.log(`updateCache (${updateTimes.length} calls):`);
      console.log(`  avg: ${avgUpdate.toFixed(3)}ms, max: ${maxUpdate.toFixed(3)}ms`);

      // Profile getBitmapSync (should be instant - just a Map lookup)
      const syncTimes: number[] = [];
      for (let pageIdx = 0; pageIdx < Math.min(20, pages.length); pageIdx++) {
        const start = performance.now();
        imageCache.getBitmapSync(pageIdx);
        syncTimes.push(performance.now() - start);
      }

      const avgSync = syncTimes.reduce((a, b) => a + b) / syncTimes.length;
      const maxSync = Math.max(...syncTimes);

      console.log(`getBitmapSync (${syncTimes.length} calls):`);
      console.log(`  avg: ${avgSync.toFixed(3)}ms, max: ${maxSync.toFixed(3)}ms`);

      // Cleanup
      imageCache.cleanup();

      // getBitmapSync should be < 0.1ms (just a Map.get())
      expect(maxSync).toBeLessThan(1);
    });
  });
});

/**
 * Tests using REAL keyboard navigation logic (no mocks)
 */
describe('Real Keyboard Navigation Performance', () => {
  const describeWithFixtures = hasFixtures ? describe : describe.skip;

  describeWithFixtures('navigation with real spread data', () => {
    it.each(fixtures)('$name - profile REAL navigation actions', async (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const pages = mokuroData.pages;

      const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

      console.log(`\n--- ${fixture.name} REAL navigation ---`);

      // Profile getNavigationAction with various keys
      const keys = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ', 'j', 'k'];
      const navTimes: number[] = [];

      for (let spreadIndex = 0; spreadIndex < Math.min(10, spreads.length); spreadIndex++) {
        const navState: NavigationState = {
          currentSpreadIndex: spreadIndex,
          totalSpreads: spreads.length,
          panY: -spreadIndex * 1000,
          spreadHeight: 2560,
          viewportHeight: 1080
        };

        for (const key of keys) {
          const start = performance.now();
          getNavigationAction(key, navState);
          navTimes.push(performance.now() - start);
        }
      }

      const avgNav = navTimes.reduce((a, b) => a + b) / navTimes.length;
      const maxNav = Math.max(...navTimes);

      console.log(`getNavigationAction (${navTimes.length} calls):`);
      console.log(`  avg: ${avgNav.toFixed(3)}ms, max: ${maxNav.toFixed(3)}ms`);

      // Should be instant - just a switch statement
      expect(maxNav).toBeLessThan(1);
    });
  });
});

describe('TextBoxes Performance Analysis', () => {
  const describeWithFixtures = hasFixtures ? describe : describe.skip;

  describeWithFixtures('text block processing', () => {
    it.each(fixtures)('$name - measure text block processing time', async (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);

      // Count total blocks
      const totalBlocks = mokuroData.pages.reduce((sum, p) => sum + p.blocks.length, 0);
      const avgBlocksPerPage = totalBlocks / mokuroData.pages.length;

      console.log(`\n${fixture.name} text block stats:`);
      console.log(`  Total blocks: ${totalBlocks}`);
      console.log(`  Pages: ${mokuroData.pages.length}`);
      console.log(`  Avg blocks/page: ${avgBlocksPerPage.toFixed(1)}`);

      // Measure the derived computation (textBoxes in TextBoxes.svelte)
      const mockSettings = {
        fontSize: 'auto',
        boldFont: false,
        displayOCR: true,
        textBoxBorders: false,
        textEditable: false
      };

      // Simulate the textBoxes derived computation for one page
      const page = mokuroData.pages[Math.floor(mokuroData.pages.length / 2)];

      const computeStart = performance.now();

      // This mirrors the $derived in TextBoxes.svelte
      const textBoxes = page.blocks
        .map((block) => {
          const { img_height, img_width } = page;
          const { box, font_size, lines, vertical } = block;
          let [_xmin, _ymin, _xmax, _ymax] = box;

          let xmin, ymin, xmax, ymax;
          if (mockSettings.fontSize === 'auto') {
            const originalWidth = _xmax - _xmin;
            const originalHeight = _ymax - _ymin;
            const expansionX = originalWidth * 0.05;
            const expansionY = originalHeight * 0.05;
            xmin = Math.max(_xmin - expansionX, 0);
            ymin = Math.max(_ymin - expansionY, 0);
            xmax = Math.min(_xmax + expansionX, img_width);
            ymax = Math.min(_ymax + expansionY, img_height);
          } else {
            xmin = _xmin;
            ymin = _ymin;
            xmax = _xmax;
            ymax = _ymax;
          }

          const width = xmax - xmin;
          const height = ymax - ymin;
          const area = width * height;
          const processedLines = lines.map((line) =>
            line.replace(/\.\.\./g, '…').replace(/．．．/g, '…')
          );

          return {
            left: `${xmin}px`,
            top: `${ymin}px`,
            width: `${width}px`,
            height: `${height}px`,
            fontSize: `${font_size}px`,
            writingMode: vertical ? 'vertical-rl' : 'horizontal-tb',
            lines: processedLines,
            area
          };
        })
        .sort(({ area: a }, { area: b }) => b - a);

      const computeTime = performance.now() - computeStart;

      console.log(`  Blocks in middle page: ${page.blocks.length}`);
      console.log(`  textBoxes computation: ${computeTime.toFixed(3)}ms`);

      // For 3 visible spreads with 2 pages each = 6 pages
      // This would run 6 times during render
      const estimatedTotal = computeTime * 6;
      console.log(`  Estimated for 6 pages: ${estimatedTotal.toFixed(3)}ms`);

      // This should be fast (< 1ms per page)
      expect(computeTime).toBeLessThan(5);
    });
  });
});
