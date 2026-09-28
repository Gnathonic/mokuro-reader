/**
 * The deep link's import half, through the real import pipeline: the archive
 * saves, then the manifest's `series.json` applies (keyed by the title the
 * volume was actually stored under) and its layers attach through the shared
 * layer importer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  const db = new CatalogDexieV3('mokuro_v3_deep_link_import_test');
  (db as unknown as { processThumbnails: () => Promise<void> }).processThumbnails = async () =>
    undefined;
  return { db };
});
vi.mock('$lib/catalog/thumbnails', () => ({
  generateThumbnail: async () => ({
    file: new File([new Uint8Array([1])], 'thumb.webp', { type: 'image/webp' }),
    width: 10,
    height: 14
  })
}));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/util/modals', () => ({
  promptImageOnlyImport: (_a: unknown, _b: unknown, onConfirm: () => void) => onConfirm(),
  promptMissingFiles: (_info: unknown, onContinue: () => void) => onContinue()
}));
const scheduleSeriesFileWrite = vi.hoisted(() => vi.fn());
vi.mock('$lib/metadata/series-file-sync', () => ({ scheduleSeriesFileWrite }));
vi.mock('$lib/util/file-processing-pool', () => ({
  getFileProcessingPool: async () => ({ addTask: () => {} }),
  incrementPoolUsers: () => {},
  decrementPoolUsers: () => {}
}));
vi.mock('$lib/util/sync/provider-manager', async () => {
  const { readable } = await import('svelte/store');
  return {
    providerManager: {
      getActiveProvider: () => null,
      status: readable({ hasAnyAuthenticated: false, currentProviderType: null, providers: {} })
    }
  };
});
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: { getCache: () => null }
}));
vi.mock('$lib/util/sync/sidecar-backfill', () => ({ noteOcrEdited: vi.fn() }));

import { db } from '$lib/catalog/db';
import { clearAllLayers, getLayerWithPages } from '$lib/catalog/layer-store';
import { installedUuids } from '../cover-sidecar';
import { importDeepLinkedArchive } from '../deep-link-import';
import type { HtmlDownloadResult } from '../html-download-provider';
import { parseImportedSeriesFile, resetImportedSeriesFiles } from '../series-file-import';
import { buildMokuroMetadata } from '$lib/util/mokuro-metadata';
import type { Page, VolumeMetadata } from '$lib/types';

// zip.js writes the archive through a Blob stream; jsdom's Blob has none.
if (typeof Blob !== 'undefined' && !Blob.prototype.stream) {
  Blob.prototype.stream = function (this: Blob) {
    const bytes = this.arrayBuffer();
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(await bytes));
        controller.close();
      }
    });
  } as Blob['stream'];
}

const volume: VolumeMetadata = {
  mokuro_version: '0.2.1',
  series_title: 'Dr Stone',
  series_uuid: 'series-uuid',
  volume_title: 'Dr Stone 01',
  volume_uuid: 'volume-uuid-01',
  page_count: 1,
  character_count: 2,
  page_char_counts: [2]
};

function page(text: string): Page {
  return {
    version: '0.2.1',
    img_width: 100,
    img_height: 100,
    img_path: '001.jpg',
    blocks: [{ box: [0, 0, 10, 10], vertical: true, font_size: 10, lines: [text] }]
  };
}

/** The deep link's archive: images only; the OCR arrives beside it. */
async function imagesOnlyCbz(): Promise<File> {
  const zipWriter = new ZipWriter(new Uint8ArrayWriter(), {
    bufferedWrite: false,
    extendedTimestamp: false
  });
  await zipWriter.add('001.jpg', new Uint8ArrayReader(new Uint8Array([1, 2, 3])));
  const bytes = await zipWriter.close();
  return new File([bytes], 'Dr Stone 01.cbz', { type: 'application/zip' });
}

function mokuroFile(): File {
  return new File(
    [JSON.stringify(buildMokuroMetadata(volume, [page('あい')]))],
    'Dr Stone 01.mokuro',
    { type: 'application/json' }
  );
}

function seriesJson(): string {
  return JSON.stringify({
    version: 2,
    series_title: 'Dr Stone',
    external_ids: { anilist: 98416 },
    titles: { native: 'Dr.STONE' },
    synonyms: ['ドクターストーン'],
    updated_at: '2026-09-27T00:00:00.000Z',
    volumes: [
      {
        volume_uuid: 'volume-uuid-01',
        volume_title: 'Dr Stone 01',
        page_count: 1,
        character_count: 2,
        mokuro_version: '0.2.1'
      }
    ]
  });
}

function layerBlob(text: string, engine?: string): Blob {
  return new Blob([
    JSON.stringify({
      ...buildMokuroMetadata(volume, [page(text)]),
      ...(engine ? { ocr_engine: { id: engine, generator: 'mokuro-bunko 0.5.0' } } : {})
    })
  ]);
}

