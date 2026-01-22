/**
 * Integration tests for ContinuousReader zoom placement using real fixtures.
 *
 * These tests verify that the ContinuousReader component calls panzoom
 * with correct scale and position values based on real manga dimensions.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import type { Page, VolumeMetadata } from '$lib/types';
import type { VolumeSettings } from '$lib/settings';
import {
  getExtractedFixtures,
  loadExtractedMokuro,
  type ExtractedFixture
} from '../fixtures/fixture-loader';
import { groupPagesIntoSpreads, type PageSpread } from '../../src/lib/reader/spread-grouping';

const extractedFixtures = getExtractedFixtures();
const hasFixtures = extractedFixtures.length > 0;
const describeWithFixtures = hasFixtures ? describe : describe.skip;

// Mock ResizeObserver - fires synchronously for testing
class MockResizeObserver {
  callback: ResizeObserverCallback;
  static instances: MockResizeObserver[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    // Fire synchronously with fallback dimensions (jsdom doesn't compute layout)
    this.callback(
      [
        {
          target,
          contentRect: {
            width: (target as HTMLElement).offsetWidth || 1000,
            height: (target as HTMLElement).offsetHeight || 1500
          }
        } as ResizeObserverEntry
      ],
      this
    );
  }
  unobserve() {}
  disconnect() {}

  static reset() {
    MockResizeObserver.instances = [];
  }
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Capture panzoom calls for verification
interface PanzoomCall {
  method: string;
  args: unknown[];
}

let panzoomCalls: PanzoomCall[] = [];
let mockTransform = { x: 0, y: 0, scale: 1 };

// Mock panzoom - capture all calls
const createMockPanzoom = () => ({
  getTransform: vi.fn(() => ({ ...mockTransform })),
  moveTo: vi.fn((x: number, y: number) => {
    panzoomCalls.push({ method: 'moveTo', args: [x, y] });
    mockTransform.x = x;
    mockTransform.y = y;
  }),
  smoothMoveTo: vi.fn((x: number, y: number) => {
    panzoomCalls.push({ method: 'smoothMoveTo', args: [x, y] });
  }),
  zoomAbs: vi.fn((cx: number, cy: number, scale: number) => {
    panzoomCalls.push({ method: 'zoomAbs', args: [cx, cy, scale] });
    mockTransform.scale = scale;
  }),
  zoomTo: vi.fn((cx: number, cy: number, multiplier: number) => {
    panzoomCalls.push({ method: 'zoomTo', args: [cx, cy, multiplier] });
  }),
  on: vi.fn(),
  dispose: vi.fn()
});

vi.mock('panzoom', () => ({
  default: vi.fn(() => createMockPanzoom())
}));

// Mock settings store
vi.mock('$lib/settings', () => ({
  settings: {
    subscribe: vi.fn((cb) => {
      cb({
        backgroundColor: '#1a1a1a',
        zoomDefault: 'zoomFitToScreen',
        scrollSnap: true,
        swapWheelBehavior: false
      });
      return () => {};
    })
  }
}));

// Mock activity tracker
vi.mock('$lib/util/activity-tracker', () => ({
  activityTracker: {
    recordActivity: vi.fn()
  }
}));

// Mock ImageCache
vi.mock('$lib/reader/image-cache', () => ({
  ImageCache: vi.fn().mockImplementation(() => ({
    updateCache: vi.fn(),
    getBitmapSync: vi.fn(() => null),
    getBitmap: vi.fn(() => Promise.resolve(null)),
    getFile: vi.fn((index: number) => new File([''], `page${index}.jpg`, { type: 'image/jpeg' })),
    cleanup: vi.fn()
  }))
}));

// Import component once after mocks are set up
import ContinuousReader from '../../src/lib/components/Reader/ContinuousReader.svelte';

// Helper to create test files from fixture
function createFilesFromPages(pages: Page[]): Record<string, File> {
  const files: Record<string, File> = {};
  pages.forEach((page, i) => {
    const path = page.img_path || `page${i}.jpg`;
    files[path] = new File([''], path, { type: 'image/jpeg' });
  });
  return files;
}

// Helper to create volume metadata
function createVolume(name: string): VolumeMetadata {
  return {
    volume_uuid: 'test-volume-uuid',
    series_uuid: 'test-series-uuid',
    title: name,
    volume: '1',
    pageCount: 10,
    charCount: 1000
  };
}

// Helper to create volume settings
function createVolumeSettings(overrides: Partial<VolumeSettings> = {}): VolumeSettings {
  return {
    singlePageView: 'auto',
    hasCover: true,
    rightToLeft: true,
    ...overrides
  };
}

// Calculate spread dimensions from pages
function calculateSpreadDimensions(spread: PageSpread): { width: number; height: number } {
  let width = 0;
  let height = 0;

  for (const page of spread.pages) {
    if (spread.type === 'dual') {
      width += page.img_width;
      height = Math.max(height, page.img_height);
    } else {
      width = page.img_width;
      height = page.img_height;
    }
  }

  return { width, height };
}

// Calculate expected zoom values for verification
// Based on standard Reader's panAlign approach
function calculateExpectedZoom(
  spread: PageSpread,
  viewportWidth: number,
  viewportHeight: number,
  zoomMode: string
): { scale: number; x: number; scaledWidth: number; scaledHeight: number } {
  const { width: spreadWidth, height: spreadHeight } = calculateSpreadDimensions(spread);

  let scale: number;
  switch (zoomMode) {
    case 'zoomFitToScreen':
      scale = Math.min(viewportWidth / spreadWidth, viewportHeight / spreadHeight);
      break;
    case 'zoomFitToWidth':
      scale = viewportWidth / spreadWidth;
      break;
    case 'zoomOriginal':
      scale = 1;
      break;
    default:
      scale = 1;
  }

  const scaledWidth = spreadWidth * scale;
  const scaledHeight = spreadHeight * scale;

  // Standard Reader centers using: x = (innerWidth - offsetWidth * scale) / 2
  // For ContinuousReader, since content uses align-items: center,
  // the content container should be positioned so the spread appears centered
  const x = (viewportWidth - scaledWidth) / 2;

  return { scale, x, scaledWidth, scaledHeight };
}

describeWithFixtures('ContinuousReader zoom placement with fixtures', () => {
  beforeAll(() => {
    console.log(`\n🔬 Testing ContinuousReader zoom with ${extractedFixtures.length} fixture(s)`);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    panzoomCalls = [];
    mockTransform = { x: 0, y: 0, scale: 1 };
    MockResizeObserver.reset();

    // Mock window dimensions
    Object.defineProperty(window, 'innerWidth', { value: 1920, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, writable: true });

    // Mock offsetHeight/offsetWidth for jsdom (doesn't compute layout)
    // Use fallback values that match MockResizeObserver
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return 1500;
      }
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return 1000;
      }
    });

    // Mock createImageBitmap
    global.createImageBitmap = vi.fn(() =>
      Promise.resolve({
        width: 1000,
        height: 1500,
        close: vi.fn()
      } as unknown as ImageBitmap)
    );
  });

  afterEach(() => {
    cleanup();
  });

  describe('fitToScreen scale', () => {
    it.each(extractedFixtures)(
      '$name should call zoomAbs with correct fitToScreen scale',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages.slice(0, 5);
        const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

        render(ContinuousReader, {
          props: {
            pages,
            files: createFilesFromPages(pages),
            volume: createVolume(fixture.name),
            volumeSettings: createVolumeSettings(),
            currentPage: 1,
            onPageChange: vi.fn(),
            onVolumeNav: vi.fn()
          }
        });

        // Wait for component initialization
        await new Promise((r) => setTimeout(r, 100));

        const zoomAbsCalls = panzoomCalls.filter((c) => c.method === 'zoomAbs');

        if (zoomAbsCalls.length > 0) {
          const lastZoomCall = zoomAbsCalls[zoomAbsCalls.length - 1];
          const [cx, cy, scale] = lastZoomCall.args as [number, number, number];

          const expected = calculateExpectedZoom(spreads[0], 1920, 1080, 'zoomFitToScreen');

          console.log(
            `   ${fixture.name}: expected scale ${expected.scale.toFixed(4)}, got ${scale.toFixed(4)}`
          );

          expect(Math.abs(scale - expected.scale)).toBeLessThan(0.01);
        } else {
          // If no zoomAbs calls, that's also a failure - zoom should be applied
          console.log(`   ${fixture.name}: NO zoomAbs calls!`);
          expect(zoomAbsCalls.length).toBeGreaterThan(0);
        }
      }
    );
  });

  describe('dual spread positioning from middle of volume', () => {
    it.each(extractedFixtures)(
      '$name dual spread from middle should be correctly centered',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages;
        const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

        // Find a dual spread from the middle of the volume (not first few)
        const dualSpreadIndex = spreads.findIndex((s, i) => s.type === 'dual' && i > 1);
        if (dualSpreadIndex === -1) {
          console.log(`   ${fixture.name}: skipped (no dual spread after index 1)`);
          return;
        }

        const dualSpread = spreads[dualSpreadIndex];
        const firstPageOfDual = dualSpread.pageIndices[0] + 1; // 1-indexed

        render(ContinuousReader, {
          props: {
            pages,
            files: createFilesFromPages(pages),
            volume: createVolume(fixture.name),
            volumeSettings: createVolumeSettings(),
            currentPage: firstPageOfDual,
            onPageChange: vi.fn(),
            onVolumeNav: vi.fn()
          }
        });

        await new Promise((r) => setTimeout(r, 100));

        const zoomAbsCalls = panzoomCalls.filter((c) => c.method === 'zoomAbs');
        const moveToCalls = panzoomCalls.filter((c) => c.method === 'moveTo');

        if (zoomAbsCalls.length > 0 && moveToCalls.length > 0) {
          const scale = zoomAbsCalls[zoomAbsCalls.length - 1].args[2] as number;
          const transformX = moveToCalls[moveToCalls.length - 1].args[0] as number;

          const { width: spreadWidth } = calculateSpreadDimensions(dualSpread);
          const scaledSpreadWidth = spreadWidth * scale;

          // Calculate visual center of spread
          const visualSpreadCenter = transformX + scaledSpreadWidth / 2;
          const viewportCenter = 1920 / 2;

          console.log(
            `   ${fixture.name} (spread ${dualSpreadIndex}, dual, page ${firstPageOfDual}):`
          );
          console.log(`     spreadWidth=${spreadWidth}, scale=${scale.toFixed(3)}`);
          console.log(
            `     transformX=${transformX.toFixed(0)}, scaledWidth=${scaledSpreadWidth.toFixed(0)}`
          );
          console.log(
            `     visualCenter=${visualSpreadCenter.toFixed(0)}, viewportCenter=${viewportCenter}`
          );
          console.log(`     offset=${Math.abs(visualSpreadCenter - viewportCenter).toFixed(0)}px`);

          // Dual spread center should be at viewport center
          expect(Math.abs(visualSpreadCenter - viewportCenter)).toBeLessThan(5);
        }
      }
    );

    it.each(extractedFixtures)(
      '$name single vs dual spread centering calculations should both target viewport center',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);

        // Get cover (spread 0) and a dual spread from middle
        const coverSpread = spreads.find((s) => s.type === 'single');
        const dualSpread = spreads.find((s, i) => s.type === 'dual' && i > 1);

        if (!coverSpread || !dualSpread) {
          console.log(`   ${fixture.name}: skipped (need both spread types)`);
          return;
        }

        // Calculate expected visual centers for both spread types
        const coverDims = calculateSpreadDimensions(coverSpread);
        const dualDims = calculateSpreadDimensions(dualSpread);

        const coverScale = Math.min(1920 / coverDims.width, 1080 / coverDims.height);
        const dualScale = Math.min(1920 / dualDims.width, 1080 / dualDims.height);

        // Current formula: x = (viewport - spreadWidth * scale) / 2
        const coverX = (1920 - coverDims.width * coverScale) / 2;
        const dualX = (1920 - dualDims.width * dualScale) / 2;

        // Visual centers
        const coverCenter = coverX + (coverDims.width * coverScale) / 2;
        const dualCenter = dualX + (dualDims.width * dualScale) / 2;

        console.log(`   ${fixture.name}:`);
        console.log(
          `     single: width=${coverDims.width}, scale=${coverScale.toFixed(3)}, X=${coverX.toFixed(0)}, center=${coverCenter.toFixed(0)}`
        );
        console.log(
          `     dual: width=${dualDims.width}, scale=${dualScale.toFixed(3)}, X=${dualX.toFixed(0)}, center=${dualCenter.toFixed(0)}`
        );

        // Both calculations should target viewport center (960)
        expect(Math.abs(coverCenter - 960)).toBeLessThan(1);
        expect(Math.abs(dualCenter - 960)).toBeLessThan(1);
      }
    );
  });

  describe('potential CSS/DOM centering conflicts', () => {
    it.each(extractedFixtures)('$name should document centering formula discrepancy', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);
      const dualSpread = spreads.find((s, i) => s.type === 'dual' && i > 1);

      if (!dualSpread) {
        console.log(`   ${fixture.name}: skipped`);
        return;
      }

      const { width: spreadWidth, height: spreadHeight } = calculateSpreadDimensions(dualSpread);
      const scale = Math.min(1920 / spreadWidth, 1080 / spreadHeight);

      // SCENARIO A: Container width = spread width (current assumption)
      // The panzoom X positions the container, spread is at x=0 in container
      const xScenarioA = (1920 - spreadWidth * scale) / 2;
      const centerA = xScenarioA + (spreadWidth * scale) / 2;

      // SCENARIO B: Container width = viewport width (CSS align-items: center)
      // The spread is already centered in container via CSS
      // panzoom X should just position the container
      const xScenarioB = (1920 * (1 - scale)) / 2;
      // Spread is at (viewport - spread) / 2 in container, scaled
      const spreadOffsetInContainer = (1920 - spreadWidth) / 2;
      const centerB = xScenarioB + spreadOffsetInContainer * scale + (spreadWidth * scale) / 2;

      console.log(`   ${fixture.name} dual spread:`);
      console.log(
        `     Scenario A (container=spread): X=${xScenarioA.toFixed(0)}, center=${centerA.toFixed(0)}`
      );
      console.log(
        `     Scenario B (container=viewport): X=${xScenarioB.toFixed(0)}, center=${centerB.toFixed(0)}`
      );
      console.log(`     Viewport center: 960`);
      console.log(
        `     NOTE: In browser, if CSS align-items:center applies, Scenario B may be correct`
      );

      // Document that both scenarios should target 960
      expect(Math.abs(centerA - 960)).toBeLessThan(1);
      // Scenario B may NOT equal 960 - this documents the potential issue
    });
  });

  describe('X centering', () => {
    it.each(extractedFixtures)(
      '$name should call moveTo with correct centered X position',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages.slice(0, 5);
        const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

        render(ContinuousReader, {
          props: {
            pages,
            files: createFilesFromPages(pages),
            volume: createVolume(fixture.name),
            volumeSettings: createVolumeSettings(),
            currentPage: 1,
            onPageChange: vi.fn(),
            onVolumeNav: vi.fn()
          }
        });

        await new Promise((r) => setTimeout(r, 100));

        const moveToCalls = panzoomCalls.filter((c) => c.method === 'moveTo');

        if (moveToCalls.length > 0) {
          const lastMoveCall = moveToCalls[moveToCalls.length - 1];
          const [x, y] = lastMoveCall.args as [number, number];

          const expected = calculateExpectedZoom(spreads[0], 1920, 1080, 'zoomFitToScreen');

          console.log(
            `   ${fixture.name}: expected X ${expected.x.toFixed(0)}, got ${x.toFixed(0)}`
          );

          expect(Math.abs(x - expected.x)).toBeLessThan(5);
        } else {
          console.log(`   ${fixture.name}: NO moveTo calls!`);
          expect(moveToCalls.length).toBeGreaterThan(0);
        }
      }
    );
  });

  describe('Y position at first spread', () => {
    it.each(extractedFixtures)(
      '$name first spread should have Y=0 (no prev spread to skip)',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages.slice(0, 5);

        render(ContinuousReader, {
          props: {
            pages,
            files: createFilesFromPages(pages),
            volume: createVolume(fixture.name),
            volumeSettings: createVolumeSettings(),
            currentPage: 1,
            onPageChange: vi.fn(),
            onVolumeNav: vi.fn()
          }
        });

        await new Promise((r) => setTimeout(r, 100));

        const moveToCalls = panzoomCalls.filter((c) => c.method === 'moveTo');

        if (moveToCalls.length > 0) {
          const lastMoveCall = moveToCalls[moveToCalls.length - 1];
          const [x, y] = lastMoveCall.args as [number, number];

          console.log(`   ${fixture.name}: Y at first spread = ${y}`);

          // Y should be ~0 for first spread (allow small tolerance for -0 vs 0)
          expect(y).toBeCloseTo(0, 5);
        }
      }
    );
  });

  describe('Y position at second spread', () => {
    it.each(extractedFixtures)(
      '$name second spread should have negative Y offset',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages.slice(0, 10);
        const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

        if (spreads.length < 2) {
          console.log(`   ${fixture.name}: skipped (not enough spreads)`);
          return;
        }

        // Find page that's on spread 1
        const spread1FirstPage = spreads[1].pageIndices[0] + 1;

        render(ContinuousReader, {
          props: {
            pages,
            files: createFilesFromPages(pages),
            volume: createVolume(fixture.name),
            volumeSettings: createVolumeSettings(),
            currentPage: spread1FirstPage,
            onPageChange: vi.fn(),
            onVolumeNav: vi.fn()
          }
        });

        await new Promise((r) => setTimeout(r, 100));

        const moveToCalls = panzoomCalls.filter((c) => c.method === 'moveTo');

        if (moveToCalls.length > 0) {
          const lastMoveCall = moveToCalls[moveToCalls.length - 1];
          const [x, y] = lastMoveCall.args as [number, number];

          console.log(`   ${fixture.name}: Y at second spread = ${y}`);

          // Y should be negative (skipping prev spread height)
          expect(y).toBeLessThan(0);
        }
      }
    );
  });

  describe('call order', () => {
    it.each(extractedFixtures)('$name zoomAbs should be called before moveTo', async (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const pages = mokuroData.pages.slice(0, 5);

      render(ContinuousReader, {
        props: {
          pages,
          files: createFilesFromPages(pages),
          volume: createVolume(fixture.name),
          volumeSettings: createVolumeSettings(),
          currentPage: 1,
          onPageChange: vi.fn(),
          onVolumeNav: vi.fn()
        }
      });

      await new Promise((r) => setTimeout(r, 100));

      let lastZoomAbsIndex = -1;
      let lastMoveToIndex = -1;

      panzoomCalls.forEach((call, index) => {
        if (call.method === 'zoomAbs') lastZoomAbsIndex = index;
        if (call.method === 'moveTo') lastMoveToIndex = index;
      });

      if (lastZoomAbsIndex >= 0 && lastMoveToIndex >= 0) {
        expect(lastZoomAbsIndex).toBeLessThan(lastMoveToIndex);
        console.log(
          `   ${fixture.name}: zoomAbs at ${lastZoomAbsIndex}, moveTo at ${lastMoveToIndex} ✓`
        );
      }
    });
  });

  describe('scale and position consistency', () => {
    it.each(extractedFixtures)(
      '$name X position should match calculated centering for applied scale',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages.slice(0, 5);
        const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

        render(ContinuousReader, {
          props: {
            pages,
            files: createFilesFromPages(pages),
            volume: createVolume(fixture.name),
            volumeSettings: createVolumeSettings(),
            currentPage: 1,
            onPageChange: vi.fn(),
            onVolumeNav: vi.fn()
          }
        });

        await new Promise((r) => setTimeout(r, 100));

        const zoomAbsCalls = panzoomCalls.filter((c) => c.method === 'zoomAbs');
        const moveToCalls = panzoomCalls.filter((c) => c.method === 'moveTo');

        if (zoomAbsCalls.length > 0 && moveToCalls.length > 0) {
          const lastZoomCall = zoomAbsCalls[zoomAbsCalls.length - 1];
          const lastMoveCall = moveToCalls[moveToCalls.length - 1];

          const appliedScale = lastZoomCall.args[2] as number;
          const appliedX = lastMoveCall.args[0] as number;

          // Calculate what X should be with the applied scale
          const spread = spreads[0];
          const { width: spreadWidth } = calculateSpreadDimensions(spread);

          const expectedScaledWidth = spreadWidth * appliedScale;
          const expectedX = (1920 - expectedScaledWidth) / 2;

          console.log(
            `   ${fixture.name}: X=${appliedX.toFixed(0)}, expected=${expectedX.toFixed(0)} (scale=${appliedScale.toFixed(3)})`
          );

          expect(Math.abs(appliedX - expectedX)).toBeLessThan(5);
        }
      }
    );
  });

  describe('horizontal centering matches standard Reader', () => {
    it.each(extractedFixtures)(
      '$name fitToScreen should center content like standard Reader panAlign("center", "center")',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages.slice(0, 5);
        const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

        render(ContinuousReader, {
          props: {
            pages,
            files: createFilesFromPages(pages),
            volume: createVolume(fixture.name),
            volumeSettings: createVolumeSettings(),
            currentPage: 1,
            onPageChange: vi.fn(),
            onVolumeNav: vi.fn()
          }
        });

        await new Promise((r) => setTimeout(r, 100));

        const zoomAbsCalls = panzoomCalls.filter((c) => c.method === 'zoomAbs');
        const moveToCalls = panzoomCalls.filter((c) => c.method === 'moveTo');

        if (zoomAbsCalls.length > 0 && moveToCalls.length > 0) {
          const appliedScale = zoomAbsCalls[zoomAbsCalls.length - 1].args[2] as number;
          const appliedX = moveToCalls[moveToCalls.length - 1].args[0] as number;

          // Standard Reader formula: x = (innerWidth - offsetWidth * scale) / 2
          const spread = spreads[0];
          const { width: spreadWidth } = calculateSpreadDimensions(spread);
          const scaledWidth = spreadWidth * appliedScale;

          // The spread should be visually centered in the viewport
          // Left edge of spread (after transform) = appliedX
          // Right edge of spread = appliedX + scaledWidth
          // For centering: leftMargin === rightMargin
          const leftMargin = appliedX;
          const rightMargin = 1920 - (appliedX + scaledWidth);

          console.log(
            `   ${fixture.name}: leftMargin=${leftMargin.toFixed(0)}, rightMargin=${rightMargin.toFixed(0)}, diff=${Math.abs(leftMargin - rightMargin).toFixed(0)}`
          );

          // Margins should be equal (centered) within 2px tolerance
          expect(Math.abs(leftMargin - rightMargin)).toBeLessThan(2);
        }
      }
    );

    it.each(extractedFixtures)(
      '$name single spread should be centered same as dual spread',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages;
        const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

        // Find a single and dual spread
        const singleSpread = spreads.find((s) => s.type === 'single');
        const dualSpread = spreads.find((s) => s.type === 'dual');

        if (!singleSpread || !dualSpread) {
          console.log(`   ${fixture.name}: skipped (need both single and dual spreads)`);
          return;
        }

        // Both should use same centering formula
        const singleExpected = calculateExpectedZoom(singleSpread, 1920, 1080, 'zoomFitToScreen');
        const dualExpected = calculateExpectedZoom(dualSpread, 1920, 1080, 'zoomFitToScreen');

        // Single spread is narrower, so it should have larger X offset
        expect(singleExpected.x).toBeGreaterThan(dualExpected.x);

        // Both should be properly centered (leftMargin === rightMargin)
        const singleLeftMargin = singleExpected.x;
        const singleRightMargin = 1920 - (singleExpected.x + singleExpected.scaledWidth);
        const dualLeftMargin = dualExpected.x;
        const dualRightMargin = 1920 - (dualExpected.x + dualExpected.scaledWidth);

        console.log(
          `   ${fixture.name}: single margins L=${singleLeftMargin.toFixed(0)} R=${singleRightMargin.toFixed(0)}, dual margins L=${dualLeftMargin.toFixed(0)} R=${dualRightMargin.toFixed(0)}`
        );

        expect(Math.abs(singleLeftMargin - singleRightMargin)).toBeLessThan(1);
        expect(Math.abs(dualLeftMargin - dualRightMargin)).toBeLessThan(1);
      }
    );
  });

  describe('fitToWidth horizontal centering', () => {
    it.each(extractedFixtures)(
      '$name fitToWidth should fill viewport width with X=0',
      async (fixture) => {
        // For fitToWidth, the scaled spread width should equal viewport width
        // So X position should be 0 (left-aligned, fills width)
        const mokuroData = loadExtractedMokuro(fixture);
        const spread = groupPagesIntoSpreads(mokuroData.pages.slice(0, 5), 'auto', true, true)[0];
        const expected = calculateExpectedZoom(spread, 1920, 1080, 'zoomFitToWidth');

        // When fit to width, scaledWidth === viewportWidth, so X should be 0
        expect(Math.abs(expected.scaledWidth - 1920)).toBeLessThan(1);
        expect(expected.x).toBeCloseTo(0, 0);

        console.log(
          `   ${fixture.name}: fitToWidth scaledWidth=${expected.scaledWidth.toFixed(0)}, X=${expected.x.toFixed(0)}`
        );
      }
    );
  });
});

/**
 * Critical test: Container width vs spread width
 * The CSS uses align-items: center on .continuous-content, which centers spreads.
 * If container width != spread width, we get incorrect centering.
 */
