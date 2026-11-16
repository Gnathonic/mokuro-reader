import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/env', () => ({ browser: true }));
vi.mock('#lib/catalog/db.js', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined), bulkGet: vi.fn(async () => []) },
    volume_ocr: { get: vi.fn(async () => undefined) }
  }
}));

import { get } from 'svelte/store';
import { VolumeData, clearVolumes, volumesWithTrash } from '#lib/settings/volume-data.js';
import { HistoryDexie } from './history-db';
import { notifyEventsRecorded } from './record';
import { _resetHistoryTurns, loadHistoryTurns } from './turns-store';
import {
  _countedForTests,
  _preparedForTests,
  _resetReadingStatsForTests,
  figuresFor,
  freezeLegacyBaselines,
  flushReadingStats,
  initReadingStats,
  creditsFor,
  measuredFigures,
  pagesNotReadHere,
  passFiguresFor,
  readingStats,
  readingStatsReady,
  recentReadingSpeed,
  seriesReadingSpeed,
  seriesSpeed,
  unexplainedBaseline
} from './stats-store';
import type { ReadingEvent } from './types';

const MIN = 60_000;
let db: HistoryDexie;
let seq = 0;

const view = (
  volume: string,
  t: number,
  page: number,
  chars: number,
  dwell: number
): ReadingEvent => ({
  device: 'dev-a',
  seq: ++seq,
  t,
  kind: 'page',
  volume,
  first_page: page,
  last_page: page,
  page_chars: [chars],
  chars_before: 0,
  dwell_ms: dwell,
  layout: 'single',
  orientation: 'portrait',
  viewport: null
});

async function record(events: ReadingEvent[]) {
  await db.reading_events.bulkAdd(events);
  notifyEventsRecorded(events);
  await Promise.resolve();
  flushReadingStats();
}

function setRecords(records: Record<string, Partial<VolumeData>>) {
  volumesWithTrash.set(
    Object.fromEntries(Object.entries(records).map(([id, r]) => [id, new VolumeData(r)]))
  );
}

beforeEach(async () => {
  clearVolumes();
  window.localStorage.clear();
  _resetHistoryTurns();
  _resetReadingStatsForTests();
  db = new HistoryDexie(`stats-${Math.random()}`);
  await loadHistoryTurns(db);
  initReadingStats();
  flushReadingStats();
});

describe('figuresFor', () => {
  it('a frozen snapshot counts what events before its freeze do not explain, plus everything after', async () => {
    const freeze = 10 * MIN;
    await record([view('v1', 0, 1, 300, 2 * MIN), view('v1', 20 * MIN, 2, 300, MIN)]);
    const legacyStats = { time_ms: 10 * MIN, chars: 1000, before: freeze };
    const figures = figuresFor(get(readingStats), 'v1', { legacyStats });
    // max(10 min old, 2 min before the freeze) + 1 min after it.
    expect(figures.timeMs).toBe(11 * MIN);
    expect(figures.minutes).toBe(11);
    // max(1000 old, 300 before) + 300 after.
    expect(figures.chars).toBe(1300);
  });

  it('names the part of the snapshot its history does not explain (what figuresFor adds)', async () => {
    await record([view('v1', 0, 1, 300, 2 * MIN), view('v1', 20 * MIN, 2, 300, MIN)]);
    const stats = get(readingStats);
    const legacyStats = { time_ms: 10 * MIN, chars: 1000, before: 10 * MIN };
    expect(unexplainedBaseline(stats, 'v1', { legacyStats })).toEqual({
      timeMs: 8 * MIN,
      chars: 700
    });
    // History before the freeze already explains more than the snapshot held.
    const small = { time_ms: MIN, chars: 100, before: 10 * MIN };
    expect(unexplainedBaseline(stats, 'v1', { legacyStats: small })).toEqual({
      timeMs: 0,
      chars: 0
    });
    expect(unexplainedBaseline(stats, 'v1')).toEqual({ timeMs: 0, chars: 0 });
    expect(unexplainedBaseline(stats, 'none', { legacyStats })).toEqual({
      timeMs: 10 * MIN,
      chars: 1000
    });
  });

  it('is the snapshot alone for a volume with no events', () => {
    const figures = figuresFor(get(readingStats), 'old', {
      legacyStats: { time_ms: 5 * MIN, chars: 7, before: 1 }
    });
    expect(figures).toMatchObject({ minutes: 5, chars: 7, skippedChars: 0, lastReadAt: null });
  });

  it('never shows less than the old figures before the snapshot is frozen', async () => {
    await record([view('v1', 0, 1, 300, 3 * MIN)]);
    const stats = get(readingStats);
    expect(figuresFor(stats, 'v1', { timeReadInMinutes: 120, chars: 5000 })).toMatchObject({
      minutes: 120,
      chars: 5000
    });
    expect(figuresFor(stats, 'v1', { timeReadInMinutes: 1, chars: 100 })).toMatchObject({
      minutes: 3,
      chars: 300
    });
  });

  it('lets an editor edit go below the snapshot (clamped only after it is added)', async () => {
    const legacyStats = { time_ms: 100 * 60 * MIN, chars: 50_000, before: 1 };
    const adjust: ReadingEvent = {
      device: 'dev-a',
      seq: ++seq,
      t: 2,
      kind: 'adjust',
      volume: 'v1',
      time_delta_ms: -100 * 60 * MIN,
      chars_delta: -50_000
    };
    await record([adjust]);
    expect(figuresFor(get(readingStats), 'v1', { legacyStats })).toMatchObject({
      timeMs: 0,
      chars: 0
    });
  });
});

