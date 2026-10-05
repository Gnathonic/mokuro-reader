/**
 * The image-only review driving a real import (#285): archives are listed
 * before anything is extracted, image-only volumes are offered one series at
 * a time, and each approval goes straight to the queue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { get } from 'svelte/store';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db: any = new Dexie('image-only-review-import-test');
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
vi.mock('$lib/util/modals', () => ({
  promptMissingFiles: (_info: unknown, onContinue: () => void) => onContinue()
}));
vi.mock('$lib/metadata/series-file-sync', () => ({ scheduleSeriesFileWrite: vi.fn() }));
// Every archive read the import makes, so the pre-scan can be held to names only.
vi.mock('../archive-extraction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../archive-extraction')>();
  return {
    ...actual,
    decompressArchive: vi.fn(actual.decompressArchive),
    extractArchiveByVolumes: vi.fn(actual.extractArchiveByVolumes)
  };
});
vi.mock('$lib/util/file-processing-pool', () => ({
  getFileProcessingPool: async () => ({ addTask: () => {} }),
  incrementPoolUsers: () => {},
  decrementPoolUsers: () => {}
}));

import { db } from '$lib/catalog/db';
import {
  cancelQueuedImports,
  describeImportOutcome,
  importFiles,
  importQueue,
  isImporting
} from '../import-service';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
import { decideCurrent, reviewSession, skipAllRemaining } from '../review-session';
import { defaultNaming } from '../image-only-review';
import {
  approveAsDialogWould,
  dialogDefaults,
  installReviewer,
  type Reviewer
} from './helpers/review-bridge';
import { showSnackbar } from '$lib/util/snackbar';
import { progressTrackerStore } from '$lib/util/progress-tracker';
import type { ReviewGroup } from '../image-only-review';
import { decompressArchive, extractArchiveByVolumes } from '../archive-extraction';

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

const IMAGE: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3]);

function picked(path: string, bytes: Uint8Array<ArrayBuffer> | Blob = IMAGE): File {
  const file = new File([bytes], path.split('/').pop()!, { lastModified: 1_700_000_000_000 });
  if (path.includes('/')) Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

async function zipOf(entries: Array<string | { path: string; data: Uint8Array }>): Promise<Blob> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    bufferedWrite: false,
    extendedTimestamp: false
  });
  for (const entry of entries) {
    const { path, data } = typeof entry === 'string' ? { path: entry, data: IMAGE } : entry;
    await writer.add(path, new Uint8ArrayReader(data));
  }
  return new Blob([await writer.close()]);
}

const mokuro = (title: string, volume: string) =>
  new TextEncoder().encode(
    JSON.stringify({
      version: '0.2.1',
      title,
      title_uuid: `${title}-series`,
      volume,
      volume_uuid: `${title}-${volume}`,
      pages: [{ version: '0.2.1', img_width: 1, img_height: 1, img_path: '001.jpg', blocks: [] }]
    })
  );

async function waitForQueue(): Promise<void> {
  const start = Date.now();
  while (
    (get(isImporting) || get(importQueue).some((i) => i.status !== 'error')) &&
    Date.now() - start < 10_000
  ) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function rows() {
  return (await db.volumes.toArray())
    .map((r) => ({ series: r.series_title, volume: r.volume_title }))
    .sort((a, b) => a.volume.localeCompare(b.volume));
}

/** Display titles of every item that passed through the import queue. */
function recordQueue() {
  const titles = new Set<string>();
  const stop = importQueue.subscribe((q) => q.forEach((item) => titles.add(item.displayTitle)));
  return { titles, stop };
}

let reviewer: Reviewer | undefined;

beforeEach(async () => {
  vi.mocked(decompressArchive).mockClear();
  vi.mocked(extractArchiveByVolumes).mockClear();
  importQueue.set([]);
  reviewSession.set({ pending: [], decided: 0 });
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_files.clear()]);
});

afterEach(() => {
  reviewer?.restore();
  reviewer = undefined;
});