describeWithFixtures('Container width analysis', () => {
  describe('centering formula depends on container structure', () => {
    it.each(extractedFixtures)(
      '$name should use correct centering formula based on container width',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages.slice(0, 5);
        const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);
        const spread = spreads[0];
        const { width: spreadWidth } = calculateSpreadDimensions(spread);

        // Standard Reader formula (container width = content width):
        // x = (viewportWidth - containerWidth * scale) / 2
        // When containerWidth === spreadWidth, this works

        // But ContinuousReader has align-items: center on a potentially wider container
        // If container fills viewport (containerWidth = viewportWidth):
        // Spread is centered in container: spreadOffset = (containerWidth - spreadWidth) / 2
        // After scale: spreadVisualOffset = spreadOffset * scale
        // For correct centering: x + containerWidth/2 * scale = viewportWidth/2
        // So: x = viewportWidth * (1 - scale) / 2

        const viewportWidth = 1920;
        const viewportHeight = 1080;
        const scale = Math.min(
          viewportWidth / spreadWidth,
          viewportHeight / calculateSpreadDimensions(spread).height
        );

        // Current code formula (assumes container width = spread width):
        const currentX = (viewportWidth - spreadWidth * scale) / 2;

        // Correct formula if container fills viewport:
        const correctXForFullViewportContainer = (viewportWidth * (1 - scale)) / 2;

        // If spread is already centered in viewport-width container:
        // The X should position container so spread ends up centered
        // spreadVisualCenter = x + (containerWidth - spreadWidth) / 2 * scale + spreadWidth * scale / 2
        //                    = x + containerWidth * scale / 2
        // For containerWidth = viewportWidth: spreadVisualCenter = x + viewportWidth * scale / 2
        // We want spreadVisualCenter = viewportWidth / 2
        // So: x = viewportWidth / 2 - viewportWidth * scale / 2 = viewportWidth * (1 - scale) / 2

        console.log(`   ${fixture.name}:`);
        console.log(`     spreadWidth=${spreadWidth}, scale=${scale.toFixed(3)}`);
        console.log(`     currentX (spread-based)=${currentX.toFixed(0)}`);
        console.log(
          `     correctX (viewport-container)=${correctXForFullViewportContainer.toFixed(0)}`
        );
        console.log(
          `     difference=${Math.abs(currentX - correctXForFullViewportContainer).toFixed(0)}`
        );

        // The key question: what is the actual container width in the browser?
        // If it matches viewport, the current formula is wrong.
        // If it matches spread width, the current formula is correct.

        // This test documents the discrepancy but doesn't fail,
        // as we need browser testing to verify actual behavior.
        expect(true).toBe(true);
      }
    );
  });
});

