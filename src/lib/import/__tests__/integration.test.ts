/**
 * Integration tests for the import system
 *
 * Tests the full import flow: files → pairing → routing → processing → database
 * Uses real fixtures to verify end-to-end behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { loadFixture, type LoadedFixture } from './helpers/fixture-loader';

// ============================================
// MOCKS
// ============================================

// Track what gets saved to the database
const savedVolumes: Array<{
  metadata: Record<string, unknown>;
  ocr: { volume_uuid: string; pages: unknown[] };
  files: { volume_uuid: string; files: Record<string, File> };
}> = [];

// Mock the database
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      add: vi.fn().mockImplementation((data) => {
        // Store for assertions
        const existing = savedVolumes.find((v) => v.metadata.volume_uuid === data.volume_uuid);
        if (!existing) {
          savedVolumes.push({
            metadata: data,
            ocr: { volume_uuid: data.volume_uuid, pages: [] },
            files: { volume_uuid: data.volume_uuid, files: {} }
          });
        }
        return Promise.resolve();
      }),
      get: vi.fn(),
      where: vi.fn().mockReturnValue({
        equals: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation((uuid) => {
            // Check if volume already exists
            const existing = savedVolumes.find((v) => v.metadata.volume_uuid === uuid);
            return Promise.resolve(existing?.metadata);
          })
        })
      })
    },
    volume_ocr: {
      add: vi.fn().mockImplementation((data) => {
        const volume = savedVolumes.find((v) => v.metadata.volume_uuid === data.volume_uuid);
        if (volume) {
          volume.ocr = data;
        }
        return Promise.resolve();
      }),
      get: vi.fn()
    },
    volume_files: {
      add: vi.fn().mockImplementation((data) => {
        const volume = savedVolumes.find((v) => v.metadata.volume_uuid === data.volume_uuid);
        if (volume) {
          volume.files = data;
        }
        return Promise.resolve();
      }),
      get: vi.fn()
    },
    transaction: vi
      .fn()
      .mockImplementation(
        async (_mode: string, _tables: unknown[], callback: () => Promise<void>) => {
          await callback();
        }
      )
  }
}));

// Mock thumbnail generation
vi.mock('$lib/catalog/thumbnails', () => ({
  generateThumbnail: vi.fn().mockResolvedValue({
    file: new File([], 'thumbnail.jpg'),
    width: 200,
    height: 300
  })
}));

// Mock snackbar
vi.mock('$lib/util/snackbar', () => ({
  showSnackbar: vi.fn()
}));

// Mock progress tracker
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: {
    addProcess: vi.fn(),
    updateProcess: vi.fn(),
    removeProcess: vi.fn()
  }
}));

// Mock modals - auto-confirm image-only imports and missing files
vi.mock('$lib/util/modals', () => ({
  promptImageOnlyImport: vi
    .fn()
    .mockImplementation((_seriesList, _totalCount, onConfirm, _onCancel) => {
      // Auto-confirm image-only imports in tests
      setTimeout(() => onConfirm(), 0);
    }),
  promptMissingFiles: vi.fn().mockImplementation((_info, onContinue, _onCancel) => {
    // Auto-continue with missing files in tests
    setTimeout(() => onContinue(), 0);
  })
}));

// Worker pool mock - only needed for non-archive operations
// Archive operations now use direct extraction in test environment (detected via __vitest__)
vi.mock('$lib/util/file-processing-pool', () => ({
  getFileProcessingPool: vi.fn().mockResolvedValue({
    addTask: vi.fn()
  }),
  incrementPoolUsers: vi.fn(),
  decrementPoolUsers: vi.fn()
}));

// Import after mocks are set up
import { importFiles, importQueue, isImporting, clearCompletedImports } from '../import-service';
import { showSnackbar } from '$lib/util/snackbar';

// ============================================
// TEST HELPERS
// ============================================

/**
 * Convert fixture FileEntry[] to File[] with webkitRelativePath
 * This simulates what the browser provides from file picker or drag-drop
 */
