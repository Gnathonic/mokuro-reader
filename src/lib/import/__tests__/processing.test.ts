/**
 * Tests for unified volume processing
 *
 * The processing module takes decompressed volume data and prepares it
 * for database storage: parsing mokuro, matching images, generating thumbnails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processVolume,
  parseMokuroFile,
  matchImagesToPages,
  extractVolumeInfo,
  keepRasterImages
} from '../processing';
import { generateThumbnail } from '$lib/catalog/thumbnails';
import type { DecompressedVolume } from '../types';
import { RUNNER_OUTPUT_DOCUMENT, RUNNER_OUTPUT_SEAL } from '$lib/catalog/__fixtures__/seal-vector';

// Mock thumbnail generation since we can't use canvas in tests
vi.mock('$lib/catalog/thumbnails', () => ({
  generateThumbnail: vi.fn().mockResolvedValue({
    file: new File([], 'thumbnail.jpg'),
    width: 200,
    height: 300
  })
}));

/**
 * Helper to create a valid mokuro JSON file
 * Uses Blob with text() method that works in jsdom
 */
function createMokuroFile(
  overrides: Partial<{
    version: string;
    title: string;
    title_uuid: string;
    volume: string;
    volume_uuid: string;
    pages: Array<{ img_path: string; blocks: unknown[] }>;
    chars: number;
  }> = {}
): File {
  const data = {
    version: '0.2.0',
    title: 'Test Series',
    title_uuid: 'series-uuid-123',
    volume: 'Test Volume 01',
    volume_uuid: 'volume-uuid-456',
    pages: [
      { img_path: 'page001.jpg', blocks: [] },
      { img_path: 'page002.jpg', blocks: [] }
    ],
    chars: 100,
    ...overrides
  };
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: 'application/json' });
  // Create a File-like object with text() method
  return Object.assign(blob, {
    name: 'test.mokuro',
    lastModified: Date.now()
  }) as unknown as File;
}

/**
 * Helper to create image files
 */
function createImageFiles(names: string[]): Map<string, File> {
  const files = new Map<string, File>();
  for (const name of names) {
    files.set(name, new File([], name, { type: 'image/jpeg' }));
  }
  return files;
}

/**
 * Helper to create a DecompressedVolume
 */
function createDecompressedVolume(overrides: Partial<DecompressedVolume> = {}): DecompressedVolume {
  return {
    mokuroFile: createMokuroFile(),
    imageFiles: createImageFiles(['page001.jpg', 'page002.jpg']),
    basePath: 'test-manga',
    sourceType: 'local',
    nestedArchives: [],
    ...overrides
  };
}

describe('parseMokuroFile', () => {
  it('extracts metadata from valid mokuro file', async () => {
    const mokuroFile = createMokuroFile({
      title: 'My Series',
      volume: 'Volume 01',
      chars: 500
    });

    const result = await parseMokuroFile(mokuroFile);

    expect(result.series).toBe('My Series');
    expect(result.volume).toBe('Volume 01');
    expect(result.chars).toBe(500);
    expect(result.pages).toHaveLength(2);
  });

  it('extracts UUIDs from mokuro file', async () => {
    const mokuroFile = createMokuroFile({
      title_uuid: 'series-abc-123',
      volume_uuid: 'volume-def-456'
    });

    const result = await parseMokuroFile(mokuroFile);

    expect(result.seriesUuid).toBe('series-abc-123');
    expect(result.volumeUuid).toBe('volume-def-456');
  });

  it('extracts version from mokuro file', async () => {
    const mokuroFile = createMokuroFile({ version: '0.3.0' });

    const result = await parseMokuroFile(mokuroFile);

    expect(result.version).toBe('0.3.0');
  });

  it('accepts a file with a leading UTF-8 BOM (rule v1 #7: tolerated on read)', async () => {
    const body = JSON.stringify({
      version: '0.2.1',
      title: 'BOM Series',
      title_uuid: 's',
      volume: 'BOM Volume',
      volume_uuid: 'v',
      pages: []
    });
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body)]);
    const file = new File([bytes], 'bom.mokuro', { type: 'application/json' });

    const result = await parseMokuroFile(file);

    expect(result.series).toBe('BOM Series');
    expect(result.volume).toBe('BOM Volume');
  });

  it('throws on invalid JSON', async () => {
    const blob = new Blob(['not json'], { type: 'application/json' });
    const badFile = Object.assign(blob, {
      name: 'bad.mokuro',
      lastModified: Date.now()
    }) as unknown as File;

    await expect(parseMokuroFile(badFile)).rejects.toThrow();
  });

  it('throws on missing required fields', async () => {
    const incompleteData = { version: '0.2.0' }; // Missing title, pages, etc.
    const blob = new Blob([JSON.stringify(incompleteData)], { type: 'application/json' });
    const badFile = Object.assign(blob, {
      name: 'incomplete.mokuro',
      lastModified: Date.now()
    }) as unknown as File;

    await expect(parseMokuroFile(badFile)).rejects.toThrow(/missing required/i);
  });

  it('ignores a legacy series_metadata block (series facts live in series.json now)', async () => {
    const file = new File(
      [
        JSON.stringify({
          version: '0.2.1',
          title: 'One Piece',
          title_uuid: 's',
          volume: 'Vol 1',
          volume_uuid: 'v',
          pages: [],
          series_metadata: {
            external_ids: { anilist: 30013 },
            titles: { english: 'One Piece' },
            synonyms: [],
            tag: '[color]',
            updated_at: '2026-08-16T00:00:00.000Z'
          }
        })
      ],
      'a.mokuro'
    );
    const parsed = await parseMokuroFile(file);
    expect(parsed.series).toBe('One Piece');
    expect(Object.keys(parsed)).not.toContain('seriesMetadata');
  });
});