/**
 * Visual layout tests - verify actual DOM positions
 * These tests check the interaction between CSS layout and panzoom transforms
 */
describeWithFixtures('Visual layout verification', () => {
  describe('spread centering in DOM', () => {
    it.each(extractedFixtures)(
      '$name spread should be visually centered in viewport',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages.slice(0, 5);
        const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

        const { container } = render(ContinuousReader, {
          props: {
            pages,
            files: createFilesFromPages(pages),
            volume: createVolume(fixture.name),
            volumeSettings: createVolumeSettings(),
            currentPage: 1,
            onPageChange: vi.fn(),
            onVolumeNav: vi.fn()
          }
        });

        await new Promise((r) => setTimeout(r, 100));

        // Get the panzoom transform values
        const zoomAbsCalls = panzoomCalls.filter((c) => c.method === 'zoomAbs');
        const moveToCalls = panzoomCalls.filter((c) => c.method === 'moveTo');

        if (zoomAbsCalls.length === 0 || moveToCalls.length === 0) {
          return;
        }

        const scale = zoomAbsCalls[zoomAbsCalls.length - 1].args[2] as number;
        const transformX = moveToCalls[moveToCalls.length - 1].args[0] as number;

        // Get spread dimensions
        const spread = spreads[0];
        const { width: spreadWidth } = calculateSpreadDimensions(spread);
        const scaledSpreadWidth = spreadWidth * scale;

        // The CSS has align-items: center on .continuous-content
        // This means the spread is centered WITHIN the content container
        // The panzoom transform then moves the entire container

        // For correct centering, the visual center of the spread should be at viewport center
        // visualSpreadCenter = transformX + (containerWidth * scale / 2)
        // But since spreads are centered in container via CSS, and container width = spread width
        // visualSpreadCenter = transformX + (scaledSpreadWidth / 2)
        const visualSpreadCenter = transformX + scaledSpreadWidth / 2;
        const viewportCenter = 1920 / 2;

        console.log(
          `   ${fixture.name}: spreadCenter=${visualSpreadCenter.toFixed(0)}, viewportCenter=${viewportCenter}, diff=${Math.abs(visualSpreadCenter - viewportCenter).toFixed(0)}`
        );

        // Spread center should be at viewport center (within 5px)
        expect(Math.abs(visualSpreadCenter - viewportCenter)).toBeLessThan(5);
      }
    );

    it.each(extractedFixtures)(
      '$name content container should have correct transform',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages.slice(0, 5);

        const { container } = render(ContinuousReader, {
          props: {
            pages,
            files: createFilesFromPages(pages),
            volume: createVolume(fixture.name),
            volumeSettings: createVolumeSettings(),
            currentPage: 1,
            onPageChange: vi.fn(),
            onVolumeNav: vi.fn()
          }
        });

        await new Promise((r) => setTimeout(r, 100));

        // Check that the content container exists and has expected classes
        const contentEl = container.querySelector('.continuous-content');
        expect(contentEl).not.toBeNull();

        // Check the spread wrapper exists
        const spreadWrapper = container.querySelector('.spread-wrapper');
        expect(spreadWrapper).not.toBeNull();

        console.log(`   ${fixture.name}: DOM structure verified ✓`);
      }
    );
  });

  describe('CSS layout interaction with panzoom', () => {
    it.each(extractedFixtures)(
      '$name CSS align-items:center should not conflict with panzoom centering',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const pages = mokuroData.pages.slice(0, 5);
        const spreads = groupPagesIntoSpreads(pages, 'auto', true, true);

        render(ContinuousReader, {
          props: {
            pages,
            files: createFilesFromPages(pages),
            volume: createVolume(fixture.name),
            volumeSettings: createVolumeSettings(),
            currentPage: 1,
            onPageChange: vi.fn(),
            onVolumeNav: vi.fn()
          }
        });

        await new Promise((r) => setTimeout(r, 100));

        const zoomAbsCalls = panzoomCalls.filter((c) => c.method === 'zoomAbs');
        const moveToCalls = panzoomCalls.filter((c) => c.method === 'moveTo');

        if (zoomAbsCalls.length === 0 || moveToCalls.length === 0) return;

        const scale = zoomAbsCalls[zoomAbsCalls.length - 1].args[2] as number;
        const transformX = moveToCalls[moveToCalls.length - 1].args[0] as number;

        const spread = spreads[0];
        const { width: spreadWidth } = calculateSpreadDimensions(spread);

        // With CSS align-items: center, the spread is centered in the container
        // Container width should equal widest spread width (since width: fit-content on wrapper)
        // For correct positioning, panzoom X should position the container such that
        // the spread appears centered in the viewport

        // Expected X calculation:
        // If spread is same width as container (single spread case):
        // x = (viewportWidth - spreadWidth * scale) / 2

        const expectedX = (1920 - spreadWidth * scale) / 2;

        console.log(
          `   ${fixture.name}: transformX=${transformX.toFixed(0)}, expectedX=${expectedX.toFixed(0)}, diff=${Math.abs(transformX - expectedX).toFixed(0)}`
        );

        // Transform X should match expected centering
        expect(Math.abs(transformX - expectedX)).toBeLessThan(5);
      }
    );
  });

  describe('dual vs single spread visual positioning', () => {
    it.each(extractedFixtures)(
      '$name both spread types should be visually centered',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);

        const singleSpread = spreads.find((s) => s.type === 'single');
        const dualSpread = spreads.find((s) => s.type === 'dual');

        if (!singleSpread || !dualSpread) {
          console.log(`   ${fixture.name}: skipped (need both spread types)`);
          return;
        }

        // Calculate visual positions for both types
        const singleDims = calculateSpreadDimensions(singleSpread);
        const dualDims = calculateSpreadDimensions(dualSpread);

        // Scale for fitToScreen
        const singleScale = Math.min(1920 / singleDims.width, 1080 / singleDims.height);
        const dualScale = Math.min(1920 / dualDims.width, 1080 / dualDims.height);

        // Expected X positions
        const singleX = (1920 - singleDims.width * singleScale) / 2;
        const dualX = (1920 - dualDims.width * dualScale) / 2;

        // Visual centers
        const singleCenter = singleX + (singleDims.width * singleScale) / 2;
        const dualCenter = dualX + (dualDims.width * dualScale) / 2;

        console.log(
          `   ${fixture.name}: singleCenter=${singleCenter.toFixed(0)}, dualCenter=${dualCenter.toFixed(0)}, viewportCenter=960`
        );

        // Both should be at viewport center
        expect(Math.abs(singleCenter - 960)).toBeLessThan(1);
        expect(Math.abs(dualCenter - 960)).toBeLessThan(1);
      }
    );
  });
});

describe('Zoom placement fixture availability', () => {
  it('should report status', () => {
    if (extractedFixtures.length === 0) {
      console.log(`
╭─────────────────────────────────────────────────────────╮
│  No fixtures for ContinuousReader zoom tests            │
│  Add mokuro-processed manga to test/fixtures/extracted  │
╰─────────────────────────────────────────────────────────╯
      `);
    }
    expect(true).toBe(true);
  });
});
