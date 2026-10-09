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
  _preparedForTests,
  _resetReadingStatsForTests,
  figuresFor,
  fillLegacyBaselines,
  flushReadingStats,
  initReadingStats,
  readingStats,
  recentReadingSpeed,
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
  it('adds the record baseline to the event totals', async () => {
    await record([view('v1', 0, 1, 300, 2 * MIN)]);
    const state = get(readingStats);
    const figures = figuresFor(state, 'v1', { legacyStats: { time_ms: 10 * MIN, chars: 1000 } });
    expect(figures.timeMs).toBe(12 * MIN);
    expect(figures.minutes).toBe(12);
    expect(figures.chars).toBe(1300);
  });

  it('is the baseline alone for a volume with no events', () => {
    const figures = figuresFor(get(readingStats), 'old', {
      legacyStats: { time_ms: 5 * MIN, chars: 7 }
    });
    expect(figures).toMatchObject({ minutes: 5, chars: 7, skippedChars: 0, lastReadAt: null });
  });
});

describe('recomputation', () => {
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

describe('fillLegacyBaselines', () => {
  it('keeps an old completed volume with no events at its old totals', async () => {
    setRecords({
      old: { completed: true, progress: 200, chars: 50_000, timeReadInMinutes: 120 }
    });
    expect(await fillLegacyBaselines()).toBe(1);
    const record = get(volumesWithTrash).old;
    expect(record.legacyStats).toEqual({ time_ms: 120 * MIN, chars: 50_000 });
    expect(figuresFor(get(readingStats), 'old', record)).toMatchObject({
      minutes: 120,
      chars: 50_000
    });
  });

  it('records only what events do not explain, and never runs twice for a record', async () => {
    // One view: no pace yet, so the cap is the 5-minute default; 4 minutes fit.
    await record([view('v1', 0, 1, 300, 4 * MIN)]);
    setRecords({ v1: { progress: 1, chars: 300, timeReadInMinutes: 6 } });
    await fillLegacyBaselines();
    expect(get(volumesWithTrash).v1.legacyStats).toEqual({ time_ms: 2 * MIN, chars: 0 });
    // A second pass changes nothing, even after more reading.
    await record([view('v1', 20 * MIN, 2, 300, MIN)]);
    expect(await fillLegacyBaselines()).toBe(0);
    expect(get(volumesWithTrash).v1.legacyStats).toEqual({ time_ms: 2 * MIN, chars: 0 });
  });

  it('counts skipped characters as explained, so a skim is not re-credited as read', async () => {
    await record([view('v1', 0, 1, 1000, 5_000)]);
    setRecords({ v1: { progress: 1, chars: 1000 } });
    await fillLegacyBaselines();
    expect(get(volumesWithTrash).v1.legacyStats).toEqual({ time_ms: 0, chars: 0 });
  });

  it('after its first pass, gives a baseline only to records still carrying old minutes', async () => {
    setRecords({});
    await fillLegacyBaselines();
    setRecords({
      fresh: { progress: 3, chars: 900 },
      oldDevice: { progress: 3, chars: 900, timeReadInMinutes: 4 }
    });
    expect(await fillLegacyBaselines()).toBe(1);
    expect(get(volumesWithTrash).fresh.legacyStats).toBeUndefined();
    expect(get(volumesWithTrash).oldDevice.legacyStats).toEqual({ time_ms: 4 * MIN, chars: 900 });
  });

  it('includes archived passes in the old characters', async () => {
    setRecords({
      v: {
        chars: 100,
        archivedReads: [{ at: 1, pages: 10, chars: 2000, completed: true }]
      }
    });
    await fillLegacyBaselines();
    expect(get(volumesWithTrash).v.legacyStats).toEqual({ time_ms: 0, chars: 2100 });
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
        legacyStats: { time_ms: 120 * MIN, chars: 24_000 }
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
