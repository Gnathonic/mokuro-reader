/**
 * One archive at a time, whatever the entry point (#285): a lone volume
 * imported directly (not through the queue) still holds the shared worker
 * pool and still counts as an import in flight, so a second drop — its
 * pre-scan, its lone `.mokuro` volume, an approval from the review — neither
 * terminates the pool under it nor runs a second archive beside it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { get } from 'svelte/store';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db: any = new Dexie('import-concurrency-test');
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
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/metadata/series-file-sync', () => ({ scheduleSeriesFileWrite: vi.fn() }));

/** The missing-files prompt holds a direct import mid-flight until released. */
const held = vi.hoisted(() => ({ release: [] as (() => void)[], cancel: [] as (() => void)[] }));
vi.mock('$lib/util/modals', () => ({
  promptMissingFiles: (_info: unknown, onContinue: () => void, onCancel: () => void) => {
    held.release.push(onContinue);
    held.cancel.push(onCancel);
  }
}));

/** The shared pool's user tally, as `file-processing-pool.ts` keeps it. */
const pool = vi.hoisted(() => ({ users: 0, terminations: 0 }));
vi.mock('$lib/util/file-processing-pool', () => ({
  getFileProcessingPool: async () => ({ addTask: () => {} }),
  incrementPoolUsers: () => {
    pool.users++;
  },
  decrementPoolUsers: () => {
    pool.users = Math.max(0, pool.users - 1);
    if (pool.users === 0) pool.terminations++;
  }
}));

import { db } from '$lib/catalog/db';
import {
  importArchiveWithOptionalMokuro,
  importFiles,
  importQueue,
  isImporting
} from '../import-service';
import { reviewSession } from '../review-session';
import { protectedSeriesKey, resetImportedSeriesFiles } from '../series-file-import';
import { createEmptySeriesMetadata } from '$lib/metadata/types';
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

const IMAGE = new Uint8Array([1, 2, 3]);

function picked(path: string, bytes: Uint8Array<ArrayBuffer> | Blob = IMAGE): File {
  const file = new File([bytes], path.split('/').pop()!, { lastModified: 1_700_000_000_000 });
  if (path.includes('/')) Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

/** A one-volume `.cbz`; `pages` beyond its one image make the import ask about missing files. */
async function volumeArchive(name: string, pages = ['001.jpg']): Promise<File> {
  const mokuro = JSON.stringify({
    version: '0.2.1',
    title: name,
    title_uuid: `${name}-series`,
    volume: name,
    volume_uuid: `${name}-volume`,
    pages: pages.map((img_path) => ({
      version: '0.2.1',
      img_width: 1,
      img_height: 1,
      img_path,
      blocks: []
    }))
  });
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    bufferedWrite: false,
    extendedTimestamp: false
  });
  await writer.add(`${name}.mokuro`, new Uint8ArrayReader(new TextEncoder().encode(mokuro)));
  await writer.add(`${name}/001.jpg`, new Uint8ArrayReader(IMAGE));
  return picked(`${name}.cbz`, new Blob([await writer.close()]));
}

