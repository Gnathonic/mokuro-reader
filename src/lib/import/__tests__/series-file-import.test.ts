/**
 * `series.json` on the import side: a sidecar dropped next to (or packed with)
 * the volumes restores the series facts and caches the volume index.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

// ---------------------------------------------------------------- mocks

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db: any = new Dexie('series-file-import-test');
  db.version(1).stores({
    volumes: 'volume_uuid, series_uuid, series_title',
    volume_ocr: 'volume_uuid',
    volume_files: 'volume_uuid',
    series_metadata: 'series_key',
    series_index: 'series_key'
  });
  db.processThumbnails = async () => undefined;
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
  progressTrackerStore: {
    addProcess: vi.fn(),
    updateProcess: vi.fn(),
    removeProcess: vi.fn()
  }
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

import { db } from '$lib/catalog/db';
import { compressVolume } from '$lib/util/compress-volume';
import { cancelQueuedImports, importFiles, importQueue, isImporting } from '../import-service';
import {
  applyImportedSeriesFiles,
  dropLinkSeriesFiles,
  parseImportedSeriesFile,
  recordImportedSeriesTitle,
  recordSeriesFile,
  resetImportedSeriesFiles,
  saveLinkVolume,
  type LinkSeriesGuard
} from '../series-file-import';
import { buildSeriesFile, type SeriesFile } from '$lib/metadata/series-file';
import { localSeriesKeys } from '../deep-link-import';
import type { ProcessedVolume } from '../types';
import { createEmptySeriesMetadata } from '$lib/metadata/types';
import { buildMokuroMetadata } from '$lib/util/mokuro-metadata';
import type { VolumeMetadata } from '$lib/types';
import { get } from 'svelte/store';
import { approveAsDialogWould, installReviewer, type Reviewer } from './helpers/review-bridge';

let reviewer: Reviewer;
beforeEach(() => {
  reviewer = installReviewer();
});
afterEach(() => reviewer.restore());

// ---------------------------------------------------------------- fixtures

const volume: VolumeMetadata = {
  mokuro_version: '0.2.1',
  series_title: 'One Piece',
  series_uuid: 'series-uuid',
  volume_title: 'Vol 1',
  volume_uuid: 'volume-uuid',
  page_count: 1,
  character_count: 5,
  page_char_counts: [5],
  spine_width: 17
};

const meta = {
  ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
  external_ids: { anilist: 30013 },
  titles: { romaji: 'ONE PIECE' },
  synonyms: ['ワンピース'],
  tag: '[color]'
};

function seriesFileFor(seriesTitle: string): SeriesFile {
  return buildSeriesFile({
    seriesTitle,
    meta: { ...meta, series_title: seriesTitle },
    localVolumes: [{ ...volume, series_title: seriesTitle }]
  })!;
}

function mokuroTextFor(volumeTitle: string, seriesTitle = 'One Piece'): string {
  return JSON.stringify(
    buildMokuroMetadata(
      {
        ...volume,
        series_title: seriesTitle,
        volume_title: volumeTitle,
        volume_uuid: `${seriesTitle}/${volumeTitle}`
      },
      [{ version: '0.2.1', img_path: '001.jpg', blocks: [] }]
    )
  );
}

const mokuroText = mokuroTextFor('Vol 1');

/** An archive of `<Vol>.mokuro` + `<Vol>/001.jpg` per volume, plus any extras. */
async function buildArchive(
  name: string,
  volumes: { title: string; mokuro: string }[],
  extras: { path: string; text: string }[] = []
): Promise<File> {
  const encoder = new TextEncoder();
  const zipWriter = new ZipWriter(new Uint8ArrayWriter(), {
    bufferedWrite: false,
    extendedTimestamp: false
  });
  for (const entry of volumes) {
    await zipWriter.add(`${entry.title}/`, new Uint8ArrayReader(new Uint8Array(0)), {
      directory: true
    });
    await zipWriter.add(`${entry.title}/001.jpg`, new Uint8ArrayReader(new Uint8Array([1, 2, 3])));
    await zipWriter.add(
      `${entry.title}.mokuro`,
      new Uint8ArrayReader(encoder.encode(entry.mokuro))
    );
  }
  for (const extra of extras) {
    await zipWriter.add(extra.path, new Uint8ArrayReader(encoder.encode(extra.text)));
  }
  const bytes = await zipWriter.close();
  return new File([bytes], name, { type: 'application/x-cbz', lastModified: 1_700_000_000_000 });
}

