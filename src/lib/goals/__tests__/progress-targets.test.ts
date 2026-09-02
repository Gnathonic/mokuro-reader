import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculatePeriodPageTargetTotal,
  formatRelativeResetTime,
  getCurrentPeriodStart,
  getNextResetTime
} from '../progress-targets';
import { pinTimeZone } from './tz';

// Day-of-week reference for the dates used below: 2026-05-18 is a Monday, so
// 2026-05-20 is a Wednesday.
const MONDAY = new Date(2026, 4, 18);
const WEDNESDAY = new Date(2026, 4, 20);

function at(day: Date, hours: number, minutes = 0): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('getCurrentPeriodStart — daily', () => {
  it('returns YESTERDAY 06:00 at 02:00, before today reset has happened', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(WEDNESDAY, 2));
    expect(getCurrentPeriodStart('daily', 6)).toBe(at(new Date(2026, 4, 19), 6).getTime());
  });

  it('returns TODAY 06:00 at 07:00, after today reset has happened', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(WEDNESDAY, 7));
    expect(getCurrentPeriodStart('daily', 6)).toBe(at(WEDNESDAY, 6).getTime());
  });

  it('treats the reset instant itself as the start of the new period', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(WEDNESDAY, 6));
    expect(getCurrentPeriodStart('daily', 6)).toBe(at(WEDNESDAY, 6).getTime());
  });
});

describe('getCurrentPeriodStart — weekly', () => {
  it('returns the previous Monday when today is Wednesday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(WEDNESDAY, 12));
    expect(getCurrentPeriodStart('weekly', 6, 1)).toBe(at(MONDAY, 6).getTime());
  });

  it('returns the PREVIOUS Monday on Monday at 05:00 with resetHour 6', () => {
    // The reset day has arrived but its hour has not, so the week that is
    // actually running is still the one that started seven days ago.
    vi.useFakeTimers();
    vi.setSystemTime(at(MONDAY, 5));
    expect(getCurrentPeriodStart('weekly', 6, 1)).toBe(at(new Date(2026, 4, 11), 6).getTime());
  });

  it('returns this Monday on Monday at 07:00 with resetHour 6', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(MONDAY, 7));
    expect(getCurrentPeriodStart('weekly', 6, 1)).toBe(at(MONDAY, 6).getTime());
  });

  it('defaults an omitted resetDay to Monday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(WEDNESDAY, 12));
    expect(getCurrentPeriodStart('weekly', 6)).toBe(getCurrentPeriodStart('weekly', 6, 1));
  });
});

describe('getNextResetTime', () => {
  it('points at today 06:00 at 02:00 and tomorrow 06:00 at 07:00', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(WEDNESDAY, 2));
    expect(getNextResetTime('daily', 6)).toBe(at(WEDNESDAY, 6).getTime());

    vi.setSystemTime(at(WEDNESDAY, 7));
    expect(getNextResetTime('daily', 6)).toBe(at(new Date(2026, 4, 21), 6).getTime());
  });

  it('points at the coming Monday from a Wednesday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(WEDNESDAY, 12));
    expect(getNextResetTime('weekly', 6, 1)).toBe(at(new Date(2026, 4, 25), 6).getTime());
  });

  it('points at today on the reset day before the reset hour, and next week after it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(MONDAY, 5));
    expect(getNextResetTime('weekly', 6, 1)).toBe(at(MONDAY, 6).getTime());

    vi.setSystemTime(at(MONDAY, 7));
    expect(getNextResetTime('weekly', 6, 1)).toBe(at(new Date(2026, 4, 25), 6).getTime());
  });

  it('brackets the current period: start is in the past, next reset in the future', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(WEDNESDAY, 12));
    for (const mode of ['daily', 'weekly'] as const) {
      expect(getCurrentPeriodStart(mode, 6, 1)).toBeLessThanOrEqual(Date.now());
      expect(getNextResetTime(mode, 6, 1)).toBeGreaterThan(Date.now());
    }
  });
});

