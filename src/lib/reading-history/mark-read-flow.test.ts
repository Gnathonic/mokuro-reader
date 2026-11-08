import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
const ocrRows = vi.hoisted(() => new Map<string, { pages: unknown[] }>());
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined), bulkGet: vi.fn(async () => []) },
    volume_ocr: { get: vi.fn(async (uuid: string) => ocrRows.get(uuid)) }
  }
}));
const stores = vi.hoisted(() => {
  // A tiny writable: the real svelte/store is not importable inside vi.hoisted.
  function writable<T>(value: T) {
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      },
      set(v: T) {
        value = v;
        for (const fn of subs) fn(v);
      }
    };
  }
  return {
    catalog: writable<Record<string, unknown>>({}),
    speed: writable({
      charsPerMinute: 200,
      isPersonalized: true,
      confidence: 'high' as string,
      sessionsUsed: 3
    })
  };
});
vi.mock('$lib/catalog', () => ({ volumes: stores.catalog }));
vi.mock('$lib/settings/reading-speed', () => ({ personalizedReadingSpeed: stores.speed }));
const snackbar = vi.hoisted(() => vi.fn());
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: snackbar }));

import { get } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import { setMarkReadPolicy, setTrackingStates, markReadPolicy } from '$lib/settings/tracking-data';
import { clearVolumes, updateProgress, volumesWithTrash } from '$lib/settings/volume-data';
import { historyDb } from './history-db';
import { recordEvent } from './record';
import {
  _resetReadingStatsForTests,
  figuresFor,
  flushReadingStats,
  initReadingStats,
  readingStats
} from './stats-store';
import { _resetHistoryTurns, getVolumeEvents, loadHistoryTurns } from './turns-store';
import {
  markRead,
  markReadBulk,
  markReadSheet,
  markUnread,
  type SheetAnswer
} from './mark-read-flow';
import type { ReadingEvent } from './types';

const MIN = 60_000;

/** `pages` pages of 100 characters. */
function volume(uuid: string, title: string, pages = 10): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 'series',
    series_title: 'Series',
    volume_title: title,
    mokuro_version: '0.2.1',
    page_count: pages,
    character_count: pages * 100,
    page_char_counts: Array.from({ length: pages }, (_, i) => (i + 1) * 100)
  } as VolumeMetadata;
}

/** Fire-and-forget history writes stored, heard and counted. */
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 15));
  flushReadingStats();
}

/** The sheet the flow opened, answered. */
async function answerSheet(answer: Partial<SheetAnswer> | null) {
  for (let i = 0; i < 50 && !get(markReadSheet); i++) await new Promise((r) => setTimeout(r, 0));
  const open = get(markReadSheet);
  expect(open).not.toBeNull();
  const request = { ...open! };
  open!.answer(
    answer && {
      count: false,
      checked: open!.checked,
      upTo: open!.upTo,
      typedMinutes: null,
      dontAskAgain: false,
      ...answer
    }
  );
  return request;
}

const events = (uuid: string) => getVolumeEvents(uuid);
const kinds = (uuid: string) => events(uuid).map((e) => e.kind);
/** The last snackbar: message, and its action. */
const lastSnackbar = () => {
  const call = snackbar.mock.calls.at(-1)!;
  return { message: call[0] as string, action: call[2] as { onClick: () => void } | undefined };
};

/** Read pages `from..to` of a volume in the app: one view each, 30 s. */
async function readPages(uuid: string, from: number, to: number) {
  for (let page = from; page <= to; page++) {
    await recordEvent(
      {
        kind: 'page',
        volume: uuid,
        first_page: page,
        last_page: page,
        page_chars: [100],
        chars_before: (page - 1) * 100,
        dwell_ms: 30_000,
        layout: 'single',
        orientation: 'portrait',
        viewport: null
      },
      Date.now() - (to - page + 1) * MIN
    );
  }
  await settle();
}

beforeEach(async () => {
  clearVolumes();
  window.localStorage.clear();
  setTrackingStates({});
  snackbar.mockClear();
  stores.speed.set({
    charsPerMinute: 200,
    isPersonalized: true,
    confidence: 'high',
    sessionsUsed: 3
  });
  _resetHistoryTurns();
  _resetReadingStatsForTests();
  const db = historyDb();
  await db.reading_events.clear();
  await loadHistoryTurns(db);
  initReadingStats();
  await settle();
});

