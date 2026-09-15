import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getCurrentPeriodKey,
  getCustomPeriod,
  getPeriodForSelection,
  getRecentPeriods,
  hasValidCustomGoalDateRange,
  isCustomGoalClosed,
  isDateWithinRange,
  parseLocalDateString
} from '../periods';
import type { CustomGoal } from '../types';

function customGoal(over: Partial<CustomGoal> = {}): CustomGoal {
  return {
    id: 'goal-1',
    name: 'Summer push',
    targetVolumes: 8,
    startDate: '2026-06-01',
    endDate: '2026-08-31',
    enabled: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseLocalDateString', () => {
  it('parses to local midnight rather than a UTC instant', () => {
    expect(parseLocalDateString('2026-06-01')).toEqual(new Date(2026, 5, 1));
  });

  it('rejects a date the calendar rolls over, and anything not three parts', () => {
    expect(parseLocalDateString('2026-02-31')).toBeNull();
    expect(parseLocalDateString('2026-13-01')).toBeNull();
    expect(parseLocalDateString('2026-06-00')).toBeNull();
    expect(parseLocalDateString('2026-06')).toBeNull();
    expect(parseLocalDateString('nonsense')).toBeNull();
  });
});

describe('custom goal date ranges', () => {
  it('accepts an equal start and end but rejects an inverted or unparseable one', () => {
    expect(hasValidCustomGoalDateRange('2026-06-01', '2026-06-01')).toBe(true);
    expect(hasValidCustomGoalDateRange('2026-06-02', '2026-06-01')).toBe(false);
    expect(hasValidCustomGoalDateRange('2026-02-31', '2026-06-01')).toBe(false);
  });

  it('is closed only once the day AFTER the inclusive end has begun', () => {
    const goal = { startDate: '2026-06-01', endDate: '2026-08-31' };
    expect(isCustomGoalClosed(goal, new Date(2026, 7, 31, 23, 59))).toBe(false);
    expect(isCustomGoalClosed(goal, new Date(2026, 8, 1, 0, 0))).toBe(true);
  });
});

describe('isDateWithinRange', () => {
  const start = new Date(2026, 5, 1);
  const end = new Date(2026, 6, 1);

  it('is half-open: the start instant is in, the end instant is out', () => {
    expect(isDateWithinRange(start.toISOString(), start, end)).toBe(true);
    expect(isDateWithinRange(end.toISOString(), start, end)).toBe(false);
    expect(isDateWithinRange(new Date(end.getTime() - 1).toISOString(), start, end)).toBe(true);
  });

  it('rejects an unparseable stamp instead of letting an Invalid Date compare', () => {
    expect(isDateWithinRange('', start, end)).toBe(false);
    expect(isDateWithinRange('not-a-date', start, end)).toBe(false);
  });
});

describe('getPeriodForSelection', () => {
  it('ends every period EXCLUSIVE on the next period start', () => {
    expect(getPeriodForSelection({ goalType: 'year', periodKey: '2026' })).toMatchObject({
      start: new Date(2026, 0, 1),
      end: new Date(2027, 0, 1)
    });
    expect(getPeriodForSelection({ goalType: 'season', periodKey: '2026-Spring' })).toMatchObject({
      start: new Date(2026, 3, 1),
      end: new Date(2026, 6, 1)
    });
    expect(getPeriodForSelection({ goalType: 'month', periodKey: '2026-02' })).toMatchObject({
      start: new Date(2026, 1, 1),
      end: new Date(2026, 2, 1)
    });
    expect(getPeriodForSelection({ goalType: 'today', periodKey: '2026-08-30' })).toMatchObject({
      start: new Date(2026, 7, 30),
      end: new Date(2026, 7, 31)
    });
  });

  it('returns null rather than a period built on an Invalid Date', () => {
    // Each of these produced a `GoalPeriod` whose start or end was an Invalid
    // Date, and every comparison against it is false — so the goal quietly
    // counted nothing instead of failing to load.
    expect(getPeriodForSelection({ goalType: 'month', periodKey: '2026-Winter' })).toBeNull();
    expect(getPeriodForSelection({ goalType: 'month', periodKey: '2026-13' })).toBeNull();
    expect(getPeriodForSelection({ goalType: 'year', periodKey: '' })).toBeNull();
    expect(getPeriodForSelection({ goalType: 'season', periodKey: '2026-08' })).toBeNull();
  });

  it('rejects a today key the calendar would roll over into another month', () => {
    expect(getPeriodForSelection({ goalType: 'today', periodKey: '2026-13-45' })).toBeNull();
    expect(getPeriodForSelection({ goalType: 'today', periodKey: '2026-02-31' })).toBeNull();
  });

  it('returns null for a custom selection — those go through getCustomPeriod', () => {
    expect(getPeriodForSelection({ goalType: 'custom', customId: 'goal-1' })).toBeNull();
  });
});

