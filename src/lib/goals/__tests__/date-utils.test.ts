import { describe, expect, it } from 'vitest';
import {
  buildMonthKey,
  buildSeasonKey,
  buildTodayKey,
  buildYearKey,
  dateUtils,
  parseMonthKey,
  parseSeasonKey,
  parseYearKey
} from '../date-utils';
import { pinTimeZone } from './tz';

describe('period key parsers reject another shape', () => {
  it('parseMonthKey rejects a season key, a bare year, a today key and a non-numeric month', () => {
    // Every one of these used to parse: `Number('Winter')` is NaN, and NaN fails
    // both `< 0` and `> 11`, so the range guard passed a NaN month index through
    // to `monthRange` and the caller built a period out of an Invalid Date.
    expect(parseMonthKey('2026-Winter')).toBeNull();
    expect(parseMonthKey('2026')).toBeNull();
    expect(parseMonthKey('2026-abc')).toBeNull();
    expect(parseMonthKey('2026-08-30')).toBeNull();
    expect(parseMonthKey('')).toBeNull();
  });

  it('parseMonthKey rejects an out-of-range and an unpadded month', () => {
    expect(parseMonthKey('2026-13')).toBeNull();
    expect(parseMonthKey('2026-00')).toBeNull();
    expect(parseMonthKey('2026-1')).toBeNull();
  });

  it('parseYearKey rejects an empty, blank, fractional or season-shaped key', () => {
    // `Number('')` is 0, not NaN — the old `Number.isFinite` guard turned an
    // empty key into the year 0, i.e. a goal period starting in 1900.
    expect(parseYearKey('')).toBeNull();
    expect(parseYearKey('   ')).toBeNull();
    expect(parseYearKey('2026-Winter')).toBeNull();
    expect(parseYearKey('2026.5')).toBeNull();
    expect(parseYearKey('2026')).toBe(2026);
  });

  it('parseSeasonKey rejects a month key and a key with trailing junk', () => {
    expect(parseSeasonKey('2026-08')).toBeNull();
    expect(parseSeasonKey('2026-Winter-extra')).toBeNull();
    expect(parseSeasonKey('2026-winter')).toBeNull();
  });
});

describe('period keys round-trip through their builders', () => {
  it('parseSeasonKey inverts buildSeasonKey for every season', () => {
    for (let seasonIndex = 0; seasonIndex < 4; seasonIndex += 1) {
      expect(parseSeasonKey(buildSeasonKey(2026, seasonIndex))).toEqual({
        year: 2026,
        seasonIndex
      });
    }
  });

  it('parseMonthKey inverts buildMonthKey for every month', () => {
    for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
      expect(parseMonthKey(buildMonthKey(2026, monthIndex))).toEqual({ year: 2026, monthIndex });
    }
  });

  it('parseYearKey inverts buildYearKey', () => {
    expect(parseYearKey(buildYearKey(2026))).toBe(2026);
  });

  it('buildTodayKey emits the local calendar date, not a UTC one', () => {
    expect(buildTodayKey(new Date(2026, 0, 1, 23, 30))).toBe('2026-01-01');
    expect(buildTodayKey(new Date(2026, 11, 31, 0, 30))).toBe('2026-12-31');
  });
});

describe('dateUtils ranges', () => {
  it('seasonRange and monthRange end EXCLUSIVE on the next period start', () => {
    expect(dateUtils.seasonRange(2026, 3)).toEqual({
      start: new Date(2026, 9, 1),
      end: new Date(2027, 0, 1)
    });
    expect(dateUtils.monthRange(2026, 11)).toEqual({
      start: new Date(2026, 11, 1),
      end: new Date(2027, 0, 1)
    });
  });

  it('seasonRange and monthRange throw rather than return an Invalid Date', () => {
    expect(() => dateUtils.seasonRange(2026, 4)).toThrow(RangeError);
    expect(() => dateUtils.monthRange(2026, 12)).toThrow(RangeError);
  });

  it('seasonIndex and seasonName bucket months in threes', () => {
    expect(dateUtils.seasonName(new Date(2026, 1, 15))).toBe('Winter');
    expect(dateUtils.seasonName(new Date(2026, 4, 15))).toBe('Spring');
    expect(dateUtils.seasonName(new Date(2026, 7, 15))).toBe('Summer');
    expect(dateUtils.seasonName(new Date(2026, 10, 15))).toBe('Autumn');
  });
});

describe('calculateDaysRemaining', () => {
  it('counts the deadline day itself, so today is 1 day', () => {
    expect(dateUtils.calculateDaysRemaining('2026-05-20', new Date(2026, 4, 20, 23, 59))).toBe(1);
    expect(dateUtils.calculateDaysRemaining('2026-05-21', new Date(2026, 4, 20, 0, 1))).toBe(2);
  });

  it('floors at 0 for a passed deadline and returns 0 for an unparseable one', () => {
    expect(dateUtils.calculateDaysRemaining('2026-05-19', new Date(2026, 4, 21))).toBe(0);
    expect(dateUtils.calculateDaysRemaining('not-a-date')).toBe(0);
  });
});

describe('calculateDaysRemaining across a DST shift (pinned to America/New_York)', () => {
  pinTimeZone('America/New_York');

  it('counts 3 days over the 23-hour spring-forward day, not the 2 a floor would give', () => {
    // Mar 7 -> Mar 9 inclusive is three calendar days, but the span is 71 hours
    // because Mar 8 2026 is 23 hours long. Only the Math.round makes it 3.
    expect(dateUtils.calculateDaysRemaining('2026-03-09', new Date(2026, 2, 7, 12))).toBe(3);
  });

  it('counts 2 days over the 25-hour fall-back day, not the 3 a ceil would give', () => {
    expect(dateUtils.calculateDaysRemaining('2026-11-01', new Date(2026, 9, 31, 12))).toBe(2);
  });
});