describe('formatRelativeResetTime', () => {
  it('drops the smaller unit when it is zero and says "now" once elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 20, 12, 0));
    const now = Date.now();

    expect(formatRelativeResetTime(now - 1)).toBe('now');
    expect(formatRelativeResetTime(now + 45 * 60 * 1000)).toBe('45m');
    expect(formatRelativeResetTime(now + 2 * 60 * 60 * 1000)).toBe('2h');
    expect(formatRelativeResetTime(now + (2 * 60 + 30) * 60 * 1000)).toBe('2h 30m');
    expect(formatRelativeResetTime(now + 48 * 60 * 60 * 1000)).toBe('2d');
    expect(formatRelativeResetTime(now + 50 * 60 * 60 * 1000)).toBe('2d 2h');
  });
});

describe('calculatePeriodPageTargetTotal', () => {
  const periodStart = new Date(2026, 4, 20, 0, 0).getTime();

  it('returns null without a deadline or with nothing left to read', () => {
    expect(calculatePeriodPageTargetTotal(100, null, 'daily', 0, periodStart)).toBeNull();
    expect(calculatePeriodPageTargetTotal(0, '2026-05-24', 'daily', 0, periodStart)).toBeNull();
  });

  it('spreads the remaining pages over the days left, deadline day included', () => {
    // May 20 -> deadline May 24 inclusive is five daily periods.
    expect(calculatePeriodPageTargetTotal(100, '2026-05-24', 'daily', 0, periodStart)).toBe(20);
  });

  it('returns a TOTAL that already contains what was read this period', () => {
    // The caller subtracts `pagesReadInCurrentPeriod` to get the remainder, so
    // the target must not shrink as the reader makes progress inside a period.
    expect(calculatePeriodPageTargetTotal(80, '2026-05-24', 'daily', 20, periodStart)).toBe(20);
  });

  it('demands everything in one go when the deadline is today or already passed', () => {
    expect(calculatePeriodPageTargetTotal(100, '2026-05-20', 'daily', 0, periodStart)).toBe(100);
    expect(calculatePeriodPageTargetTotal(100, '2026-05-01', 'daily', 0, periodStart)).toBe(100);
  });

  it('counts weekly periods by reset boundary, rounding a part week up', () => {
    // 14 days -> 2 weekly resets; 15 days -> 3, because the last few days still
    // need a period of their own.
    expect(calculatePeriodPageTargetTotal(100, '2026-06-02', 'weekly', 0, periodStart)).toBe(50);
    expect(calculatePeriodPageTargetTotal(100, '2026-06-03', 'weekly', 0, periodStart)).toBe(34);
  });
});

describe('calculatePeriodPageTargetTotal across a DST fall-back (pinned to America/New_York)', () => {
  pinTimeZone('America/New_York');

  it('counts 2 daily periods over the 25-hour day, not the 3 a ms division invents', () => {
    // Oct 31 00:00 -> Nov 2 00:00 is 49 hours because Nov 1 2026 is 25 hours
    // long. `Math.ceil(49h / 24h)` said 3 periods, so the reader was told to do
    // 34 pages a day for a deadline that actually needs 50.
    const periodStart = new Date(2026, 9, 31, 0, 0).getTime();
    expect(calculatePeriodPageTargetTotal(100, '2026-11-01', 'daily', 0, periodStart)).toBe(50);
  });

  it('gives the same answer as an identical span with no DST shift in it', () => {
    const acrossDst = new Date(2026, 9, 31, 0, 0).getTime();
    const noDst = new Date(2026, 9, 20, 0, 0).getTime();
    expect(calculatePeriodPageTargetTotal(100, '2026-11-01', 'daily', 0, acrossDst)).toBe(
      calculatePeriodPageTargetTotal(100, '2026-10-21', 'daily', 0, noDst)
    );
  });

  it('counts 2 weekly periods over the 25-hour day, not the 3 a ms division invents', () => {
    // Oct 25 -> Nov 8 is exactly 14 calendar days, but 337 hours, and
    // `Math.ceil(337h / 168h)` is 3.
    const periodStart = new Date(2026, 9, 25, 0, 0).getTime();
    expect(calculatePeriodPageTargetTotal(100, '2026-11-07', 'weekly', 0, periodStart)).toBe(50);
  });

  it('keeps the daily period start on the same wall clock across the fall-back', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 2, 3, 0));
    expect(getCurrentPeriodStart('daily', 6)).toBe(new Date(2026, 10, 1, 6, 0).getTime());
    vi.useRealTimers();
  });
});
