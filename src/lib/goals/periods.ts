import {
  buildMonthKey,
  buildSeasonKey,
  buildTodayKey,
  buildYearKey,
  dateUtils,
  parseMonthKey,
  parseSeasonKey,
  parseYearKey
} from './date-utils';
import type { CustomGoal, GoalPeriod, GoalSelection, GoalType } from './types';

export function parseLocalDateString(dateString: string): Date | null {
  const parts = dateString.split('-').map(Number);
  if (parts.length !== 3) return null;

  const [year, month, day] = parts;
  if (!year || !month || !day) return null;

  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return date;
}

export function hasValidCustomGoalDateRange(startDate: string, endDate: string): boolean {
  const start = parseLocalDateString(startDate);
  const end = parseLocalDateString(endDate);

  if (!start || !end) return false;

  return start.getTime() <= end.getTime();
}

export function isCustomGoalClosed(
  goal: Pick<CustomGoal, 'startDate' | 'endDate'>,
  now = new Date()
): boolean {
  const inclusiveEnd = parseLocalDateString(goal.endDate);
  if (!inclusiveEnd) return false;

  const end = new Date(
    inclusiveEnd.getFullYear(),
    inclusiveEnd.getMonth(),
    inclusiveEnd.getDate() + 1
  );

  return end.getTime() <= now.getTime();
}

export function isDateWithinRange(dateIso: string, start: Date, end: Date): boolean {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return false;
  return date >= start && date < end;
}

export function getPeriodForSelection(selection: GoalSelection): GoalPeriod | null {
  if (selection.goalType === 'custom') return null;

  const now = new Date();
  if (selection.goalType === 'year') {
    const year = parseYearKey(selection.periodKey);
    if (year === null) return null;
    const start = new Date(year, 0, 1);
    const end = new Date(year + 1, 0, 1);
    return {
      goalType: 'year',
      periodKey: selection.periodKey,
      label: `${year}`,
      start,
      end
    };
  }

  if (selection.goalType === 'season') {
    const parsed = parseSeasonKey(selection.periodKey);
    if (!parsed) return null;
    const { start, end } = dateUtils.seasonRange(parsed.year, parsed.seasonIndex);
    const label = `${dateUtils.seasonNames[parsed.seasonIndex]} ${parsed.year}`;
    return {
      goalType: 'season',
      periodKey: selection.periodKey,
      label,
      start,
      end
    };
  }

  if (selection.goalType === 'month') {
    const parsed = parseMonthKey(selection.periodKey);
    if (!parsed) return null;
    const { start, end } = dateUtils.monthRange(parsed.year, parsed.monthIndex);
    const label = start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    return {
      goalType: 'month',
      periodKey: selection.periodKey,
      label,
      start,
      end
    };
  }

  if (selection.goalType === 'today') {
    const [yearPart, monthPart, dayPart] = selection.periodKey.split('-').map(Number);
    if (!yearPart || !monthPart || !dayPart) return null;
    const start = new Date(yearPart, monthPart - 1, dayPart);
    const end = new Date(yearPart, monthPart - 1, dayPart + 1);
    const label = start.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    return {
      goalType: 'today',
      periodKey: selection.periodKey,
      label,
      start,
      end
    };
  }

  return {
    goalType: 'today',
    periodKey: buildTodayKey(now),
    label: 'Today',
    start: dateUtils.startOfDay(now),
    end: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  };
}

export function getCurrentPeriodKey(goalType: Exclude<GoalType, 'custom'>): string {
  const now = new Date();
  if (goalType === 'year') return buildYearKey(now.getFullYear());
  if (goalType === 'season') return buildSeasonKey(now.getFullYear(), dateUtils.seasonIndex(now));
  if (goalType === 'month') return buildMonthKey(now.getFullYear(), now.getMonth());
  return buildTodayKey(now);
}

export function getRecentPeriods(
  goalType: Exclude<GoalType, 'custom'>,
  count: number
): GoalPeriod[] {
  const now = new Date();
  const periods: GoalPeriod[] = [];

  if (goalType === 'year') {
    for (let i = 0; i < count; i += 1) {
      const year = now.getFullYear() - i;
      periods.push({
        goalType,
        periodKey: buildYearKey(year),
        label: `${year}`,
        start: new Date(year, 0, 1),
        end: new Date(year + 1, 0, 1)
      });
    }
    return periods;
  }

  if (goalType === 'season') {
    for (let i = 0; i < count; i += 1) {
      const seasonOffset = dateUtils.seasonIndex(now) - i;
      const yearOffset = Math.floor(seasonOffset / 4);
      const seasonIndex = ((seasonOffset % 4) + 4) % 4;
      const year = now.getFullYear() + yearOffset;
      const { start, end } = dateUtils.seasonRange(year, seasonIndex);
      periods.push({
        goalType,
        periodKey: buildSeasonKey(year, seasonIndex),
        label: `${dateUtils.seasonNames[seasonIndex]} ${year}`,
        start,
        end
      });
    }
    return periods;
  }

  if (goalType === 'month') {
    for (let i = 0; i < count; i += 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const { start, end } = dateUtils.monthRange(date.getFullYear(), date.getMonth());
      periods.push({
        goalType,
        periodKey: buildMonthKey(date.getFullYear(), date.getMonth()),
        label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        start,
        end
      });
    }
    return periods;
  }

  for (let i = 0; i < count; i += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const start = dateUtils.startOfDay(date);
    const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    periods.push({
      goalType,
      periodKey: buildTodayKey(date),
      label: date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }),
      start,
      end
    });
  }

  return periods;
}

export function getCustomPeriod(selection: GoalSelection, custom: CustomGoal[]): GoalPeriod | null {
  if (selection.goalType !== 'custom') return null;
  const goal = custom.find((entry) => entry.id === selection.customId);
  if (!goal) return null;

  const start = parseLocalDateString(goal.startDate);
  const inclusiveEnd = parseLocalDateString(goal.endDate);
  if (!start || !inclusiveEnd) return null;
  if (start.getTime() > inclusiveEnd.getTime()) return null;

  const end = new Date(
    inclusiveEnd.getFullYear(),
    inclusiveEnd.getMonth(),
    inclusiveEnd.getDate() + 1
  );
  return {
    goalType: 'custom',
    periodKey: goal.id,
    label: goal.name,
    start,
    end
  };
}