async function downloaded(
  overrides: Partial<HtmlDownloadResult> = {}
): Promise<HtmlDownloadResult> {
  const archiveFile = await imagesOnlyCbz();
  const mokuro = mokuroFile();
  return {
    bundleType: 'pair',
    archiveFile,
    mokuroFile: mokuro,
    importFiles: [archiveFile, mokuro],
    coverFile: null,
    layers: [],
    seriesFile: null,
    manifest: null,
    ...overrides
  };
}

beforeEach(async () => {
  resetImportedSeriesFiles();
  scheduleSeriesFileWrite.mockReset();
  await Promise.all([
    db.volumes.clear(),
    db.volume_ocr.clear(),
    db.volume_files.clear(),
    db.series_metadata.clear(),
    db.series_index.clear(),
    clearAllLayers(db)
  ]);
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetImportedSeriesFiles();
});

describe('importDeepLinkedArchive', () => {
  it('applies the manifest series.json after the volume saves, under its stored title', async () => {
    const seriesFile = parseImportedSeriesFile(
      'https://bunko.example/mokuro-reader/Dr%20Stone/series.json',
      seriesJson(),
      100,
      Date.parse('2026-09-27T01:02:07Z')
    )!;
    // Nothing is applied yet: it waits for the volume the batch saves.
    expect(await db.series_metadata.count()).toBe(0);

    await importDeepLinkedArchive(await downloaded({ seriesFile }), 'Dr Stone 01', new Set());

    expect(await db.volumes.count()).toBe(1);
    const record = await db.series_metadata.get('dr stone');
    expect(record?.external_ids).toEqual({ anilist: 98416 });
    expect(record?.synonyms).toEqual(['ドクターストーン']);
    const index = await db.series_index.get('dr stone');
    expect(index?.source).toMatchObject({
      provider: 'import',
      path: 'https://bunko.example/mokuro-reader/Dr%20Stone/series.json'
    });
    // Keyed by the title a SAVED volume recorded: a file applied before the save
    // would have had no series to belong to (see resolveSeriesTitle) and been dropped.
  });

  it('attaches the manifest layers to the volume just imported, filed by their stamps', async () => {
    await importDeepLinkedArchive(
      await downloaded({
        layers: [
          {
            layerId: 'hayai-nova-ppocr',
            gz: false,
            blob: layerBlob('かな', 'hayai-nova'),
            label: 'https://bunko.example/x/Dr%20Stone%2001.hayai-nova-ppocr.mokuro',
            size: 67,
            modifiedTime: '2026-09-27T01:02:05Z'
          },
          {
            layerId: 'broken',
            gz: false,
            blob: new Blob(['{ not json']),
            label: 'https://bunko.example/x/Dr%20Stone%2001.broken.mokuro'
          }
        ]
      }),
      'Dr Stone 01',
      new Set()
    );

    const [row] = await db.volumes.toArray();
    expect(row.volume_uuid).toBe('volume-uuid-01');
    const layer = (await getLayerWithPages(db, row.volume_uuid, 'hayai-nova-ppocr'))!;
    expect(layer).toMatchObject({ kind: 'ocr', engine: 'hayai-nova' });
    expect(layer.cloud?.provider).toBe('html-download');
    expect(layer.pages[0].blocks[0].lines).toEqual(['かな']);
    // A bad layer costs only itself.
    expect(await getLayerWithPages(db, row.volume_uuid, 'broken')).toBeUndefined();
    expect((await db.volume_ocr.get(row.volume_uuid))?.pages).toHaveLength(1);
  });

  it('imports image-only when the manifest had no OCR', async () => {
    const error = vi.spyOn(console, 'error');
    const archiveFile = await imagesOnlyCbz();
    await importDeepLinkedArchive(
      await downloaded({ mokuroFile: null, importFiles: [archiveFile], archiveFile }),
      'Dr Stone 01',
      new Set()
    );
    const [row] = await db.volumes.toArray();
    expect(row.mokuro_version).toBe('');
    expect(await db.volume_files.get(row.volume_uuid)).toBeDefined();
    expect(error).not.toHaveBeenCalled();
  });

  it('attaches no layer to a volume that was already installed before the import', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await importDeepLinkedArchive(await downloaded(), 'Dr Stone 01', new Set());
    const before = installedUuids(await db.volumes.toArray());

    await importDeepLinkedArchive(
      await downloaded({
        layers: [
          {
            layerId: 'paddle',
            gz: false,
            blob: layerBlob('ろ', 'paddle'),
            label: 'https://bunko.example/x/Dr%20Stone%2001.paddle.mokuro'
          }
        ]
      }),
      'Dr Stone 01',
      before
    );
    expect(await getLayerWithPages(db, 'volume-uuid-01', 'paddle')).toBeUndefined();
    expect(warn.mock.calls.some((c) => c.map(String).join(' ').includes('layer'))).toBe(true);
  });
});
