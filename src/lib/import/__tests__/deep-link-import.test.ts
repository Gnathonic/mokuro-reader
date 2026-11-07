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
const watchServerOcr = vi.hoisted(() => vi.fn());
vi.mock('$lib/catalog/server-ocr-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/catalog/server-ocr-queue')>();
  return { queueUrlForArchive: actual.queueUrlForArchive, watchServerOcr };
});

import { db } from '$lib/catalog/db';
import { clearAllLayers, getLayerWithPages } from '$lib/catalog/layer-store';
import { installedUuids } from '../cover-sidecar';
import { importDeepLinkedArchive, localSeriesKeys } from '../deep-link-import';
import type { HtmlDownloadResult } from '../html-download-provider';
import { parseImportedSeriesFile, resetImportedSeriesFiles } from '../series-file-import';
import { buildMokuroMetadata } from '$lib/util/mokuro-metadata';
import type { Page, VolumeMetadata } from '$lib/types';
import { installReviewer, type Reviewer } from './helpers/review-bridge';

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

/** A deep-linked archive holding whatever entries the test names. */
async function cbzWith(entries: Record<string, string | Uint8Array>): Promise<File> {
  const zipWriter = new ZipWriter(new Uint8ArrayWriter(), {
    bufferedWrite: false,
    extendedTimestamp: false
  });
  for (const [name, body] of Object.entries(entries)) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    await zipWriter.add(name, new Uint8ArrayReader(bytes));
  }
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
    manifestUrl: null,
    ...overrides
  };
}

let reviewer: Reviewer;

