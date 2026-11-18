import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * "Mark as read" may count pages this app never saw read (#224), but never
 * more than the volume holds: a pass of a volume counts at most its
 * characters. These cases are built from the states real libraries are in —
 * reading from before history, converted page turns, older editor edits,
 * placeholders, OCR upgrades — and go through the real flow (sheet answer,
 * credit event, stats engine, figures).
 */

vi.mock('$app/env', () => ({ browser: true }));
vi.mock('#lib/catalog/db.js', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined), bulkGet: vi.fn(async () => []) },
    volume_ocr: { get: vi.fn(async () => undefined) }
  }
}));
const stores = vi.hoisted(() => {
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
vi.mock('#lib/catalog/index.js', () => ({ volumes: stores.catalog }));
vi.mock('#lib/settings/reading-speed.js', () => ({ personalizedReadingSpeed: stores.speed }));
vi.mock('#lib/util/snackbar.js', () => ({ showSnackbar: vi.fn() }));

import { get } from 'svelte/store';
import type { VolumeMetadata } from '#lib/types/index.js';
import { setMarkReadPolicy, setTrackingStates } from '#lib/settings/tracking-data.js';
import {
  VolumeData,
  clearVolumes,
  updateProgress,
  volumesWithTrash
} from '#lib/settings/volume-data.js';
import { historyDb } from './history-db';
import { notifyEventsRecorded, recordEvent } from './record';
import {
  _resetReadingStatsForTests,
  figuresFor,
  flushReadingStats,
  initReadingStats,
  measuredFigures,
  passFiguresFor,
  readingStats
} from './stats-store';
import { _resetHistoryTurns, getVolumeEvents, loadHistoryTurns } from './turns-store';
import { markRead, markUnread, prepareSheetVolume } from './mark-read-flow';
import { updateVolumeStats } from '#lib/util/volume-editor.js';
import type { ReadingEvent } from './types';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const PAGES = 10;
const TOTAL = 1000;

/** 10 pages of 100 characters, as an installed row has them. */
function volume(uuid: string, over: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 'series',
    series_title: 'Series',
    volume_title: 'Vol 1',
    mokuro_version: '0.2.1',
    page_count: PAGES,
    character_count: TOTAL,
    page_char_counts: Array.from({ length: PAGES }, (_, i) => (i + 1) * 100),
    ...over
  } as VolumeMetadata;
}

/**
 * Fire-and-forget history writes stored, heard and counted: until the stored
 * events stop changing for a few rounds (a loaded machine takes longer).
 */
async function settle() {
  let last = -1;
  for (let quiet = 0, round = 0; quiet < 3 && round < 200; round++) {
    await new Promise((r) => setTimeout(r, 15));
    const count = await historyDb().reading_events.count();
    quiet = count === last ? quiet + 1 : 0;
    last = count;
  }
  await Promise.resolve();
  flushReadingStats();
}

/** A view of one page on this device, `ago` ms before now. */
function view(uuid: string, page: number, chars: number, before: number, ago: number) {
  return recordEvent(
    {
      kind: 'page',
      volume: uuid,
      first_page: page,
      last_page: page,
      page_chars: [chars],
      chars_before: before,
      dwell_ms: 30_000,
      layout: 'single',
      orientation: 'portrait',
      viewport: null
    },
    Date.now() - ago
  );
}

/** Events another device (or the legacy conversion) recorded, as a sync brings them. */
async function arrive(events: ReadingEvent[]) {
  await historyDb().reading_events.bulkAdd(events);
  notifyEventsRecorded(events);
  await settle();
}

function setRecord(uuid: string, fields: ConstructorParameters<typeof VolumeData>[0]) {
  volumesWithTrash.update((all) => ({ ...all, [uuid]: new VolumeData(fields) }));
}

const figures = (uuid: string) => figuresFor(get(readingStats), uuid, get(volumesWithTrash)[uuid]);
const pass = (uuid: string) => passFiguresFor(get(readingStats), uuid, get(volumesWithTrash)[uuid]);

/** Mark read with "Count" (no sheet), then wait for the stats. */
async function markCounted(v: VolumeMetadata) {
  setMarkReadPolicy('count');
  await markRead(v);
  await settle();
}

beforeEach(async () => {
  clearVolumes();
  window.localStorage.clear();
  // A device that has run before: its pre-history snapshots are frozen.
  window.localStorage.setItem('reading-stats:baselines', 'done');
  setTrackingStates({});
  _resetHistoryTurns();
  _resetReadingStatsForTests();
  const db = historyDb();
  await db.reading_events.clear();
  await loadHistoryTurns(db);
  initReadingStats();
  await settle();
});

describe('a credit never takes a volume past its characters (#224)', () => {
  it('reading from before history, un-read and marked read again', async () => {
    // Finished before reading history existed: the old counter's lump.
    setRecord('a', {
      progress: PAGES,
      chars: TOTAL,
      completed: true,
      legacyStats: { time_ms: 40 * MIN, chars: TOTAL, before: Date.now() - DAY }
    });
    await settle();
    expect(figures('a').chars).toBe(TOTAL);
    await markUnread(volume('a'));
    await settle();
    await markCounted(volume('a'));
    // The old reading already counts the whole volume: nothing is left to count.
    expect(getVolumeEvents('a').some((e) => e.kind === 'credit')).toBe(false);
    expect(figures('a').chars).toBe(TOTAL);
    expect(pass('a').chars).toBe(TOTAL);
  });

  it('reading from before history, then the page moved back (editor, or paging back)', async () => {
    setRecord('a', {
      progress: 6,
      chars: 600,
      legacyStats: { time_ms: 20 * MIN, chars: 600, before: Date.now() - DAY }
    });
    // The editor's page field, or a look back: the position only.
    setRecord('a', { ...get(volumesWithTrash).a, progress: 2, chars: 200 });
    await settle();
    await markCounted(volume('a'));
    expect(figures('a').chars).toBe(TOTAL);
  });

  it('a pass begun before history (an archived read) and finished elsewhere', async () => {
    const restartAt = Date.now() - 3 * DAY;
    setRecord('a', {
      progress: 5,
      chars: 500,
      archivedReads: [{ at: restartAt, pages: PAGES, chars: TOTAL, completed: true }],
      legacyStats: { time_ms: 60 * MIN, chars: TOTAL + 500, before: Date.now() - DAY }
    });
    // The cut-over records each archived read as a restart.
    await arrive([
      { device: 'legacy:a', seq: restartAt, t: restartAt, kind: 'restart', volume: 'a' }
    ]);
    await markCounted(volume('a'));
    // Two reads, the second finished on paper: two volumes' worth, no more.
    expect(figures('a').chars).toBe(2 * TOTAL);
    expect(pass('a').chars).toBe(TOTAL);
  });

  it('converted page turns of a two-page reader (one turn per spread)', async () => {
    // Turns at pages 1, 3, 5, 7: each carries its spread's characters.
    const t0 = Date.now() - 2 * DAY;
    const turns = [1, 3, 5, 7].map((page, i) => ({
      device: 'legacy:a',
      seq: t0 + i * 2 * MIN,
      t: t0 + i * 2 * MIN,
      kind: 'page' as const,
      volume: 'a',
      first_page: page,
      last_page: page,
      page_chars: [0],
      chars_before: page * 100,
      dwell_ms: i < 3 ? 2 * MIN : null,
      layout: 'unknown' as const,
      orientation: 'unknown' as const,
      viewport: null
    }));
    await arrive(turns);
    const read = figures('a').chars;
    expect(read).toBe(600);
    await markCounted(volume('a'));
    expect(figures('a').chars).toBe(TOTAL);
  });

  it('characters an older volume editor recorded for a page edit', async () => {
    // Before #224 a page edit recorded its linear estimate as an adjust.
    await recordEvent({ kind: 'adjust', volume: 'a', time_delta_ms: 0, chars_delta: 600 });
    updateProgress('a', 6, 600);
    await settle();
    await markUnread(volume('a'));
    await settle();
    await markCounted(volume('a'));
    expect(figures('a').chars).toBe(TOTAL);
  });

  it('a placeholder spreads its characters evenly; another device read its dense pages', async () => {
    // Pages 1–5 hold 180 characters each, 6–10 hold 20: 1,000 in all.
    for (let page = 1; page <= 5; page++) await view('p', page, 180, (page - 1) * 180, page * MIN);
    await settle();
    // This device has the series index's totals only (no per-page counts).
    const placeholder = volume('p', { page_char_counts: undefined });
    await markCounted(placeholder);
    expect(figures('p').chars).toBe(TOTAL);
  });

  it('pages read before an OCR upgrade recounted them', async () => {
    // The old OCR found 150 characters a page; the new one 100.
    for (let page = 1; page <= 5; page++) await view('o', page, 150, (page - 1) * 150, page * MIN);
    await settle();
    await markCounted(volume('o'));
    // 750 counted at the old size leave 250: pages 9–10 (a page only partly
    // left is not counted — a credit may count less than was read, never more).
    expect(figures('o').chars).toBe(950);
  });

  it('a double tap marks twice: the second counts nothing', async () => {
    setMarkReadPolicy('count');
    await Promise.all([markRead(volume('a')), markRead(volume('a'))]);
    await settle();
    expect(getVolumeEvents('a').filter((e) => e.kind === 'credit').length).toBeGreaterThan(0);
    expect(figures('a').chars).toBe(TOTAL);
  });

  it('a re-read: each pass holds one volume, the lifetime total both', async () => {
    for (let page = 1; page <= PAGES; page++) await view('a', page, 100, (page - 1) * 100, MIN);
    await settle();
    await recordEvent({ kind: 'restart', volume: 'a' });
    updateProgress('a', 0, 0);
    await settle();
    await markCounted(volume('a'));
    expect(figures('a').chars).toBe(2 * TOTAL);
    expect(pass('a').chars).toBe(TOTAL);
  });

  it('what the sheet offers is what is left', async () => {
    setRecord('a', {
      progress: PAGES,
      chars: TOTAL,
      completed: true,
      legacyStats: { time_ms: 40 * MIN, chars: 700, before: Date.now() - DAY }
    });
    await markUnread(volume('a'));
    await settle();
    const sheet = await prepareSheetVolume(volume('a'));
    // 700 of the volume were counted before history: 300 are left, its last pages.
    expect(sheet.notRead).toEqual([8, 9, 10]);
  });

  it('pages skimmed before the freeze: counted as marked read, never as reading from before history', async () => {
    // Another device read pages 1–2 and skimmed 3–10 before this record's
    // snapshot was frozen (a record merge kept the later device's snapshot).
    const t0 = Date.now() - 3 * DAY;
    const skims = Array.from({ length: PAGES }, (_, i) => ({
      device: 'dev-other',
      seq: i + 1,
      t: t0 + i * MIN,
      kind: 'page' as const,
      volume: 's',
      first_page: i + 1,
      last_page: i + 1,
      page_chars: [100],
      chars_before: i * 100,
      dwell_ms: i < 2 ? MIN : 500,
      layout: 'single' as const,
      orientation: 'portrait' as const,
      viewport: null
    }));
    await arrive(skims);
    setRecord('s', {
      progress: PAGES,
      chars: TOTAL,
      completed: true,
      legacyStats: { time_ms: 12 * MIN, chars: TOTAL, before: Date.now() - DAY }
    });
    await settle();
    const before = figures('s');
    expect(before).toMatchObject({ chars: 200, baseline: { chars: 0 } });
    await markUnread(volume('s'));
    await settle();
    await markCounted(volume('s'));
    const after = figures('s');
    expect(after).toMatchObject({ chars: TOTAL, baseline: { chars: 0 }, credit: { chars: 800 } });
    expect(pass('s').chars).toBe(TOTAL);
    // What was counted is the credit's, not measured reading: speed is unmoved.
    expect(measuredFigures(after)).toEqual(measuredFigures(before));
  });

  it('Reset All, then the volume read again in the app: it counts again, never past the volume', async () => {
    for (let page = 1; page <= PAGES; page++) {
      await view('r', page, 100, (page - 1) * 100, 3 * DAY - page * MIN);
    }
    await settle();
    expect(pass('r').chars).toBe(TOTAL);
    // The editor's Reset All.
    updateVolumeStats('r', {
      progress: 0,
      chars: 0,
      timeRead: { from: figures('r').minutes, to: 0 },
      reset: true,
      completed: false
    });
    await settle();
    expect(pass('r').chars).toBe(0);
    expect(figures('r')).toMatchObject({ chars: 0, minutes: 0 });
    // After the reset (a few seconds on).
    for (let page = 1; page <= PAGES; page++) {
      await view('r', page, 100, (page - 1) * 100, -page * 1000);
    }
    await settle();
    expect(pass('r').chars).toBe(TOTAL);
    expect(figures('r').chars).toBe(TOTAL);
    // And a mark finds nothing left to count.
    await markCounted(volume('r'));
    expect(getVolumeEvents('r').some((e) => e.kind === 'credit')).toBe(false);
    expect(pass('r').chars).toBe(TOTAL);
  });

  it('a capped credit leaves speed alone: measured figures are the same with or without it', async () => {
    setRecord('a', {
      progress: 4,
      chars: 400,
      legacyStats: { time_ms: 20 * MIN, chars: 400, before: Date.now() - DAY }
    });
    for (let page = 3; page <= 6; page++) await view('a', page, 100, (page - 1) * 100, page * MIN);
    await settle();
    const before = measuredFigures(figures('a'));
    const recent = get(readingStats).recent;
    await markCounted(volume('a'));
    expect(measuredFigures(figures('a'))).toEqual(before);
    expect(get(readingStats).recent).toEqual(recent);
    expect(figures('a').chars).toBe(TOTAL);
  });
});