describe('matchImagesToPages', () => {
  it('matches images to mokuro page paths exactly', () => {
    const pages = [
      { img_path: 'page001.jpg', blocks: [] },
      { img_path: 'page002.jpg', blocks: [] }
    ];
    const files = createImageFiles(['page001.jpg', 'page002.jpg']);

    const result = matchImagesToPages(pages, files);

    expect(result.matched).toHaveLength(2);
    expect(result.missing).toHaveLength(0);
    expect(result.extra).toHaveLength(0);
  });

  it('detects missing images', () => {
    const pages = [
      { img_path: 'page001.jpg', blocks: [] },
      { img_path: 'page002.jpg', blocks: [] },
      { img_path: 'page003.jpg', blocks: [] }
    ];
    const files = createImageFiles(['page001.jpg', 'page002.jpg']);

    const result = matchImagesToPages(pages, files);

    expect(result.matched).toHaveLength(2);
    expect(result.missing).toEqual(['page003.jpg']);
  });

  it('detects extra images not in mokuro', () => {
    const pages = [{ img_path: 'page001.jpg', blocks: [] }];
    const files = createImageFiles(['page001.jpg', 'bonus.jpg']);

    const result = matchImagesToPages(pages, files);

    expect(result.matched).toHaveLength(1);
    expect(result.extra).toEqual(['bonus.jpg']);
  });

  it('handles path remapping when extensions differ', () => {
    const pages = [
      { img_path: 'page001.png', blocks: [] },
      { img_path: 'page002.png', blocks: [] }
    ];
    const files = createImageFiles(['page001.webp', 'page002.webp']);

    const result = matchImagesToPages(pages, files);

    expect(result.matched).toHaveLength(2);
    expect(result.remapped.get('page001.png')).toBe('page001.webp');
    expect(result.remapped.get('page002.png')).toBe('page002.webp');
  });

  it('handles nested paths in mokuro', () => {
    const pages = [
      { img_path: 'images/page001.jpg', blocks: [] },
      { img_path: 'images/page002.jpg', blocks: [] }
    ];
    const files = createImageFiles(['images/page001.jpg', 'images/page002.jpg']);

    const result = matchImagesToPages(pages, files);

    expect(result.matched).toHaveLength(2);
  });

  it('handles case-insensitive matching', () => {
    const pages = [{ img_path: 'PAGE001.JPG', blocks: [] }];
    const files = createImageFiles(['page001.jpg']);

    const result = matchImagesToPages(pages, files);

    expect(result.matched).toHaveLength(1);
  });

  it('uses count-based fallback when names completely mismatch but counts match', () => {
    // Simulates files that were renamed after mokuro processing (e.g., with _result suffix)
    const pages = [
      { img_path: '001.png', blocks: [] },
      { img_path: '002.png', blocks: [] },
      { img_path: '003.png', blocks: [] }
    ];
    const files = createImageFiles(['001_result.webp', '002_result.webp', '003_result.webp']);

    const result = matchImagesToPages(pages, files);

    // Should match all via count-based fallback
    expect(result.matched).toHaveLength(3);
    expect(result.missing).toHaveLength(0);
    expect(result.extra).toHaveLength(0);
    // Check remapping is correct (sorted order)
    expect(result.remapped.get('001.png')).toBe('001_result.webp');
    expect(result.remapped.get('002.png')).toBe('002_result.webp');
    expect(result.remapped.get('003.png')).toBe('003_result.webp');
  });

  it('does not use count-based fallback when most files match by name', () => {
    // If more than 50% match by name, don't use fallback for the rest
    const pages = [
      { img_path: 'page001.jpg', blocks: [] },
      { img_path: 'page002.jpg', blocks: [] },
      { img_path: 'page003.jpg', blocks: [] }, // This one won't match
      { img_path: 'page004.jpg', blocks: [] }
    ];
    const files = createImageFiles(['page001.jpg', 'page002.jpg', 'renamed.jpg', 'page004.jpg']);

    const result = matchImagesToPages(pages, files);

    // 3 should match by name, 1 missing, 1 extra (no fallback since >50% matched)
    expect(result.matched).toHaveLength(3);
    expect(result.missing).toEqual(['page003.jpg']);
    expect(result.extra).toEqual(['renamed.jpg']);
  });

  it('does not use count-based fallback when counts do not match', () => {
    const pages = [
      { img_path: '001.png', blocks: [] },
      { img_path: '002.png', blocks: [] },
      { img_path: '003.png', blocks: [] }
    ];
    // Only 2 files for 3 pages - counts don't match
    const files = createImageFiles(['001_result.webp', '002_result.webp']);

    const result = matchImagesToPages(pages, files);

    // Should NOT use fallback, report missing
    expect(result.matched).toHaveLength(0);
    expect(result.missing).toHaveLength(3);
    expect(result.extra).toHaveLength(2);
  });
});