/** A one-volume CBZ, the shape our own single-volume export writes. */
function buildVolumeArchive(
  name: string,
  mokuro: string,
  extras: { path: string; text: string }[] = []
): Promise<File> {
  return buildArchive(name, [{ title: 'Vol 1', mokuro }], extras);
}

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

async function clearDb(): Promise<void> {
  await Promise.all([
    db.volumes.clear(),
    db.volume_ocr.clear(),
    db.volume_files.clear(),
    db.series_metadata.clear(),
    db.series_index.clear()
  ]);
}

// ---------------------------------------------------------------- tests

describe('importing a volume archive that carries series.json', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetImportedSeriesFiles();
    await clearDb();
  });

  afterEach(() => {
    resetImportedSeriesFiles();
  });

  it('upserts the facts and caches the index under the imported series title', async () => {
    const file = seriesFileFor('One Piece');
    const archive = await buildVolumeArchive('Vol 1.cbz', mokuroText, [
      { path: 'series.json', text: JSON.stringify(file, null, 2) }
    ]);

    const result = await importFiles([archive]);
    expect(result.success).toBe(true);

    const volumes = await db.volumes.toArray();
    expect(volumes).toHaveLength(1);
    expect(volumes[0].series_title).toBe('One Piece');

    const record = await db.series_metadata.get('one piece');
    expect(record?.external_ids).toEqual({ anilist: 30013 });
    expect(record?.synonyms).toEqual(['ワンピース']);
    expect(record?.tag).toBe('[color]');

    const index = await db.series_index.get('one piece');
    expect(index?.series_title).toBe('One Piece');
    expect(index?.source.provider).toBe('import');
    expect(index?.source.path).toBe('series.json');
    expect(index?.source.size).toBeGreaterThan(0);
    expect(index?.file.volumes.map((v) => v.volume_uuid)).toEqual(['volume-uuid']);
  });

  it('imports the volume anyway when series.json is malformed, warning once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const archive = await buildVolumeArchive('Vol 1.cbz', mokuroText, [
      { path: 'series.json', text: '{ not json' }
    ]);

    const result = await importFiles([archive]);

    expect(result.success).toBe(true);
    expect(await db.volumes.count()).toBe(1);
    expect(await db.series_metadata.get('one piece')).toBeUndefined();
    expect(await db.series_index.get('one piece')).toBeUndefined();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('series.json'))).toHaveLength(
      1
    );
  });

  it('applies one series.json once for a series ZIP holding several volumes', async () => {
    const file = seriesFileFor('One Piece');
    const archive = await buildArchive(
      'One Piece.zip',
      [
        { title: 'Vol 1', mokuro: mokuroTextFor('Vol 1') },
        { title: 'Vol 2', mokuro: mokuroTextFor('Vol 2') }
      ],
      [{ path: 'series.json', text: JSON.stringify(file, null, 2) }]
    );

    const result = await importFiles([archive]);

    expect(result.success).toBe(true);
    expect(await db.volumes.count()).toBe(2);
    expect(await db.series_metadata.count()).toBe(1);
    expect(await db.series_index.count()).toBe(1);
    expect((await db.series_metadata.get('one piece'))?.external_ids).toEqual({ anilist: 30013 });
  });

  it('applies the sidecar even while a failed item is pinned in the queue', async () => {
    importQueue.set([
      {
        id: 'stuck',
        source: {} as never,
        provider: 'local-import',
        status: 'error',
        progress: 0,
        displayTitle: 'An earlier import that failed',
        errorMessage: 'boom'
      }
    ]);

    const archive = await buildVolumeArchive('Vol 1.cbz', mokuroText, [
      { path: 'series.json', text: JSON.stringify(seriesFileFor('One Piece')) }
    ]);

    await importFiles([archive]);

    expect((await db.series_metadata.get('one piece'))?.external_ids).toEqual({ anilist: 30013 });
    importQueue.set([]);
  });

  it('merges the imported index over the cached one instead of shrinking it', async () => {
    await db.series_index.put({
      series_key: 'one piece',
      series_title: 'One Piece',
      file: {
        ...seriesFileFor('One Piece'),
        volumes: [
          {
            volume_uuid: 'cloud-only-uuid',
            volume_title: 'Vol 9',
            page_count: 2,
            character_count: 7,
            mokuro_version: '0.2.1'
          }
        ]
      },
      source: { provider: 'mega', path: 'One Piece/series.json', size: 5, modifiedTime: 'x' },
      fetched_at: '2026-08-16T00:00:00.000Z'
    });

    const archive = await buildVolumeArchive('Vol 1.cbz', mokuroText, [
      { path: 'series.json', text: JSON.stringify(seriesFileFor('One Piece')) }
    ]);

    await importFiles([archive]);

    const index = await db.series_index.get('one piece');
    expect(index?.file.volumes.map((v) => v.volume_uuid).sort()).toEqual([
      'cloud-only-uuid',
      'volume-uuid'
    ]);
    expect(index?.source.provider).toBe('import');
  });

  it('does not break pairing when a series.json is dropped next to the archive', async () => {
    const file = seriesFileFor('One Piece');
    const archive = await buildVolumeArchive('Vol 1.cbz', mokuroText);
    const sidecar = new File([JSON.stringify(file)], 'series.json', {
      type: 'application/json',
      lastModified: 1_700_000_000_000
    });

    const result = await importFiles([archive, sidecar]);

    expect(result.success).toBe(true);
    expect(await db.volumes.count()).toBe(1);
    expect((await db.series_metadata.get('one piece'))?.external_ids).toEqual({ anilist: 30013 });
    expect((await db.series_index.get('one piece'))?.source.provider).toBe('import');
  });
});

