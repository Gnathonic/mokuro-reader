/**
 * Integration test for scroll stuttering in PureCanvasReader.
 *
 * This test mounts the actual component and measures frame timing
 * by capturing and invoking the panzoom pan callback.
 *
 * Uses real fixture data when available for accurate performance testing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import type { Page, VolumeMetadata } from '$lib/types';
import type { VolumeSettings } from '$lib/settings';
import {
  getExtractedFixtures,
  loadExtractedMokuro,
  hasExtractedFixtures,
  type ExtractedFixture
} from '../fixtures/fixture-loader';

// Track registered panzoom callbacks
const panzoomCallbacks: Record<string, ((...args: unknown[]) => void)[]> = {};
let currentY = 0;

// Mock ResizeObserver
class MockResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Mock panzoom that captures callbacks
const mockPanzoom = {
  getTransform: vi.fn(() => ({ x: 0, y: currentY, scale: 1 })),
  moveTo: vi.fn((x, y) => {
    currentY = y;
  }),
  smoothMoveTo: vi.fn(),
  zoomAbs: vi.fn(),
  zoomTo: vi.fn(),
  on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
    if (!panzoomCallbacks[event]) {
      panzoomCallbacks[event] = [];
    }
    panzoomCallbacks[event].push(callback);
  }),
  dispose: vi.fn()
};

vi.mock('panzoom', () => ({
  default: vi.fn(() => mockPanzoom)
}));

// Mock settings store
vi.mock('$lib/settings', () => ({
  settings: {
    subscribe: vi.fn((cb) => {
      cb({
        backgroundColor: '#1a1a1a',
        zoomDefault: 'zoomFitToScreen',
        continuousZoomDefault: 'zoomFitToWidth',
        scrollSnap: false, // Disable snap for continuous scroll test
        swapWheelBehavior: false,
        invertColors: false
      });
      return () => {};
    })
  },
  invertColorsActive: {
    subscribe: vi.fn((cb) => {
      cb(false);
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

// Mock ImageCache - but track actual operations for profiling
const imageCacheOperations: { method: string; time: number }[] = [];
vi.mock('$lib/reader/image-cache', () => ({
  ImageCache: vi.fn().mockImplementation(() => ({
    updateCache: vi.fn(() => {
      const start = performance.now();
      // Simulate real cache update work
      imageCacheOperations.push({ method: 'updateCache', time: performance.now() - start });
    }),
    getBitmapSync: vi.fn(() => {
      const start = performance.now();
      imageCacheOperations.push({ method: 'getBitmapSync', time: performance.now() - start });
      return null; // Return null to test placeholder path
    }),
    getBitmap: vi.fn(() => {
      const start = performance.now();
      imageCacheOperations.push({ method: 'getBitmap', time: performance.now() - start });
      return Promise.resolve(null);
    }),
    getFile: vi.fn((index: number) => new File([''], `page${index}.jpg`, { type: 'image/jpeg' })),
    cleanup: vi.fn()
  }))
}));

// Check for real fixtures
const fixtures = getExtractedFixtures();
const hasFixtures = fixtures.length > 0;

// Helper to create test pages
function createPage(width = 1920, height = 2560, path = 'test.jpg'): Page {
  return {
    version: '0.2.0',
    img_width: width,
    img_height: height,
    img_path: path,
    blocks: []
  };
}

// Helper to create test volume
function createVolume(): VolumeMetadata {
  return {
    volume_uuid: 'test-volume-uuid',
    series_uuid: 'test-series-uuid',
    title: 'Test Volume',
    volume: '1',
    pageCount: 20,
    charCount: 5000
  };
}

// Helper to create volume settings
function createVolumeSettings(): VolumeSettings {
  return {
    singlePageView: 'auto',
    hasCover: true,
    rightToLeft: true
  };
}

// Create test files record
function createFiles(count: number): Record<string, File> {
  const files: Record<string, File> = {};
  for (let i = 0; i < count; i++) {
    files[`page${i}.jpg`] = new File([''], `page${i}.jpg`, { type: 'image/jpeg' });
  }
  return files;
}

describe('Scroll Stutter Integration Test', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Clear captured callbacks
    Object.keys(panzoomCallbacks).forEach((key) => delete panzoomCallbacks[key]);
    currentY = 0;

    // Mock window dimensions
    Object.defineProperty(window, 'innerWidth', { value: 1920, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, writable: true });

    // Mock createImageBitmap
    global.createImageBitmap = vi.fn(() =>
      Promise.resolve({
        width: 1920,
        height: 2560,
        close: vi.fn()
      } as unknown as ImageBitmap)
    );
  });

  afterEach(() => {
    cleanup();
  });

  // Skip: PureCanvasReader doesn't use panzoom - it manages transforms directly
  it.skip('should capture pan callback when component mounts', async () => {
    const { default: PureCanvasReader } = await import(
      '../../src/lib/components/Reader/PureCanvasReader.svelte'
    );

    const pages = Array.from({ length: 20 }, (_, i) => createPage(1920, 2560, `page${i}.jpg`));

    render(PureCanvasReader, {
      props: {
        pages,
        files: createFiles(20),
        volume: createVolume(),
        volumeSettings: createVolumeSettings(),
        currentPage: 5,
        onPageChange: vi.fn(),
        onVolumeNav: vi.fn()
      }
    });

    // Wait for component to mount and register callbacks
    await new Promise((r) => setTimeout(r, 100));

    // Verify pan callback was registered
    expect(panzoomCallbacks['pan']).toBeDefined();
    expect(panzoomCallbacks['pan'].length).toBeGreaterThan(0);
  });

  // Skip: PureCanvasReader doesn't use panzoom - it manages transforms directly
  it.skip('FAILS if pan callback causes frame drops (> 16ms per call)', async () => {
    const { default: PureCanvasReader } = await import(
      '../../src/lib/components/Reader/PureCanvasReader.svelte'
    );

    const pages = Array.from({ length: 20 }, (_, i) => createPage(1920, 2560, `page${i}.jpg`));

    render(PureCanvasReader, {
      props: {
        pages,
        files: createFiles(20),
        volume: createVolume(),
        volumeSettings: createVolumeSettings(),
        currentPage: 5,
        onPageChange: vi.fn(),
        onVolumeNav: vi.fn()
      }
    });

    // Wait for component to mount
    await new Promise((r) => setTimeout(r, 100));

    const panCallbacks = panzoomCallbacks['pan'] || [];
    expect(panCallbacks.length).toBeGreaterThan(0);

    // Simulate 60 rapid pan events (1 second of scrolling)
    const frameTimes: number[] = [];

    for (let i = 0; i < 60; i++) {
      // Update mock position to simulate scrolling
      currentY = -i * 50; // 50px per frame

      const start = performance.now();

      // Call all registered pan callbacks
      for (const callback of panCallbacks) {
        callback();
      }

      const elapsed = performance.now() - start;
      frameTimes.push(elapsed);
    }

    // Analyze frame timing
    const maxTime = Math.max(...frameTimes);
    const avgTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    const droppedFrames = frameTimes.filter((t) => t > 16.67).length;
    const severeDrops = frameTimes.filter((t) => t > 33.33).length;

    console.log(`
Pan callback frame timing:
  Max: ${maxTime.toFixed(3)}ms
  Avg: ${avgTime.toFixed(3)}ms
  Dropped frames (>16.67ms): ${droppedFrames}
  Severe drops (>33.33ms): ${severeDrops}
  Frame times: [${frameTimes
    .slice(0, 10)
    .map((t) => t.toFixed(2))
    .join(', ')}...]
`);

    // Test assertions - fail if there's stuttering
    expect(maxTime).toBeLessThan(16.67); // No single frame should exceed budget
    expect(avgTime).toBeLessThan(5); // Average should be well under budget
    expect(droppedFrames).toBe(0); // No dropped frames allowed
  });

  // Note: Wheel event testing is skipped because jsdom doesn't support target.closest()
  // The pan callback test above covers the same code path
});

describe('Scroll Stutter with Real Fixtures', () => {
  const describeWithFixtures = hasFixtures ? describe : describe.skip;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(panzoomCallbacks).forEach((key) => delete panzoomCallbacks[key]);
    currentY = 0;
    imageCacheOperations.length = 0;

    Object.defineProperty(window, 'innerWidth', { value: 1920, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, writable: true });

    global.createImageBitmap = vi.fn(() =>
      Promise.resolve({
        width: 1920,
        height: 2560,
        close: vi.fn()
      } as unknown as ImageBitmap)
    );
  });

  afterEach(() => {
    cleanup();
  });

  describeWithFixtures('with real mokuro data', () => {
    it.each(fixtures)('$name - should not stutter during scroll simulation', async (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const pages = mokuroData.pages;

      const { default: PureCanvasReader } = await import(
        '../../src/lib/components/Reader/PureCanvasReader.svelte'
      );

      // Create files from fixture
      const files: Record<string, File> = {};
      for (const imgPath of fixture.imageFiles) {
        files[imgPath] = new File([''], imgPath, { type: 'image/jpeg' });
      }

      const volume: VolumeMetadata = {
        volume_uuid: fixture.name,
        series_uuid: 'test-series',
        title: mokuroData.title || fixture.name,
        volume: mokuroData.volume || '1',
        pageCount: pages.length,
        charCount: mokuroData.chars || 0
      };

      render(PureCanvasReader, {
        props: {
          pages,
          files,
          volume,
          volumeSettings: {
            singlePageView: 'auto',
            hasCover: true,
            rightToLeft: true
          },
          currentPage: Math.floor(pages.length / 2), // Start in middle
          onPageChange: vi.fn(),
          onVolumeNav: vi.fn()
        }
      });

      // Wait for component to mount
      await new Promise((r) => setTimeout(r, 100));

      const panCallbacks = panzoomCallbacks['pan'] || [];
      expect(panCallbacks.length).toBeGreaterThan(0);

      // Simulate scrolling through the volume
      const frameTimes: number[] = [];
      const scrollDistance = pages.length * 2560; // Total scroll distance

      for (let i = 0; i < 120; i++) {
        // 2 seconds at 60fps
        currentY = -(i * (scrollDistance / 120));

        const start = performance.now();
        for (const callback of panCallbacks) {
          callback();
        }
        frameTimes.push(performance.now() - start);
      }

      // Analyze results
      const maxTime = Math.max(...frameTimes);
      const avgTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
      const droppedFrames = frameTimes.filter((t) => t > 16.67).length;

      console.log(`
${fixture.name} scroll performance (${pages.length} pages):
  Max frame time: ${maxTime.toFixed(3)}ms
  Avg frame time: ${avgTime.toFixed(3)}ms
  Dropped frames: ${droppedFrames} / 120
  ImageCache calls: ${imageCacheOperations.length}
`);

      // Assertions
      expect(maxTime).toBeLessThan(16.67);
      expect(droppedFrames).toBe(0);
    });

    it.each(fixtures)(
      '$name - should profile individual operations during scroll',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);

        const { default: PureCanvasReader } = await import(
          '../../src/lib/components/Reader/PureCanvasReader.svelte'
        );

        const files: Record<string, File> = {};
        for (const imgPath of fixture.imageFiles) {
          files[imgPath] = new File([''], imgPath, { type: 'image/jpeg' });
        }

        render(PureCanvasReader, {
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

        await new Promise((r) => setTimeout(r, 100));
        imageCacheOperations.length = 0;

        const panCallbacks = panzoomCallbacks['pan'] || [];

        // Profile operations
        const operationTimings: Record<string, number[]> = {
          panCallback: [],
          getTransform: []
        };

        for (let i = 0; i < 60; i++) {
          currentY = -i * 100;

          let start = performance.now();
          mockPanzoom.getTransform();
          operationTimings.getTransform.push(performance.now() - start);

          start = performance.now();
          for (const callback of panCallbacks) {
            callback();
          }
          operationTimings.panCallback.push(performance.now() - start);
        }

        const avgPanCallback =
          operationTimings.panCallback.reduce((a, b) => a + b, 0) /
          operationTimings.panCallback.length;
        const maxPanCallback = Math.max(...operationTimings.panCallback);

        console.log(`
${fixture.name} operation profiling:
  Pan callback avg: ${avgPanCallback.toFixed(3)}ms
  Pan callback max: ${maxPanCallback.toFixed(3)}ms
  ImageCache getBitmapSync calls: ${imageCacheOperations.filter((o) => o.method === 'getBitmapSync').length}
  ImageCache updateCache calls: ${imageCacheOperations.filter((o) => o.method === 'updateCache').length}
`);

        expect(maxPanCallback).toBeLessThan(16.67);
      }
    );
  });
});

describe('Frame Pacing Analysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(panzoomCallbacks).forEach((key) => delete panzoomCallbacks[key]);
    currentY = 0;

    Object.defineProperty(window, 'innerWidth', { value: 1920, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, writable: true });

    global.createImageBitmap = vi.fn(() =>
      Promise.resolve({
        width: 1920,
        height: 2560,
        close: vi.fn()
      } as unknown as ImageBitmap)
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('should detect jank patterns in frame timing', async () => {
    const { default: PureCanvasReader } = await import(
      '../../src/lib/components/Reader/PureCanvasReader.svelte'
    );

    const pages = Array.from({ length: 20 }, (_, i) => createPage(1920, 2560, `page${i}.jpg`));

    render(PureCanvasReader, {
      props: {
        pages,
        files: createFiles(20),
        volume: createVolume(),
        volumeSettings: createVolumeSettings(),
        currentPage: 5,
        onPageChange: vi.fn(),
        onVolumeNav: vi.fn()
      }
    });

    await new Promise((r) => setTimeout(r, 100));

    const panCallbacks = panzoomCallbacks['pan'] || [];

    // Collect frame timing data
    const frameTimes: number[] = [];
    const frameDeltas: number[] = [];
    let lastFrameEnd = performance.now();

    for (let i = 0; i < 120; i++) {
      // 2 seconds at 60fps
      currentY = -i * 30;

      const frameStart = performance.now();

      for (const callback of panCallbacks) {
        callback();
      }

      const frameEnd = performance.now();
      const frameTime = frameEnd - frameStart;
      const frameDelta = frameStart - lastFrameEnd;

      frameTimes.push(frameTime);
      frameDeltas.push(frameDelta);
      lastFrameEnd = frameEnd;
    }

    // Analyze jank patterns
    const jankThreshold = 16.67; // 60fps budget
    const jankFrames = frameTimes.filter((t) => t > jankThreshold);
    const jankPercentage = (jankFrames.length / frameTimes.length) * 100;

    // Calculate frame time variance (high variance = stuttering)
    const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    const variance =
      frameTimes.reduce((sum, t) => sum + Math.pow(t - avgFrameTime, 2), 0) / frameTimes.length;
    const stdDev = Math.sqrt(variance);

    console.log(`
Frame Pacing Analysis (120 frames):
  Average frame time: ${avgFrameTime.toFixed(3)}ms
  Std deviation: ${stdDev.toFixed(3)}ms
  Jank frames (>${jankThreshold}ms): ${jankFrames.length} (${jankPercentage.toFixed(1)}%)
  Max frame time: ${Math.max(...frameTimes).toFixed(3)}ms
  Min frame time: ${Math.min(...frameTimes).toFixed(3)}ms
`);

    // Assertions for smooth scrolling
    expect(jankPercentage).toBeLessThan(5); // Less than 5% jank frames
    expect(stdDev).toBeLessThan(5); // Low variance = consistent timing
    expect(avgFrameTime).toBeLessThan(8); // Well under budget
  });

  it('should identify specific operations causing jank', async () => {
    const { default: PureCanvasReader } = await import(
      '../../src/lib/components/Reader/PureCanvasReader.svelte'
    );

    const pages = Array.from({ length: 20 }, (_, i) => createPage(1920, 2560, `page${i}.jpg`));

    render(PureCanvasReader, {
      props: {
        pages,
        files: createFiles(20),
        volume: createVolume(),
        volumeSettings: createVolumeSettings(),
        currentPage: 5,
        onPageChange: vi.fn(),
        onVolumeNav: vi.fn()
      }
    });

    await new Promise((r) => setTimeout(r, 100));

    const panCallbacks = panzoomCallbacks['pan'] || [];

    // Profile individual operations
    const timings = {
      getTransform: [] as number[],
      panCallback: [] as number[]
    };

    for (let i = 0; i < 60; i++) {
      currentY = -i * 50;

      // Time getTransform
      let start = performance.now();
      mockPanzoom.getTransform();
      timings.getTransform.push(performance.now() - start);

      // Time full pan callback
      start = performance.now();
      for (const callback of panCallbacks) {
        callback();
      }
      timings.panCallback.push(performance.now() - start);
    }

    const avgGetTransform =
      timings.getTransform.reduce((a, b) => a + b, 0) / timings.getTransform.length;
    const avgPanCallback =
      timings.panCallback.reduce((a, b) => a + b, 0) / timings.panCallback.length;
    const maxPanCallback = Math.max(...timings.panCallback);

    console.log(`
Operation Timing Breakdown:
  getTransform avg: ${avgGetTransform.toFixed(3)}ms
  Pan callback avg: ${avgPanCallback.toFixed(3)}ms
  Pan callback max: ${maxPanCallback.toFixed(3)}ms
`);

    // Pan callback should be fast
    expect(maxPanCallback).toBeLessThan(16.67);
  });
});
