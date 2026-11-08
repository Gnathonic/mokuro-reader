import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false }));
vi.mock('$lib/catalog/db', () => ({ db: {} }));

import {
  creditPages,
  creditSpeed,
  estimateMinutes,
  formatMinutes,
  pageCharsOf,
  retractable,
  splitTime
} from './credit';
import { countVolume, prepareVolume, DEFAULT_K, type VolumeTotals } from './stats-engine';
import type { ReadingStatsState } from './stats-store';
import type { ReadingEvent } from './types';
import type { ReadingSpeedResult } from '$lib/util/reading-speed';

const MIN = 60_000;

function stateWith(byVolume: Map<string, VolumeTotals>): ReadingStatsState {
  return {
    ready: true,
    pace: null,
    idle: { k: DEFAULT_K, overrideMs: null },
    byVolume,
    recent: { charsPerMinute: 0, minutes: 0 }
  };
}

const recent = (charsPerMinute: number, confidence: ReadingSpeedResult['confidence']) => ({
  charsPerMinute,
  confidence,
  isPersonalized: confidence !== 'none',
  sessionsUsed: 1
});

describe('pageCharsOf', () => {
  it('reads each page from the cumulative counts', () => {
    expect(pageCharsOf({ page_count: 4, page_char_counts: [10, 10, 35, 40] })).toEqual([
      10, 0, 25, 5
    ]);
  });

  it('falls back to the OCR, counted as the reader counts a page', () => {
    const page = (line: string) => ({ blocks: [{ lines: [line] }] });
    expect(pageCharsOf({ page_count: 2 }, [page('あいう'), page('abc 漢字')])).toEqual([3, 2]);
  });

  it('spreads character_count evenly with the sum kept exact (a placeholder)', () => {
    const chars = pageCharsOf({ page_count: 4, character_count: 10 });
    expect(chars).toEqual([2, 2, 3, 3]);
    expect(chars.reduce((a, b) => a + b)).toBe(10);
    expect(pageCharsOf({ page_count: 3 })).toEqual([0, 0, 0]);
    expect(pageCharsOf({ page_count: 0, character_count: 5 })).toEqual([]);
  });
});

describe('creditSpeed: the estimate', () => {
  /** A series volume with `minutes` of reading at 300 chars/min. */
  function series(minutes: number): Map<string, VolumeTotals> {
    const events: ReadingEvent[] = Array.from({ length: minutes }, (_, i) => ({
      device: 'd',
      seq: i + 1,
      t: i * MIN,
      kind: 'page',
      volume: 'v1',
      first_page: i + 1,
      last_page: i + 1,
      page_chars: [300],
      chars_before: 0,
      dwell_ms: MIN,
      layout: 'single',
      orientation: 'portrait',
      viewport: null
    }));
    return new Map([['v1', countVolume(prepareVolume(events), null, { k: 3, overrideMs: null })]]);
  }

  it("the series' own speed beats the recent one", () => {
    expect(creditSpeed(stateWith(series(61)), ['v1'], recent(150, 'high'))).toEqual({
      charsPerMinute: 300,
      source: 'series',
      rough: false
    });
  });

  it('without an hour of the series, the recent speed; rough under 4 hours', () => {
    const stats = stateWith(series(20));
    expect(creditSpeed(stats, ['v1'], recent(150, 'high'))).toEqual({
      charsPerMinute: 150,
      source: 'recent',
      rough: false
    });
    expect(creditSpeed(stats, ['v1'], recent(150, 'low'))?.rough).toBe(true);
  });

  it('confidence none: no estimate — never the 100 chars/min default', () => {
    const none = {
      charsPerMinute: 100,
      confidence: 'none' as const,
      isPersonalized: false,
      sessionsUsed: 0
    };
    const speed = creditSpeed(stateWith(new Map()), [], none);
    expect(speed).toBeNull();
    expect(estimateMinutes(9412, speed)).toBeNull();
  });

  it('minutes round up', () => {
    const speed = { charsPerMinute: 248, source: 'series' as const, rough: false };
    expect(estimateMinutes(9412, speed)).toBe(38);
    expect(estimateMinutes(248, speed)).toBe(1);
    expect(estimateMinutes(249, speed)).toBe(2);
    expect(estimateMinutes(0, speed)).toBe(0);
  });
});

describe('creditPages', () => {
  it('takes the pages not read here up to the bound, with their characters', () => {
    expect(creditPages([2, 5, 6, 9], [1, 2, 3, 4, 5, 6, 7, 8, 9], 6)).toEqual({
      pages: [2, 5, 6],
      page_chars: [2, 5, 6],
      chars: 13
    });
  });
});

describe('splitTime: one total time across volumes by characters', () => {
  it('splits in proportion and sums exactly', () => {
    const parts = splitTime(10 * MIN + 1, [100, 200, 0, 700]);
    expect(parts.reduce((a, b) => a + b)).toBe(10 * MIN + 1);
    expect(parts[2]).toBe(0);
    expect(parts[1]).toBeCloseTo(2 * parts[0], -1);
    expect(splitTime(MIN, [0, 0])).toEqual([0, 0]);
    expect(splitTime(0, [5])).toEqual([0]);
  });
});

describe('retractable', () => {
  it('pairs live credits with their recorded fields; one with no event is skipped', () => {
    const event: ReadingEvent = {
      device: 'd',
      seq: 4,
      t: 0,
      kind: 'credit',
      volume: 'v',
      pages: [3, 4],
      page_chars: [10, 20],
      time_ms: MIN
    };
    const live = { device: 'd', seq: 4, t: 0, pass: 0, ms: MIN, chars: 30, pages: [3, 4] };
    expect(retractable([live, { ...live, seq: 9 }], [event])).toEqual([
      { target: ['d', 4], fields: { pages: [3, 4], page_chars: [10, 20], time_ms: MIN } }
    ]);
  });
});

describe('formatMinutes', () => {
  it.each([
    [38, '38 min'],
    [60, '1 h'],
    [715, '11 h 55 min']
  ])('%d → %s', (m, text) => expect(formatMinutes(m)).toBe(text));
});
