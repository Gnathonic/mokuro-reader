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
import { _resetReadingStatsForTests, flushReadingStats, initReadingStats } from './stats-store';
import { totalStats } from './total-stats';
import type { ReadingEvent } from './types';

const MIN = 60_000;
let db: HistoryDexie;
let seq = 0;
const view = (volume: string, page: number, chars: number, dwell: number): ReadingEvent => ({
  device: 'dev-a',
  seq: ++seq,
  t: seq * MIN,
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

beforeEach(async () => {
  clearVolumes();
  window.localStorage.clear();
  _resetHistoryTurns();
  _resetReadingStatsForTests();
  db = new HistoryDexie(`totals-${Math.random()}`);
  await loadHistoryTurns(db);
  initReadingStats();
  flushReadingStats();
});

describe('totalStats', () => {
  it('sums event figures and baselines; skimmed characters are counted apart', async () => {
    volumesWithTrash.set({
      a: new VolumeData({ progress: 2, chars: 999, completed: true }),
      b: new VolumeData({
        progress: 10,
        chars: 5000,
        archivedReads: [{ at: 1, pages: 30, chars: 9000, completed: true }],
        legacyStats: { time_ms: 60 * MIN, chars: 14_000, before: 1 }
      })
    });
    const events = [view('a', 1, 300, 2 * MIN), view('a', 2, 1000, 5_000)];
    await db.reading_events.bulkAdd(events);
    notifyEventsRecorded(events);
    await Promise.resolve();
    flushReadingStats();

    expect(get(totalStats)).toEqual({
      completed: 1,
      pagesRead: 2 + 10 + 30,
      charsRead: 300 + 14_000,
      charsSkipped: 1000,
      minutesRead: Math.floor((2 * MIN + 5_000) / MIN) + 60
    });
  });
});
