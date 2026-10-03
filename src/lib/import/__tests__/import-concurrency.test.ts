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
const held = vi.hoisted(() => ({ release: [] as (() => void)[] }));
vi.mock('$lib/util/modals', () => ({
  promptMissingFiles: (_info: unknown, onContinue: () => void) => {
    held.release.push(onContinue);
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
import { importFiles, importQueue, isImporting } from '../import-service';
import { reviewSession } from '../review-session';
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
  pool.users = 0;
  pool.terminations = 0;
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_files.clear()]);
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
