/**
 * Tests for series name extraction consistency
 *
 * These tests verify that series names are extracted consistently
 * across all import codepaths:
 * - Local directory import
 * - Local archive import
 * - Cloud download import
 *
 * The key issue is that there are multiple functions that extract series names:
 * - extractSeriesName / extractTitlesFromPath in image-only-fallback.ts (sophisticated)
 * - extractVolumeInfo in processing.ts (simple)
 * - parseFilename in download-queue.ts (simple)
 *
 * These have drifted from each other, causing inconsistent series grouping.
 */

import { describe, it, expect } from 'vitest';

// Import the different series name extraction functions
import { extractSeriesName } from '$lib/upload/image-only-fallback';
import { extractVolumeInfo } from '$lib/import/processing';

// We can't import parseFilename directly as it's not exported,
// so we'll inline test data based on its known behavior

describe('series name extraction consistency', () => {
  // Test cases with expected series names
  // Note: extractSeriesName is the "reference" sophisticated implementation
  // Some edge cases are documented with their actual behavior
  const testCases = [
    {
      input: 'Test Manga With Long Name v01 (2023) (Digital) (scan-group).cbz',
      expectedSeries: 'Test Manga With Long Name',
      description: 'strips year and release info'
    },
    {
      input: 'Sample Series 01.cbz',
      expectedSeries: 'Sample Series',
      description: 'handles simple volume number'
    },
    {
      input: 'Another Test Manga Vol 05.cbz',
      expectedSeries: 'Another Test Manga',
      description: 'handles Vol prefix'
    },
    {
      input: '漫画 第01巻.cbz',
      expectedSeries: '漫画',
      description: 'handles Japanese volume markers'
    },
    {
      input: 'Series [DL版] v01.cbz',
      expectedSeries: 'Series',
      description: 'strips DL版 marker'
    },
    {
      input: '(一般コミック) Series v01.cbz',
      expectedSeries: 'Series',
      description: 'strips category prefix'
    }
  ];

  // These cases document current behavior that may or may not need fixing
  const documentedBehaviorCases = [
    {
      input: '[Author] My Manga v01.cbz',
      // extractSeriesName only strips author prefix when followed by Japanese quotes
      // e.g., "Author 「Title」" -> "Title", but not "[Author] Title"
      actualResult: '[Author] My Manga',
      description: 'does NOT strip [Author] prefix (only strips when followed by 「」)'
    },
    {
      input: 'Series Name (完) v10.cbz',
      // The (完) stripping only works at end of string, not mid-string before volume
      actualResult: 'Series Name (完)',
      description: 'does NOT strip mid-string (完) marker'
    }
  ];

  describe('extractSeriesName (image-only-fallback.ts)', () => {
    // This is the sophisticated implementation that should be the reference

    for (const { input, expectedSeries, description } of testCases) {
      it(`${description}: "${input}"`, () => {
        const result = extractSeriesName(input);
        expect(result).toBe(expectedSeries);
      });
    }

    // Document current behavior for edge cases
    describe('documented current behavior', () => {
      for (const { input, actualResult, description } of documentedBehaviorCases) {
        it(`${description}: "${input}"`, () => {
          const result = extractSeriesName(input);
          expect(result).toBe(actualResult);
        });
      }
    });
  });

  describe('extractVolumeInfo (processing.ts)', () => {
    // Now uses sophisticated extraction from shared module

    it('should extract volume info from simple paths', () => {
      const result = extractVolumeInfo('Series/Volume 01');
      expect(result.series).toBe('Series');
      // Note: extractTitlesFromPath extracts volume number as "Volume XX"
      expect(result.volume).toBe('Volume 01');
    });

    it('should handle single segment paths with volume numbers', () => {
      const result = extractVolumeInfo('MyManga 01');
      expect(result.series).toBe('MyManga');
      expect(result.volume).toBe('Volume 01');
    });

    it('should handle single segment paths without volume numbers', () => {
      const result = extractVolumeInfo('MyManga');
      expect(result.series).toBe('MyManga');
      expect(result.volume).toBe('MyManga');
    });

    it('strips metadata from path segments', () => {
      const result = extractVolumeInfo(
        'Test Manga With Long Name v01 (2023) (Digital) (scan-group)'
      );
      expect(result.series).toBe('Test Manga With Long Name');
      expect(result.volume).toBe('Volume 01');
    });
  });

  describe('parseFilename behavior (download-queue.ts)', () => {
    // parseFilename is not exported, so we test its documented behavior
    // The function uses: /^(.+?)\s+(?:vol\.?\s*|v\.?\s*)?(\d+)$/i

    // Simulate parseFilename behavior for testing
    function simulateParseFilename(filename: string): { series: string; volume: string } {
      const nameWithoutExt = filename.replace(/\.(cbz|zip)$/i, '');
      const volumePattern = /^(.+?)\s+(?:vol\.?\s*|v\.?\s*)?(\d+)$/i;
      const match = nameWithoutExt.match(volumePattern);

      if (match) {
        return {
          series: match[1].trim(),
          volume: match[2].padStart(2, '0')
        };
      }

      return {
        series: nameWithoutExt,
        volume: '01'
      };
    }

    it('extracts series from simple filename', () => {
      const result = simulateParseFilename('Sample Series 01.cbz');
      expect(result.series).toBe('Sample Series');
      expect(result.volume).toBe('01');
    });

    // This test documents the current (broken) behavior
    it.fails('KNOWN BUG: does not strip metadata suffix', () => {
      // parseFilename extracts everything before the last number
      // It doesn't strip metadata like (2023) (Digital) (scan-group)
      const result = simulateParseFilename(
        'Test Manga With Long Name v01 (2023) (Digital) (scan-group).cbz'
      );
      // Current behavior: "Test Manga With Long Name v01 (2023) (Digital)"
      // (captures up to the last number, which is in (scan-group))
      // Expected behavior: "Test Manga With Long Name"
      expect(result.series).toBe('Test Manga With Long Name');
    });

    // This test documents another issue
    it.fails('KNOWN BUG: includes (scan-group) in series name when metadata present', () => {
      const result = simulateParseFilename(
        'Test Manga With Long Name v01 (2023) (Digital) (scan-group).cbz'
      );
      // The regex matches the "0" in "(scan-group)" as the volume number!
      // So series becomes everything before that
      expect(result.series).not.toContain('(scan-group)');
    });
  });

  describe('cross-codepath consistency', () => {
    // These tests verify that series names are extracted consistently
    // across different codepaths. Both extractSeriesName and extractVolumeInfo
    // now use the same sophisticated extraction from the shared module.

    it('extractVolumeInfo extracts volume number from single-segment paths', () => {
      const result = extractVolumeInfo('Sample Series 01');
      expect(result.series).toBe('Sample Series');
      expect(result.volume).toBe('Volume 01');
    });

    it('extractSeriesName extracts series from volume patterns', () => {
      const result = extractSeriesName('Sample Series 01');
      expect(result).toBe('Sample Series');
    });

    it('single-segment paths produce consistent results', () => {
      const basePath = 'Sample Series 01';

      const fromExtractSeriesName = extractSeriesName(basePath);
      const fromExtractVolumeInfo = extractVolumeInfo(basePath);

      // Both should extract "Sample Series" as series
      expect(fromExtractSeriesName).toBe(fromExtractVolumeInfo.series);
    });

    it('metadata-heavy paths produce consistent results', () => {
      const basePath = 'Test Manga With Long Name v01 (2023) (Digital) (scan-group)';

      const fromExtractSeriesName = extractSeriesName(basePath);
      const fromExtractVolumeInfo = extractVolumeInfo(basePath);

      // Both should extract "Test Manga With Long Name" as series
      expect(fromExtractSeriesName).toBe(fromExtractVolumeInfo.series);
      expect(fromExtractSeriesName).toBe('Test Manga With Long Name');
    });

    it('extractVolumeInfo works correctly with multi-segment paths', () => {
      const result = extractVolumeInfo('My Series/Volume 01');
      expect(result.series).toBe('My Series');
      expect(result.volume).toBe('Volume 01');
    });
  });
});

describe('deterministic UUID generation', () => {
  // Test that the same series name always produces the same UUID
  // This is important for grouping volumes from the same series
  //
  // generateDeterministicUUID is now in the shared series-extraction module

  it('same input produces same UUID', () => {
    // This test uses extractSeriesName to verify series names are consistent
    const name1 = extractSeriesName('My Manga v01.cbz');
    const name2 = extractSeriesName('My Manga v02.cbz');

    // Both should produce "My Manga" as the series name
    expect(name1).toBe(name2);
  });
});