beforeEach(async () => {
  reviewer = installReviewer();
  resetImportedSeriesFiles();
  scheduleSeriesFileWrite.mockReset();
  watchServerOcr.mockReset();
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
  reviewer.restore();
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

  function pendingManifest(pending: unknown[], recheck_after: number | null) {
    return {
      // The server's names for it (folder / archive stem), not the .mokuro's.
      series: 'Dr Stone (Server Folder)',
      volume: 'Dr Stone 01 (server file)',
      archive: { url: 'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz' },
      ocr: null,
      layers: [],
      cover: null,
      series_file: null,
      pending,
      recheck_after
    } as unknown as HtmlDownloadResult['manifest'];
  }

  it('watches the volume on its server’s queue when the manifest shows jobs still pending', async () => {
    const archiveFile = await imagesOnlyCbz();
    const pending = [{ kind: 'ocr', id: 'mokuro-fp16', eta: '2026-09-27T21:14:00Z' }];
    await importDeepLinkedArchive(
      await downloaded({
        archiveFile,
        mokuroFile: null,
        importFiles: [archiveFile],
        manifest: pendingManifest(pending, 95),
        manifestUrl:
          'https://bunko.example/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001'
      }),
      'Dr Stone 01',
      new Set()
    );
    const [row] = await db.volumes.toArray();
    expect(watchServerOcr).toHaveBeenCalledWith({
      volumeUuid: row.volume_uuid,
      series: 'Dr Stone (Server Folder)',
      volume: 'Dr Stone 01 (server file)',
      queueUrl: 'https://bunko.example/mokuro-reader/.mokuro-queue.json',
      manifestUrl:
        'https://bunko.example/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001',
      auth: 'none',
      source: 'html-download'
    });
  });

  it('registers nothing when nothing is pending', async () => {
    await importDeepLinkedArchive(
      await downloaded({ manifest: pendingManifest([], null), manifestUrl: 'https://b.example/m' }),
      'Dr Stone 01',
      new Set()
    );
    expect(watchServerOcr).not.toHaveBeenCalled();
  });

  describe('a link’s series.json and a series already in the library', () => {
    const seriesFile = () =>
      parseImportedSeriesFile(
        'https://bunko.example/mokuro-reader/Dr%20Stone/series.json',
        seriesJson(),
        100,
        Date.parse('2026-09-27T01:02:07Z')
      )!;

    /** Another volume of the series, its pages removed from this device. */
    async function seedExistingSeries() {
      await db.volumes.put({
        ...volume,
        volume_uuid: 'volume-uuid-02',
        volume_title: 'Dr Stone 02',
        metadata_only: true
      });
    }

    it('leaves the series alone — facts, cached index and cloud write — unless the user allowed it', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      await seedExistingSeries();

      await importDeepLinkedArchive(
        await downloaded({ seriesFile: seriesFile() }),
        'Dr Stone 01',
        new Set()
      );

      // The volume itself still imports, into that series.
      expect((await db.volumes.get('volume-uuid-01'))?.series_title).toBe('Dr Stone');
      expect(await db.series_metadata.get('dr stone')).toBeUndefined();
      expect(await db.series_index.get('dr stone')).toBeUndefined();
      expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
      expect(info.mock.calls.flat().join(' ')).toContain('already in the library');
    });

    it('applies it to that series when the user ticked the box for it', async () => {
      await seedExistingSeries();

      await importDeepLinkedArchive(
        await downloaded({ seriesFile: seriesFile() }),
        'Dr Stone 01',
        new Set(),
        { allowSeriesKey: 'dr stone' }
      );

      expect((await db.series_metadata.get('dr stone'))?.external_ids).toEqual({ anilist: 98416 });
      expect(await db.series_index.get('dr stone')).toBeDefined();
    });

    it('a series known only by its metadata record is just as protected', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      await db.series_metadata.put({
        series_key: 'dr stone',
        series_title: 'Dr Stone',
        external_ids: { anilist: 1 },
        facts_updated_at: '2020-01-01T00:00:00.000Z'
      } as never);

      await importDeepLinkedArchive(
        await downloaded({ seriesFile: seriesFile() }),
        'Dr Stone 01',
        new Set()
      );

      expect((await db.series_metadata.get('dr stone'))?.external_ids).toEqual({ anilist: 1 });
    });

    // The archive itself carries the series.json — this app's own exports put
    // one at the root of every archive, so a bunko-served .cbz usually has it.
    // Two routes through the importer: the OCR beside the archive (a manifest's,
    // or the legacy guessed sidecar), and the OCR inside it.
    const embeddedCases = [
      {
        name: 'beside the archive',
        make: async () => ({
          archiveFile: await cbzWith({
            '001.jpg': new Uint8Array([1, 2, 3]),
            'series.json': seriesJson()
          }),
          mokuroFile: mokuroFile()
        })
      },
      {
        name: 'inside the archive',
        make: async () => ({
          archiveFile: await cbzWith({
            'Dr Stone 01.mokuro': JSON.stringify(buildMokuroMetadata(volume, [page('あい')])),
            'Dr Stone 01/001.jpg': new Uint8Array([1, 2, 3]),
            'series.json': seriesJson()
          }),
          mokuroFile: null
        })
      }
    ];

    for (const { name, make } of embeddedCases) {
      describe(`a series.json packed inside the linked archive (OCR ${name})`, () => {
        async function importIt(options = {}) {
          const { archiveFile, mokuroFile: mokuro } = await make();
          await importDeepLinkedArchive(
            await downloaded({
              archiveFile,
              mokuroFile: mokuro,
              importFiles: mokuro ? [archiveFile, mokuro] : [archiveFile]
            }),
            'Dr Stone 01',
            new Set(),
            options
          );
        }

        it('never reaches a series already in the library', async () => {
          const info = vi.spyOn(console, 'info').mockImplementation(() => {});
          await seedExistingSeries();

          await importIt();

          expect((await db.volumes.get('volume-uuid-01'))?.series_title).toBe('Dr Stone');
          expect(await db.series_metadata.get('dr stone')).toBeUndefined();
          expect(await db.series_index.get('dr stone')).toBeUndefined();
          expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
          expect(info.mock.calls.flat().join(' ')).toContain('already in the library');
        });

        it('applies to a series the link brings new', async () => {
          await importIt();
          expect((await db.series_metadata.get('dr stone'))?.external_ids).toEqual({
            anilist: 98416
          });
        });

        it('applies to the existing series once the user allowed it', async () => {
          await seedExistingSeries();
          await importIt({ allowSeriesKey: 'dr stone' });
          expect((await db.series_metadata.get('dr stone'))?.external_ids).toEqual({
            anilist: 98416
          });
        });
      });
    }

    it('protects a series the library spells composed (NFC) from a link spelling it decomposed', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      const composed = 'Pokémon'.normalize('NFC');
      const decomposed = 'Pokémon'.normalize('NFD');
      await db.volumes.put({
        ...volume,
        series_title: composed,
        volume_uuid: 'volume-uuid-02',
        volume_title: 'Pokémon 02',
        metadata_only: true
      });
      const linked = { ...volume, series_title: decomposed, volume_title: 'Pokémon 01' };
      const file = parseImportedSeriesFile(
        'https://bunko.example/x/series.json',
        JSON.stringify({ ...JSON.parse(seriesJson()), series_title: decomposed }),
        100,
        Date.parse('2026-09-27T01:02:07Z')
      )!;
      const mokuro = new File(
        [JSON.stringify(buildMokuroMetadata(linked, [page('あい')]))],
        'Pokémon 01.mokuro',
        { type: 'application/json' }
      );

      await importDeepLinkedArchive(
        await downloaded({ seriesFile: file, mokuroFile: mokuro }),
        'Pokémon 01',
        new Set()
      );

      expect(await db.volumes.get('volume-uuid-01')).toBeDefined();
      expect(await db.series_metadata.count()).toBe(0);
      expect(await db.series_index.count()).toBe(0);
      expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
    });

    it('allowing one series does not open up another', async () => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      await seedExistingSeries();

      await importDeepLinkedArchive(
        await downloaded({ seriesFile: seriesFile() }),
        'Dr Stone 01',
        new Set(),
        { allowSeriesKey: 'one piece' }
      );

      expect(await db.series_metadata.get('dr stone')).toBeUndefined();
    });
  });
});

describe('localSeriesKeys', () => {
  it('folds every series the library knows: rows, metadata records and cached indexes', async () => {
    await db.volumes.put({ ...volume, series_title: '  Dr   STONE ' });
    await db.series_metadata.put({ series_key: 'one piece', series_title: 'One Piece' } as never);
    await db.series_index.put({ series_key: 'bleach', series_title: 'Bleach' } as never);
    expect([...(await localSeriesKeys())].sort()).toEqual(['bleach', 'dr stone', 'one piece']);
  });

  it('folds unicode composition too, so NFD and NFC spellings are one series', async () => {
    await db.volumes.put({ ...volume, series_title: 'Pokémon'.normalize('NFD') });
    expect([...(await localSeriesKeys())]).toEqual(['pokémon'.normalize('NFC')]);
  });
});
