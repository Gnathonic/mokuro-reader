/**
 * Tests for the mokuro-source pairing logic
 *
 * These tests use fixture directories from ./fixtures/
 * Each fixture has an input/ directory and expected.json file
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  loadFixture,
  loadFixtureCategory,
  loadAllFixtures,
  listFixtureCategories,
  type LoadedFixture
} from './helpers/fixture-loader';
import { pairMokuroWithSources } from '../pairing';
import type { PairedSource, ExpectedPairingDetail } from '../types';

/**
 * Helper to assert a pairing matches expected
 */
function assertPairingMatches(
  actual: PairedSource,
  expected: ExpectedPairingDetail,
  index: number
): void {
  const prefix = `Pairing ${index}:`;

  // Check source type
  expect(actual.source.type, `${prefix} source type`).toBe(expected.sourceType);

  // Check mokuro presence
  if (expected.hasMokuro) {
    expect(actual.mokuroFile, `${prefix} should have mokuro file`).not.toBeNull();
  } else {
    expect(actual.mokuroFile, `${prefix} should not have mokuro file`).toBeNull();
  }

  // Check base path contains expected substring
  expect(
    actual.basePath.toLowerCase(),
    `${prefix} basePath should contain "${expected.basePathContains}"`
  ).toContain(expected.basePathContains.toLowerCase());

  // Check image-only flag
  expect(actual.imageOnly, `${prefix} imageOnly`).toBe(expected.imageOnly);

  // Check file count for directory sources
  if (expected.fileCount !== undefined && actual.source.type === 'directory') {
    expect(actual.source.files.size, `${prefix} file count`).toBe(expected.fileCount);
  }

  // Check chapter names for TOC sources
  if (expected.chapterNames !== undefined && actual.source.type === 'toc-directory') {
    const actualChapters = Array.from(actual.source.chapters.keys()).sort();
    const expectedChapters = [...expected.chapterNames].sort();
    expect(actualChapters, `${prefix} chapter names`).toEqual(expectedChapters);
  }
}

/**
 * Run pairing test for a fixture
 */
async function runFixtureTest(fixture: LoadedFixture): Promise<void> {
  const { inputs, expected, name, category } = fixture;

  // If an error is expected, assert it throws
  if (expected.error) {
    await expect(
      pairMokuroWithSources(inputs),
      `${category}/${name}: should throw "${expected.error}"`
    ).rejects.toThrow(expected.error);
    return;
  }

  // Run the pairing logic
  const result = await pairMokuroWithSources(inputs);

  // Check pairing count
  expect(result.pairings.length, `${category}/${name}: pairing count`).toBe(expected.count);

  // Check each pairing matches expected
  for (let i = 0; i < expected.pairings.length; i++) {
    assertPairingMatches(result.pairings[i], expected.pairings[i], i);
  }

  // Check warnings if specified
  if (expected.warnings) {
    expect(result.warnings).toEqual(expect.arrayContaining(expected.warnings));
  }
}

// ============================================
// FIXTURE-BASED TESTS
// ============================================

describe('pairMokuroWithSources', () => {
  let categories: string[] = [];

  beforeAll(async () => {
    try {
      categories = await listFixtureCategories();
    } catch (e) {
      console.warn('Could not load fixture categories:', e);
    }
  });

  // Dynamic test generation from fixtures
  describe('basic pairing', () => {
    it.each([
      'mokuro-with-same-name-dir',
      'mokuro-with-same-name-archive',
      'mokuro-inside-dir',
      'mokuro-different-name'
    ])('%s', async (fixtureName) => {
      try {
        const fixture = await loadFixture('basic', fixtureName);
        await runFixtureTest(fixture);
      } catch (e) {
        if ((e as Error).message.includes('Fixture not found')) {
          // Skip if fixture doesn't exist yet
          console.warn(`Fixture basic/${fixtureName} not found, skipping`);
          return;
        }
        throw e;
      }
    });
  });

  describe('TOC format detection', () => {
    it.each([
      'mokuro-with-chapter-subdirs',
      'not-toc-with-sibling-images',
      'toc-deeply-nested-chapters'
    ])('%s', async (fixtureName) => {
      try {
        const fixture = await loadFixture('toc-format', fixtureName);
        await runFixtureTest(fixture);
      } catch (e) {
        if ((e as Error).message.includes('Fixture not found')) {
          console.warn(`Fixture toc-format/${fixtureName} not found, skipping`);
          return;
        }
        throw e;
      }
    });
  });

  describe('internal mokuro detection', () => {
    it.each(['standalone-archive', 'archive-with-external-mokuro', 'mixed-external-and-internal'])(
      '%s',
      async (fixtureName) => {
        try {
          const fixture = await loadFixture('internal-mokuro', fixtureName);
          await runFixtureTest(fixture);
        } catch (e) {
          if ((e as Error).message.includes('Fixture not found')) {
            console.warn(`Fixture internal-mokuro/${fixtureName} not found, skipping`);
            return;
          }
          throw e;
        }
      }
    );
  });

  describe('multiple volumes', () => {
    it.each(['multiple-dirs-with-mokuro', 'multiple-archives-with-mokuro', 'bundle-archive'])(
      '%s',
      async (fixtureName) => {
        try {
          const fixture = await loadFixture('multiple-volumes', fixtureName);
          await runFixtureTest(fixture);
        } catch (e) {
          if ((e as Error).message.includes('Fixture not found')) {
            console.warn(`Fixture multiple-volumes/${fixtureName} not found, skipping`);
            return;
          }
          throw e;
        }
      }
    );
  });

  describe('image-only', () => {
    it.each(['directory-no-mokuro', 'multiple-dirs-no-mokuro'])('%s', async (fixtureName) => {
      try {
        const fixture = await loadFixture('image-only', fixtureName);
        await runFixtureTest(fixture);
      } catch (e) {
        if ((e as Error).message.includes('Fixture not found')) {
          console.warn(`Fixture image-only/${fixtureName} not found, skipping`);
          return;
        }
        throw e;
      }
    });
  });

  describe('edge cases', () => {
    it.each([
      'mokuro-root-images-subdir',
      'ignores-non-manga-files',
      'deeply-nested-structure',
      'multiple-mokuro-same-dir',
      'empty-directory',
      'stem-matching-with-special-chars',
      'prefers-directory-over-archive',
      'case-insensitive-matching',
      'unicode-names'
    ])('%s', async (fixtureName) => {
      try {
        const fixture = await loadFixture('edge-cases', fixtureName);
        await runFixtureTest(fixture);
      } catch (e) {
        if ((e as Error).message.includes('Fixture not found')) {
          console.warn(`Fixture edge-cases/${fixtureName} not found, skipping`);
          return;
        }
        throw e;
      }
    });
  });
});