function fixtureToFiles(fixture: LoadedFixture): File[] {
  return fixture.inputs.map((entry) => {
    // Create a new File with webkitRelativePath
    const file = new File([entry.file], entry.file.name, {
      type: entry.file.type,
      lastModified: entry.file.lastModified
    });
    // Set webkitRelativePath (readonly property, need to use defineProperty)
    Object.defineProperty(file, 'webkitRelativePath', {
      value: entry.path,
      writable: false
    });
    return file;
  });
}

/**
 * Wait for imports to complete
 */
async function waitForImportsToComplete(timeout = 5000): Promise<void> {
  const start = Date.now();
  while (get(isImporting) && Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Additional wait for any pending async operations
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// ============================================
// TESTS
// ============================================

describe('importFiles integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedVolumes.length = 0;
    importQueue.set([]);
  });

  afterEach(async () => {
    // Clean up any pending imports
    clearCompletedImports();
    await waitForImportsToComplete();
  });

  describe('single volume imports (direct processing)', () => {
    it('imports a directory with mokuro file', async () => {
      const fixture = await loadFixture('basic', 'mokuro-inside-dir');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
      expect(result.failed).toBe(0);
      expect(savedVolumes).toHaveLength(1);
      expect(savedVolumes[0].metadata.series_title).toBeDefined();
    });

    it('imports a directory with external mokuro file', async () => {
      const fixture = await loadFixture('basic', 'mokuro-with-same-name-dir');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
      expect(savedVolumes).toHaveLength(1);
    });

    it('imports a directory with differently named mokuro file', async () => {
      const fixture = await loadFixture('basic', 'mokuro-different-name');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
    });

    it('imports an image-only directory', async () => {
      const fixture = await loadFixture('image-only', 'directory-no-mokuro');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
      expect(savedVolumes).toHaveLength(1);
      expect(savedVolumes[0].metadata.mokuro_version).toBe(''); // Image-only marker
    });
  });

  describe('multiple volume imports (queued processing)', () => {
    it('queues multiple directories with mokuro files', async () => {
      const fixture = await loadFixture('multiple-volumes', 'multiple-dirs-with-mokuro');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      // Multiple items go to queue
      expect(result.imported).toBe(2);
    });

    it('queues multiple image-only directories', async () => {
      const fixture = await loadFixture('image-only', 'multiple-dirs-no-mokuro');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      expect(result.imported).toBe(2);
    });
  });

  describe('TOC format handling', () => {
    it('imports TOC format as single volume with chapters', async () => {
      const fixture = await loadFixture('toc-format', 'mokuro-with-chapter-subdirs');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
      expect(savedVolumes).toHaveLength(1);
      // TOC volumes should have more pages (from multiple chapters)
      expect(savedVolumes[0].metadata.page_count).toBeGreaterThan(0);
    });

    it('imports deeply nested TOC chapters', async () => {
      const fixture = await loadFixture('toc-format', 'toc-deeply-nested-chapters');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('handles deeply nested directory structure', async () => {
      const fixture = await loadFixture('edge-cases', 'deeply-nested-structure');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
    });

    it('ignores non-manga files', async () => {
      const fixture = await loadFixture('edge-cases', 'ignores-non-manga-files');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
      // Should only have image files, not txt or DS_Store
      const savedFiles = savedVolumes[0].files.files;
      const fileNames = Object.keys(savedFiles);
      expect(fileNames.every((name) => /\.(jpg|jpeg|png|webp)$/i.test(name))).toBe(true);
    });

    it('handles unicode names', async () => {
      const fixture = await loadFixture('edge-cases', 'unicode-names');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
    });

    it('handles case-insensitive archive matching', async () => {
      const fixture = await loadFixture('edge-cases', 'case-insensitive-matching');
      const files = fixtureToFiles(fixture);

      console.log(
        'Test files:',
        files.map((f) => `${f.name} (${f.size} bytes)`)
      );

      const result = await importFiles(files);

      console.log('Import result:', JSON.stringify(result, null, 2));
      console.log('Saved volumes:', savedVolumes.length);

      // External mokuro pairs with flat archive (images at root level)
      // Tests the fix for root-level basePath matching
      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
      expect(savedVolumes).toHaveLength(1);
    });

    it('returns early for empty file list', async () => {
      const result = await importFiles([]);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(0);
      expect(savedVolumes).toHaveLength(0);
    });

    it('handles empty directory (mokuro with no images)', async () => {
      const fixture = await loadFixture('edge-cases', 'empty-directory');
      const files = fixtureToFiles(fixture);

      const result = await importFiles(files);

      // Should show "no importable volumes" since mokuro has no images
      expect(showSnackbar).toHaveBeenCalledWith('No importable volumes found');
      expect(result.imported).toBe(0);
    });
  });

  describe('stores and state', () => {
    it('sets isImporting to false after import completes', async () => {
      const fixture = await loadFixture('basic', 'mokuro-inside-dir');
      const files = fixtureToFiles(fixture);

      // Check initial state
      expect(get(isImporting)).toBe(false);

      // For single items, processing is synchronous so isImporting
      // may already be false by the time we check. Just verify it
      // ends up false after completion.
      await importFiles(files);

      // Should be done
      expect(get(isImporting)).toBe(false);
    });
  });

  describe('database operations', () => {
    it('saves metadata with correct structure', async () => {
      const fixture = await loadFixture('basic', 'mokuro-inside-dir');
      const files = fixtureToFiles(fixture);

      await importFiles(files);

      const metadata = savedVolumes[0].metadata;
      expect(metadata).toHaveProperty('volume_uuid');
      expect(metadata).toHaveProperty('series_uuid');
      expect(metadata).toHaveProperty('series_title');
      expect(metadata).toHaveProperty('volume_title');
      expect(metadata).toHaveProperty('page_count');
      expect(metadata).toHaveProperty('character_count');
      expect(metadata).toHaveProperty('mokuro_version');
    });

    it('saves OCR data with pages', async () => {
      const fixture = await loadFixture('basic', 'mokuro-inside-dir');
      const files = fixtureToFiles(fixture);

      await importFiles(files);

      const ocr = savedVolumes[0].ocr;
      expect(ocr.volume_uuid).toBeDefined();
      expect(ocr.pages).toBeInstanceOf(Array);
      expect(ocr.pages.length).toBeGreaterThan(0);
    });

    it('saves files with images', async () => {
      const fixture = await loadFixture('basic', 'mokuro-inside-dir');
      const files = fixtureToFiles(fixture);

      await importFiles(files);

      const fileData = savedVolumes[0].files;
      expect(fileData.volume_uuid).toBeDefined();
      expect(Object.keys(fileData.files).length).toBeGreaterThan(0);
    });

    it('generates and saves thumbnail', async () => {
      const fixture = await loadFixture('basic', 'mokuro-inside-dir');
      const files = fixtureToFiles(fixture);

      await importFiles(files);

      const metadata = savedVolumes[0].metadata;
      expect(metadata.thumbnail).toBeDefined();
      expect(metadata.thumbnail_width).toBeGreaterThan(0);
      expect(metadata.thumbnail_height).toBeGreaterThan(0);
    });

    it('calculates page character counts', async () => {
      const fixture = await loadFixture('basic', 'mokuro-inside-dir');
      const files = fixtureToFiles(fixture);

      await importFiles(files);

      const metadata = savedVolumes[0].metadata;
      expect(metadata.page_char_counts).toBeInstanceOf(Array);
    });
  });
});

describe('importFiles with archives', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedVolumes.length = 0;
    importQueue.set([]);
  });

  // Archive tests now use direct extraction in test environment
  // This tests the full archive import pipeline without mocking

  it('pairs archive with external mokuro file', async () => {
    const fixture = await loadFixture('internal-mokuro', 'archive-with-external-mokuro');
    const files = fixtureToFiles(fixture);

    const result = await importFiles(files);

    // External mokuro pairs with archive and imports successfully
    expect(result.success).toBe(true);
    expect(result.imported).toBe(1);
    expect(savedVolumes).toHaveLength(1);
  });

  it('handles standalone archive (internal mokuro)', async () => {
    const fixture = await loadFixture('internal-mokuro', 'standalone-archive');
    const files = fixtureToFiles(fixture);

    const result = await importFiles(files);

    // Archive with internal mokuro imports successfully
    expect(result.success).toBe(true);
    expect(result.imported).toBe(1);
    expect(savedVolumes).toHaveLength(1);
  });
});