describe('getCurrentPeriodKey', () => {
  it('builds the key for the goal type containing now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 20, 13, 0));

    expect(getCurrentPeriodKey('year')).toBe('2026');
    expect(getCurrentPeriodKey('season')).toBe('2026-Spring');
    expect(getCurrentPeriodKey('month')).toBe('2026-05');
    expect(getCurrentPeriodKey('today')).toBe('2026-05-20');
  });
});

describe('getRecentPeriods', () => {
  it('walks seasons backwards across a year boundary', () => {
    // The wrap is `Math.floor(seasonOffset / 4)` on a NEGATIVE offset, which is
    // the arithmetic worth pinning: from Winter 2026, offset -5 must land on
    // Autumn 2024 (yearOffset -2), not Autumn 2025.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0));

    expect(getRecentPeriods('season', 6).map((period) => period.periodKey)).toEqual([
      '2026-Winter',
      '2025-Autumn',
      '2025-Summer',
      '2025-Spring',
      '2025-Winter',
      '2024-Autumn'
    ]);
  });

  it('gives each season the range its own key parses to', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0));

    for (const period of getRecentPeriods('season', 6)) {
      expect(getPeriodForSelection({ goalType: 'season', periodKey: period.periodKey })).toEqual(
        period
      );
    }
  });

  it('walks months, days and years backwards across a year boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 12, 0));

    expect(getRecentPeriods('month', 3).map((period) => period.periodKey)).toEqual([
      '2026-01',
      '2025-12',
      '2025-11'
    ]);
    expect(getRecentPeriods('today', 3).map((period) => period.periodKey)).toEqual([
      '2026-01-02',
      '2026-01-01',
      '2025-12-31'
    ]);
    expect(getRecentPeriods('year', 2).map((period) => period.periodKey)).toEqual(['2026', '2025']);
  });

  it('returns nothing for a count of 0', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 12, 0));
    expect(getRecentPeriods('month', 0)).toEqual([]);
  });
});

describe('getCustomPeriod', () => {
  it('makes the inclusive end date exclusive by advancing one day', () => {
    const goal = customGoal();
    expect(getCustomPeriod({ goalType: 'custom', customId: 'goal-1' }, [goal])).toMatchObject({
      periodKey: 'goal-1',
      label: 'Summer push',
      start: new Date(2026, 5, 1),
      end: new Date(2026, 8, 1)
    });
  });

  it('returns null for a missing goal, an inverted range or an impossible date', () => {
    expect(getCustomPeriod({ goalType: 'custom', customId: 'nope' }, [customGoal()])).toBeNull();
    expect(
      getCustomPeriod({ goalType: 'custom', customId: 'goal-1' }, [
        customGoal({ startDate: '2026-09-01', endDate: '2026-08-31' })
      ])
    ).toBeNull();
    expect(
      getCustomPeriod({ goalType: 'custom', customId: 'goal-1' }, [
        customGoal({ endDate: '2026-02-31' })
      ])
    ).toBeNull();
  });

  it('returns null for a non-custom selection', () => {
    expect(getCustomPeriod({ goalType: 'year', periodKey: '2026' }, [customGoal()])).toBeNull();
  });
});