describe('extractVolumeInfo', () => {
  it('extracts series and volume from base path', () => {
    const result = extractVolumeInfo('Author/Series Name/Volume 01');

    expect(result.series).toBe('Series Name');
    expect(result.volume).toBe('Volume 01');
  });

  it('handles simple paths (single segment) with volume info', () => {
    // Single segment paths with volume info now extract series and volume
    const result = extractVolumeInfo('My Manga Vol 1');

    expect(result.series).toBe('My Manga');
    expect(result.volume).toBe('Volume 1');
  });

  it('handles empty path', () => {
    const result = extractVolumeInfo('');

    expect(result.series).toBe('Untitled');
    expect(result.volume).toBe('Untitled');
  });

  it('handles single segment path', () => {
    const result = extractVolumeInfo('Manga');

    expect(result.series).toBe('Manga');
    expect(result.volume).toBe('Manga');
  });
});

describe('processVolume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes volume with mokuro file', async () => {
    const input = createDecompressedVolume();

    const result = await processVolume(input);

    expect(result.metadata.series).toBe('Test Series');
    expect(result.metadata.volume).toBe('Test Volume 01');
    expect(result.metadata.pageCount).toBe(2);
    expect(result.metadata.chars).toBe(100);
  });

  it('records the SHA-256 of exactly the mokuro bytes the OCR was parsed from', async () => {
    const input = createDecompressedVolume();
    const bytes = new Uint8Array(await input.mokuroFile!.arrayBuffer());
    const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');

    const result = await processVolume(input);

    expect(result.metadata.mokuroSha256).toBe(expected);
  });

  it('records no hash for an image-only volume', async () => {
    const result = await processVolume(
      createDecompressedVolume({
        mokuroFile: null,
        basePath: 'My Manga/Volume 01',
        imageFiles: createImageFiles(['001.jpg'])
      })
    );
    expect(result.metadata.mokuroSha256).toBeUndefined();
  });

  it('calculates cumulative character counts', async () => {
    const mokuroFile = createMokuroFile({
      pages: [
        { img_path: 'page001.jpg', blocks: [{ lines: ['あいう'] }] }, // 3 chars
        { img_path: 'page002.jpg', blocks: [{ lines: ['かきくけ'] }] } // 4 chars
      ],
      chars: 7
    });
    const input = createDecompressedVolume({ mokuroFile });

    const result = await processVolume(input);

    expect(result.ocrData.pages[0].cumulativeChars).toBe(3);
    expect(result.ocrData.pages[1].cumulativeChars).toBe(7);
  });

  it('includes matched files in fileData', async () => {
    const input = createDecompressedVolume();

    const result = await processVolume(input);

    expect(result.fileData.files['page001.jpg']).toBeDefined();
    expect(result.fileData.files['page002.jpg']).toBeDefined();
  });

  it('handles image-only volumes (no mokuro)', async () => {
    const input = createDecompressedVolume({
      mokuroFile: null,
      basePath: 'My Manga/Volume 01',
      imageFiles: createImageFiles(['001.jpg', '002.jpg', '003.jpg'])
    });

    const result = await processVolume(input);

    expect(result.metadata.imageOnly).toBe(true);
    expect(result.metadata.pageCount).toBe(3);
    expect(result.metadata.series).toBe('My Manga');
    expect(result.metadata.volume).toBe('Volume 01');
  });

  it('generates thumbnail from first image', async () => {
    const input = createDecompressedVolume();

    const result = await processVolume(input);

    expect(result.metadata.thumbnail).toBeDefined();
    expect(result.metadata.thumbnailWidth).toBeGreaterThan(0);
    expect(result.metadata.thumbnailHeight).toBeGreaterThan(0);
  });

  it('prefers cover image for thumbnail when available', async () => {
    const mokuroFile = createMokuroFile({
      pages: [
        { img_path: 'page001.jpg', blocks: [] },
        { img_path: 'cover.jpg', blocks: [] },
        { img_path: 'page002.jpg', blocks: [] }
      ]
    });
    const input = createDecompressedVolume({
      mokuroFile,
      imageFiles: createImageFiles(['page001.jpg', 'cover.jpg', 'page002.jpg'])
    });

    await processVolume(input);

    // Check that generateThumbnail was called with the cover image
    const { generateThumbnail } = await import('$lib/catalog/thumbnails');
    expect(generateThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'cover.jpg'
      })
    );
  });

  it('uses case-insensitive cover detection', async () => {
    const mokuroFile = createMokuroFile({
      pages: [
        { img_path: 'page001.jpg', blocks: [] },
        { img_path: 'COVER_IMAGE.png', blocks: [] },
        { img_path: 'page002.jpg', blocks: [] }
      ]
    });
    const input = createDecompressedVolume({
      mokuroFile,
      imageFiles: createImageFiles(['page001.jpg', 'COVER_IMAGE.png', 'page002.jpg'])
    });

    await processVolume(input);

    // Check that generateThumbnail was called with the cover image
    const { generateThumbnail } = await import('$lib/catalog/thumbnails');
    expect(generateThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'COVER_IMAGE.png'
      })
    );
  });

  it('handles missing images gracefully', async () => {
    const mokuroFile = createMokuroFile({
      pages: [
        { img_path: 'page001.jpg', blocks: [] },
        { img_path: 'page002.jpg', blocks: [] },
        { img_path: 'page003.jpg', blocks: [] } // Missing
      ]
    });
    const input = createDecompressedVolume({
      mokuroFile,
      imageFiles: createImageFiles(['page001.jpg', 'page002.jpg'])
    });

    const result = await processVolume(input);

    expect(result.metadata.mismatchWarning).toContain('page003.jpg');
    expect(result.ocrData.pages).toHaveLength(3); // Still includes all pages
  });

  it('discovers nested archives', async () => {
    const nestedArchive = new File([], 'nested.cbz');
    const input = createDecompressedVolume({
      nestedArchives: [nestedArchive]
    });

    const result = await processVolume(input);

    expect(result.nestedSources).toHaveLength(1);
    expect(result.nestedSources[0].source.type).toBe('archive');
  });

  it('preserves source type in metadata', async () => {
    const localInput = createDecompressedVolume({ sourceType: 'local' });
    const cloudInput = createDecompressedVolume({ sourceType: 'cloud' });

    const localResult = await processVolume(localInput);
    const cloudResult = await processVolume(cloudInput);

    expect(localResult.metadata.sourceType).toBe('local');
    expect(cloudResult.metadata.sourceType).toBe('cloud');
  });
});

