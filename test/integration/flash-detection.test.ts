/**
 * Flash Detection Test
 *
 * Detects when MangaPage renders without a cached bitmap (causes visual flash).
 * A flash occurs when:
 * 1. visibleSpreads changes (spread transition)
 * 2. MangaPage component renders for a page
 * 3. getBitmap() returns null for that page at render time
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import {
  getExtractedFixtures,
  loadExtractedMokuro,
  hasExtractedFixtures
} from '../fixtures/fixture-loader';
import fs from 'fs';
import path from 'path';
import type { Page, VolumeMetadata } from '$lib/types';
import type { VolumeSettings } from '$lib/settings';

// Track all getBitmap calls and their results
const bitmapCalls: { pageIndex: number; hadBitmap: boolean; timestamp: number }[] = [];
// Track MangaPage renders
const pageRenders: { imgPath: string; hadBitmap: boolean; timestamp: number }[] = [];
// Track transitions
const transitions: { spreadIndex: number; timestamp: number }[] = [];

// ResizeObserver mock
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
  MockResizeObserver as unknown as typeof ResizeObserver;

// Panzoom mock with transform tracking
let mockTransform = { x: 0, y: 0, scale: 0.5 };
const mockPanzoom = {
  getTransform: () => ({ ...mockTransform }),
  moveTo: (x: number, y: number) => {
    mockTransform.x = x;
    mockTransform.y = y;
  },
  smoothMoveTo: () => {},
  zoomAbs: (_x: number, _y: number, scale: number) => {
    mockTransform.scale = scale;
  },
  zoomTo: () => {},
  on: () => {},
  dispose: () => {}
};

vi.mock('panzoom', () => ({
  default: () => mockPanzoom
}));

// Settings mock
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

// Activity tracker mock
vi.mock('$lib/util/activity-tracker', () => ({
  activityTracker: { recordActivity: vi.fn() }
}));

// Create a tracking ImageCache that logs all getBitmapSync calls
class TrackingImageCache {
  private bitmaps = new Map<number, ImageBitmap>();
  private files = new Map<number, File>();
  private preloadedPages = new Set<number>();

  updateCache(files: Record<string, File>, pages: Page[], centerPage: number) {
    // Store files for all pages
    pages.forEach((page, idx) => {
      const fileName = page.img_path.split('/').pop() || page.img_path;
      const file = files[fileName] || files[page.img_path];
      if (file) {
        this.files.set(idx, file);
      }
    });

    // Simulate preloading: mark pages as "loaded" in a window around center
    const windowSize = 5;
    for (
      let i = Math.max(0, centerPage - windowSize);
      i <= Math.min(pages.length - 1, centerPage + windowSize);
      i++
    ) {
      if (!this.preloadedPages.has(i)) {
        this.preloadedPages.add(i);
        // Create a mock bitmap
        this.bitmaps.set(i, {
          width: pages[i]?.img_width || 1000,
          height: pages[i]?.img_height || 1500,
          close: () => {}
        } as unknown as ImageBitmap);
      }
    }
  }

  getBitmapSync(pageIndex: number): ImageBitmap | null {
    const bitmap = this.bitmaps.get(pageIndex) || null;
    bitmapCalls.push({
      pageIndex,
      hadBitmap: !!bitmap,
      timestamp: performance.now()
    });
    return bitmap;
  }

  getFile(pageIndex: number): File | undefined {
    return this.files.get(pageIndex);
  }

  cleanup() {
    this.bitmaps.clear();
    this.files.clear();
    this.preloadedPages.clear();
  }
}

// Mock ImageCache to use our tracking version
vi.mock('$lib/reader/image-cache', () => ({
  ImageCache: vi.fn().mockImplementation(() => new TrackingImageCache())
}));

const fixtures = getExtractedFixtures();
const hasFixtures = fixtures.length > 0;

describe('Flash Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bitmapCalls.length = 0;
    pageRenders.length = 0;
    transitions.length = 0;
    mockTransform = { x: 0, y: 0, scale: 0.5 };

    // Mock window dimensions
    Object.defineProperty(window, 'innerWidth', { value: 1920, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, writable: true });
  });

  afterEach(() => {
    cleanup();
  });

  describe.skipIf(!hasFixtures)('with real fixtures', () => {
    fixtures.forEach((fixture) => {
      it(`${fixture.name} - should have bitmaps ready at render time`, async () => {
        const mokuroData = loadExtractedMokuro(fixture.path);
        if (!mokuroData) {
          console.log(`   ⚠️ No mokuro data for ${fixture.name}`);
          return;
        }

        // Create files map from fixture
        const filesMap: Record<string, File> = {};
        const imagesDir = path.join(fixture.path, 'images');
        if (fs.existsSync(imagesDir)) {
          const images = fs.readdirSync(imagesDir);
          images.forEach((img) => {
            const content = fs.readFileSync(path.join(imagesDir, img));
            filesMap[img] = new File([content], img, { type: 'image/jpeg' });
          });
        }

        const volume: VolumeMetadata = {
          mokuro_version: mokuroData.version || '0.2.0',
          volume_uuid: mokuroData.volume_uuid || 'test-uuid',
          series_uuid: mokuroData.title_uuid || 'test-series',
          series_title: mokuroData.title || 'Test',
          volume_title: mokuroData.volume || '1',
          page_count: mokuroData.pages.length,
          character_count: mokuroData.chars || 0,
          page_char_counts: []
        };

        const volumeSettings: VolumeSettings = {
          singlePageView: 'auto',
          hasCover: true,
          rightToLeft: true
        };

        // Import component after mocks
        const { default: ContinuousReader } = await import(
          '$lib/components/Reader/ContinuousReader.svelte'
        );

        const onPageChange = vi.fn();

        // Clear tracking arrays
        bitmapCalls.length = 0;

        // Render starting at page 3 (not first page, to test preloading)
        const { component } = render(ContinuousReader, {
          props: {
            pages: mokuroData.pages,
            files: filesMap,
            volume,
            volumeSettings,
            currentPage: 3,
            onPageChange,
            onVolumeNav: vi.fn()
          }
        });

        // Wait for initial render
        await vi.waitFor(() => {
          expect(bitmapCalls.length).toBeGreaterThan(0);
        });

        // Analyze initial render - check if any getBitmap calls returned null
        const initialNullBitmaps = bitmapCalls.filter((c) => !c.hadBitmap);

        console.log(`\n   ${fixture.name} initial render:`);
        console.log(`     Total getBitmap calls: ${bitmapCalls.length}`);
        console.log(`     Null bitmap calls: ${initialNullBitmaps.length}`);
        if (initialNullBitmaps.length > 0) {
          console.log(
            `     Pages without bitmaps: ${initialNullBitmaps.map((c) => c.pageIndex).join(', ')}`
          );
        }

        // Now simulate a page transition by dispatching PageDown
        bitmapCalls.length = 0;
        const event = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true });
        window.dispatchEvent(event);

        // Wait for transition to process
        await new Promise((r) => setTimeout(r, 100));

        // Analyze post-transition
        const postTransitionNullBitmaps = bitmapCalls.filter((c) => !c.hadBitmap);

        console.log(`   ${fixture.name} after PageDown:`);
        console.log(`     Total getBitmap calls: ${bitmapCalls.length}`);
        console.log(`     Null bitmap calls: ${postTransitionNullBitmaps.length}`);
        if (postTransitionNullBitmaps.length > 0) {
          console.log(
            `     Pages without bitmaps: ${postTransitionNullBitmaps.map((c) => c.pageIndex).join(', ')}`
          );
        }

        // The key assertion: no null bitmaps should be returned during render
        // (A null bitmap at render time = flash)
        expect(postTransitionNullBitmaps.length).toBe(0);
      });
    });
  });

  it('should detect flash when bitmap is missing', async () => {
    // Create a scenario where we KNOW a flash will occur
    // by having a page that's not preloaded

    const pages: Page[] = Array.from({ length: 20 }, (_, i) => ({
      version: '0.2.0',
      img_width: 1000,
      img_height: 1500,
      img_path: `page${i}.jpg`,
      blocks: []
    }));

    const filesMap: Record<string, File> = {};
    pages.forEach((p) => {
      filesMap[p.img_path] = new File([''], p.img_path, { type: 'image/jpeg' });
    });

    const volume: VolumeMetadata = {
      mokuro_version: '0.2.0',
      volume_uuid: 'test-uuid',
      series_uuid: 'test-series',
      series_title: 'Test',
      volume_title: '1',
      page_count: pages.length,
      character_count: 0,
      page_char_counts: []
    };

    const volumeSettings: VolumeSettings = {
      singlePageView: 'auto',
      hasCover: true,
      rightToLeft: true
    };

    const { default: ContinuousReader } = await import(
      '$lib/components/Reader/ContinuousReader.svelte'
    );

    bitmapCalls.length = 0;

    // Start at page 1
    render(ContinuousReader, {
      props: {
        pages,
        files: filesMap,
        volume,
        volumeSettings,
        currentPage: 1,
        onPageChange: vi.fn(),
        onVolumeNav: vi.fn()
      }
    });

    await new Promise((r) => setTimeout(r, 50));

    // Log all bitmap calls to understand the pattern
    console.log('\n   Synthetic test bitmap calls:');
    const grouped = new Map<number, boolean[]>();
    bitmapCalls.forEach((c) => {
      if (!grouped.has(c.pageIndex)) grouped.set(c.pageIndex, []);
      grouped.get(c.pageIndex)!.push(c.hadBitmap);
    });

    grouped.forEach((results, pageIndex) => {
      const hasFlash = results.includes(false);
      console.log(
        `     Page ${pageIndex}: ${results.map((r) => (r ? '✓' : '✗')).join(' ')} ${hasFlash ? '⚠️ FLASH' : ''}`
      );
    });

    // Count pages that had at least one null bitmap call
    const pagesWithFlash = Array.from(grouped.entries()).filter(([_, results]) =>
      results.includes(false)
    );

    console.log(`\n   Pages with potential flash: ${pagesWithFlash.length}`);

    // This test documents the current behavior
    // If pagesWithFlash.length > 0, we have a flash problem
    if (pagesWithFlash.length > 0) {
      console.log('   ⚠️ FLASH DETECTED - bitmaps not ready at render time');
    }
  });
});