describe('credits (#224)', () => {
  const credit = (
    volume: string,
    t: number,
    pages: number[],
    chars: number[],
    ms: number,
    total_chars: number
  ) =>
    ({
      device: 'dev-a',
      seq: ++seq,
      t,
      kind: 'credit',
      volume,
      pages,
      page_chars: chars,
      time_ms: ms,
      total_chars
    }) as ReadingEvent;
  const restart = (volume: string, t: number): ReadingEvent => ({
    device: 'dev-a',
    seq: ++seq,
    t,
    kind: 'restart',
    volume
  });
  /** Six pages of 1,000 characters. */
  const SIX = [1000, 1000, 1000, 1000, 1000, 1000];

  it('figures carry what credits counted, inside the totals; measured figures leave it out', async () => {
    await record([
      view('v1', 0, 1, 300, 3 * MIN),
      credit('v1', MIN, [2, 3], [200, 100], 10 * MIN, 600)
    ]);
    const figures = figuresFor(get(readingStats), 'v1');
    expect(figures).toMatchObject({
      timeMs: 13 * MIN,
      chars: 600,
      credit: { timeMs: 10 * MIN, chars: 300 }
    });
    expect(measuredFigures(figures)).toEqual({ timeMs: 3 * MIN, chars: 300 });
    expect(figuresFor(get(readingStats), 'none').credit).toEqual({ timeMs: 0, chars: 0 });
  });

  it('pages not read here: every page no view read and no credit claimed in this pass', async () => {
    await record([
      view('v1', 0, 2, 300, 3 * MIN),
      view('v1', 5 * MIN, 3, 300, 3 * MIN),
      credit('v1', 10 * MIN, [5], [100], MIN, 1000)
    ]);
    const pageChars = [100, 300, 300, 100, 100, 100];
    expect(pagesNotReadHere(get(readingStats), 'v1', pageChars)).toEqual([1, 4, 6]);
    expect(pagesNotReadHere(get(readingStats), 'never-read', [5, 5, 5])).toEqual([1, 2, 3]);
  });

  it('pre-history reading covers the first pages, whatever the position says now', async () => {
    const legacyStats = { time_ms: 30 * MIN, chars: 4000, before: 1 };
    // No events: the old lump is four pages' worth, read from the start.
    expect(pagesNotReadHere(get(readingStats), 'old', SIX, { legacyStats })).toEqual([5, 6]);
    // Un-read since (the page back at 0) or paged back: still four pages read.
    expect(
      pagesNotReadHere(get(readingStats), 'old', SIX, { legacyStats, chars: 0, completed: false })
    ).toEqual([5, 6]);
    // Nothing unexplained: nothing covered.
    expect(pagesNotReadHere(get(readingStats), 'old', SIX, {})).toEqual([1, 2, 3, 4, 5, 6]);
    // A page only partly covered goes too: a credit may undercount, never overcount.
    const partial = { ...legacyStats, chars: 3500 };
    expect(pagesNotReadHere(get(readingStats), 'old', SIX, { legacyStats: partial })).toEqual([
      5, 6
    ]);
    // After a restart since the freeze the old lump belongs to an earlier pass.
    await record([restart('old', 5)]);
    expect(pagesNotReadHere(get(readingStats), 'old', SIX, { legacyStats })).toEqual([
      1, 2, 3, 4, 5, 6
    ]);
  });

  it("an archived pre-history read is its own pass: only the position's part is this pass's", async () => {
    // Read once (archived, a restart at `at`), then four pages again, all before history.
    const at = -10;
    const record0 = {
      legacyStats: { time_ms: 60 * MIN, chars: 6000 + 4000, before: 1 },
      archivedReads: [{ at, chars: 6000 }]
    };
    await record([restart('old', at)]);
    expect(pagesNotReadHere(get(readingStats), 'old', SIX, record0)).toEqual([5, 6]);
    expect(passFiguresFor(get(readingStats), 'old', record0)).toMatchObject({
      pass: 1,
      chars: 4000
    });
  });

  it('the baseline cuts the credits in its pass to what the volume has left, from the first pages', async () => {
    const legacyStats = { time_ms: 30 * MIN, chars: 4000, before: 1 };
    // Counted on a device that did not know the old reading: every page.
    await record([
      credit('old', 10, [1, 2, 3], [1000, 1000, 1000], 30 * MIN, 6000),
      credit('old', 20, [4, 5, 6], [1000, 1000, 1000], 30 * MIN, 6000)
    ]);
    const stats = get(readingStats);
    const figures = figuresFor(stats, 'old', { legacyStats });
    // 4,000 before history + what the volume has left: 2,000.
    expect(figures.chars).toBe(6000);
    expect(figures.credit).toEqual({ timeMs: 20 * MIN, chars: 2000 });
    expect(measuredFigures(figures)).toEqual({ timeMs: 30 * MIN, chars: 4000 });
    // The old reading covers the first pages: the credits keep pages 5 and 6.
    expect(creditsFor(stats, 'old', { legacyStats }).map((c) => [c.pages, c.chars, c.ms])).toEqual([
      [[], 0, 0],
      [[5, 6], 2000, 20 * MIN]
    ]);
    expect(passFiguresFor(stats, 'old', { legacyStats })).toEqual({
      pass: 0,
      chars: 6000,
      credit: { timeMs: 20 * MIN, chars: 2000 }
    });
  });

  it('a credit in a later pass, or an unfrozen snapshot, is not cut', async () => {
    await record([restart('v1', 5), credit('v1', 10, [1, 2, 3, 4, 5, 6], SIX, 60 * MIN, 6000)]);
    const frozen = { legacyStats: { time_ms: 30 * MIN, chars: 6000, before: 1 } };
    expect(figuresFor(get(readingStats), 'v1', frozen)).toMatchObject({
      chars: 12_000,
      credit: { chars: 6000 }
    });
    expect(passFiguresFor(get(readingStats), 'v1', frozen).chars).toBe(6000);
    // Unfrozen (a record on the old minute counter): credits explain it.
    await record([credit('v2', 10, [1, 2, 3, 4, 5, 6], SIX, 60 * MIN, 6000)]);
    const unfrozen = { timeReadInMinutes: 30, chars: 4000 };
    expect(figuresFor(get(readingStats), 'v2', unfrozen)).toMatchObject({
      chars: 6000,
      credit: { chars: 6000 }
    });
  });

  /**
   * The review's counterexample: native views from before the freeze (a
   * record merge kept a later device's snapshot), pages 1–4 read and 5–10
   * skimmed, all of it in the old counter's 1,000.
   */
  const readThenSkimmed = (volume: string) => [
    ...[1, 2, 3, 4].map((page) => view(volume, page * MIN, page, 100, MIN)),
    ...[5, 6, 7, 8, 9, 10].map((page) => view(volume, (10 + page) * MIN, page, 100, 500))
  ];
  const frozenAfter = { legacyStats: { time_ms: 10 * MIN, chars: 1000, before: 30 * MIN } };
  const TEN = Array.from({ length: 10 }, () => 100);

  it('a credit on pages skimmed before the freeze counts as a credit, never as baseline', async () => {
    await record(readThenSkimmed('sk'));
    const before = figuresFor(get(readingStats), 'sk', frozenAfter);
    expect(before).toMatchObject({ chars: 400, baseline: { chars: 0 } });
    // The sheet offers the skimmed pages: they were never read.
    expect(pagesNotReadHere(get(readingStats), 'sk', TEN, frozenAfter)).toEqual([
      5, 6, 7, 8, 9, 10
    ]);
    await record([credit('sk', 40 * MIN, [5, 6, 7, 8, 9, 10], TEN.slice(4), 6 * MIN, 1000)]);
    const after = figuresFor(get(readingStats), 'sk', frozenAfter);
    expect(after).toMatchObject({
      chars: 1000,
      baseline: { chars: 0 },
      credit: { chars: 600, timeMs: 6 * MIN }
    });
    // Speed: the same reading as before the mark.
    expect(measuredFigures(after)).toEqual(measuredFigures(before));
    expect(creditsFor(get(readingStats), 'sk', frozenAfter)[0].chars).toBe(600);
  });

  it('… and with an older editor’s adjust filling the pass, the credit adds nothing', async () => {
    const adjust: ReadingEvent = {
      device: 'dev-c',
      seq: ++seq,
      t: 35 * MIN,
      kind: 'adjust',
      volume: 'sa',
      time_delta_ms: 0,
      chars_delta: 600
    };
    await record([...readThenSkimmed('sa'), adjust]);
    const before = figuresFor(get(readingStats), 'sa', frozenAfter);
    expect(before.chars).toBe(1000);
    await record([credit('sa', 40 * MIN, [5, 6, 7, 8, 9, 10], TEN.slice(4), 6 * MIN, 1000)]);
    const stats = get(readingStats);
    expect(figuresFor(stats, 'sa', frozenAfter)).toMatchObject({
      chars: 1000,
      credit: { chars: 0 }
    });
    expect(passFiguresFor(stats, 'sa', frozenAfter).chars).toBe(1000);
    expect(measuredFigures(figuresFor(stats, 'sa', frozenAfter))).toEqual(measuredFigures(before));
  });

  it('Reset All takes the pass to zero, the baseline’s share included; reading again counts again', async () => {
    const legacyStats = { time_ms: 30 * MIN, chars: 4000, before: 1 };
    await record([
      view('rs', 10, 5, 1000, 5 * MIN),
      credit('rs', 20, [6], [1000], 5 * MIN, 6000),
      { device: 'dev-a', seq: ++seq, t: 30, kind: 'reset', volume: 'rs' }
    ]);
    let stats = get(readingStats);
    expect(passFiguresFor(stats, 'rs', { legacyStats })).toMatchObject({ pass: 1, chars: 0 });
    expect(figuresFor(stats, 'rs', { legacyStats })).toMatchObject({
      chars: 0,
      baseline: { chars: 0 },
      credit: { chars: 0 }
    });
    expect(pagesNotReadHere(stats, 'rs', SIX, { legacyStats })).toEqual([1, 2, 3, 4, 5, 6]);
    // Read through again in the app.
    await record([1, 2, 3, 4, 5, 6].map((page) => view('rs', 100 + page * MIN, page, 1000, MIN)));
    stats = get(readingStats);
    expect(passFiguresFor(stats, 'rs', { legacyStats }).chars).toBe(6000);
    expect(figuresFor(stats, 'rs', { legacyStats }).chars).toBe(6000);
    expect(pagesNotReadHere(stats, 'rs', SIX, { legacyStats })).toEqual([]);
  });
});

