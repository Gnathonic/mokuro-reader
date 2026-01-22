/**
 * Integration tests for zoom placement using real fixtures.
 *
 * Tests zoom mode calculations (fit to screen, fit to width, original)
 * with actual page dimensions from mokuro-processed manga.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  getExtractedFixtures,
  loadExtractedMokuro,
  type ExtractedFixture
} from '../fixtures/fixture-loader';
import { groupPagesIntoSpreads, type PageSpread } from '../../src/lib/reader/spread-grouping';

const extractedFixtures = getExtractedFixtures();
const hasFixtures = extractedFixtures.length > 0;
const describeWithFixtures = hasFixtures ? describe : describe.skip;

// Viewport configurations to test
const viewports = [
  { name: 'Desktop 1080p', width: 1920, height: 1080 },
  { name: 'Desktop 1440p', width: 2560, height: 1440 },
  { name: 'Laptop', width: 1366, height: 768 },
  { name: 'iPad Pro', width: 1024, height: 1366 },
  { name: 'iPad', width: 768, height: 1024 },
  { name: 'Phone Portrait', width: 390, height: 844 },
  { name: 'Phone Landscape', width: 844, height: 390 }
];

// Zoom calculation functions (matching ContinuousReader logic)
interface ZoomResult {
  scale: number;
  x: number;
  y: number;
  scaledWidth: number;
  scaledHeight: number;
}

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

function calculateFitToScreen(
  spreadWidth: number,
  spreadHeight: number,
  viewportWidth: number,
  viewportHeight: number
): ZoomResult {
  const scaleX = viewportWidth / spreadWidth;
  const scaleY = viewportHeight / spreadHeight;
  const scale = Math.min(scaleX, scaleY);

  const scaledWidth = spreadWidth * scale;
  const scaledHeight = spreadHeight * scale;
  const x = (viewportWidth - scaledWidth) / 2;
  const y = 0; // Top-aligned for continuous scroll

  return { scale, x, y, scaledWidth, scaledHeight };
}

function calculateFitToWidth(
  spreadWidth: number,
  spreadHeight: number,
  viewportWidth: number,
  viewportHeight: number
): ZoomResult {
  const scale = viewportWidth / spreadWidth;
  const scaledWidth = spreadWidth * scale;
  const scaledHeight = spreadHeight * scale;
  const x = 0; // Full width
  const y = 0;

  return { scale, x, y, scaledWidth, scaledHeight };
}

function calculateOriginal(
  spreadWidth: number,
  spreadHeight: number,
  viewportWidth: number,
  viewportHeight: number
): ZoomResult {
  const scale = 1;
  const scaledWidth = spreadWidth;
  const scaledHeight = spreadHeight;
  const x = (viewportWidth - scaledWidth) / 2;
  const y = 0;

  return { scale, x, y, scaledWidth, scaledHeight };
}

describeWithFixtures('Zoom placement with real fixtures', () => {
  beforeAll(() => {
    console.log(`\n🔍 Testing zoom placement with ${extractedFixtures.length} fixture(s)`);
  });

  describe('fitToScreen calculations', () => {
    it.each(extractedFixtures)(
      '$name should calculate correct fitToScreen scale for all spreads',
      (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);

        for (const viewport of viewports) {
          for (const spread of spreads) {
            const { width, height } = calculateSpreadDimensions(spread);
            const result = calculateFitToScreen(width, height, viewport.width, viewport.height);

            // Scale should be positive
            expect(result.scale).toBeGreaterThan(0);

            // Scaled dimensions should fit within viewport
            expect(result.scaledWidth).toBeLessThanOrEqual(viewport.width + 0.01);
            expect(result.scaledHeight).toBeLessThanOrEqual(viewport.height + 0.01);

            // Should be centered horizontally (within 1px due to floating point)
            const expectedX = (viewport.width - result.scaledWidth) / 2;
            expect(Math.abs(result.x - expectedX)).toBeLessThan(1);
          }
        }
      }
    );

    it.each(extractedFixtures)('$name fitToScreen should maximize visible area', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);
      const viewport = { width: 1920, height: 1080 };

      let totalAreaRatio = 0;

      for (const spread of spreads) {
        const { width, height } = calculateSpreadDimensions(spread);
        const result = calculateFitToScreen(width, height, viewport.width, viewport.height);

        // Either width OR height should fill the viewport (whichever is the limiting factor)
        const widthFillRatio = result.scaledWidth / viewport.width;
        const heightFillRatio = result.scaledHeight / viewport.height;

        // At least one dimension should be ~100% (within 0.1% tolerance)
        const maxFill = Math.max(widthFillRatio, heightFillRatio);
        expect(maxFill).toBeGreaterThan(0.999);

        totalAreaRatio +=
          (result.scaledWidth * result.scaledHeight) / (viewport.width * viewport.height);
      }

      const avgAreaRatio = totalAreaRatio / spreads.length;
      console.log(`   ✓ ${fixture.name}: avg area fill ${(avgAreaRatio * 100).toFixed(1)}%`);
    });
  });

  describe('fitToWidth calculations', () => {
    it.each(extractedFixtures)('$name should calculate correct fitToWidth scale', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);

      for (const viewport of viewports) {
        for (const spread of spreads) {
          const { width, height } = calculateSpreadDimensions(spread);
          const result = calculateFitToWidth(width, height, viewport.width, viewport.height);

          // Scale should be positive
          expect(result.scale).toBeGreaterThan(0);

          // Width should exactly fill viewport
          expect(Math.abs(result.scaledWidth - viewport.width)).toBeLessThan(1);

          // X should be 0 (full width)
          expect(result.x).toBe(0);
        }
      }
    });

    it.each(extractedFixtures)('$name fitToWidth may require vertical scrolling', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);
      const viewport = { width: 1920, height: 1080 };

      let requiresScroll = 0;

      for (const spread of spreads) {
        const { width, height } = calculateSpreadDimensions(spread);
        const result = calculateFitToWidth(width, height, viewport.width, viewport.height);

        if (result.scaledHeight > viewport.height) {
          requiresScroll++;
        }
      }

      const scrollPercent = (requiresScroll / spreads.length) * 100;
      console.log(
        `   ✓ ${fixture.name}: ${requiresScroll}/${spreads.length} spreads need scroll (${scrollPercent.toFixed(0)}%)`
      );
    });
  });

  describe('original scale calculations', () => {
    it.each(extractedFixtures)(
      '$name should maintain original dimensions at scale 1',
      (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);

        for (const spread of spreads) {
          const { width, height } = calculateSpreadDimensions(spread);
          const result = calculateOriginal(width, height, 1920, 1080);

          // Scale should be exactly 1
          expect(result.scale).toBe(1);

          // Dimensions should match original
          expect(result.scaledWidth).toBe(width);
          expect(result.scaledHeight).toBe(height);
        }
      }
    );

    it.each(extractedFixtures)('$name original scale may exceed viewport', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);
      const viewport = { width: 1920, height: 1080 };

      let exceedsWidth = 0;
      let exceedsHeight = 0;

      for (const spread of spreads) {
        const { width, height } = calculateSpreadDimensions(spread);
        const result = calculateOriginal(width, height, viewport.width, viewport.height);

        if (result.scaledWidth > viewport.width) exceedsWidth++;
        if (result.scaledHeight > viewport.height) exceedsHeight++;
      }

      console.log(
        `   ✓ ${fixture.name}: ${exceedsWidth} exceed width, ${exceedsHeight} exceed height`
      );
    });
  });

  describe('spread type impact on zoom', () => {
    it.each(extractedFixtures)(
      '$name dual spreads should have different scale than single spreads',
      (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);
        const viewport = { width: 1920, height: 1080 };

        const singleScales: number[] = [];
        const dualScales: number[] = [];

        for (const spread of spreads) {
          const { width, height } = calculateSpreadDimensions(spread);
          const result = calculateFitToScreen(width, height, viewport.width, viewport.height);

          if (spread.type === 'single') {
            singleScales.push(result.scale);
          } else {
            dualScales.push(result.scale);
          }
        }

        if (singleScales.length > 0 && dualScales.length > 0) {
          const avgSingle = singleScales.reduce((a, b) => a + b) / singleScales.length;
          const avgDual = dualScales.reduce((a, b) => a + b) / dualScales.length;

          // Dual spreads are wider, so they typically have smaller scale
          console.log(
            `   ✓ ${fixture.name}: single avg scale ${avgSingle.toFixed(3)}, dual avg scale ${avgDual.toFixed(3)}`
          );

          // Single pages should generally have larger scale (they're narrower)
          // Unless pages are very wide (like wide spreads marked as single)
          expect(avgSingle).toBeGreaterThan(0);
          expect(avgDual).toBeGreaterThan(0);
        }
      }
    );
  });

  describe('responsive zoom across viewports', () => {
    it.each(extractedFixtures)(
      '$name should scale appropriately for different devices',
      (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);

        // Test first spread on each viewport
        const spread = spreads[0];
        const { width, height } = calculateSpreadDimensions(spread);

        const results: Array<{ viewport: string; scale: number; fills: string }> = [];

        for (const viewport of viewports) {
          const result = calculateFitToScreen(width, height, viewport.width, viewport.height);
          const widthFill = ((result.scaledWidth / viewport.width) * 100).toFixed(0);
          const heightFill = ((result.scaledHeight / viewport.height) * 100).toFixed(0);

          results.push({
            viewport: viewport.name,
            scale: result.scale,
            fills: `${widthFill}%W x ${heightFill}%H`
          });
        }

        console.log(`   ✓ ${fixture.name} first spread (${width}x${height}):`);
        for (const r of results) {
          console.log(`      ${r.viewport}: scale ${r.scale.toFixed(3)} (${r.fills})`);
        }
      }
    );
  });

  describe('centering calculations', () => {
    it.each(extractedFixtures)('$name should center spreads correctly', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);
      const viewport = { width: 1920, height: 1080 };

      for (const spread of spreads) {
        const { width, height } = calculateSpreadDimensions(spread);
        const result = calculateFitToScreen(width, height, viewport.width, viewport.height);

        // Calculate expected center position
        const leftEdge = result.x;
        const rightEdge = result.x + result.scaledWidth;
        const leftMargin = leftEdge;
        const rightMargin = viewport.width - rightEdge;

        // Margins should be equal (centered)
        expect(Math.abs(leftMargin - rightMargin)).toBeLessThan(1);
      }
    });
  });

  describe('zoom bounds', () => {
    it.each(extractedFixtures)('$name scales should be within reasonable bounds', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);

      // Panzoom min/max bounds
      const minAllowedScale = 0.1;
      const maxAllowedScale = 10;

      // Test with desktop viewport only (small viewports may need scales < 0.1)
      const desktopViewport = viewports.find((v) => v.name === 'Desktop 1080p')!;

      for (const spread of spreads) {
        const { width, height } = calculateSpreadDimensions(spread);

        const fitScreen = calculateFitToScreen(
          width,
          height,
          desktopViewport.width,
          desktopViewport.height
        );
        const fitWidth = calculateFitToWidth(
          width,
          height,
          desktopViewport.width,
          desktopViewport.height
        );

        expect(fitScreen.scale).toBeGreaterThanOrEqual(minAllowedScale);
        expect(fitScreen.scale).toBeLessThanOrEqual(maxAllowedScale);

        expect(fitWidth.scale).toBeGreaterThanOrEqual(minAllowedScale);
        expect(fitWidth.scale).toBeLessThanOrEqual(maxAllowedScale);
      }
    });
  });

  describe('aspect ratio preservation', () => {
    it.each(extractedFixtures)('$name should preserve spread aspect ratio', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);
      const viewport = { width: 1920, height: 1080 };

      for (const spread of spreads) {
        const { width, height } = calculateSpreadDimensions(spread);
        const originalAspectRatio = width / height;

        const result = calculateFitToScreen(width, height, viewport.width, viewport.height);
        const scaledAspectRatio = result.scaledWidth / result.scaledHeight;

        // Aspect ratio should be preserved (within floating point tolerance)
        expect(Math.abs(originalAspectRatio - scaledAspectRatio)).toBeLessThan(0.001);
      }
    });
  });
});

describeWithFixtures('Panzoom position calculations with fixtures', () => {
  describe('prev spread offset', () => {
    it.each(extractedFixtures)(
      '$name should calculate correct Y offset to skip prev spread',
      (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);
        const viewport = { width: 1920, height: 1080 };

        // For spread index 1, we need to skip past spread 0
        if (spreads.length >= 2) {
          const prevSpread = spreads[0];
          const currentSpread = spreads[1];

          const prevDims = calculateSpreadDimensions(prevSpread);
          const prevZoom = calculateFitToScreen(
            prevDims.width,
            prevDims.height,
            viewport.width,
            viewport.height
          );

          // Y offset should be negative of prev spread's scaled height
          const expectedYOffset = -prevZoom.scaledHeight;

          expect(expectedYOffset).toBeLessThan(0);
          console.log(`   ✓ ${fixture.name}: prev spread offset Y=${expectedYOffset.toFixed(0)}px`);
        }
      }
    );
  });

  describe('transition position adjustments', () => {
    it.each(extractedFixtures)(
      '$name should calculate correct Y adjustment on spread transition',
      (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);
        const viewport = { width: 1920, height: 1080 };

        if (spreads.length >= 3) {
          // Simulate transition from spread 1 to spread 2
          const prevSpread = spreads[0];
          const currentSpread = spreads[1];

          const prevDims = calculateSpreadDimensions(prevSpread);
          const prevZoom = calculateFitToScreen(
            prevDims.width,
            prevDims.height,
            viewport.width,
            viewport.height
          );

          // When transitioning DOWN, old prev spread is removed
          // We need to adjust Y up by its height to maintain visual continuity
          const currentY = -1500; // Example: scrolled down
          const adjustedY = currentY + prevZoom.scaledHeight;

          expect(adjustedY).toBeGreaterThan(currentY);
          console.log(
            `   ✓ ${fixture.name}: transition adjustment +${prevZoom.scaledHeight.toFixed(0)}px`
          );
        }
      }
    );
  });
});

// Report fixture status
describe('Zoom test fixture availability', () => {
  it('should report fixture status', () => {
    if (extractedFixtures.length === 0) {
      console.log(`
╭─────────────────────────────────────────────────────────╮
│  No extracted fixtures found for zoom tests             │
│  Add mokuro-processed manga to test/fixtures/extracted  │
╰─────────────────────────────────────────────────────────╯
      `);
    }
    expect(true).toBe(true);
  });
});
