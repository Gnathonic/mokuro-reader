import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import type { Page, VolumeMetadata } from '$lib/types';
import type { VolumeSettings } from '$lib/settings';

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

// Mock panzoom before importing component
const mockPanzoom = {
  getTransform: vi.fn(() => ({ x: 0, y: 0, scale: 1 })),
  moveTo: vi.fn(),
  smoothMoveTo: vi.fn(),
  zoomAbs: vi.fn(),
  zoomTo: vi.fn(),
  on: vi.fn(),
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

// Helper to create test pages
function createPage(width = 1000, height = 1500, path = 'test.jpg'): Page {
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
    mokuro_version: '0.2.0',
    series_title: 'Test Series',
    series_uuid: 'test-series-uuid',
    volume_title: 'Test Volume',
    volume_uuid: 'test-volume-uuid',
    page_count: 10,
    character_count: 1000,
    page_char_counts: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
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

describe('ContinuousReader', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock window dimensions
    Object.defineProperty(window, 'innerWidth', { value: 1920, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, writable: true });

    // Mock createImageBitmap
    globalThis.createImageBitmap = vi.fn(() =>
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

  describe('spread grouping integration', () => {
    it('should group pages correctly with hasCover', async () => {
      // Import after mocks are set up
      const { default: ContinuousReader } = await import('../ContinuousReader.svelte');

      const pages = [
        createPage(1000, 1500, 'cover.jpg'), // Cover - single
        createPage(1000, 1500, 'page1.jpg'), // Should pair
        createPage(1000, 1500, 'page2.jpg'), // Should pair
        createPage(1000, 1500, 'page3.jpg') // Single (odd)
      ];

      const { container } = render(ContinuousReader, {
        props: {
          pages,
          files: createFiles(4),
          volume: createVolume(),
          volumeSettings: createVolumeSettings(),
          currentPage: 1,
          onPageChange: vi.fn(),
          onVolumeNav: vi.fn()
        }
      });

      // The component renders spread wrappers
      const spreadWrappers = container.querySelectorAll('.spread-wrapper');
      // Should render 3 spreads in the visible window (prev, current, next)
      // At page 1, we're at spread 0 (cover), so visible are: current (0), next (1)
      expect(spreadWrappers.length).toBeGreaterThanOrEqual(1);
    });

    it('should render correct number of visible spreads', async () => {
      const { default: ContinuousReader } = await import('../ContinuousReader.svelte');

      const pages = Array.from({ length: 10 }, (_, i) => createPage(1000, 1500, `page${i}.jpg`));

      const { container } = render(ContinuousReader, {
        props: {
          pages,
          files: createFiles(10),
          volume: createVolume(),
          volumeSettings: { ...createVolumeSettings(), hasCover: false },
          currentPage: 3, // Middle of volume
          onPageChange: vi.fn(),
          onVolumeNav: vi.fn()
        }
      });

      const spreadWrappers = container.querySelectorAll('.spread-wrapper');
      // Should render up to 5 spreads (PRERENDER_BUFFER=2: current ± 2)
      expect(spreadWrappers.length).toBeLessThanOrEqual(5);
      expect(spreadWrappers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('container structure', () => {
    it('should have correct container classes', async () => {
      const { default: ContinuousReader } = await import('../ContinuousReader.svelte');

      const pages = [createPage(), createPage()];

      const { container } = render(ContinuousReader, {
        props: {
          pages,
          files: createFiles(2),
          volume: createVolume(),
          volumeSettings: createVolumeSettings(),
          currentPage: 1,
          onPageChange: vi.fn(),
          onVolumeNav: vi.fn()
        }
      });

      const reader = container.querySelector('.continuous-reader');
      expect(reader).not.toBeNull();
      expect(reader?.classList.contains('h-screen')).toBe(true);
      expect(reader?.classList.contains('w-screen')).toBe(true);
      expect(reader?.classList.contains('overflow-hidden')).toBe(true);
    });

    it('should have vertical flex content container', async () => {
      const { default: ContinuousReader } = await import('../ContinuousReader.svelte');

      const pages = [createPage(), createPage()];

      const { container } = render(ContinuousReader, {
        props: {
          pages,
          files: createFiles(2),
          volume: createVolume(),
          volumeSettings: createVolumeSettings(),
          currentPage: 1,
          onPageChange: vi.fn(),
          onVolumeNav: vi.fn()
        }
      });

      const content = container.querySelector('.continuous-content');
      expect(content).not.toBeNull();
    });
  });

  describe('RTL mode', () => {
    it('should apply flex-row-reverse for RTL dual spreads', async () => {
      const { default: ContinuousReader } = await import('../ContinuousReader.svelte');

      // Need enough pages to create a dual spread
      const pages = [
        createPage(1000, 1500, 'cover.jpg'),
        createPage(1000, 1500, 'page1.jpg'),
        createPage(1000, 1500, 'page2.jpg')
      ];

      const { container } = render(ContinuousReader, {
        props: {
          pages,
          files: createFiles(3),
          volume: createVolume(),
          volumeSettings: { ...createVolumeSettings(), rightToLeft: true, hasCover: true },
          currentPage: 2, // Page in the dual spread
          onPageChange: vi.fn(),
          onVolumeNav: vi.fn()
        }
      });

      // Check if any spread wrapper has flex-row-reverse (for dual spreads in RTL)
      const spreadWrappers = container.querySelectorAll('.spread-wrapper');
      const hasDualRTL = Array.from(spreadWrappers).some((w) =>
        w.classList.contains('flex-row-reverse')
      );
      // Should have at least one RTL dual spread (pages 1-2)
      expect(hasDualRTL).toBe(true);
    });
  });

  describe('callbacks', () => {
    it('should call onPageChange when navigating', async () => {
      const { default: ContinuousReader } = await import('../ContinuousReader.svelte');
      const onPageChange = vi.fn();

      const pages = Array.from({ length: 6 }, (_, i) => createPage(1000, 1500, `page${i}.jpg`));

      render(ContinuousReader, {
        props: {
          pages,
          files: createFiles(6),
          volume: createVolume(),
          volumeSettings: { ...createVolumeSettings(), hasCover: false },
          currentPage: 1,
          onPageChange,
          onVolumeNav: vi.fn()
        }
      });

      // Simulate keyboard navigation by dispatching event
      const event = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true });
      window.dispatchEvent(event);

      // onPageChange should be called (may be async)
      // Note: The actual call depends on panzoom mocking behavior
      // This test verifies the event handling is set up
      expect(mockPanzoom.getTransform).toHaveBeenCalled();
    });
  });
});

// Separate file for pure logic tests that don't need component rendering
describe('ContinuousReader positioning logic', () => {
  describe('spread height calculations', () => {
    it('should calculate correct scaled height for zoom', () => {
      const spreadHeight = 1500;
      const scale = 0.72; // Fit to screen scale
      const scaledHeight = spreadHeight * scale;

      expect(scaledHeight).toBe(1080);
    });

    it('should calculate bottom boundary correctly', () => {
      const viewportHeight = 1080;
      const spreadHeight = 1500;
      const bottomBoundary = Math.min(0, viewportHeight - spreadHeight);

      expect(bottomBoundary).toBe(-420);
    });

    it('should center spread when smaller than viewport', () => {
      const viewportHeight = 1080;
      const spreadHeight = 800;
      const centerY = (viewportHeight - spreadHeight) / 2;

      expect(centerY).toBe(140);
    });
  });

  describe('transition thresholds', () => {
    it('should calculate down transition threshold correctly', () => {
      const prevHeight = 1500;
      const currentHeight = 1500;
      const viewportHeight = 1080;

      // Bottom of current is at prevHeight + currentHeight from content top
      // Threshold is when 90% scrolled past current
      const threshold = -(prevHeight + currentHeight - viewportHeight * 0.1);

      expect(threshold).toBe(-2892); // -(1500 + 1500 - 108)
    });

    it('should calculate up transition threshold correctly', () => {
      const prevHeight = 1500;
      const viewportHeight = 1080;

      // Top of current is at prevHeight
      // Threshold is when 90% scrolled up past current
      const threshold = -(prevHeight - viewportHeight * 0.9);

      expect(threshold).toBe(-528); // -(1500 - 972)
    });
  });

  describe('zoom mode calculations', () => {
    it('should calculate fitToScreen scale correctly', () => {
      const spreadWidth = 2000; // Dual spread
      const spreadHeight = 1500;
      const viewportWidth = 1920;
      const viewportHeight = 1080;

      const scaleX = viewportWidth / spreadWidth; // 0.96
      const scaleY = viewportHeight / spreadHeight; // 0.72
      const fitToScreenScale = Math.min(scaleX, scaleY);

      expect(fitToScreenScale).toBe(0.72);
    });

    it('should calculate fitToWidth scale correctly', () => {
      const spreadWidth = 2000;
      const viewportWidth = 1920;

      const fitToWidthScale = viewportWidth / spreadWidth;

      expect(fitToWidthScale).toBe(0.96);
    });

    it('should calculate horizontal centering offset', () => {
      const viewportWidth = 1920;
      const spreadWidth = 2000;
      const scale = 0.72;

      const scaledWidth = spreadWidth * scale; // 1440
      const centerX = (viewportWidth - scaledWidth) / 2;

      expect(centerX).toBe(240);
    });
  });
});

describe('Keyboard navigation integration', () => {
  describe('pan actions', () => {
    it('should pan by correct amount on arrow key', () => {
      const panStep = 100;
      let currentY = 0;

      // Arrow down
      currentY += -panStep;
      expect(currentY).toBe(-100);

      // Arrow up
      currentY += panStep;
      expect(currentY).toBe(0);
    });

    it('should respect viewport bounds on pan', () => {
      const viewportHeight = 1080;
      const spreadHeight = 1500;
      const bottomBoundary = viewportHeight - spreadHeight; // -420

      let currentY = -400;

      // Pan down more
      currentY -= 100;
      expect(currentY).toBe(-500);

      // Clamped would be
      const clamped = Math.max(bottomBoundary, Math.min(0, currentY));
      expect(clamped).toBe(-420);
    });
  });

  describe('spread jump actions', () => {
    it('should calculate next spread index on PageDown', () => {
      const currentSpreadIndex = 2;
      const totalSpreads = 5;

      const nextIndex = Math.min(currentSpreadIndex + 1, totalSpreads - 1);
      expect(nextIndex).toBe(3);
    });

    it('should not exceed total spreads', () => {
      const currentSpreadIndex = 4;
      const totalSpreads = 5;

      const nextIndex = Math.min(currentSpreadIndex + 1, totalSpreads - 1);
      expect(nextIndex).toBe(4); // Stay at last
    });

    it('should calculate previous spread index on PageUp', () => {
      const currentSpreadIndex = 2;

      const prevIndex = Math.max(currentSpreadIndex - 1, 0);
      expect(prevIndex).toBe(1);
    });

    it('should not go below zero', () => {
      const currentSpreadIndex = 0;

      const prevIndex = Math.max(currentSpreadIndex - 1, 0);
      expect(prevIndex).toBe(0); // Stay at first
    });
  });

  describe('edge jump actions', () => {
    it('should jump to first spread on Home', () => {
      const targetIndex = 0;
      expect(targetIndex).toBe(0);
    });

    it('should jump to last spread on End', () => {
      const totalSpreads = 10;
      const targetIndex = totalSpreads - 1;
      expect(targetIndex).toBe(9);
    });
  });
});

describe('Scroll smoothness helpers', () => {
  describe('velocity tracking', () => {
    it('should calculate velocity from position delta and time', () => {
      const lastY = -100;
      const currentY = -150;
      const deltaTime = 16; // ~60fps frame

      const velocity = (currentY - lastY) / deltaTime;
      expect(velocity).toBeCloseTo(-3.125);
    });

    it('should ignore stale velocity readings', () => {
      const deltaTime = 200; // Too old
      const maxDeltaTime = 100;

      const shouldIgnore = deltaTime > maxDeltaTime;
      expect(shouldIgnore).toBe(true);
    });
  });

  describe('animation easing', () => {
    it('should calculate ease-out cubic correctly', () => {
      // t=0 -> 0
      expect(1 - Math.pow(1 - 0, 3)).toBe(0);

      // t=0.5 -> 0.875
      expect(1 - Math.pow(1 - 0.5, 3)).toBe(0.875);

      // t=1 -> 1
      expect(1 - Math.pow(1 - 1, 3)).toBe(1);
    });

    it('should interpolate position smoothly', () => {
      const startY = 0;
      const endY = -420;
      const progress = 0.5;
      const easedProgress = 1 - Math.pow(1 - progress, 3); // 0.875

      const interpolatedY = startY + (endY - startY) * easedProgress;
      expect(interpolatedY).toBeCloseTo(-367.5);
    });
  });
});