describe('pre-scanned archives', () => {
  it('a batch of loose .cbz is ONE series step, never a prompt per archive', async () => {
    reviewer = installReviewer();
    const files = await Promise.all(
      ['01', '02', '03'].map(async (n) =>
        picked(`Killing Bites v${n}.cbz`, await zipOf(['001.jpg']))
      )
    );
    await importFiles(files);
    await waitForQueue();
    expect(reviewer.offered.map((g) => [g.series, g.candidates.map((c) => c.source)])).toEqual([
      ['Killing Bites', ['Killing Bites v01.cbz', 'Killing Bites v02.cbz', 'Killing Bites v03.cbz']]
    ]);
    expect(await rows()).toEqual(
      ['01', '02', '03'].map((n) => ({ series: 'Killing Bites', volume: `Killing Bites ${n}` }))
    );
  });

  it('a series archive of volume folders is one step named after the archive', async () => {
    reviewer = installReviewer();
    await importFiles([
      picked('Series Pack [Digital].zip', await zipOf(['v01/001.jpg', 'v02/001.jpg']))
    ]);
    await waitForQueue();
    expect(reviewer.offered.map((g) => [g.series, g.candidates.length])).toEqual([
      ['Series Pack [Digital]', 2]
    ]);
    expect((await rows()).map((r) => r.volume)).toEqual([
      'Series Pack [Digital] 01',
      'Series Pack [Digital] 02'
    ]);
  });

  it('a mixed archive imports its .mokuro volume even when its image-only part is skipped', async () => {
    reviewer = installReviewer(() => ({ action: 'skip' }));
    const pack = await zipOf([
      { path: 'A.mokuro', data: mokuro('Mixed', 'A') },
      'A/001.jpg',
      'B/001.jpg'
    ]);
    await importFiles([picked('Pack.zip', pack)]);
    await waitForQueue();
    expect(reviewer.offered.map((g) => g.series)).toEqual(['Pack']);
    expect(await rows()).toEqual([{ series: 'Mixed', volume: 'A' }]);
  });

  it('a mixed archive imports both parts when its image-only part is approved', async () => {
    reviewer = installReviewer();
    const pack = await zipOf([
      { path: 'A.mokuro', data: mokuro('Mixed', 'A') },
      'A/001.jpg',
      'B/001.jpg'
    ]);
    await importFiles([picked('Pack.zip', pack)]);
    await waitForQueue();
    expect(await rows()).toEqual([
      { series: 'Mixed', volume: 'A' },
      { series: 'Pack', volume: 'Pack 01' }
    ]);
  });

  it('a skipped archive with no .mokuro volume is never queued', async () => {
    reviewer = installReviewer(() => ({ action: 'skip' }));
    const queued = recordQueue();
    await importFiles([picked('Dorohedoro v01.cbz', await zipOf(['001.jpg']))]);
    await waitForQueue();
    queued.stop();
    expect([...queued.titles]).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});

describe('the pre-scan reads entry names only (mobile)', () => {
  it('lists each archive once, names-only, and reads no entry bytes before the decision', async () => {
    reviewer = installReviewer('manual');
    const loose = picked('Killing Bites v01.cbz', await zipOf(['001.jpg']));
    // A .mokuro inside an archive is not read by the pre-scan either.
    const mixed = picked(
      'Pack.zip',
      await zipOf([{ path: 'A.mokuro', data: mokuro('Mixed', 'A') }, 'A/001.jpg', 'B/001.jpg'])
    );
    await importFiles([loose, mixed]);

    // Offered, not decided: the only archive reads so far are the listings.
    expect(reviewer.pending.map((p) => p.group.series)).toEqual(['Killing Bites', 'Pack']);
    const listings = vi.mocked(decompressArchive).mock.calls;
    expect(listings.map(([file, filter, listOnly]) => [file, filter, listOnly])).toEqual([
      [loose, undefined, true],
      [mixed, undefined, true]
    ]);
    const listed = await Promise.all(vi.mocked(decompressArchive).mock.results.map((r) => r.value));
    expect(listed.flat().map((e) => e.filename)).toContain('A.mokuro');
    expect(listed.flat().every((e) => e.data.byteLength === 0)).toBe(true);
    expect(extractArchiveByVolumes).not.toHaveBeenCalled();

    // Approved: the queue opens each archive as it always did — one image pass each.
    for (const step of [...reviewer.pending]) step.decide(approveAsDialogWould(step.group));
    await waitForQueue();
    expect(extractArchiveByVolumes).toHaveBeenCalledTimes(2);
    expect((await rows()).map((r) => r.volume)).toEqual(['A', 'Killing Bites 01', 'Pack 01']);
  });
});

describe('approval order', () => {
  const twoSeries = () => [
    picked('Chained Soldier (Semi-Color)/01/001.jpg'),
    picked('Chained Soldier (Semi-Color)/02/001.jpg'),
    picked('Killing Bites/Killing Bites 01/001.jpg')
  ];

  it('series 1 imports while series 2 is still waiting for its decision', async () => {
    reviewer = installReviewer('manual');
    await importFiles(twoSeries());
    expect(reviewer.pending.map((p) => p.group.series)).toEqual([
      'Chained Soldier (Semi-Color)',
      'Killing Bites'
    ]);
    expect(await db.volumes.count()).toBe(0);

    reviewer.pending[0].decide(approveAsDialogWould(reviewer.pending[0].group));
    await waitForQueue();
    expect(await rows()).toEqual([
      { series: 'Chained Soldier (Semi-Color)', volume: 'Chained Soldier (Semi-Color) 01' },
      { series: 'Chained Soldier (Semi-Color)', volume: 'Chained Soldier (Semi-Color) 02' }
    ]);

    reviewer.pending[1].decide(approveAsDialogWould(reviewer.pending[1].group));
    await waitForQueue();
    expect((await rows()).map((r) => r.volume)).toContain('Killing Bites 01');
  });

  it('an approved image-only volume goes through the queue, even alone', async () => {
    reviewer = installReviewer();
    const queued = recordQueue();
    await importFiles([picked('Killing Bites/Killing Bites 01/001.jpg')]);
    await waitForQueue();
    queued.stop();
    expect([...queued.titles]).toEqual(['Killing Bites 01']);
  });

  it('a second import while the review is open joins it', async () => {
    await importFiles([picked('Chained Soldier (Semi-Color)/01/001.jpg')]);
    await importFiles([picked('Killing Bites/Killing Bites 01/001.jpg')]);
    expect(get(reviewSession).pending.map((p) => p.group.series)).toEqual([
      'Chained Soldier (Semi-Color)',
      'Killing Bites'
    ]);
    const approveCurrent = () =>
      decideCurrent({
        action: 'import',
        naming: defaultNaming(get(reviewSession).pending[0].group, 'cleaned')
      });
    approveCurrent();
    approveCurrent();
    await waitForQueue();
    expect((await rows()).map((r) => r.volume)).toEqual([
      'Chained Soldier (Semi-Color) 01',
      'Killing Bites 01'
    ]);
  });

  it('a lone .mokuro volume dropped while a review is open waits its turn in the queue', async () => {
    await importFiles([picked('Killing Bites/Killing Bites 01/001.jpg')]);
    const queued = recordQueue();
    const solo = await zipOf([
      { path: 'Solo.mokuro', data: mokuro('Solo', 'Vol 1') },
      'Solo/001.jpg'
    ]);
    await importFiles([picked('Solo.cbz', solo)]);
    await waitForQueue();
    queued.stop();
    expect([...queued.titles]).toEqual(['Solo']);
    expect(await rows()).toEqual([{ series: 'Solo', volume: 'Vol 1' }]);
    expect(get(reviewSession).pending).toHaveLength(1);
    skipAllRemaining();
  });

  it('skip and skip all remaining import nothing and queue nothing', async () => {
    const queued = recordQueue();
    await importFiles([...twoSeries(), picked('Dorohedoro/Dorohedoro 01/001.jpg')]);
    expect(get(reviewSession).pending).toHaveLength(3);
    decideCurrent({ action: 'skip' });
    skipAllRemaining();
    await waitForQueue();
    queued.stop();
    expect([...queued.titles]).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});

describe('reviewed when the queue reaches them', () => {
  it('an archive inside an archive is reviewed when the queue opens it', async () => {
    reviewer = installReviewer();
    const inner = new Uint8Array(await (await zipOf(['001.jpg'])).arrayBuffer());
    const outer = await zipOf([{ path: 'Vol 1 (2020).cbz', data: inner }]);
    await importFiles([picked('Outer Series (Digital).zip', outer)]);
    await waitForQueue();
    expect(reviewer.offered.map((g) => g.series)).toEqual(['Outer Series (Digital)']);
    expect(await rows()).toEqual([
      { series: 'Outer Series (Digital)', volume: 'Outer Series (Digital) 01' }
    ]);
  });

  it('an archive that cannot be read fails like any import error; the rest of the batch imports', async () => {
    reviewer = installReviewer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await importFiles([
      picked('Broken.cbz', new Blob([new Uint8Array([1, 2, 3, 4])])),
      picked('Dorohedoro v01.cbz', await zipOf(['001.jpg'])),
      picked('Dorohedoro v02.cbz', await zipOf(['001.jpg']))
    ]);
    await waitForQueue();
    expect(reviewer.offered.map((g) => g.series)).toEqual(['Dorohedoro']);
    expect((await rows()).map((r) => r.volume)).toEqual(['Dorohedoro 01', 'Dorohedoro 02']);
    expect(get(importQueue).map((i) => [i.displayTitle, i.status])).toEqual([['Broken', 'error']]);
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('a decision the import cannot act on', () => {
  // Decided through the real review session, which only logs a throwing
  // callback: the import has to report its own failures.
  const malformed = (group: ReviewGroup) => ({
    action: 'import' as const,
    naming: { ...dialogDefaults(group), overrides: null as unknown as Record<string, string> }
  });

  beforeEach(() => {
    vi.mocked(showSnackbar).mockClear();
    vi.mocked(progressTrackerStore.addProcess).mockReset();
    vi.mocked(progressTrackerStore.removeProcess).mockClear();
  });

  it('is reported to the user and leaves no progress row behind for what never queued', async () => {
    vi.mocked(progressTrackerStore.addProcess).mockImplementation((p) => {
      if (p.description.endsWith('Killing Bites 02')) throw new Error('tracker gone');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await importFiles([
      picked('Killing Bites/Killing Bites 01/001.jpg'),
      picked('Killing Bites/Killing Bites 02/001.jpg')
    ]);
    decideCurrent(approveAsDialogWould(get(reviewSession).pending[0].group));
    await waitForQueue();
    error.mockRestore();

    expect(showSnackbar).toHaveBeenCalledWith('Import failed: tracker gone');
    const added = vi
      .mocked(progressTrackerStore.addProcess)
      .mock.calls.map(([p]) => p)
      .filter((p) => p.description === 'Importing Killing Bites 01');
    expect(added).toHaveLength(1);
    expect(progressTrackerStore.removeProcess).toHaveBeenCalledWith(added[0].id);
    expect(get(importQueue)).toEqual([]);
    expect(await rows()).toEqual([]);
    expect(get(isImporting)).toBe(false);
  });

  it('in the queue, is reported and the queue moves on instead of waiting forever', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const inner = new Uint8Array(await (await zipOf(['001.jpg'])).arrayBuffer());
    const outer = await zipOf([{ path: 'Vol 1 (2020).cbz', data: inner }]);
    await importFiles([picked('Outer Series (Digital).zip', outer)]);
    // The queue opens the nested archive and waits on its review step.
    const start = Date.now();
    while (get(reviewSession).pending.length === 0 && Date.now() - start < 5_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const { group } = get(reviewSession).pending[0];
    expect(group.series).toBe('Outer Series (Digital)');
    decideCurrent(malformed(group));
    await waitForQueue();
    error.mockRestore();

    expect(showSnackbar).toHaveBeenCalledWith(expect.stringMatching(/^Import failed: /));
    expect(get(isImporting)).toBe(false);
    expect(get(importQueue).map((i) => i.status)).toEqual(['error']);
    expect(await rows()).toEqual([]);
  });
});

async function until(condition: () => boolean, timeout = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('a volume already in the library keeps its uuid, whatever the pick (final review #1)', () => {
  // Measured: every pre-branch import of these volumes, whatever was picked.
  const LEGACY_KB = generateDeterministicUUID('Killing Bites/Volume 01'); // c2329fe8
  const LEGACY_CS = generateDeterministicUUID('Chained Soldier (Semi-Color)/Volume 01'); // 4a785ce6
  const kbArchive = async (path: string) => picked(path, await zipOf(['001.jpg']));

  async function seed(uuid: string, installed: boolean, series = 'Killing Bites') {
    await db.volumes.put({
      volume_uuid: uuid,
      series_uuid: 'seed-series',
      series_title: series,
      volume_title: 'Volume 01',
      mokuro_version: '',
      page_count: 1,
      character_count: 0,
      page_char_counts: [0],
      ...(installed ? {} : { metadata_only: true as const })
    });
    if (installed) {
      await db.volume_ocr.put({ volume_uuid: uuid, pages: [] });
      await db.volume_files.put({ volume_uuid: uuid, files: {} });
    }
  }

  async function only() {
    const all = await db.volumes.toArray();
    expect(all).toHaveLength(1);
    return all[0];
  }

  for (const shape of [
    'Killing Bites v01.cbz',
    'Killing Bites/Killing Bites v01.cbz',
    'Downloads/Killing Bites v01.cbz'
  ]) {
    it(`a removed pre-branch volume picked as "${shape}" is filled in place, history kept`, async () => {
      await seed(LEGACY_KB, false);
      reviewer = installReviewer();
      await importFiles([await kbArchive(shape)]);
      await waitForQueue();
      const row = await only();
      expect(row.volume_uuid).toBe(LEGACY_KB);
      expect(row.metadata_only).toBeUndefined();
      expect(row.volume_title).toBe('Volume 01');
      expect(await db.volume_ocr.get(LEGACY_KB)).toBeDefined();
    });
  }

  it('"Chained Soldier (Semi-Color)/01" finds its pre-branch row', async () => {
    await seed(LEGACY_CS, false, 'Chained Soldier (Semi-Color)');
    reviewer = installReviewer();
    await importFiles([picked('Chained Soldier (Semi-Color)/01/001.jpg')]);
    await waitForQueue();
    expect((await only()).volume_uuid).toBe(LEGACY_CS);
  });

  it('a volume first imported loose is found again inside its series folder and inside Downloads', async () => {
    await seed(generateDeterministicUUID('Killing Bites v01'), false);
    reviewer = installReviewer();
    await importFiles([await kbArchive('Killing Bites/Killing Bites v01.cbz')]);
    await waitForQueue();
    const row = await only();
    expect(row.volume_uuid).toBe(generateDeterministicUUID('Killing Bites v01'));

    // Removed from the device again, then picked from Downloads.
    await db.volume_ocr.delete(row.volume_uuid);
    await db.volume_files.delete(row.volume_uuid);
    await db.volumes.update(row.volume_uuid, { metadata_only: true });
    importQueue.set([]);
    await importFiles([await kbArchive('Downloads/Killing Bites v01.cbz')]);
    await waitForQueue();
    expect((await only()).volume_uuid).toBe(row.volume_uuid);
  });

  it('a volume first imported in its series folder is found again when picked loose', async () => {
    const inFolder = generateDeterministicUUID('Killing Bites/Killing Bites v01');
    await seed(inFolder, false);
    reviewer = installReviewer();
    await importFiles([await kbArchive('Killing Bites v01.cbz')]);
    await waitForQueue();
    expect((await only()).volume_uuid).toBe(inFolder);
  });

  it('an installed volume is shown as already in the library, never re-imported, and takes no number', async () => {
    await seed(LEGACY_KB, true);
    reviewer = installReviewer();
    const queued = recordQueue();
    await importFiles([
      await kbArchive('Killing Bites v01.cbz'),
      await kbArchive('Killing Bites v02.cbz')
    ]);
    await waitForQueue();
    queued.stop();
    const [group] = reviewer.offered;
    const v01 = group.candidates.find((c) => c.source === 'Killing Bites v01.cbz')!;
    expect(group.matches.get(v01.id)).toEqual({ uuid: LEGACY_KB, installed: true });
    expect([...queued.titles]).toEqual(['Killing Bites v02']);
    expect(await rows()).toEqual([
      { series: 'Killing Bites', volume: 'Killing Bites 02' },
      { series: 'Killing Bites', volume: 'Volume 01' }
    ]);
    expect(get(importQueue).filter((i) => i.status === 'error')).toEqual([]);
  });
});

describe('skip all remaining reaches the reviews the queue raises later (final review #4)', () => {
  async function seriesPack() {
    const inner = new Uint8Array(await (await zipOf(['001.jpg'])).arrayBuffer());
    return picked(
      'Series Pack.zip',
      await zipOf([
        { path: 'Pack v01.cbz', data: inner },
        { path: 'Pack v02.cbz', data: inner },
        { path: 'Pack v03.cbz', data: inner },
        { path: 'A.mokuro', data: mokuro('Mixed', 'A') },
        'A/001.jpg'
      ])
    );
  }

  function recordSteps() {
    const ids = new Set<string>();
    const stop = reviewSession.subscribe((s) => s.pending.forEach((p) => ids.add(p.group.id)));
    return { ids, stop };
  }

  it("a pack of image-only .cbz: skip all at step 1 raises no more steps; the pack's .mokuro volume imports", async () => {
    const steps = recordSteps();
    await importFiles([await seriesPack()]);
    await until(() => get(reviewSession).pending.length > 0);
    skipAllRemaining();
    await waitForQueue();
    steps.stop();
    expect(steps.ids.size).toBe(1);
    expect(get(reviewSession).pending).toEqual([]);
    expect(await rows()).toEqual([{ series: 'Mixed', volume: 'A' }]);
  });

  it('cancelling the queue also skips the step on screen and every later one', async () => {
    const steps = recordSteps();
    await importFiles([await seriesPack()]);
    await until(() => get(reviewSession).pending.length > 0);
    cancelQueuedImports();
    expect(get(reviewSession).pending).toEqual([]);
    await waitForQueue();
    steps.stop();
    expect(steps.ids.size).toBe(1);
    expect(await rows()).toEqual([{ series: 'Mixed', volume: 'A' }]);
  });

  it('a later batch is still reviewed after an earlier one was skipped', async () => {
    await importFiles([await seriesPack()]);
    await until(() => get(reviewSession).pending.length > 0);
    skipAllRemaining();
    await waitForQueue();
    await importFiles([picked('Gleipnir v01.cbz', await zipOf(['001.jpg']))]);
    await until(() => get(reviewSession).pending.length > 0);
    expect(get(reviewSession).pending.map((p) => p.group.series)).toEqual(['Gleipnir']);
    skipAllRemaining();
  });
});

describe('an archive whose image-only volumes were all skipped (follow-up #3)', () => {
  beforeEach(() => vi.mocked(showSnackbar).mockClear());

  const errors = () => get(importQueue).filter((i) => i.status === 'error');

  it('is finished, not failed, when the queue reviews it and it is skipped', async () => {
    reviewer = installReviewer(() => ({ action: 'skip' }));
    const inner = new Uint8Array(await (await zipOf(['001.jpg'])).arrayBuffer());
    const outer = await zipOf([{ path: 'Vol 1 (2020).cbz', data: inner }]);
    await importFiles([picked('Outer Series (Digital).zip', outer)]);
    await waitForQueue();
    expect(reviewer.offered).toHaveLength(1);
    expect(errors()).toEqual([]);
    expect(get(importQueue)).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it('a series pack skipped with Skip all remaining leaves no error rows behind', async () => {
    const inner = new Uint8Array(await (await zipOf(['001.jpg'])).arrayBuffer());
    const pack = await zipOf([
      { path: 'Pack v01.cbz', data: inner },
      { path: 'Pack v02.cbz', data: inner },
      { path: 'A.mokuro', data: mokuro('Mixed', 'A') },
      'A/001.jpg'
    ]);
    await importFiles([picked('Series Pack.zip', pack)]);
    await until(() => get(reviewSession).pending.length > 0);
    skipAllRemaining();
    await waitForQueue();
    expect(errors()).toEqual([]);
    expect(await rows()).toEqual([{ series: 'Mixed', volume: 'A' }]);
  });

  it('a genuinely empty archive still fails', async () => {
    reviewer = installReviewer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const empty = await zipOf([{ path: 'readme.txt', data: new TextEncoder().encode('hi') }]);
    const inner = new Uint8Array(await empty.arrayBuffer());
    const outer = await zipOf([{ path: 'Empty.cbz', data: inner }]);
    await importFiles([picked('Holder.zip', outer)]);
    await waitForQueue();
    warn.mockRestore();
    expect(errors().map((i) => [i.displayTitle, i.errorMessage])).toEqual([
      ['Empty', 'No importable volumes found in archive']
    ]);
  });
});

describe('what importFiles reports while a review is open', () => {
  it('counts the volumes still waiting for review, and never calls that complete', async () => {
    reviewer = installReviewer('manual');
    const result = await importFiles([
      picked('Chained Soldier (Semi-Color)/01/001.jpg'),
      picked('Chained Soldier (Semi-Color)/02/001.jpg'),
      picked('Dorohedoro v01.cbz', await zipOf(['001.jpg']))
    ]);
    expect(result).toMatchObject({ imported: 0, queued: 0, awaitingReview: 3 });
    expect(describeImportOutcome(result)).toBe('3 volumes waiting for your review');
    reviewer.pending.forEach((p) => p.decide({ action: 'skip' }));
  });

  it('counts approvals made before it resolved as queued, not complete', async () => {
    reviewer = installReviewer();
    const result = await importFiles([picked('Killing Bites/Killing Bites 01/001.jpg')]);
    expect(result).toMatchObject({ imported: 1, queued: 1, awaitingReview: 0 });
    expect(describeImportOutcome(result)).toBe('Importing 1 item...');
    await waitForQueue();
  });

  it('calls a lone .mokuro volume imported directly complete', async () => {
    const solo = await zipOf([
      { path: 'Solo.mokuro', data: mokuro('Solo', 'Vol 1') },
      'Solo/001.jpg'
    ]);
    const result = await importFiles([picked('Solo.cbz', solo)]);
    expect(result).toMatchObject({ imported: 1, queued: 0, awaitingReview: 0 });
    expect(describeImportOutcome(result)).toBe('Import complete!');
  });
});

describe('describeImportOutcome', () => {
  const base = { success: true, imported: 0, failed: 0, errors: [], queued: 0, awaitingReview: 0 };
  it('names what is still pending, a failure, or nothing at all', () => {
    expect(describeImportOutcome({ ...base, imported: 3, queued: 3 })).toBe('Importing 3 items...');
    expect(describeImportOutcome({ ...base, awaitingReview: 1, imported: 2, queued: 2 })).toBe(
      '1 volume waiting for your review'
    );
    expect(describeImportOutcome({ ...base, success: false, failed: 1, errors: ['boom'] })).toBe(
      'Import failed: boom'
    );
    expect(describeImportOutcome(base)).toBe('Nothing was imported');
  });
});