describe('OCR provenance (ocr_engine)', () => {
  function vectorFile(text = RUNNER_OUTPUT_DOCUMENT): File {
    return Object.assign(new Blob([text], { type: 'application/json' }), {
      name: 'vector.mokuro',
      lastModified: Date.now()
    }) as unknown as File;
  }

  it('parseMokuroFile keeps a Bunko-shaped ocr_engine block verbatim', async () => {
    const parsed = await parseMokuroFile(vectorFile());
    expect(parsed.ocrEngine).toEqual(JSON.parse(RUNNER_OUTPUT_DOCUMENT).ocr_engine);
  });

  it('parseMokuroFile ignores a block that is not a plain object', async () => {
    const doc = JSON.parse(RUNNER_OUTPUT_DOCUMENT);
    doc.ocr_engine = ['hayai-nova'];
    expect((await parseMokuroFile(vectorFile(JSON.stringify(doc)))).ocrEngine).toBeUndefined();
    expect((await parseMokuroFile(createMokuroFile())).ocrEngine).toBeUndefined();
  });

  it('records the block with the digest of the file pages (the vector’s seal)', async () => {
    const result = await processVolume(
      createDecompressedVolume({
        mokuroFile: vectorFile(),
        imageFiles: createImageFiles(['001.jpg', '002.jpg'])
      })
    );
    expect(result.metadata.ocrProvenance).toEqual({
      engine: JSON.parse(RUNNER_OUTPUT_DOCUMENT).ocr_engine,
      digest: RUNNER_OUTPUT_SEAL
    });
  });

  it('computes the digest from the FILE pages when the import remaps img_path', async () => {
    const result = await processVolume(
      createDecompressedVolume({
        mokuroFile: vectorFile(),
        imageFiles: createImageFiles(['images/001.png', 'images/002.png'])
      })
    );
    expect(result.ocrData.pages[0].img_path).not.toBe('001.jpg');
    expect(result.metadata.ocrProvenance?.digest).toBe(RUNNER_OUTPUT_SEAL);
  });

  it('an EDITED file (with an ocr_engine left in) records its `edited` block, not the engine', async () => {
    const doc = JSON.parse(RUNNER_OUTPUT_DOCUMENT);
    const edited = { by: 'mokuro-reader', at: '2026-10-01T00:00:00.000Z', base_sha256: null };
    doc.edited = edited;
    const parsed = await parseMokuroFile(vectorFile(JSON.stringify(doc)));
    expect(parsed.edited).toEqual(edited);
    const result = await processVolume(
      createDecompressedVolume({
        mokuroFile: vectorFile(JSON.stringify(doc)),
        imageFiles: createImageFiles(['001.jpg', '002.jpg'])
      })
    );
    expect(result.metadata.ocrProvenance?.edited).toEqual(edited);
    expect(result.metadata.ocrProvenance && 'engine' in result.metadata.ocrProvenance).toBe(false);
  });

  it('a file with a stray `preserved` block is classified by its `ocr_engine`', async () => {
    const doc = JSON.parse(RUNNER_OUTPUT_DOCUMENT);
    doc.preserved = { by: 'mokuro-bunko', reason: 'generation-upgrade' };
    const parsed = await parseMokuroFile(vectorFile(JSON.stringify(doc)));
    expect('preserved' in parsed).toBe(false);
    const result = await processVolume(
      createDecompressedVolume({
        mokuroFile: vectorFile(JSON.stringify(doc)),
        imageFiles: createImageFiles(['001.jpg', '002.jpg'])
      })
    );
    expect(result.metadata.ocrProvenance?.engine).toEqual(doc.ocr_engine);
    expect(result.metadata.ocrProvenance?.digest).toBe(RUNNER_OUTPUT_SEAL);
  });

  it('a file with a stray `preserved` block beside `edited` is EDITED', async () => {
    const doc = JSON.parse(RUNNER_OUTPUT_DOCUMENT);
    const edited = { by: 'mokuro-reader', at: '2026-10-01T00:00:00.000Z', base_sha256: null };
    doc.edited = edited;
    doc.preserved = { by: 'mokuro-bunko', reason: 'generation-upgrade' };
    const result = await processVolume(
      createDecompressedVolume({
        mokuroFile: vectorFile(JSON.stringify(doc)),
        imageFiles: createImageFiles(['001.jpg', '002.jpg'])
      })
    );
    expect(result.metadata.ocrProvenance?.edited).toEqual(edited);
  });

  it('records nothing for a file without a block, or an image-only volume', async () => {
    expect(
      (await processVolume(createDecompressedVolume())).metadata.ocrProvenance
    ).toBeUndefined();
    const imageOnly = await processVolume(
      createDecompressedVolume({
        mokuroFile: null,
        basePath: 'My Manga/Volume 01',
        imageFiles: createImageFiles(['001.jpg'])
      })
    );
    expect(imageOnly.metadata.ocrProvenance).toBeUndefined();
  });
});