describe('the archive our own single-volume export writes', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetImportedSeriesFiles();
    await clearDb();
  });

  it('round-trips: exporting a volume then importing it restores the series facts', async () => {
    const seriesFile = seriesFileFor('One Piece');
    const exported = await compressVolume(
      'Vol 1',
      JSON.parse(mokuroText),
      [{ filename: '001.jpg', data: new Uint8Array([1, 2, 3]) }],
      undefined,
      { seriesFile }
    );
    const archive = new File([exported], 'One Piece - Vol 1.cbz', {
      type: 'application/x-cbz',
      lastModified: 1_700_000_000_000
    });

    const result = await importFiles([archive]);

    expect(result.success).toBe(true);
    expect(await db.volumes.count()).toBe(1);
    expect((await db.series_metadata.get('one piece'))?.external_ids).toEqual({ anilist: 30013 });
    expect((await db.series_index.get('one piece'))?.file.volumes).toHaveLength(1);
  });
});

describe('keying a series.json to a series of the batch', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetImportedSeriesFiles();
    await clearDb();
  });

  afterEach(() => {
    resetImportedSeriesFiles();
  });

  function record(seriesTitle: string) {
    recordSeriesFile({
      file: seriesFileFor(seriesTitle),
      path: `${seriesTitle}/series.json`,
      size: 10,
      modifiedTime: '2026-08-17T00:00:00.000Z'
    });
  }

  it('keys each file of a multi-series drop to its own series', async () => {
    record('One Piece');
    record('Naruto');
    recordImportedSeriesTitle('One Piece');
    recordImportedSeriesTitle('Naruto');

    await applyImportedSeriesFiles();

    expect((await db.series_metadata.get('one piece'))?.series_title).toBe('One Piece');
    expect((await db.series_metadata.get('naruto'))?.series_title).toBe('Naruto');
  });

  it('skips a file whose series is not in an ambiguous batch, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    record('Bleach');
    recordImportedSeriesTitle('One Piece');
    recordImportedSeriesTitle('Naruto');

    await applyImportedSeriesFiles();

    expect(await db.series_metadata.count()).toBe(0);
    expect(await db.series_index.count()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never grafts a foreign series.json onto the one series of the batch', async () => {
    // "Bleach/series.json" dropped alongside "Naruto v01.cbz": the file names a
    // series this import knows nothing about, so Naruto stays unlinked.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    record('Bleach');
    recordImportedSeriesTitle('Naruto');

    await applyImportedSeriesFiles();

    expect(await db.series_metadata.count()).toBe(0);
    expect(await db.series_index.count()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keys a renamed series by index membership, whatever title the file carries', async () => {
    // The sidecar was written before the series was renamed here, so its title
    // is stale — but its index lists the very volume we just imported.
    record('Old Title');
    recordImportedSeriesTitle('New Title', 'volume-uuid');

    await applyImportedSeriesFiles();

    const stored = await db.series_metadata.get('new title');
    expect(stored?.external_ids).toEqual({ anilist: 30013 });
    expect((await db.series_index.get('new title'))?.series_title).toBe('New Title');
  });

  it('membership wins over a title that names another series of the same batch', async () => {
    record('One Piece');
    // Its index lists the Naruto volume (the file was written after a merge),
    // so it belongs to Naruto no matter what its `series_title` says.
    recordImportedSeriesTitle('One Piece', 'one-piece-vol');
    recordImportedSeriesTitle('Naruto', 'volume-uuid');

    await applyImportedSeriesFiles();

    expect(await db.series_metadata.get('one piece')).toBeUndefined();
    expect((await db.series_metadata.get('naruto'))?.external_ids).toEqual({ anilist: 30013 });
  });

  it('when the index straddles two imported series, the one the file names wins', async () => {
    // "One Piece/series.json" whose index lists a volume this batch stored
    // under "One Piece Colored" (sorted first) AND its own volume: the file
    // belongs to the series it names, not the first membership hit.
    recordSeriesFile({
      file: buildSeriesFile({
        seriesTitle: 'One Piece',
        meta: { ...meta, series_title: 'One Piece' },
        localVolumes: [
          { ...volume, series_title: 'One Piece', volume_uuid: 'colored-vol', volume_title: 'A' },
          { ...volume, series_title: 'One Piece', volume_uuid: 'plain-vol', volume_title: 'B' }
        ]
      })!,
      path: 'One Piece/series.json',
      size: 10,
      modifiedTime: '2026-08-17T00:00:00.000Z'
    });
    recordImportedSeriesTitle('One Piece Colored', 'colored-vol');
    recordImportedSeriesTitle('One Piece', 'plain-vol');

    await applyImportedSeriesFiles();

    expect(await db.series_metadata.get('one piece colored')).toBeUndefined();
    expect((await db.series_metadata.get('one piece'))?.external_ids).toEqual({ anilist: 30013 });
  });

  it('when the file names neither owner, the series holding most of its volumes wins', async () => {
    recordSeriesFile({
      file: buildSeriesFile({
        seriesTitle: 'Stale Name',
        meta: { ...meta, series_title: 'Stale Name' },
        localVolumes: [
          { ...volume, series_title: 'Stale Name', volume_uuid: 'a-1', volume_title: 'A1' },
          { ...volume, series_title: 'Stale Name', volume_uuid: 'b-1', volume_title: 'B1' },
          { ...volume, series_title: 'Stale Name', volume_uuid: 'b-2', volume_title: 'B2' }
        ]
      })!,
      path: 'Stale Name/series.json',
      size: 10,
      modifiedTime: '2026-08-17T00:00:00.000Z'
    });
    recordImportedSeriesTitle('Alpha', 'a-1');
    recordImportedSeriesTitle('Beta', 'b-1');
    recordImportedSeriesTitle('Beta', 'b-2');

    await applyImportedSeriesFiles();

    expect(await db.series_metadata.get('alpha')).toBeUndefined();
    expect((await db.series_metadata.get('beta'))?.external_ids).toEqual({ anilist: 30013 });
  });

  it('refuses a file that names a series we already have under that name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await db.volumes.put({ ...volume, series_title: 'Bleach', volume_uuid: 'bleach-vol' });
    record('Bleach');
    recordImportedSeriesTitle('One Piece');

    await applyImportedSeriesFiles();

    expect(await db.series_metadata.get('one piece')).toBeUndefined();
    expect(await db.series_index.count()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('cancelling the queue drops the pending files', async () => {
    record('One Piece');
    cancelQueuedImports();
    recordImportedSeriesTitle('One Piece');

    await applyImportedSeriesFiles();

    expect(await db.series_metadata.count()).toBe(0);
  });

  it('drains the batch so a later import cannot reuse it', async () => {
    record('One Piece');
    recordImportedSeriesTitle('One Piece');
    await applyImportedSeriesFiles();
    await clearDb();

    await applyImportedSeriesFiles();
    expect(await db.series_metadata.count()).toBe(0);
  });

  describe('a file a link brought (LinkSeriesGuard)', () => {
    function guard(batch: number, now: string[] = []): LinkSeriesGuard {
      return {
        batch,
        protectedKeys: new Set(),
        refresh: async () => new Set(now)
      };
    }

    function recordLinked(seriesTitle: string, linkGuard: LinkSeriesGuard) {
      recordSeriesFile({
        file: seriesFileFor(seriesTitle),
        path: `https://link.example/${seriesTitle}/series.json`,
        size: 10,
        modifiedTime: '2026-08-17T00:00:00.000Z',
        linkGuard
      });
    }

    it('is keyed only by the titles its own import stored', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      recordLinked('Naruto', guard(7));
      recordImportedSeriesTitle('Deep', 'deep-vol', 7);
      // Another import of the same batch window stored "Naruto".
      recordImportedSeriesTitle('Naruto', 'naruto-vol', 8);

      await applyImportedSeriesFiles();

      expect(await db.series_metadata.count()).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    /** A guard that reads the real library, as a deep link's does. */
    function libraryGuard(batch: number): LinkSeriesGuard {
      return { batch, protectedKeys: new Set(), refresh: localSeriesKeys };
    }

    /** One processed volume of `seriesTitle`, ready for a real save. */
    function linkVolume(seriesTitle: string, uuid: string): ProcessedVolume {
      return {
        metadata: {
          volumeUuid: uuid,
          seriesUuid: `${seriesTitle}-series`,
          series: seriesTitle,
          volume: uuid,
          mokuroVersion: '0.2.1',
          pageCount: 1,
          chars: 0,
          thumbnail: new Blob(['thumb']),
          thumbnailWidth: 10,
          thumbnailHeight: 14
        },
        ocrData: {
          volume_uuid: uuid,
          pages: [{ img_path: '001.jpg', blocks: [], cumulativeChars: 0 }]
        },
        fileData: { volume_uuid: uuid, files: { '001.jpg': new File([], '001.jpg') } },
        nestedSources: []
      };
    }

    /** Save as an import does, then record the title as `noteImportedVolume` would. */
    async function linkSaves(seriesTitle: string, uuid: string, linkGuard: LinkSeriesGuard) {
      await saveLinkVolume(linkVolume(seriesTitle, uuid), linkGuard);
      recordImportedSeriesTitle(seriesTitle, uuid, linkGuard.batch);
    }

    /** A volume row some other writer (a download, another tab) stored. */
    const otherRow = (seriesTitle: string, uuid: string) =>
      ({ ...volume, series_title: seriesTitle, volume_uuid: uuid }) as VolumeMetadata;

    it('lands on a series that was absent when its import saved there', async () => {
      const linkGuard = libraryGuard(7);
      recordLinked('Naruto', linkGuard);
      await linkSaves('Naruto', 'naruto-vol', linkGuard);
      recordImportedSeriesTitle('Naruto', 'naruto-vol-2', 8);

      await applyImportedSeriesFiles();

      expect((await db.series_metadata.get('naruto'))?.series_title).toBe('Naruto');
    });

    it('not on one the library already held when its import saved there', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      // Whatever put "Naruto" there — another import, a cloud download — the
      // read inside the link's save sees it.
      await db.volumes.put(otherRow('Naruto', 'cloud-naruto'));
      const linkGuard = libraryGuard(7);
      recordLinked('Naruto', linkGuard);
      await linkSaves('Naruto', 'naruto-vol', linkGuard);

      await applyImportedSeriesFiles();

      expect(await db.series_metadata.count()).toBe(0);
      expect(await db.series_index.count()).toBe(0);
      expect(info.mock.calls.flat().join(' ')).toContain('already in the library');
    });

    it('nor on one another writer created just before the save’s transaction', async () => {
      // The window the old read-then-save left open: the series lands after
      // any read made before `saveVolume`, before its transaction opens.
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const original = db.transaction.bind(db) as (...a: unknown[]) => unknown;
      const spy = vi
        .spyOn(db, 'transaction')
        .mockImplementationOnce(((...args: unknown[]) =>
          db.volumes
            .put(otherRow('Naruto', 'cloud-naruto'))
            .then(() => original(...args))) as never);
      const linkGuard = libraryGuard(7);
      recordLinked('Naruto', linkGuard);
      await linkSaves('Naruto', 'naruto-vol', linkGuard);
      spy.mockRestore();

      await applyImportedSeriesFiles();

      expect(await db.volumes.count()).toBe(2);
      expect(await db.series_metadata.count()).toBe(0);
      expect(info.mock.calls.flat().join(' ')).toContain('already in the library');
    });

    it('reads the library once per series, inside the first save there', async () => {
      const linkGuard = libraryGuard(7);
      const refresh = vi.spyOn(linkGuard, 'refresh');
      await linkSaves('Naruto', 'naruto-vol', linkGuard);
      // The second save would see the link's own first volume; it must not
      // take that back.
      await linkSaves('Naruto', 'naruto-vol-2', linkGuard);
      recordLinked('Naruto', linkGuard);

      await applyImportedSeriesFiles();

      expect(refresh).toHaveBeenCalledTimes(2); // the first save's, then the apply's
      expect((await db.series_metadata.get('naruto'))?.series_title).toBe('Naruto');
    });

    it('remembers what a link created across an apply that came between', async () => {
      const linkGuard = libraryGuard(7);
      await linkSaves('Naruto', 'naruto-vol', linkGuard);
      // Another import's apply drains the batch before the link's file arrives.
      await applyImportedSeriesFiles();

      recordLinked('Naruto', linkGuard);
      await linkSaves('Naruto', 'naruto-vol-2', linkGuard);
      await applyImportedSeriesFiles();

      expect((await db.series_metadata.get('naruto'))?.series_title).toBe('Naruto');
    });

    it.each([
      ['a thrown error', async () => Promise.reject(new Error('library unreadable'))],
      // A failed IndexedDB request inside the save's transaction (NaN is no
      // valid key): caught, it must not abort the transaction.
      ['a failed Dexie read', async () => db.volumes.get(NaN as never)]
    ])(
      'saves the volume but creates nothing when the read in the save fails (%s)',
      async (_label, failingRead) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});
        let reads = 0;
        const linkGuard: LinkSeriesGuard = {
          batch: 7,
          protectedKeys: new Set(),
          refresh: async () => {
            if (reads++ === 0) {
              await failingRead();
              throw new Error('the read did not fail');
            }
            return localSeriesKeys();
          }
        };
        recordLinked('Naruto', linkGuard);
        await linkSaves('Naruto', 'naruto-vol', linkGuard);

        expect(await db.volumes.get('naruto-vol')).toBeDefined();
        expect(await db.volume_files.get('naruto-vol')).toBeDefined();

        await applyImportedSeriesFiles();

        expect(reads).toBe(2);
        expect(await db.series_metadata.count()).toBe(0);
        const warned = warn.mock.calls.flat().join(' ');
        expect(warned).toContain('Could not read the library');
        expect(warned).not.toContain('the read did not fail');
      }
    );

    it.each([
      [
        'a duplicate uuid, before its read',
        async () => {
          // Installed, in another series: "Naruto" is still absent.
          await db.volumes.put(otherRow('Other', 'naruto-vol'));
        },
        /already exists/
      ],
      [
        'a write after its read found the series absent',
        async () => {
          vi.spyOn(db.volume_files, 'add').mockRejectedValueOnce(new Error('QuotaExceededError'));
        },
        /QuotaExceededError/
      ]
    ])('creates nothing when the save itself fails (%s)', async (_label, breakTheSave, thrown) => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      await breakTheSave();
      const linkGuard = libraryGuard(7);
      const refresh = vi.spyOn(linkGuard, 'refresh');
      recordLinked('Naruto', linkGuard);
      await expect(saveLinkVolume(linkVolume('Naruto', 'naruto-vol'), linkGuard)).rejects.toThrow(
        thrown
      );
      const readsInFailedSave = refresh.mock.calls.length;
      // The link's next volume there is saved, but the key was already judged
      // (and not created) by the failed save.
      await linkSaves('Naruto', 'naruto-vol-2', linkGuard);

      await applyImportedSeriesFiles();

      expect(await db.volumes.get('naruto-vol-2')).toBeDefined();
      expect(await db.series_metadata.count()).toBe(0);
      // Only the apply read again: the next save did not get a second look.
      expect(refresh.mock.calls.length).toBe(readsInFailedSave + 1);
    });

    it('of two links naming one new series, only the one that created it applies', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const first = libraryGuard(7);
      const second = libraryGuard(8);
      await linkSaves('Naruto', 'naruto-vol', first);
      await linkSaves('Naruto', 'naruto-vol-2', second);
      recordLinked('Naruto', first);
      recordSeriesFile({
        // Newer facts: only the guard can keep them off.
        file: {
          ...seriesFileFor('Naruto'),
          external_ids: { anilist: 999 },
          updated_at: '2026-09-01T00:00:00.000Z'
        },
        path: 'https://other.example/Naruto/series.json',
        size: 10,
        modifiedTime: '2026-08-17T00:00:00.000Z',
        linkGuard: second
      });

      await applyImportedSeriesFiles();

      expect((await db.series_metadata.get('naruto'))?.external_ids).toEqual(
        seriesFileFor('Naruto').external_ids
      );
      expect(info.mock.calls.flat().join(' ')).toContain('already in the library');
    });

    it('dropLinkSeriesFiles forgets that link’s files and nobody else’s', async () => {
      recordLinked('Naruto', guard(7));
      record('One Piece');
      recordImportedSeriesTitle('Naruto', 'naruto-vol', 7);
      recordImportedSeriesTitle('One Piece', 'op-vol', 8);

      dropLinkSeriesFiles(7);
      await applyImportedSeriesFiles();

      expect(await db.series_metadata.get('naruto')).toBeUndefined();
      expect((await db.series_metadata.get('one piece'))?.series_title).toBe('One Piece');
    });
  });
});

