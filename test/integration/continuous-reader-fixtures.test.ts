/**
 * Integration tests for ContinuousReader using real fixtures.
 *
 * Uses extracted fixtures (fast) when available, falls back to CBZ (slow).
 * Add mokuro-processed manga to test/fixtures/ to run these tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  getExtractedFixtures,
  getCBZFixtures,
  loadExtractedMokuro,
  hasExtractedFixtures,
  type ExtractedFixture
} from '../fixtures/fixture-loader';

// Get extracted fixtures (preferred - fast)
const extractedFixtures = getExtractedFixtures();
const cbzFixtures = getCBZFixtures();

const hasFixtures = extractedFixtures.length > 0;
const describeWithFixtures = hasFixtures ? describe : describe.skip;

describeWithFixtures('ContinuousReader with real fixtures', () => {
  beforeAll(() => {
    console.log(`\n📦 Found ${extractedFixtures.length} extracted fixture(s):`);
    extractedFixtures.forEach((f) => {
      console.log(`   - ${f.name} (${f.imageFiles.length} images)`);
    });
    if (cbzFixtures.length > 0) {
      console.log(`📦 Also found ${cbzFixtures.length} CBZ fixture(s) for ZIP tests`);
    }
  });

  describe('fixture loading', () => {
    it.each(extractedFixtures)('should load $name mokuro data', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);

      expect(mokuroData).toBeDefined();
      expect(mokuroData.pages).toBeInstanceOf(Array);
      expect(mokuroData.pages.length).toBeGreaterThan(0);

      console.log(`   ✓ ${fixture.name}: ${mokuroData.pages.length} pages`);
    });
  });

  describe('mokuro data structure', () => {
    it.each(extractedFixtures)('$name should have valid page structure', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);

      // Check required fields
      expect(mokuroData.version).toBeDefined();
      expect(mokuroData.title).toBeDefined();
      expect(mokuroData.pages).toBeInstanceOf(Array);

      // Check each page has required fields
      for (const page of mokuroData.pages) {
        expect(page.img_width).toBeGreaterThan(0);
        expect(page.img_height).toBeGreaterThan(0);
        expect(page.img_path).toBeDefined();
        expect(page.blocks).toBeInstanceOf(Array);
      }
    });

    it.each(extractedFixtures)('$name should have matching image files', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const { imageFiles } = fixture;
      let matchedCount = 0;

      for (const page of mokuroData.pages) {
        const imgPath = page.img_path;
        // Check various path matching strategies
        const hasMatch = imageFiles.some(
          (f) =>
            f === imgPath ||
            f.endsWith(imgPath) ||
            imgPath.endsWith(f) ||
            f.split('/').pop() === imgPath.split('/').pop()
        );

        if (hasMatch) matchedCount++;
      }

      const matchRate = matchedCount / mokuroData.pages.length;
      console.log(
        `   ✓ ${fixture.name}: ${matchedCount}/${mokuroData.pages.length} images matched (${(matchRate * 100).toFixed(0)}%)`
      );

      expect(matchRate).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('spread grouping with real data', () => {
    it.each(extractedFixtures)('$name should group into valid spreads', async (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const { groupPagesIntoSpreads } = await import('../../src/lib/reader/spread-grouping');

      const spreads = groupPagesIntoSpreads(
        mokuroData.pages,
        'auto',
        true, // hasCover
        true // rtl
      );

      expect(spreads.length).toBeGreaterThan(0);

      // Verify all pages are covered
      const coveredPages = spreads.flatMap((s) => s.pageIndices);
      expect(coveredPages.length).toBe(mokuroData.pages.length);

      // Verify spreads are sequential
      let expectedIndex = 0;
      for (const spread of spreads) {
        for (const pageIdx of spread.pageIndices) {
          expect(pageIdx).toBe(expectedIndex);
          expectedIndex++;
        }
      }

      // Count spread types
      const singleCount = spreads.filter((s) => s.type === 'single').length;
      const dualCount = spreads.filter((s) => s.type === 'dual').length;

      console.log(
        `   ✓ ${fixture.name}: ${spreads.length} spreads (${singleCount} single, ${dualCount} dual)`
      );
    });

    it.each(extractedFixtures)(
      '$name spreads should handle different page modes',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const { groupPagesIntoSpreads } = await import('../../src/lib/reader/spread-grouping');

        // Test single mode
        const singleSpreads = groupPagesIntoSpreads(mokuroData.pages, 'single', true, true);
        expect(singleSpreads.every((s) => s.type === 'single')).toBe(true);
        expect(singleSpreads.length).toBe(mokuroData.pages.length);

        // Test dual mode
        const dualSpreads = groupPagesIntoSpreads(mokuroData.pages, 'dual', false, true);
        const expectedDualCount = Math.ceil(mokuroData.pages.length / 2);
        expect(dualSpreads.length).toBe(expectedDualCount);
      }
    );
  });

  describe('page dimensions', () => {
    it.each(extractedFixtures)('$name should have reasonable page dimensions', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);

      const widths = mokuroData.pages.map((p: any) => p.img_width);
      const heights = mokuroData.pages.map((p: any) => p.img_height);

      const avgWidth = widths.reduce((a: number, b: number) => a + b, 0) / widths.length;
      const avgHeight = heights.reduce((a: number, b: number) => a + b, 0) / heights.length;
      const avgAspectRatio = avgWidth / avgHeight;

      expect(avgWidth).toBeGreaterThan(100);
      expect(avgHeight).toBeGreaterThan(100);

      console.log(
        `   ✓ ${fixture.name}: avg ${avgWidth.toFixed(0)}x${avgHeight.toFixed(0)} (AR: ${avgAspectRatio.toFixed(2)})`
      );
    });

    it.each(extractedFixtures)('$name should detect wide spreads correctly', async (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);
      const { isWideSpread } = await import('../../src/lib/reader/page-mode-detection');

      const wideSpreads = mokuroData.pages.filter((p: any) => isWideSpread(p));
      const widePercent = (wideSpreads.length / mokuroData.pages.length) * 100;

      console.log(
        `   ✓ ${fixture.name}: ${wideSpreads.length} wide spreads (${widePercent.toFixed(1)}%)`
      );

      // Wide spreads should be relatively rare in manga (usually < 20%)
      expect(widePercent).toBeLessThan(50);
    });
  });

  describe('text extraction', () => {
    it.each(extractedFixtures)('$name should have extractable text', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);

      let totalChars = 0;
      let totalBlocks = 0;
      let pagesWithText = 0;

      for (const page of mokuroData.pages) {
        let pageChars = 0;
        for (const block of page.blocks) {
          totalBlocks++;
          if (block.lines) {
            for (const line of block.lines) {
              totalChars += line.length;
              pageChars += line.length;
            }
          }
        }
        if (pageChars > 0) pagesWithText++;
      }

      const avgCharsPerPage = totalChars / mokuroData.pages.length;

      console.log(
        `   ✓ ${fixture.name}: ${totalChars} chars, ${totalBlocks} blocks, ${pagesWithText}/${mokuroData.pages.length} pages with text`
      );

      // Should have some text blocks
      expect(totalBlocks).toBeGreaterThan(0);
    });

    it.each(extractedFixtures)('$name text blocks should have valid structure', (fixture) => {
      const mokuroData = loadExtractedMokuro(fixture);

      for (const page of mokuroData.pages) {
        for (const block of page.blocks) {
          // Each block should have lines array
          expect(block.lines).toBeInstanceOf(Array);

          // Each block should have bounding box
          expect(block.box).toBeInstanceOf(Array);
          expect(block.box.length).toBe(4);

          // Box coordinates should be numbers (can be negative for OCR edge cases)
          const [x1, y1, x2, y2] = block.box;
          expect(typeof x1).toBe('number');
          expect(typeof y1).toBe('number');
          expect(typeof x2).toBe('number');
          expect(typeof y2).toBe('number');

          // x2 should be >= x1, y2 should be >= y1 (box has positive dimensions)
          expect(x2).toBeGreaterThanOrEqual(x1);
          expect(y2).toBeGreaterThanOrEqual(y1);
        }
      }
    });
  });

  describe('keyboard navigation simulation', () => {
    it.each(extractedFixtures)(
      '$name should calculate valid navigation states',
      async (fixture) => {
        const mokuroData = loadExtractedMokuro(fixture);
        const { groupPagesIntoSpreads } = await import('../../src/lib/reader/spread-grouping');
        const { getNavigationAction } = await import(
          '../../src/lib/reader/continuous-keyboard-nav'
        );

        const spreads = groupPagesIntoSpreads(mokuroData.pages, 'auto', true, true);

        // Simulate navigation at start
        const startState = {
          currentSpreadIndex: 0,
          totalSpreads: spreads.length,
          panY: 0,
          spreadHeight: 1500,
          viewportHeight: 1080
        };

        // PageDown should go to next spread
        const pageDownAction = getNavigationAction('PageDown', startState);
        if (spreads.length > 1) {
          expect(pageDownAction.type).toBe('jump_spread');
        } else {
          expect(pageDownAction.type).toBe('volume_nav');
        }

        // Simulate navigation at end
        const endState = {
          ...startState,
          currentSpreadIndex: spreads.length - 1
        };

        // PageDown at end should navigate to next volume
        const endAction = getNavigationAction('PageDown', endState);
        expect(endAction.type).toBe('volume_nav');

        console.log(`   ✓ ${fixture.name}: navigation valid for ${spreads.length} spreads`);
      }
    );
  });
});

// Report fixture status
describe('Fixture availability', () => {
  it('should report fixture status', () => {
    if (extractedFixtures.length === 0) {
      console.log(`
╭─────────────────────────────────────────────────────────╮
│  No extracted fixtures found in test/fixtures/extracted │
│                                                         │
│  To set up fixtures:                                    │
│  1. Add .cbz files to test/fixtures/                    │
│  2. Run: cd test/fixtures && for f in *.cbz; do         │
│       unzip -q "$f" -d "extracted/\${f%.cbz}"; done      │
╰─────────────────────────────────────────────────────────╯
      `);
    }
    expect(true).toBe(true);
  });
});