describe('recomputation', () => {
  it('a page turn recounts only its volume while the pace holds within 2%', async () => {
    await record(Array.from({ length: 40 }, (_, i) => view('v1', i * MIN, i + 1, 100, 20_000)));
    await record([view('v2', 50 * MIN, 1, 100, 20_000)]);
    _countedForTests().length = 0;
    await record([view('v2', 51 * MIN, 2, 100, 20_400)]);
    expect(_countedForTests()).toEqual(['v2']);
  });

  it('re-prepares only the volumes whose events changed', async () => {
    await record([view('v1', 0, 1, 300, MIN), view('v2', 0, 1, 300, MIN)]);
    _preparedForTests().length = 0;
    await record([view('v2', 2 * MIN, 2, 300, MIN)]);
    expect(_preparedForTests()).toEqual(['v2']);
  });

  it('keeps adjust events: a volume-editor time edit moves the figure', async () => {
    const adjust: ReadingEvent = {
      device: 'dev-a',
      seq: ++seq,
      t: 5,
      kind: 'adjust',
      volume: 'v1',
      time_delta_ms: 3 * MIN,
      chars_delta: 0
    };
    await record([adjust]);
    expect(figuresFor(get(readingStats), 'v1').minutes).toBe(3);
  });
});

describe('readingStatsReady', () => {
  it('settles only once history has been counted, flushing a pending pass', async () => {
    // A reader of a volume's figures (the volume editor) must not see the
    // empty byVolume map the 500 ms debounce leaves before the first flush.
    _resetReadingStatsForTests();
    await db.reading_events.bulkAdd([view('v1', 0, 1, 300, 4 * MIN)]);
    _resetHistoryTurns();
    const loading = loadHistoryTurns(db);
    initReadingStats();
    expect(get(readingStats).ready).toBe(false);
    const ready = readingStatsReady();
    await loading;
    await ready;
    expect(get(readingStats).ready).toBe(true);
    expect(figuresFor(get(readingStats), 'v1').minutes).toBe(4);
  });

  it('resolves at once when the stats are already counted', async () => {
    expect(get(readingStats).ready).toBe(true);
    await expect(readingStatsReady()).resolves.toBeUndefined();
  });
});

