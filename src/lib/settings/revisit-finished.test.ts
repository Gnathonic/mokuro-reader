/**
 * #304: going back to check something in a volume already finished must not
 * un-finish it, re-date it, or count it again — only a real re-read does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: vi.fn().mockResolvedValue(undefined),
      bulkGet: vi.fn(async (uuids: string[]) => uuids.map(() => undefined)),
      toArray: vi.fn(async () => [])
    }
  }
}));

import {
  VolumeData,
  clearVolumes,
  markVolumeAsComplete,
  registerCompletionListener,
  updateProgress,
  volumes,
  volumesWithTrash
} from './volume-data';
import { _resetHistoryTurns, _setHistoryTurnsForTest } from '$lib/reading-history/turns-store';
import { isVolumeFinished } from '$lib/util/volume-helpers';
import { isCompletedInPeriod, partialProgressInPeriod } from '$lib/goals/goal-counting';
import type { PageTurn } from './volume-data';

const PAGES = 200;
const FINISHED = '2025-06-01T00:00:00.000Z';
const REVISIT = Date.parse('2026-03-01T10:00:00.000Z');
const YEAR_START = new Date(2026, 0, 1);
const YEAR_END = new Date(2027, 0, 1);

/** Characters through `page` at 10 per page. */
const charsAt = (page: number) => page * 10;

/** A volume read to its last page in 2025. */
function finishedLastYear(): void {
  volumesWithTrash.set({
    v: new VolumeData({
      progress: PAGES,
      chars: charsAt(PAGES),
      completed: true,
      completedAt: FINISHED,
      lastProgressUpdate: FINISHED
    })
  });
}