async function until(condition: () => boolean, timeout = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForQueue(): Promise<void> {
  await until(
    () => !get(isImporting) && !get(importQueue).some((i) => i.status !== 'error'),
    10_000
  );
}

const titles = async () => (await db.volumes.toArray()).map((r) => r.volume_title).sort();

let reviewer: Reviewer | undefined;

beforeEach(async () => {
  importQueue.set([]);
  reviewSession.set({ pending: [], decided: 0 });
  held.release = [];
  held.cancel = [];
  pool.users = 0;
  pool.terminations = 0;
  resetImportedSeriesFiles();
  await Promise.all([
    db.volumes.clear(),
    db.volume_ocr.clear(),
    db.volume_files.clear(),
    db.series_metadata.clear(),
    db.series_index.clear()
  ]);
});

afterEach(() => {
  reviewer?.restore();
  reviewer = undefined;
});

describe('a direct import in flight', () => {
  it("holds the worker pool, so a second drop's pre-scan cannot terminate it", async () => {
    const first = importFiles([await volumeArchive('First', ['001.jpg', '002.jpg'])]);
    await until(() => held.release.length === 1);
    expect(pool.users).toBeGreaterThan(0);
    const terminationsBefore = pool.terminations;

    // Dropped meanwhile: its pre-scan counts in and out of the pool.
    await importFiles([await volumeArchive('Second')]);
    expect(pool.terminations).toBe(terminationsBefore);

    held.release.shift()!();
    await first;
    await waitForQueue();
    expect(await titles()).toEqual(['First', 'Second']);
    expect(pool.users).toBe(0);
  });

  it('makes a second lone .mokuro volume wait its turn in the queue', async () => {
    const first = importFiles([await volumeArchive('First', ['001.jpg', '002.jpg'])]);
    await until(() => held.release.length === 1);

    await importFiles([await volumeArchive('Second')]);
    await new Promise((r) => setTimeout(r, 100));
    expect(await titles()).toEqual([]);
    expect(get(importQueue).map((i) => [i.displayTitle, i.status])).toEqual([['Second', 'queued']]);

    held.release.shift()!();
    await first;
    await waitForQueue();
    expect(await titles()).toEqual(['First', 'Second']);
  });

  it('makes an approval from the review wait its turn too', async () => {
    reviewer = installReviewer();
    const first = importFiles([await volumeArchive('First', ['001.jpg', '002.jpg'])]);
    await until(() => held.release.length === 1);

    await importFiles([picked('Killing Bites/Killing Bites 01/001.jpg')]);
    expect(reviewer.offered.map((g) => g.series)).toEqual(['Killing Bites']);
    await new Promise((r) => setTimeout(r, 100));
    expect(await titles()).toEqual([]);
    expect(get(importQueue).map((i) => i.status)).toEqual(['queued']);

    held.release.shift()!();
    await first;
    await waitForQueue();
    expect(await titles()).toEqual(['First', 'Killing Bites 01']);
  });
});

describe('approved but not saved yet (final review #3)', () => {
  it('a second pick of the same series while the first still waits in the queue numbers after it', async () => {
    reviewer = installReviewer();
    // The phone flow: v01–02 approved, still waiting behind a running import…
    const first = importFiles([await volumeArchive('First', ['001.jpg', '002.jpg'])]);
    await until(() => held.release.length === 1);
    await importFiles([picked('Killing Bites v01/001.jpg'), picked('Killing Bites v02/001.jpg')]);
    expect(await titles()).toEqual([]);
    // …and v03–04 picked meanwhile.
    await importFiles([picked('Killing Bites v03/001.jpg'), picked('Killing Bites v04/001.jpg')]);
    expect(reviewer.offered.map((g) => g.existingCount)).toEqual([0, 2]);

    held.release.shift()!();
    await first;
    await waitForQueue();
    expect(await titles()).toEqual([
      'First',
      'Killing Bites 01',
      'Killing Bites 02',
      'Killing Bites 03',
      'Killing Bites 04'
    ]);
  });

  it('a volume that fails to import stops counting', async () => {
    reviewer = installReviewer();
    const first = importFiles([await volumeArchive('First', ['001.jpg', '002.jpg'])]);
    await until(() => held.release.length === 1);
    // Approved, then cancelled before it ever ran.
    await importFiles([picked('Killing Bites v01/001.jpg')]);
    const { cancelQueuedImports } = await import('../import-service');
    cancelQueuedImports();
    await importFiles([picked('Killing Bites v02/001.jpg')]);
    expect(reviewer.offered.map((g) => g.existingCount)).toEqual([0, 0]);
    held.release.shift()!();
    await first;
    await waitForQueue();
  });
});

describe('a deep link (final review #8)', () => {
  it('waits for a running import before it opens its archive', async () => {
    const first = importFiles([await volumeArchive('First', ['001.jpg', '002.jpg'])]);
    await until(() => held.release.length === 1);

    const deep = importArchiveWithOptionalMokuro(await volumeArchive('Deep'), null);
    await new Promise((r) => setTimeout(r, 100));
    expect(await titles()).toEqual([]);

    held.release.shift()!();
    await first;
    await deep;
    await waitForQueue();
    expect(await titles()).toEqual(['Deep', 'First']);
  });

  it('reads its series guard only once it has its turn, after the running import saved', async () => {
    // A link's series.json must not land on a series the user was importing
    // right then: the guard is read once that import is done, so it sees it.
    const first = importFiles([await volumeArchive('First', ['001.jpg', '002.jpg'])]);
    await until(() => held.release.length === 1);

    const seenAtGuard: string[][] = [];
    const protectSeries = vi.fn(async () => {
      seenAtGuard.push(await titles());
      return new Set<string>();
    });
    const deep = importArchiveWithOptionalMokuro(await volumeArchive('Deep'), null, {
      protectSeries
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(protectSeries).not.toHaveBeenCalled();

    held.release.shift()!();
    await first;
    await deep;
    await waitForQueue();
    // The turn's read, then the one just before its own volume saved.
    expect(seenAtGuard).toEqual([['First'], ['First']]);
  });

  it('fails the import, saving nothing, when its series guard cannot be read', async () => {
    const result = await importArchiveWithOptionalMokuro(await volumeArchive('Deep'), null, {
      protectSeries: async () => {
        throw new Error('library unreadable');
      }
    }).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(await titles()).toEqual([]);
    expect(get(isImporting)).toBe(false);
  });

  it('waits for the queue too, and the queue waits for it in turn', async () => {
    // A queued pair: the first holds the queue on its missing-files prompt.
    void importFiles([
      await volumeArchive('Queued A', ['001.jpg', '002.jpg']),
      await volumeArchive('Queued B')
    ]);
    await until(() => held.release.length === 1);
    const deep = importArchiveWithOptionalMokuro(await volumeArchive('Deep'), null);
    await new Promise((r) => setTimeout(r, 100));
    expect(await titles()).toEqual([]);
    held.release.shift()!();
    await deep;
    await waitForQueue();
    expect(await titles()).toEqual(['Deep', 'Queued A', 'Queued B']);
    expect(pool.users).toBe(0);
  });
});

describe('a deep link’s series.json and the imports around it (TOCTOU)', () => {
  /** The library's series, as `localSeriesKeys` reads them for a real link. */
  const libraryKeys = async (): Promise<Set<string>> => {
    const rows = await db.volumes.toArray();
    const records = await db.series_metadata.toCollection().primaryKeys();
    return new Set(
      [...rows.map((r: { series_title: string }) => r.series_title), ...records].map((k) =>
        protectedSeriesKey(String(k))
      )
    );
  };

  function seriesJson(series: string, volumeUuids: string[] = []): string {
    return JSON.stringify({
      version: 2,
      series_title: series,
      external_ids: { anilist: 4242 },
      titles: { native: 'リンク' },
      synonyms: [],
      updated_at: '2026-10-01T00:00:00.000Z',
      volumes: volumeUuids.map((volume_uuid) => ({
        volume_uuid,
        volume_title: volume_uuid,
        page_count: 1,
        character_count: 0,
        mokuro_version: '0.2.1'
      }))
    });
  }

  function mokuroJson(series: string, volume: string, uuid: string, pages: string[]): string {
    return JSON.stringify({
      version: '0.2.1',
      title: series,
      title_uuid: `${series}-series`,
      volume,
      volume_uuid: uuid,
      pages: pages.map((img_path) => ({
        version: '0.2.1',
        img_width: 1,
        img_height: 1,
        img_path,
        blocks: []
      }))
    });
  }

  async function zip(name: string, entries: Record<string, string | Uint8Array>): Promise<File> {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      bufferedWrite: false,
      extendedTimestamp: false
    });
    for (const [path, body] of Object.entries(entries)) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      await writer.add(path, new Uint8ArrayReader(bytes));
    }
    return picked(name, new Blob([await writer.close()]));
  }

  /** One volume of `series`; extra `pages` make its import stop on the missing-files prompt. */
  async function seriesVolume(
    series: string,
    volume: string,
    { pages = ['001.jpg'], extra = {} }: { pages?: string[]; extra?: Record<string, string> } = {}
  ): Promise<File> {
    return zip(`${volume}.cbz`, {
      [`${volume}.mokuro`]: mokuroJson(series, volume, `${volume}-volume`, pages),
      [`${volume}/001.jpg`]: IMAGE,
      ...extra
    });
  }

  /**
   * What the user drops while the link is in flight: "Victim" — the series the
   * link's file names — and a second volume, so the batch is still queued when
   * the link's own import ends and its files wait for the queue to drain.
   */
  const localDrop = async () => [
    await seriesVolume('Victim', 'Victim 01'),
    await seriesVolume('Bystander', 'Bystander 01')
  ];

  const facts = async (series: string) =>
    (await db.series_metadata.get(series.toLowerCase()))?.external_ids;

  it('never lands on a series a local import created while the link was in flight', async () => {
    // The link's own volume is in "Deep"; its series.json names "Victim".
    const link = importArchiveWithOptionalMokuro(
      await seriesVolume('Deep', 'Deep 01', {
        pages: ['001.jpg', '002.jpg'],
        extra: { 'series.json': seriesJson('Victim') }
      }),
      null,
      { protectSeries: libraryKeys }
    );
    await until(() => held.release.length === 1);
    // Guard read at the link's turn: "Victim" is not in the library yet.
    await importFiles(await localDrop());
    expect(get(importQueue).map((i) => i.status)).toEqual(['queued', 'queued']);

    held.release.shift()!();
    await link;
    await waitForQueue();

    expect(await titles()).toEqual(['Bystander 01', 'Deep 01', 'Victim 01']);
    expect(await facts('Victim')).toBeUndefined();
    expect(await db.series_index.get('victim')).toBeUndefined();
  });

  it('never lands on one a local import created before the link’s queued archives saved', async () => {
    // A series pack: the link's own volume, and an archive of "Victim" nested
    // in it — queued behind whatever the user dropped during the link's turn.
    const link = importArchiveWithOptionalMokuro(
      await zip('Pack.zip', {
        'Deep 01.mokuro': mokuroJson('Deep', 'Deep 01', 'Deep 01-volume', ['001.jpg', '002.jpg']),
        'Deep 01/001.jpg': IMAGE,
        'Victim 02.cbz': new Uint8Array(
          await (await seriesVolume('Victim', 'Victim 02')).arrayBuffer()
        ),
        'series.json': seriesJson('Victim', ['Victim 02-volume'])
      }),
      null,
      { protectSeries: libraryKeys }
    );
    await until(() => held.release.length === 1);
    await importFiles([await seriesVolume('Victim', 'Victim 01')]);

    held.release.shift()!();
    await link;
    await waitForQueue();

    // Both landed in "Victim", but the user's import created it.
    expect(await titles()).toEqual(['Deep 01', 'Victim 01', 'Victim 02']);
    expect(await facts('Victim')).toBeUndefined();
    expect(await db.series_index.get('victim')).toBeUndefined();
  });

  /**
   * A series pack whose own volume holds on the missing-files prompt, with
   * "Victim 02" in a nested archive that carries its own series.json (naming
   * Victim) and holds on the prompt too — so a test can act while that nested
   * archive is mid-scan in the queue.
   */
  async function packWithNestedVictim(): Promise<File> {
    const nested = await seriesVolume('Victim', 'Victim 02', {
      pages: ['001.jpg', '002.jpg'],
      extra: { 'series.json': seriesJson('Victim', ['Victim 02-volume']) }
    });
    return zip('Pack.zip', {
      'Deep 01.mokuro': mokuroJson('Deep', 'Deep 01', 'Deep 01-volume', ['001.jpg', '002.jpg']),
      'Deep 01/001.jpg': IMAGE,
      'N1.cbz': new Uint8Array(await nested.arrayBuffer())
    });
  }

  it.each([
    ['an empty drop', async () => void (await importFiles([]))],
    [
      'a lone volume, which must queue behind the running item',
      async () => {
        await importFiles([await seriesVolume('Other', 'Other 01')]);
        const other = get(importQueue).find((i) => i.displayTitle.includes('Other'));
        expect(other?.status).toBe('queued');
      }
    ],
    [
      'an all-skip review decision',
      async () => {
        reviewer = installReviewer(() => ({ action: 'skip' }));
        await importFiles([await zip('Loose 01.cbz', { '001.jpg': IMAGE })]);
      }
    ]
  ])(
    'never lands on a series the user created, after %s while the link’s nested archive scans',
    async (_label, midScan) => {
      const link = importArchiveWithOptionalMokuro(await packWithNestedVictim(), null, {
        protectSeries: libraryKeys
      });
      await until(() => held.release.length === 1);
      // Queued ahead of the link's nested archive, so it creates "Victim".
      await importFiles([await seriesVolume('Victim', 'Victim 01')]);
      held.release.shift()!();
      await link;

      // The queue saved Victim 01 and now holds N1 mid-scan.
      await until(() => held.release.length === 1);
      expect(await titles()).toContain('Victim 01');
      await midScan();

      held.release.shift()!();
      await waitForQueue();

      expect(await titles()).toEqual(expect.arrayContaining(['Deep 01', 'Victim 01', 'Victim 02']));
      expect(await facts('Victim')).toBeUndefined();
      expect(await db.series_index.get('victim')).toBeUndefined();
    }
  );

  it('does apply a nested archive’s file to the series that archive of the link created', async () => {
    // The control for the two tests around it: with nobody else creating
    // "Victim", the file a nested archive of the link carries does land.
    const link = importArchiveWithOptionalMokuro(await packWithNestedVictim(), null, {
      protectSeries: libraryKeys
    });
    await until(() => held.release.length === 1);
    held.release.shift()!();
    await link;
    await until(() => held.release.length === 1);
    held.release.shift()!();
    await waitForQueue();

    expect(await titles()).toEqual(['Deep 01', 'Victim 02']);
    // The queue reports idle BEFORE its finally applies the batch's series.json
    // (facts, then the cached index): wait for both, or the index write lands
    // in the next test, after its beforeEach cleared the tables.
    await vi.waitFor(async () => expect(await facts('Victim')).toEqual({ anilist: 4242 }));
    await vi.waitFor(async () => expect(await db.series_index.get('victim')).toBeDefined());
  });

  it('never lands on a series a cloud download created before the link’s archive saved', async () => {
    const link = importArchiveWithOptionalMokuro(
      await zip('Pack.zip', {
        'Deep 01.mokuro': mokuroJson('Deep', 'Deep 01', 'Deep 01-volume', ['001.jpg', '002.jpg']),
        'Deep 01/001.jpg': IMAGE,
        'Victim 02.cbz': new Uint8Array(
          await (await seriesVolume('Victim', 'Victim 02')).arrayBuffer()
        ),
        'series.json': seriesJson('Victim', ['Victim 02-volume'])
      }),
      null,
      { protectSeries: libraryKeys }
    );
    await until(() => held.release.length === 1);
    // The link's turn has read the library; now a download installs "Victim"
    // (download-queue's processVolumeData records nothing with the import).
    await db.volumes.put({
      volume_uuid: 'cloud-victim-01',
      series_uuid: 'cloud-victim',
      series_title: 'Victim',
      volume_title: 'Victim 01',
      mokuro_version: '0.2.1',
      page_count: 1,
      character_count: 0,
      page_char_counts: [0]
    } as never);

    held.release.shift()!();
    await link;
    await waitForQueue();

    expect(await titles()).toEqual(['Deep 01', 'Victim 01', 'Victim 02']);
    expect(await facts('Victim')).toBeUndefined();
    expect(await db.series_index.get('victim')).toBeUndefined();
  });

  /**
   * Run `writer` once, just before the next volume save opens its transaction:
   * after any read the link's import made before calling `saveVolume`, before
   * the save commits — another tab, a cloud download or a sync landing in
   * that window.
   */
  function writeJustBeforeTheSave(writer: () => Promise<unknown>) {
    const original = db.transaction.bind(db) as (...a: unknown[]) => unknown;
    let armed = true;
    return vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
      const tables = args[1];
      if (!armed || !Array.isArray(tables) || !tables.includes(db.volume_files)) {
        return original(...args);
      }
      armed = false;
      return writer().then(() => original(...args));
    }) as never);
  }

  it('never lands on a series another writer created between the library read and the save', async () => {
    const spy = writeJustBeforeTheSave(() =>
      db.volumes.put({
        volume_uuid: 'cloud-victim-00',
        series_uuid: 'cloud-victim',
        series_title: 'Victim',
        volume_title: 'Victim 00',
        mokuro_version: '0.2.1',
        page_count: 1,
        character_count: 0,
        page_char_counts: [0]
      } as never)
    );
    await importArchiveWithOptionalMokuro(
      await seriesVolume('Victim', 'Victim 01', {
        extra: { 'series.json': seriesJson('Victim', ['Victim 01-volume']) }
      }),
      null,
      { protectSeries: libraryKeys }
    );
    await waitForQueue();
    spy.mockRestore();

    expect(await titles()).toEqual(['Victim 00', 'Victim 01']);
    expect(await facts('Victim')).toBeUndefined();
    expect(await db.series_index.get('victim')).toBeUndefined();
  });

  it('never overwrites series facts another writer stored between the library read and the save', async () => {
    const theUsers = {
      ...createEmptySeriesMetadata('Victim', '2026-01-01T00:00:00.000Z'),
      folded_key: protectedSeriesKey('Victim'),
      external_ids: { anilist: 1 },
      facts_updated_at: '2026-01-01T00:00:00.000Z'
    };
    const spy = writeJustBeforeTheSave(() => db.series_metadata.put(theUsers));
    await importArchiveWithOptionalMokuro(
      await seriesVolume('Victim', 'Victim 01', {
        extra: { 'series.json': seriesJson('Victim', ['Victim 01-volume']) }
      }),
      null,
      { protectSeries: libraryKeys }
    );
    await waitForQueue();
    spy.mockRestore();

    expect(await titles()).toEqual(['Victim 01']);
    expect(await facts('Victim')).toEqual({ anilist: 1 });
    expect(await db.series_index.get('victim')).toBeUndefined();
  });

  it('a failed link’s series.json is dropped, not applied to the next import’s series', async () => {
    const link = importArchiveWithOptionalMokuro(
      await seriesVolume('Deep', 'Deep 01', {
        pages: ['001.jpg', '002.jpg'],
        extra: { 'series.json': seriesJson('Victim') }
      }),
      null,
      { protectSeries: libraryKeys }
    );
    await until(() => held.cancel.length === 1);
    await importFiles(await localDrop());

    // The user cancels the link's import at the missing-files prompt.
    held.cancel.shift()!();
    const result = await link;
    await waitForQueue();

    expect(result.success).toBe(false);
    expect(await titles()).toEqual(['Bystander 01', 'Victim 01']);
    expect(await facts('Victim')).toBeUndefined();
  });

  it('a skipped link’s series.json is dropped too', async () => {
    reviewer = installReviewer('manual');
    // Image-only: the link waits in its review until the user decides.
    const link = importArchiveWithOptionalMokuro(
      await zip('Deep 01.cbz', {
        '001.jpg': IMAGE,
        'series.json': seriesJson('Victim')
      }),
      null,
      { protectSeries: libraryKeys }
    );
    await until(() => reviewer!.pending.length === 1);
    await importFiles(await localDrop());

    reviewer.pending.shift()!.decide({ action: 'skip' });
    await link;
    await waitForQueue();

    expect(await titles()).toEqual(['Bystander 01', 'Victim 01']);
    expect(await facts('Victim')).toBeUndefined();
  });

  it('still applies to the series the link itself created, whatever joined it later', async () => {
    const link = importArchiveWithOptionalMokuro(
      await seriesVolume('Deep', 'Deep 01', {
        pages: ['001.jpg', '002.jpg'],
        extra: { 'series.json': seriesJson('Deep', ['Deep 01-volume']) }
      }),
      null,
      { protectSeries: libraryKeys }
    );
    await until(() => held.release.length === 1);
    // The user's own volume of the same series, queued behind the link.
    await importFiles([await seriesVolume('Deep', 'Deep 02')]);

    held.release.shift()!();
    await link;
    await waitForQueue();

    expect(await titles()).toEqual(['Deep 01', 'Deep 02']);
    // The queue reports idle (`isImporting` false) BEFORE its finally applies
    // the batch's series.json (facts, then the cached index), so both are
    // waited for rather than read the moment the queue went idle.
    await vi.waitFor(async () => expect(await facts('Deep')).toEqual({ anilist: 4242 }));
    await vi.waitFor(async () => expect(await db.series_index.get('deep')).toBeDefined());
  });

  it('applies a link’s file in a lone confirmed import', async () => {
    await importArchiveWithOptionalMokuro(
      await seriesVolume('Deep', 'Deep 01', { extra: { 'series.json': seriesJson('Deep') } }),
      null,
      { protectSeries: libraryKeys }
    );
    await waitForQueue();
    expect(await facts('Deep')).toEqual({ anilist: 4242 });
  });

  it('applies nothing when the library cannot be read again at apply time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reads = 0;
    await importArchiveWithOptionalMokuro(
      await seriesVolume('Deep', 'Deep 01', { extra: { 'series.json': seriesJson('Deep') } }),
      null,
      {
        protectSeries: async () => {
          // The turn's read and the save's succeed; the apply's fails.
          if (reads++ > 1) throw new Error('library unreadable');
          return libraryKeys();
        }
      }
    );
    await waitForQueue();
    expect(reads).toBe(3);
    expect(await facts('Deep')).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('could not read the library');
    warn.mockRestore();
  });
});