describe('freezeLegacyBaselines', () => {
  it('snapshots an old completed volume with no events at its old totals', () => {
    setRecords({
      old: { completed: true, progress: 200, chars: 50_000, timeReadInMinutes: 120 }
    });
    const before = Date.now();
    expect(freezeLegacyBaselines()).toBe(1);
    const record = get(volumesWithTrash).old;
    expect(record.legacyStats).toMatchObject({ time_ms: 120 * MIN, chars: 50_000 });
    expect(record.legacyStats!.before).toBeGreaterThanOrEqual(before);
    expect(figuresFor(get(readingStats), 'old', record)).toMatchObject({
      minutes: 120,
      chars: 50_000
    });
  });

  it('freezes each record once; reading after the freeze adds on top', async () => {
    await record([view('v1', 0, 1, 300, 4 * MIN)]);
    setRecords({ v1: { progress: 1, chars: 300, timeReadInMinutes: 6 } });
    freezeLegacyBaselines();
    expect(figuresFor(get(readingStats), 'v1', get(volumesWithTrash).v1).minutes).toBe(6);
    await record([view('v1', Date.now() + MIN, 2, 300, MIN)]);
    expect(freezeLegacyBaselines()).toBe(0);
    expect(figuresFor(get(readingStats), 'v1', get(volumesWithTrash).v1).minutes).toBe(7);
  });

  it("another device's events arriving after the freeze explain the old figure instead of adding to it", async () => {
    setRecords({ v1: { progress: 9, chars: 3000, timeReadInMinutes: 60 } });
    freezeLegacyBaselines();
    // The phone's reading from before the freeze reaches this device later.
    await record([view('v1', 0, 1, 300, 4 * MIN)]);
    const figures = figuresFor(get(readingStats), 'v1', get(volumesWithTrash).v1);
    expect(figures.minutes).toBe(60);
    expect(figures.chars).toBe(3000);
  });

  it('counts skimmed characters as explained, so a skim is not re-credited as read', async () => {
    await record([view('v1', 0, 1, 1000, 5_000)]);
    setRecords({ v1: { progress: 1, chars: 1000 } });
    freezeLegacyBaselines();
    expect(figuresFor(get(readingStats), 'v1', get(volumesWithTrash).v1)).toMatchObject({
      chars: 0,
      skippedChars: 1000
    });
  });

  it('after its first pass, snapshots only records still carrying old minutes', () => {
    setRecords({});
    freezeLegacyBaselines();
    setRecords({
      fresh: { progress: 3, chars: 900 },
      oldDevice: { progress: 3, chars: 900, timeReadInMinutes: 4 }
    });
    expect(freezeLegacyBaselines()).toBe(1);
    expect(get(volumesWithTrash).fresh.legacyStats).toBeUndefined();
    expect(get(volumesWithTrash).oldDevice.legacyStats).toMatchObject({
      time_ms: 4 * MIN,
      chars: 900
    });
  });

  it('leaves the volumes store untouched when no record needs a snapshot', () => {
    // It runs at every start and after every sync: a no-op pass that still
    // "updated" the store re-emitted the whole map and rewrote localStorage.
    setRecords({
      done: { progress: 3, chars: 900, legacyStats: { time_ms: MIN, chars: 900, before: 1 } },
      blank: { progress: 0, chars: 0 }
    });
    const seen = vi.fn();
    const unsubscribe = volumesWithTrash.subscribe(seen);
    seen.mockClear();
    expect(freezeLegacyBaselines()).toBe(0);
    expect(freezeLegacyBaselines()).toBe(0);
    expect(seen).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('includes archived passes in the old characters', () => {
    setRecords({
      v: {
        chars: 100,
        archivedReads: [{ at: 1, pages: 10, chars: 2000, completed: true }]
      }
    });
    freezeLegacyBaselines();
    expect(get(volumesWithTrash).v.legacyStats).toMatchObject({ time_ms: 0, chars: 2100 });
  });
});

describe('speed', () => {
  it('is personalized from 30 minutes of recent reading, by time', async () => {
    await record(Array.from({ length: 40 }, (_, i) => view('v1', i * 2 * MIN, i + 1, 300, MIN)));
    const speed = recentReadingSpeed(get(readingStats), {});
    expect(speed.isPersonalized).toBe(true);
    expect(speed.charsPerMinute).toBe(300);
    expect(speed.confidence).toBe('low');
  });

  it('falls back to completed volumes when recent reading is thin', () => {
    const records = {
      old: new VolumeData({
        completed: true,
        chars: 24_000,
        lastProgressUpdate: '2026-01-01T00:00:00.000Z',
        legacyStats: { time_ms: 120 * MIN, chars: 24_000, before: 1 }
      })
    };
    const speed = recentReadingSpeed(get(readingStats), records);
    expect(speed).toMatchObject({ charsPerMinute: 200, isPersonalized: true });
  });

  it("the fill-in adds only what a completed volume's pre-freeze events do not explain", async () => {
    // 4 min of events at 250 cpm from before the freeze are already in the
    // recent samples; the snapshot (20 min, 4000 chars = 200 cpm) covers
    // them. Adding the whole snapshot on top counted that reading twice.
    await record([view('old', 0, 1, 1000, 4 * MIN)]);
    const records = {
      old: new VolumeData({
        completed: true,
        chars: 4000,
        lastProgressUpdate: '2026-01-01T00:00:00.000Z',
        legacyStats: { time_ms: 20 * MIN, chars: 4000, before: 5 * MIN }
      })
    };
    expect(recentReadingSpeed(get(readingStats), records)).toMatchObject({
      charsPerMinute: 200,
      sessionsUsed: 2
    });
  });

  it('a completed volume whose events explain its whole snapshot adds nothing', async () => {
    await record([view('old', 0, 1, 1000, 4 * MIN)]);
    const records = {
      old: new VolumeData({
        completed: true,
        chars: 1000,
        lastProgressUpdate: '2026-01-01T00:00:00.000Z',
        legacyStats: { time_ms: 4 * MIN, chars: 1000, before: 5 * MIN }
      })
    };
    expect(recentReadingSpeed(get(readingStats), records)).toMatchObject({
      charsPerMinute: 250,
      sessionsUsed: 1
    });
  });

  it('is the default with no data at all', () => {
    expect(recentReadingSpeed(get(readingStats), {})).toMatchObject({
      charsPerMinute: 100,
      isPersonalized: false,
      confidence: 'none'
    });
  });

  it("uses a series' own speed only from an hour of its reading", async () => {
    await record(Array.from({ length: 30 }, (_, i) => view('a', i * 3 * MIN, i + 1, 200, MIN)));
    expect(seriesSpeed(get(readingStats), ['a'])).toBeNull();
    await record(
      Array.from({ length: 40 }, (_, i) => view('a', 200 * MIN + i * 3 * MIN, i + 40, 200, MIN))
    );
    expect(seriesSpeed(get(readingStats), ['a'])?.charsPerMinute).toBe(200);
  });
});

describe('seriesReadingSpeed', () => {
  const fallback = {
    charsPerMinute: 150,
    isPersonalized: true,
    confidence: 'low' as const,
    sessionsUsed: 3
  };

  it("is the series' own speed with an hour of its reading", async () => {
    await record(Array.from({ length: 70 }, (_, i) => view('a', i * 3 * MIN, i + 1, 200, MIN)));
    expect(seriesReadingSpeed(get(readingStats), ['a'], fallback)).toMatchObject({
      charsPerMinute: 200,
      isPersonalized: true,
      confidence: 'low'
    });
  });

  it('falls back to the recent speed without enough series data', () => {
    expect(seriesReadingSpeed(get(readingStats), ['nothing'], fallback)).toBe(fallback);
  });
});