describe('markRead: one volume (#224)', () => {
  it('nothing left to count: marked at once, no sheet, no credit, with Undo', async () => {
    const v = volume('a', 'Vol 1', 3);
    await readPages('a', 1, 3);
    await markRead(v);
    expect(get(markReadSheet)).toBeNull();
    expect(get(volumesWithTrash).a).toMatchObject({ progress: 3, completed: true });
    expect(kinds('a')).not.toContain('credit');
    expect(lastSnackbar().message).toBe('Marked Vol 1 as read');
    expect(lastSnackbar().action).toBeDefined();
  });

  it('asks; Count them credits the pages not read here, at the estimate, and leaves speed alone', async () => {
    const v = volume('a', 'Vol 1');
    await readPages('a', 1, 4);
    const before = get(readingStats);
    const done = markRead(v);
    const request = await answerSheet({ count: true });
    await done;
    expect(request.volumes[0].notRead).toEqual([5, 6, 7, 8, 9, 10]);
    expect(request.focus).toBe('skip');
    await settle();
    const credit = events('a').find((e) => e.kind === 'credit') as Extract<
      ReadingEvent,
      { kind: 'credit' }
    >;
    // 600 characters at 200 chars/min.
    expect(credit).toMatchObject({ pages: [5, 6, 7, 8, 9, 10], time_ms: 3 * MIN });
    const figures = figuresFor(get(readingStats), 'a');
    expect(figures.chars).toBe(1000);
    expect(figures.credit).toEqual({ timeMs: 3 * MIN, chars: 600 });
    expect(get(readingStats).recent).toEqual(before.recent);
    expect(get(readingStats).pace).toBe(before.pace);
    expect(lastSnackbar().message).toBe('Marked Vol 1 as read · counted 600 characters, 3 min');
  });

  it('×, Escape or the backdrop write nothing', async () => {
    updateProgress('a', 2, 200);
    const record = { ...get(volumesWithTrash).a };
    const done = markRead(volume('a', 'Vol 1'));
    await answerSheet(null);
    await done;
    expect(get(volumesWithTrash).a).toEqual(record);
    expect(events('a')).toEqual([]);
    expect(snackbar).not.toHaveBeenCalled();
  });

  it('Don’t count marks exactly as before; Don’t ask again makes the answer the setting', async () => {
    const done = markRead(volume('a', 'Vol 1'));
    await answerSheet({ count: false, dontAskAgain: true });
    await done;
    await settle();
    expect(get(volumesWithTrash).a).toMatchObject({ progress: 10, completed: true });
    expect(kinds('a')).toEqual(['position']);
    expect(get(markReadPolicy)).toBe('skip');
    // Asked no more.
    await markRead(volume('b', 'Vol 2'));
    expect(get(markReadSheet)).toBeNull();
    await settle();
    expect(kinds('b')).toEqual(['position']);
  });

  it('setting Count: no sheet; with no speed data it counts characters only', async () => {
    setMarkReadPolicy('count');
    stores.speed.set({
      charsPerMinute: 100,
      isPersonalized: false,
      confidence: 'none',
      sessionsUsed: 0
    });
    await markRead(volume('a', 'Vol 1'));
    expect(get(markReadSheet)).toBeNull();
    await settle();
    expect(events('a').find((e) => e.kind === 'credit')).toMatchObject({ time_ms: 0 });
    expect(lastSnackbar().message).toBe(
      'Marked Vol 1 as read · counted 1,000 characters, no time added'
    );
  });

  it('Undo returns to the page it was on and takes the credit back', async () => {
    updateProgress('a', 4, 400);
    await readPages('a', 1, 4);
    const done = markRead(volume('a', 'Vol 1'));
    await answerSheet({ count: true, typedMinutes: 20 });
    await done;
    await settle();
    expect(figuresFor(get(readingStats), 'a').credit.timeMs).toBe(20 * MIN);
    lastSnackbar().action!.onClick();
    await settle();
    await settle();
    expect(get(volumesWithTrash).a).toMatchObject({ progress: 4, completed: false });
    expect(figuresFor(get(readingStats), 'a').credit).toEqual({ timeMs: 0, chars: 0 });
    expect(kinds('a')).toContain('retract');
  });

  it('an implausible page count (a damaged series.json) marks, but counts nothing', async () => {
    setMarkReadPolicy('count');
    const huge = {
      ...volume('a', 'Vol 1', 1),
      page_count: 250_000,
      character_count: 250_000,
      page_char_counts: undefined
    } as unknown as VolumeMetadata;
    await markRead(huge);
    expect(get(markReadSheet)).toBeNull();
    await settle();
    expect(get(volumesWithTrash).a).toMatchObject({ progress: 250_000, completed: true });
    expect(kinds('a')).not.toContain('credit');
    expect(lastSnackbar().message).toBe('Marked Vol 1 as read');
  });

  it('a page bound limits the credit to pages not read here up to it', async () => {
    await readPages('a', 1, 2);
    const done = markRead(volume('a', 'Vol 1'));
    await answerSheet({ count: true, upTo: 6 });
    await done;
    await settle();
    expect(events('a').find((e) => e.kind === 'credit')).toMatchObject({
      pages: [3, 4, 5, 6],
      time_ms: 2 * MIN
    });
  });
});