describe('publishing what an import applied', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetImportedSeriesFiles();
    await clearDb();
  });

  afterEach(() => {
    resetImportedSeriesFiles();
  });

  function record(seriesTitle: string) {
    recordSeriesFile({
      file: seriesFileFor(seriesTitle),
      path: `${seriesTitle}/series.json`,
      size: 10,
      modifiedTime: '2026-08-17T00:00:00.000Z'
    });
  }

  it('queues a cloud write for facts an import brought in', async () => {
    // An import is out of band — the cloud copy knows nothing about these
    // facts, and nothing else will publish them.
    record('One Piece');
    recordImportedSeriesTitle('One Piece');

    await applyImportedSeriesFiles();

    expect(scheduleSeriesFileWrite).toHaveBeenCalledWith('One Piece');
  });

  it('queues nothing when the sidecar had nothing newer to say', async () => {
    record('One Piece');
    recordImportedSeriesTitle('One Piece');
    await applyImportedSeriesFiles();
    scheduleSeriesFileWrite.mockClear();

    // The same file again: already applied, so there is nothing to publish.
    record('One Piece');
    recordImportedSeriesTitle('One Piece');
    await applyImportedSeriesFiles();

    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
  });
});

describe('parseImportedSeriesFile', () => {
  it('rejects a file that is not a series.json, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseImportedSeriesFile('series.json', '[]', 2, 0)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('stamps the entry with the file modification time', () => {
    const parsed = parseImportedSeriesFile(
      'One Piece/series.json',
      JSON.stringify(seriesFileFor('One Piece')),
      42,
      1_700_000_000_000
    );
    expect(parsed?.path).toBe('One Piece/series.json');
    expect(parsed?.size).toBe(42);
    expect(parsed?.modifiedTime).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('falls back to now for an unusable modification time', () => {
    const parsed = parseImportedSeriesFile(
      'series.json',
      JSON.stringify(seriesFileFor('One Piece')),
      42,
      Number.NaN
    );
    expect(Number.isNaN(Date.parse(parsed!.modifiedTime))).toBe(false);
  });
});

describe('a series.json beside an image-only series waits for its review', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetImportedSeriesFiles();
    await clearDb();
    importQueue.set([]);
    reviewer.restore();
    reviewer = installReviewer('manual');
  });

  afterEach(() => resetImportedSeriesFiles());

  async function waitForIdle(): Promise<void> {
    const start = Date.now();
    while (
      (get(isImporting) ||
        get(importQueue).some((i) => i.status === 'queued' || i.status === 'processing')) &&
      Date.now() - start < 10_000
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function pickedAt(path: string, bytes: BlobPart): File {
    const file = new File([bytes], path.split('/').pop()!, { lastModified: 1_700_000_000_000 });
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    return file;
  }

  it('is applied once the reviewed volumes are saved, not when the queue first drains', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sidecar = pickedAt(
      'Killing Bites/series.json',
      JSON.stringify(seriesFileFor('Killing Bites'))
    );
    const page = pickedAt('Killing Bites/Killing Bites 01/001.jpg', new Uint8Array([1, 2, 3]));
    // A .mokuro volume of another series in the same drop drains the queue first.
    const other = await buildVolumeArchive('Vol 1.cbz', mokuroText);

    await importFiles([sidecar, page, other]);
    await waitForIdle();
    expect(await db.volumes.count()).toBe(1);
    expect(await db.series_metadata.get('killing bites')).toBeUndefined();

    reviewer.pending[0].decide(approveAsDialogWould(reviewer.pending[0].group));
    await waitForIdle();
    await new Promise((r) => setTimeout(r, 50));
    expect((await db.series_metadata.get('killing bites'))?.external_ids).toEqual({
      anilist: 30013
    });
  });
});