/** The reading history the reader records for views shown at `pages`, from `start`. */
function viewed(pages: number[], start = REVISIT, stepMs = 20_000): void {
  const turns: PageTurn[] = pages.map((page, i) => [start + i * stepMs, page, charsAt(page)]);
  _setHistoryTurnsForTest(new Map([['v', turns]]));
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

beforeEach(() => {
  clearVolumes();
  vi.useFakeTimers();
  vi.setSystemTime(REVISIT);
});

afterEach(() => {
  vi.useRealTimers();
  _resetHistoryTurns();
});

describe('#304 revisiting a finished volume', () => {
  it('stays finished when left on an earlier page', () => {
    finishedLastYear();
    // Open at the end, flip back to chapter 2 to check a scene, close there.
    updateProgress('v', 30, charsAt(30), false, PAGES);
    viewed([30]);

    const record = get(volumes).v;
    expect(record.progress).toBe(30); // the reader stands where the user left it
    expect(record.completed).toBe(true);
    expect(isVolumeFinished({ volume_uuid: 'v', page_count: PAGES }, record)).toBe(true);
    // The pass's characters are not taken back by a look at an earlier page.
    expect(record.chars).toBe(charsAt(PAGES));
    expect(record.completedAt).toBe(FINISHED);
  });

  it('stays finished after paging back through half the volume to find a scene', () => {
    finishedLastYear();
    const back = Array.from({ length: 181 }, (_, i) => PAGES - i); // 200 → 20, a page at a time
    viewed(back, REVISIT, 1_500);
    updateProgress('v', 20, charsAt(20), false, PAGES);
    expect(get(volumes).v.completed).toBe(true);
    expect(get(volumes).v.completedAt).toBe(FINISHED);
  });

  it('keeps its completion date when the check ends back at the last page', () => {
    finishedLastYear();
    updateProgress('v', 30, charsAt(30), false, PAGES);
    viewed([30, 31, 32]);
    vi.setSystemTime(REVISIT + 120_000);
    updateProgress('v', PAGES, charsAt(PAGES), true, PAGES);

    expect(get(volumes).v.completedAt).toBe(FINISHED);
    expect(isCompletedInPeriod(get(volumes).v, YEAR_START, YEAR_END)).toBe(false);
  });

  it('keeps its completion date when marked as read again after a check', () => {
    finishedLastYear();
    updateProgress('v', 30, charsAt(30), false, PAGES);
    viewed([30]);
    vi.setSystemTime(REVISIT + 60_000);
    markVolumeAsComplete('v', PAGES, charsAt(PAGES));

    expect(get(volumes).v.completedAt).toBe(FINISHED);
  });

  it('earns no goal credit for the pages looked at', () => {
    finishedLastYear();
    updateProgress('v', 30, charsAt(30), false, PAGES);
    viewed(range(28, 36));
    expect(partialProgressInPeriod(get(volumes).v, PAGES, YEAR_START, YEAR_END)).toBe(0);
  });

  it('announces no new completion when the check returns to the end', () => {
    finishedLastYear();
    const announced: string[] = [];
    const stop = registerCompletionListener((volume) => announced.push(volume));
    try {
      updateProgress('v', 30, charsAt(30), false, PAGES);
      viewed([30]);
      updateProgress('v', PAGES, charsAt(PAGES), true, PAGES);
      expect(announced).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe('#304 a finish that has not settled yet', () => {
  it('is taken back by paging away from the end within minutes, keeping its date', () => {
    // A slip of the slider to the end, or the end of a look-up the visit may
    // still restore: as it always was.
    updateProgress('v', PAGES, charsAt(PAGES), true, PAGES);
    const dated = get(volumes).v.completedAt;
    vi.setSystemTime(REVISIT + 60_000);
    updateProgress('v', 150, charsAt(150), false, PAGES);
    expect(get(volumes).v.completed).toBe(false);
    expect(get(volumes).v.completedAt).toBe(dated);
  });

  it('holds once settled', () => {
    updateProgress('v', PAGES, charsAt(PAGES), true, PAGES);
    vi.setSystemTime(REVISIT + 11 * 60_000);
    updateProgress('v', 150, charsAt(150), false, PAGES);
    expect(get(volumes).v.completed).toBe(true);
  });
});

describe('#304 a genuine re-read of a finished volume', () => {
  it('is reading again once a quarter of the volume has been read from the start', () => {
    finishedLastYear();
    updateProgress('v', 1, charsAt(1), false, PAGES);
    viewed(range(1, 60));
    updateProgress('v', 61, charsAt(61), false, PAGES);

    const record = get(volumes).v;
    expect(record.completed).toBe(false);
    expect(record.chars).toBe(charsAt(61));
    // Its earlier finish keeps its date until the re-read finishes.
    expect(record.completedAt).toBe(FINISHED);
    expect(partialProgressInPeriod(record, PAGES, YEAR_START, YEAR_END)).toBeGreaterThan(0);
  });

  it('is dated when the re-read reaches the end, and announced', () => {
    finishedLastYear();
    const announced: string[] = [];
    const stop = registerCompletionListener((volume) => announced.push(volume));
    try {
      updateProgress('v', 1, charsAt(1), false, PAGES);
      viewed(range(1, 199));
      const end = REVISIT + 199 * 20_000;
      vi.setSystemTime(end);
      updateProgress('v', PAGES, charsAt(PAGES), true, PAGES);

      expect(get(volumes).v.completedAt).toBe(new Date(end).toISOString());
      expect(isCompletedInPeriod(get(volumes).v, YEAR_START, YEAR_END)).toBe(true);
      expect(announced).toEqual(['v']);
    } finally {
      stop();
    }
  });

  it('is dated at the end even when the reader never reported the page count', () => {
    // Callers that only move the page (cover toggle, page input) pass no page
    // count, so the flag cannot fall there; the finish still re-dates.
    finishedLastYear();
    updateProgress('v', 1, charsAt(1));
    viewed(range(1, 199));
    const end = REVISIT + 199 * 20_000;
    vi.setSystemTime(end);
    updateProgress('v', PAGES, charsAt(PAGES), true);
    expect(get(volumes).v.completedAt).toBe(new Date(end).toISOString());
  });
});

describe('#304 the explicit un-read still un-reads', () => {
  it('Mark as unread clears the flag, the page and the date', async () => {
    const { markVolumeAsUnread } = await import('./volume-data');
    finishedLastYear();
    markVolumeAsUnread('v');
    const record = get(volumes).v;
    expect(record.completed).toBe(false);
    expect(record.progress).toBe(0);
    expect(record.completedAt).toBeUndefined();
  });
});