/**
 * Raster images only (SVG is an unsupported format). Every install path
 * converges on `processVolume`, so this is where a page's stored type is
 * decided: from its magic bytes, never its extension or the type it came with.
 */
describe('raster images only', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const SVG =
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>';

  function images(entries: Array<[string, BlobPart, string?]>): Map<string, File> {
    return new Map(entries.map(([name, body, type]) => [name, new File([body], name, { type })]));
  }

  it('types every page by its bytes and leaves out what is not raster', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { images: kept, rejected } = await keepRasterImages(
      images([
        ['a/page001.jpg', JPEG], // untyped, as an archive entry arrives
        ['a/page002.jpg', PNG, 'image/jpeg'], // the extension lies
        ['a/page003.png', SVG, 'image/png'], // an SVG dressed as a PNG
        ['a/page004.jpg', '<html><script>1</script></html>'],
        ['a/page005.webp', new Uint8Array(0)] // empty: nothing to sniff or run
      ])
    );

    expect([...kept.keys()]).toEqual(['a/page001.jpg', 'a/page002.jpg', 'a/page005.webp']);
    expect(kept.get('a/page001.jpg')!.type).toBe('image/jpeg');
    expect(kept.get('a/page002.jpg')!.type).toBe('image/png');
    expect(kept.get('a/page002.jpg')!.name).toBe('a/page002.jpg');
    expect(kept.get('a/page005.webp')!.type).toBe('image/webp');
    expect(rejected).toEqual(['a/page003.png', 'a/page004.jpg']);
    expect(warn.mock.calls.flat().map(String).join(' ')).toContain('not a supported raster image');
    warn.mockRestore();
  });

  it('treats an SVG page of an OCR volume as a missing page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await processVolume(
      createDecompressedVolume({
        imageFiles: images([
          ['page001.jpg', JPEG],
          ['page002.jpg', SVG, 'image/svg+xml']
        ])
      })
    );

    expect(result.metadata.missingPagePaths).toEqual(['page002.jpg']);
    expect(result.metadata.mismatchWarning).toContain('page002.jpg');
    expect(result.ocrData.pages).toHaveLength(2);
    for (const file of Object.values(result.fileData.files)) {
      expect(file.type).toMatch(/^image\/(jpeg|png)$/);
    }
    expect(await result.fileData.files['page002.jpg'].text()).not.toContain('<svg');
    warn.mockRestore();
  });

  it('drops an SVG page of an image-only volume', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await processVolume(
      createDecompressedVolume({
        mokuroFile: null,
        imageFiles: images([
          ['page001.jpg', JPEG],
          ['page002.svg', SVG]
        ])
      })
    );

    expect(result.metadata.pageCount).toBe(1);
    expect(Object.keys(result.fileData.files)).toEqual(['page001.jpg']);
    expect(result.fileData.files['page001.jpg'].type).toBe('image/jpeg');
    warn.mockRestore();
  });

  it('never keeps an SVG thumbnail sidecar, building the cover from the pages instead', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(generateThumbnail).mockClear();
    const result = await processVolume(
      createDecompressedVolume({
        thumbnailSidecar: new File([SVG], 'Test Volume 01.webp', { type: 'image/webp' })
      })
    );

    expect(generateThumbnail).toHaveBeenCalledTimes(1);
    expect(result.metadata.thumbnail).not.toBeNull();
    expect(await result.metadata.thumbnail!.text()).not.toContain('<svg');
    warn.mockRestore();
  });

  it('keeps a raster thumbnail sidecar, typed by its bytes', async () => {
    const original = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
      width: 250,
      height: 350,
      close() {}
    });
    try {
      vi.mocked(generateThumbnail).mockClear();
      const result = await processVolume(
        createDecompressedVolume({ thumbnailSidecar: new File([PNG], 'Test Volume 01.webp') })
      );
      expect(generateThumbnail).not.toHaveBeenCalled();
      expect((result.metadata.thumbnail as File).type).toBe('image/png');
      expect(result.metadata.thumbnailWidth).toBe(250);
    } finally {
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = original;
    }
  });
});
