import { describe, expect, it } from 'vitest';
import {
  calculatePartialVolumeProgressInPeriod,
  getDaysRemainingInPeriod,
  getExpectedProgressPercent
} from '../goal-math';
import type { PageTurn } from '$lib/settings/volume-data';
import { pinTimeZone } from './tz';

const PERIOD_START = new Date(2026, 5, 1);
const PERIOD_END = new Date(2026, 6, 1);

function turn(date: Date, pageNumber: number): PageTurn {
  return [date.getTime(), pageNumber, 0];
}

describe('getExpectedProgressPercent', () => {
  it('clamps to 0 before the period and 100 after it', () => {
    expect(getExpectedProgressPercent(PERIOD_START, PERIOD_END, new Date(2026, 4, 1))).toBe(0);
    expect(getExpectedProgressPercent(PERIOD_START, PERIOD_END, new Date(2026, 7, 1))).toBe(100);
  });

  it('is the elapsed fraction at the halfway mark', () => {
    const halfway = new Date((PERIOD_START.getTime() + PERIOD_END.getTime()) / 2);
    expect(getExpectedProgressPercent(PERIOD_START, PERIOD_END, halfway)).toBeCloseTo(50, 6);
  });

  it('returns 0 for an empty or inverted period rather than dividing by zero', () => {
    expect(getExpectedProgressPercent(PERIOD_START, PERIOD_START)).toBe(0);
    expect(getExpectedProgressPercent(PERIOD_END, PERIOD_START)).toBe(0);
  });
});

describe('getDaysRemainingInPeriod', () => {
  it('counts whole calendar days to the exclusive end and floors at 0', () => {
    expect(getDaysRemainingInPeriod(new Date(2026, 6, 1), new Date(2026, 5, 28, 23, 59))).toBe(3);
    expect(getDaysRemainingInPeriod(new Date(2026, 6, 1), new Date(2026, 6, 1, 0, 1))).toBe(0);
    expect(getDaysRemainingInPeriod(new Date(2026, 5, 1), new Date(2026, 6, 1))).toBe(0);
  });
});

describe('getDaysRemainingInPeriod across a DST shift (pinned to America/New_York)', () => {
  pinTimeZone('America/New_York');

  it('counts 3 days over the 23-hour spring-forward day, not the 2 a floor would give', () => {
    // Mar 7 -> Mar 10 spans 71 hours, not 72, because Mar 8 2026 is 23 hours
    // long. The Math.round is what keeps this at 3.
    expect(getDaysRemainingInPeriod(new Date(2026, 2, 10), new Date(2026, 2, 7, 12))).toBe(3);
  });

  it('counts 2 days over the 25-hour fall-back day, not the 3 a ceil would give', () => {
    expect(getDaysRemainingInPeriod(new Date(2026, 10, 2), new Date(2026, 9, 31, 12))).toBe(2);
  });
});

describe('calculatePartialVolumeProgressInPeriod', () => {
  it('counts a turn exactly at periodStart but not one exactly at periodEnd', () => {
    expect(
      calculatePartialVolumeProgressInPeriod([turn(PERIOD_START, 1)], PERIOD_START, PERIOD_END, 10)
    ).toBe(0.1);
    expect(
      calculatePartialVolumeProgressInPeriod([turn(PERIOD_END, 1)], PERIOD_START, PERIOD_END, 10)
    ).toBe(0);
  });

  it('ignores turns outside the period', () => {
    const turns = [
      turn(new Date(2026, 4, 31, 23, 59), 1),
      turn(new Date(2026, 5, 15), 2),
      turn(new Date(2026, 6, 2), 3)
    ];
    expect(calculatePartialVolumeProgressInPeriod(turns, PERIOD_START, PERIOD_END, 10)).toBe(0.1);
  });

  it('counts a page re-read inside the period once, not twice', () => {
    // Page turns are an append-only log, so a reader flipping back and forth
    // logs the same page repeatedly; counting them would credit more pages than
    // the volume has.
    const turns = [
      turn(new Date(2026, 5, 2), 4),
      turn(new Date(2026, 5, 3), 4),
      turn(new Date(2026, 5, 4), 5)
    ];
    expect(calculatePartialVolumeProgressInPeriod(turns, PERIOD_START, PERIOD_END, 10)).toBe(0.2);
  });

  it('clamps to 1 when more distinct pages were turned than the volume has', () => {
    const turns = Array.from({ length: 12 }, (_, index) =>
      turn(new Date(2026, 5, 2 + index), index + 1)
    );
    expect(calculatePartialVolumeProgressInPeriod(turns, PERIOD_START, PERIOD_END, 10)).toBe(1);
  });

  it('returns 0 for an unknown page count or an empty log', () => {
    expect(
      calculatePartialVolumeProgressInPeriod(
        [turn(new Date(2026, 5, 2), 1)],
        PERIOD_START,
        PERIOD_END,
        0
      )
    ).toBe(0);
    expect(calculatePartialVolumeProgressInPeriod([], PERIOD_START, PERIOD_END, 10)).toBe(0);
  });
});
