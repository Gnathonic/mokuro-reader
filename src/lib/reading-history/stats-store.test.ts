import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined), bulkGet: vi.fn(async () => []) },
    volume_ocr: { get: vi.fn(async () => undefined) }
  }
}));

import { get } from 'svelte/store';
import { VolumeData, clearVolumes, volumesWithTrash } from '$lib/settings/volume-data';
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
  readingStats,
  recentReadingSpeed,
  seriesReadingSpeed,
  seriesSpeed
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