describe('markUnread (#224)', () => {
  it('retracts only the current pass’s credits; Undo restores the record and the credit', async () => {
    const v = volume('a', 'Vol 1');
    // Pass 0: counted when marked read. Then a restart and a second mark.
    setMarkReadPolicy('count');
    await markRead(v);
    await settle();
    await recordEvent({ kind: 'restart', volume: 'a' });
    await settle();
    updateProgress('a', 0, 0);
    await markRead(v);
    await settle();
    const [first, second] = events('a').filter((e) => e.kind === 'credit');
    await markUnread(v);
    await settle();
    const retracted = events('a')
      .filter((e) => e.kind === 'retract')
      .map((e) => (e as Extract<ReadingEvent, { kind: 'retract' }>).target);
    expect(retracted).toEqual([[second.device, second.seq]]);
    expect(retracted).not.toContainEqual([first.device, first.seq]);
    expect(get(volumesWithTrash).a).toMatchObject({ progress: 0, completed: false });
    expect(lastSnackbar().message).toBe('Marked Vol 1 as unread · removed 5 min counted');
    lastSnackbar().action!.onClick();
    await settle();
    await settle();
    expect(get(volumesWithTrash).a).toMatchObject({ progress: 10, completed: true });
    expect(figuresFor(get(readingStats), 'a').credit.chars).toBe(2000);
  });
});

describe('markReadBulk (#224)', () => {
  const series = [volume('v1', 'Vol 1'), volume('v2', 'Vol 2'), volume('v3', 'Vol 3')];

  it('up to here: lists every unfinished volume, ticks those up to this one, always asks', async () => {
    setMarkReadPolicy('count');
    updateProgress('v1', 10, 1000, true);
    const done = markReadBulk([...series].reverse(), 'v2');
    const request = await answerSheet({ count: false });
    await done;
    expect(request.volumes.map((v) => v.uuid)).toEqual(['v2', 'v3']);
    expect(request.checked).toEqual(['v2']);
    // The setting only picks the focus.
    expect(request.focus).toBe('count');
    expect(get(volumesWithTrash).v2).toMatchObject({ completed: true });
    expect(get(volumesWithTrash).v3).toBeUndefined();
  });

  it('one typed total split by characters, one credit per volume, one Undo for the batch', async () => {
    await readPages('v1', 1, 5);
    const done = markReadBulk(series);
    await answerSheet({ count: true, checked: ['v1', 'v2'], typedMinutes: 30 });
    await done;
    await settle();
    const c1 = events('v1').find((e) => e.kind === 'credit') as { time_ms: number };
    const c2 = events('v2').find((e) => e.kind === 'credit') as { time_ms: number };
    // 500 and 1,000 characters: 10 and 20 minutes.
    expect([c1.time_ms, c2.time_ms]).toEqual([10 * MIN, 20 * MIN]);
    expect(lastSnackbar().message).toBe(
      'Marked 2 volumes as read · counted 1,500 characters, 30 min'
    );
    lastSnackbar().action!.onClick();
    await settle();
    await settle();
    expect(get(volumesWithTrash).v2).toMatchObject({ completed: false, progress: 0 });
    expect(figuresFor(get(readingStats), 'v2').credit.chars).toBe(0);
  });

  it('skips a volume without a page count and says so', async () => {
    const done = markReadBulk([series[0], { ...volume('v9', 'Vol 9'), page_count: 0 }]);
    await answerSheet({ count: false, checked: ['v1', 'v9'] });
    await done;
    expect(lastSnackbar().message).toBe('Marked 1 volume as read · 1 skipped (page count unknown)');
  });
});