// ============================================
// RUN ALL FIXTURES TEST
// ============================================

describe('all fixtures', () => {
  it('should pass all available fixtures', async () => {
    const fixtures = await loadAllFixtures();

    if (fixtures.length === 0) {
      console.warn('No fixtures found, skipping all-fixtures test');
      return;
    }

    const results: { fixture: string; passed: boolean; error?: string }[] = [];

    for (const fixture of fixtures) {
      try {
        await runFixtureTest(fixture);
        results.push({ fixture: `${fixture.category}/${fixture.name}`, passed: true });
      } catch (e) {
        results.push({
          fixture: `${fixture.category}/${fixture.name}`,
          passed: false,
          error: (e as Error).message
        });
      }
    }

    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      const failureReport = failed.map((f) => `  - ${f.fixture}: ${f.error}`).join('\n');
      throw new Error(`${failed.length}/${fixtures.length} fixtures failed:\n${failureReport}`);
    }
  });
});

// ============================================
// SYSTEM FILE FILTERING TESTS
// ============================================

describe('system file filtering', () => {
  it('should exclude __MACOSX directories from pairing', async () => {
    const entries = [
      { path: 'manga/page1.jpg', file: new File([''], 'page1.jpg') },
      { path: 'manga/page2.jpg', file: new File([''], 'page2.jpg') },
      { path: '__MACOSX/manga/._page1.jpg', file: new File([''], '._page1.jpg') },
      { path: '__MACOSX/._manga', file: new File([''], '._manga') }
    ];

    const result = await pairMokuroWithSources(entries);

    // Should only have one pairing for the manga folder
    expect(result.pairings.length).toBe(1);
    expect(result.pairings[0].basePath).toBe('manga');

    // __MACOSX should NOT be paired as image-only
    const macosxPairing = result.pairings.find((p) => p.basePath.includes('MACOSX'));
    expect(macosxPairing).toBeUndefined();
  });

  it('should exclude .DS_Store from image count', async () => {
    const entries = [
      { path: 'manga/page1.jpg', file: new File([''], 'page1.jpg') },
      { path: 'manga/.DS_Store', file: new File([''], '.DS_Store') }
    ];

    const result = await pairMokuroWithSources(entries);

    expect(result.pairings.length).toBe(1);
    if (result.pairings[0].source.type === 'directory') {
      // Should only have the image, not .DS_Store
      expect(result.pairings[0].source.files.size).toBe(1);
    }
  });

  it('should exclude Thumbs.db from image directories', async () => {
    const entries = [
      { path: 'manga/page1.jpg', file: new File([''], 'page1.jpg') },
      { path: 'manga/Thumbs.db', file: new File([''], 'Thumbs.db') }
    ];

    const result = await pairMokuroWithSources(entries);

    expect(result.pairings.length).toBe(1);
    if (result.pairings[0].source.type === 'directory') {
      expect(result.pairings[0].source.files.size).toBe(1);
    }
  });

  it('should exclude resource fork files (._prefix)', async () => {
    const entries = [
      { path: 'manga/page1.jpg', file: new File([''], 'page1.jpg') },
      { path: 'manga/._page1.jpg', file: new File([''], '._page1.jpg') }
    ];

    const result = await pairMokuroWithSources(entries);

    expect(result.pairings.length).toBe(1);
    if (result.pairings[0].source.type === 'directory') {
      expect(result.pairings[0].source.files.size).toBe(1);
    }
  });

  it('should not create pairings for system-only directories', async () => {
    const entries = [
      { path: '__MACOSX/._file', file: new File([''], '._file') },
      { path: '.Trash/file.jpg', file: new File([''], 'file.jpg') }
    ];

    const result = await pairMokuroWithSources(entries);

    // All entries are system files, no valid pairings
    expect(result.pairings.length).toBe(0);
  });
});
