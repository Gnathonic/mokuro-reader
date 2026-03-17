import { browser } from '$app/environment';
import { writable, derived, get, readable } from 'svelte/store';
import { volumes, type VolumeData, type PageTurn } from './volume-data';
import { volumes as catalogVolumes } from '$lib/catalog';
import { generateUUID } from '$lib/util/uuid';

// ================================
// TYPES
// ================================

export type GoalType = 'year' | 'season' | 'month' | 'today' | 'custom';

export type GoalTarget = {
  goalType: Exclude<GoalType, 'custom'>;
  periodKey: string;
  targetVolumes: number;
  createdAt: string; // ISO datetime
};

export type CustomGoal = {
  id: string;
  name: string;
  targetVolumes: number;
  startDate: string; // YYYY-MM-DD (local date)
  endDate: string; // YYYY-MM-DD (local date)
  enabled: boolean;
  createdAt: string; // ISO datetime
};

export type GoalSelection =
  | { goalType: Exclude<GoalType, 'custom'>; periodKey: string }
  | { goalType: 'custom'; customId: string };

export type GoalPeriod = {
  goalType: GoalType;
  periodKey: string;
  label: string;
  start: Date;
  end: Date;
};

export type GoalSnapshot = {
  goalType: GoalType;
  periodKey: string;
  startDate: string; // YYYY-MM-DD (local date)
  endDate: string; // YYYY-MM-DD (local date)
  closedAt: string; // ISO datetime
  completed: Record<string, string>; // volumeId -> completedAt (ISO datetime)
  partialProgress: Record<string, number>; // volumeId -> fraction completed within period
};

type CompletedAtMap = Record<string, string>;

export type VolumeDeadline = {
  volumeId: string;
  deadline: string; // ISO date string (YYYY-MM-DD)
};

export type GoalSettings = {
  volumeDeadlines: Record<string, string>; // volumeId -> deadline (YYYY-MM-DD)
};

export type GoalsData = {
  targets: GoalTarget[];
  customGoals: CustomGoal[];
  activeSelection: GoalSelection;
};

// ================================
// DATE UTILITIES
// ================================

const seasonNames = ['Winter', 'Spring', 'Summer', 'Autumn'] as const;

export const dateUtils = {
  /**
   * Calculate days remaining from startDate until endDate (inclusive on both ends)
   * Example: Jan 5 to Jan 8 = 4 days (5th, 6th, 7th, 8th)
   */
  calculateDaysRemaining: (endDate: string | Date, startDate: Date = new Date()): number => {
    let end: Date;
    if (endDate instanceof Date) {
      end = endDate;
    } else {
      // Parse YYYY-MM-DD as local date, not UTC
      const [year, month, day] = endDate.split('-').map(Number);
      end = new Date(year, month - 1, day);
    }
    if (isNaN(end.getTime())) return 0;

    // Set start to midnight of start date, end to midnight AFTER the deadline (end of deadline day)
    const endMidnight = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    const startMidnight = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      startDate.getDate()
    );

    const diffInMs = endMidnight.getTime() - startMidnight.getTime();
    const diffInDays = diffInMs / (1000 * 60 * 60 * 24);

    return Math.max(0, Math.round(diffInDays));
  },

  /**
   * Get the number of days into the current year (1-indexed, so Jan 1 = 1)
   */
  daysIntoYear: (date: Date = new Date()): number => {
    const startOfYear = new Date(date.getFullYear(), 0, 1); // January 1st
    const dateMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.floor((dateMidnight.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  },

  /**
   * Get the total number of days in a year
   */
  daysInYear: (date: Date = new Date()): number => {
    const year = date.getFullYear();
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  },

  /**
   * Get the end of year date string (December 31st)
   */
  endOfYear: (year: number = new Date().getFullYear()): string => {
    return `${year}-12-31`;
  },

  /**
   * Format date as YYYY-MM-DD (using local timezone)
   */
  formatDate: (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },

  startOfDay: (date: Date = new Date()): Date => {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  },

  seasonNames,

  seasonIndex: (date: Date = new Date()): number => {
    return Math.floor(date.getMonth() / 3);
  },

  seasonName: (date: Date = new Date()): (typeof seasonNames)[number] => {
    return seasonNames[dateUtils.seasonIndex(date)];
  },

  /**
   * Returns the start and end dates of a calendar quarter.
   * @param year Full year (e.g. 2025)
   * @param quarter 0-based index (0 = Q1 Jan–Mar, 1 = Q2 Apr–Jun, 2 = Q3 Jul–Sep, 3 = Q4 Oct–Dec)
   */
  seasonRange: (year: number, quarter: number): { start: Date; end: Date } => {
    if (quarter < 0 || quarter > 3) {
      throw new RangeError('Quarter must be 0–3');
    }
    const month = quarter * 3;
    return {
      start: new Date(year, month, 1),
      end: new Date(year, month + 3, 1)
    };
  },

  monthRange: (year: number, monthIndex: number): { start: Date; end: Date } => {
    if (monthIndex < 0 || monthIndex > 11) {
      throw new RangeError('Month index must be 0–11');
    }
    return {
      start: new Date(year, monthIndex, 1),
      end: new Date(year, monthIndex + 1, 1)
    };
  }
};

/**
 * Get the start timestamp of the current period based on mode and reset settings
 * @param mode - 'daily' or 'weekly'
 * @param resetHour - Hour (0-23) when period resets
 * @param resetDay - Day of week (0=Sunday, 1=Monday, etc.) when weekly period resets
 * @returns Timestamp (ms) of when the current period started
 */
export function getCurrentPeriodStart(
  mode: 'daily' | 'weekly',
  resetHour: number,
  resetDay?: number
): number {
  const now = new Date();

  if (mode === 'daily') {
    // Calculate today's reset time
    const todayReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      resetHour,
      0,
      0,
      0
    );

    // If we haven't reached today's reset time yet, period started yesterday at reset time
    if (now < todayReset) {
      const yesterdayReset = new Date(todayReset);
      yesterdayReset.setDate(yesterdayReset.getDate() - 1);
      return yesterdayReset.getTime();
    }

    return todayReset.getTime();
  } else {
    // Weekly mode
    const targetDay = resetDay ?? 1; // Default to Monday
    const currentDay = now.getDay();

    // Calculate days since last reset day
    let daysSinceReset = (currentDay - targetDay + 7) % 7;

    // Calculate this week's reset time
    const thisWeekReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - daysSinceReset,
      resetHour,
      0,
      0,
      0
    );

    // If we haven't reached this week's reset time yet, period started last week
    if (now < thisWeekReset) {
      const lastWeekReset = new Date(thisWeekReset);
      lastWeekReset.setDate(lastWeekReset.getDate() - 7);
      return lastWeekReset.getTime();
    }

    return thisWeekReset.getTime();
  }
}

/**
 * Get the timestamp of the next reset time
 * @param mode - 'daily' or 'weekly'
 * @param resetHour - Hour (0-23) when period resets
 * @param resetDay - Day of week (0=Sunday, 1=Monday, etc.) when weekly period resets
 * @returns Timestamp (ms) of when the next reset will occur
 */
export function getNextResetTime(
  mode: 'daily' | 'weekly',
  resetHour: number,
  resetDay?: number
): number {
  const now = new Date();

  if (mode === 'daily') {
    // Calculate today's reset time
    const todayReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      resetHour,
      0,
      0,
      0
    );

    // If we've passed today's reset, next reset is tomorrow
    if (now >= todayReset) {
      const tomorrowReset = new Date(todayReset);
      tomorrowReset.setDate(tomorrowReset.getDate() + 1);
      return tomorrowReset.getTime();
    }

    return todayReset.getTime();
  } else {
    // Weekly mode
    const targetDay = resetDay ?? 1; // Default to Monday
    const currentDay = now.getDay();

    // Calculate days until next reset day
    let daysUntilReset = (targetDay - currentDay + 7) % 7;

    // Calculate this week's potential reset time
    const thisWeekReset = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + daysUntilReset,
      resetHour,
      0,
      0,
      0
    );

    // If it's the reset day but we've passed the reset hour, or if daysUntilReset is 0,
    // we need to check if we've passed the reset time
    if (daysUntilReset === 0 && now >= thisWeekReset) {
      const nextWeekReset = new Date(thisWeekReset);
      nextWeekReset.setDate(nextWeekReset.getDate() + 7);
      return nextWeekReset.getTime();
    }

    return thisWeekReset.getTime();
  }
}

/**
 * Format a timestamp as a relative time string
 * @param timestamp - Future timestamp in milliseconds
 * @returns Formatted string like "4h 23m" or "2d 5h"
 */
export function formatRelativeResetTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = timestamp - now;

  if (diffMs <= 0) return 'now';

  const totalMinutes = Math.floor(diffMs / (1000 * 60));
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) {
    if (hours > 0) {
      return `${days}d ${hours}h`;
    }
    return `${days}d`;
  }

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${hours}h`;
  }

  return `${minutes}m`;
}

export function buildSeasonKey(year: number, seasonIndex: number): string {
  const name = dateUtils.seasonNames[seasonIndex] || 'Unknown';
  return `${year}-${name}`;
}

export function buildMonthKey(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

export function buildYearKey(year: number): string {
  return `${year}`;
}

export function buildTodayKey(date: Date = new Date()): string {
  return dateUtils.formatDate(date);
}

function parseLocalDateString(dateString: string): Date | null {
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

function hasValidCustomGoalDateRange(startDate: string, endDate: string): boolean {
  const start = parseLocalDateString(startDate);
  const end = parseLocalDateString(endDate);

  if (!start || !end) return false;

  return start.getTime() <= end.getTime();
}

function isCustomGoalClosed(
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

export function isCustomGoalDateRangeLocked(
  goal: Pick<CustomGoal, 'id' | 'startDate' | 'endDate'>,
  now = new Date()
): boolean {
  if (isCustomGoalClosed(goal, now)) return true;

  const snapshotKey = buildGoalSnapshotKey('custom', goal.id);
  return Boolean(get(_goalSnapshots)[snapshotKey]);
}

export function isDateWithinRange(dateIso: string, start: Date, end: Date): boolean {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return false;
  return date >= start && date < end;
}

export function parseSeasonKey(periodKey: string): { year: number; seasonIndex: number } | null {
  const [yearPart, seasonPart] = periodKey.split('-');
  const year = Number(yearPart);
  const seasonIndex = dateUtils.seasonNames.indexOf(seasonPart as (typeof seasonNames)[number]);
  if (!Number.isFinite(year) || seasonIndex < 0) return null;
  return { year, seasonIndex };
}

export function parseMonthKey(periodKey: string): { year: number; monthIndex: number } | null {
  const [yearPart, monthPart] = periodKey.split('-');
  const year = Number(yearPart);
  const monthIndex = Number(monthPart) - 1;
  if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return null;
  return { year, monthIndex };
}

export function parseYearKey(periodKey: string): number | null {
  const year = Number(periodKey);
  return Number.isFinite(year) ? year : null;
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

// ================================
// DEFAULT SETTINGS
// ================================

const currentYear = new Date().getFullYear();

const defaultSettings: GoalSettings = {
  volumeDeadlines: {}
};

// ================================
// STORE INITIALIZATION
// ================================

function loadGoalSettings(): GoalSettings {
  if (!browser) return defaultSettings;

  const stored = window.localStorage.getItem('goalSettings');
  if (!stored) return defaultSettings;

  try {
    const parsed = JSON.parse(stored);
    return {
      volumeDeadlines: parsed.volumeDeadlines || defaultSettings.volumeDeadlines
    };
  } catch {
    return defaultSettings;
  }
}

const _goalSettings = writable<GoalSettings>(loadGoalSettings());

// Persist to localStorage
_goalSettings.subscribe((settings) => {
  if (browser) {
    window.localStorage.setItem('goalSettings', JSON.stringify(settings));
  }
});

export const goalSettings = _goalSettings;

// ================================
// GOALS DATA (NEW MULTI-PERIOD)
// ================================

const defaultGoalsData: GoalsData = {
  targets: [
    {
      goalType: 'year',
      periodKey: buildYearKey(currentYear),
      targetVolumes: 52,
      createdAt: new Date().toISOString()
    }
  ],
  customGoals: [],
  activeSelection: { goalType: 'year', periodKey: buildYearKey(currentYear) }
};

function loadGoalsData(): GoalsData {
  if (!browser) return defaultGoalsData;

  const stored = window.localStorage.getItem('goalsData');
  if (!stored) return defaultGoalsData;

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return defaultGoalsData;

    const data = parsed as Partial<GoalsData>;
    return {
      targets: data.targets ?? defaultGoalsData.targets,
      customGoals: data.customGoals ?? defaultGoalsData.customGoals,
      activeSelection: data.activeSelection ?? defaultGoalsData.activeSelection
    };
  } catch {
    return defaultGoalsData;
  }
}

const _goalsData = writable<GoalsData>(loadGoalsData());

_goalsData.subscribe((data) => {
  if (browser) {
    window.localStorage.setItem('goalsData', JSON.stringify(data));
  }
});

export const goalsData = _goalsData;

export const goalTargets = derived(goalsData, ($data) => $data.targets);
export const customGoals = derived(goalsData, ($data) => $data.customGoals);
export const activeGoalSelection = derived(goalsData, ($data) => $data.activeSelection);

export function setGoalTarget(
  goalType: Exclude<GoalType, 'custom'>,
  periodKey: string,
  targetVolumes: number
) {
  _goalsData.update((data) => {
    const existingIndex = data.targets.findIndex(
      (goal) => goal.goalType === goalType && goal.periodKey === periodKey
    );

    const updatedTargets = [...data.targets];
    if (existingIndex >= 0) {
      updatedTargets[existingIndex] = {
        ...updatedTargets[existingIndex],
        targetVolumes
      };
    } else {
      updatedTargets.push({
        goalType,
        periodKey,
        targetVolumes,
        createdAt: new Date().toISOString()
      });
    }

    return { ...data, targets: updatedTargets };
  });
}

export function removeGoalTarget(goalType: Exclude<GoalType, 'custom'>, periodKey: string) {
  _goalsData.update((data) => {
    return {
      ...data,
      targets: data.targets.filter(
        (goal) => !(goal.goalType === goalType && goal.periodKey === periodKey)
      )
    };
  });
}

export function setActiveGoalSelection(selection: GoalSelection) {
  _goalsData.update((data) => ({ ...data, activeSelection: selection }));
}

export function createCustomGoal(goal: Omit<CustomGoal, 'id' | 'createdAt'>) {
  if (!hasValidCustomGoalDateRange(goal.startDate, goal.endDate)) return;

  _goalsData.update((data) => {
    const id = generateUUID();
    const newGoal: CustomGoal = {
      ...goal,
      id,
      createdAt: new Date().toISOString()
    };
    return {
      ...data,
      customGoals: [...data.customGoals, newGoal],
      activeSelection: { goalType: 'custom', customId: id }
    };
  });
}

export function updateCustomGoal(updatedGoal: CustomGoal) {
  if (!hasValidCustomGoalDateRange(updatedGoal.startDate, updatedGoal.endDate)) return;

  _goalsData.update((data) => ({
    ...data,
    customGoals: data.customGoals.map((goal) => {
      if (goal.id !== updatedGoal.id) return goal;

      if (!isCustomGoalDateRangeLocked(goal)) {
        return {
          ...goal,
          ...updatedGoal,
          id: goal.id,
          createdAt: goal.createdAt
        };
      }

      return {
        ...goal,
        ...updatedGoal,
        id: goal.id,
        createdAt: goal.createdAt,
        startDate: goal.startDate,
        endDate: goal.endDate
      };
    })
  }));
}

export function removeCustomGoal(customId: string) {
  _goalsData.update((data) => {
    const nextSelection: GoalSelection =
      data.activeSelection.goalType === 'custom' && data.activeSelection.customId === customId
        ? { goalType: 'year', periodKey: getCurrentPeriodKey('year') }
        : data.activeSelection;

    return {
      ...data,
      customGoals: data.customGoals.filter((goal) => goal.id !== customId),
      activeSelection: nextSelection
    };
  });
}

// ================================
// COMPLETED-AT MAP
// ================================

function loadCompletedAtMapFromVolumes(): CompletedAtMap {
  if (!browser) return {};

  const stored = window.localStorage.getItem('volumes');
  if (!stored) return {};

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return {};

    const map: CompletedAtMap = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([volumeId, value]) => {
      if (!value || typeof value !== 'object') return;
      const candidate = (value as { completedAt?: unknown }).completedAt;
      if (typeof candidate === 'string' && candidate.length > 0) {
        map[volumeId] = candidate;
      }
    });
    return map;
  } catch {
    return {};
  }
}

/**
 * Mirrors the in-memory completed-at map back into the persisted `volumes`
 * localStorage payload.
 *
 * Goal progress/snapshots read from `_completedAtMap`, but older code and
 * persisted volume records still expect each volume entry to carry its own
 * `completedAt` field. This keeps both representations aligned after we detect
 * newly completed volumes.
 */
function persistCompletedAtMapToVolumes(map: CompletedAtMap) {
  if (!browser) return;

  const stored = window.localStorage.getItem('volumes');
  if (!stored) return;

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return;

    const volumesPayload = parsed as Record<string, Record<string, unknown>>;
    Object.entries(volumesPayload).forEach(([volumeId, volumeData]) => {
      if (map[volumeId]) {
        volumesPayload[volumeId] = {
          ...volumeData,
          completedAt: map[volumeId]
        };
        return;
      }

      const { completedAt: _completedAt, ...rest } = volumeData;
      volumesPayload[volumeId] = rest;
    });

    // Persist the merged payload so completion timestamps survive reloads.
    window.localStorage.setItem('volumes', JSON.stringify(volumesPayload));
  } catch {
    // Ignore storage errors
  }
}

const _completedAtMap = writable<CompletedAtMap>(loadCompletedAtMapFromVolumes());
export const completedAtMap = derived(_completedAtMap, ($map) => $map);

function isVolumeCompleted(volumeData: VolumeData, totalPages: number): boolean {
  return volumeData.completed || (totalPages > 0 && volumeData.progress >= totalPages);
}

function shouldPreserveCompletedAt(
  volumeData: VolumeData,
  totalPages: number,
  previousCompletedAt?: string
): boolean {
  if (!previousCompletedAt) return false;

  if (isVolumeCompleted(volumeData, totalPages)) {
    return true;
  }

  if (totalPages > 0) {
    return false;
  }

  return volumeData.progress > 1;
}

function buildCompletedAtMapFromState(
  allVolumes: Record<string, VolumeData>,
  catalog: Record<string, { page_count?: number }>,
  previousMap: CompletedAtMap
): CompletedAtMap {
  const nextMap: CompletedAtMap = {};

  Object.entries(allVolumes).forEach(([volumeId, volumeData]) => {
    const totalPages = catalog[volumeId]?.page_count ?? 0;

    if (!isVolumeCompleted(volumeData, totalPages)) {
      if (shouldPreserveCompletedAt(volumeData, totalPages, previousMap[volumeId])) {
        nextMap[volumeId] = previousMap[volumeId];
      }
      return;
    }

    nextMap[volumeId] =
      previousMap[volumeId] ?? (volumeData.lastProgressUpdate || new Date().toISOString());
  });

  return nextMap;
}

function hasCompletedAtMapChanged(previousMap: CompletedAtMap, nextMap: CompletedAtMap): boolean {
  const previousEntries = Object.entries(previousMap);
  const nextEntries = Object.entries(nextMap);

  if (previousEntries.length !== nextEntries.length) return true;

  return nextEntries.some(([volumeId, completedAt]) => previousMap[volumeId] !== completedAt);
}

// Manage completion tracking with proper cleanup
const _completionTracking = readable(null, () => {
  const unsubscribe = derived([volumes, catalogVolumes], ([$volumes, $catalog]) => ({
    volumes: $volumes,
    catalog: $catalog
  })).subscribe(({ volumes: $volumes, catalog: $catalog }) => {
    if (!browser || !$volumes) return;

    let nextMap: CompletedAtMap | null = null;

    _completedAtMap.update((map) => {
      const updated = buildCompletedAtMapFromState(
        $volumes as Record<string, VolumeData>,
        $catalog as Record<string, { page_count?: number }>,
        map
      );

      if (!hasCompletedAtMapChanged(map, updated)) {
        return map;
      }

      nextMap = updated;
      return updated;
    });

    if (!nextMap) return;

    Promise.resolve().then(() => {
      persistCompletedAtMapToVolumes(nextMap as CompletedAtMap);
    });
  });

  return unsubscribe;
});

// Initialize the completion tracking subscription
if (browser) {
  _completionTracking.subscribe(() => {});
}

// ================================
// GOAL SNAPSHOTS
// ================================

type GoalSnapshots = Record<string, GoalSnapshot>;

function normalizeGoalSnapshot(snapshot: unknown): GoalSnapshot | null {
  if (!snapshot || typeof snapshot !== 'object') return null;

  const candidate = snapshot as Partial<GoalSnapshot> & {
    partialProgress?: unknown;
    completed?: unknown;
  };

  if (
    typeof candidate.goalType !== 'string' ||
    typeof candidate.periodKey !== 'string' ||
    typeof candidate.startDate !== 'string' ||
    typeof candidate.endDate !== 'string' ||
    typeof candidate.closedAt !== 'string'
  ) {
    return null;
  }

  const completed =
    candidate.completed && typeof candidate.completed === 'object'
      ? Object.fromEntries(
          Object.entries(candidate.completed).filter(
            ([volumeId, completedAt]) =>
              typeof volumeId === 'string' && typeof completedAt === 'string'
          )
        )
      : {};

  const partialProgress =
    candidate.partialProgress && typeof candidate.partialProgress === 'object'
      ? Object.fromEntries(
          Object.entries(candidate.partialProgress).filter(
            ([volumeId, progress]) =>
              typeof volumeId === 'string' &&
              typeof progress === 'number' &&
              Number.isFinite(progress) &&
              progress > 0
          )
        )
      : {};

  return {
    goalType: candidate.goalType as GoalType,
    periodKey: candidate.periodKey,
    startDate: candidate.startDate,
    endDate: candidate.endDate,
    closedAt: candidate.closedAt,
    completed,
    partialProgress
  };
}

function loadGoalSnapshots(): GoalSnapshots {
  if (!browser) return {};

  const stored = window.localStorage.getItem('goalSnapshots');
  if (!stored) return {};

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return {};

    return Object.fromEntries(
      Object.entries(parsed).flatMap(([snapshotKey, snapshotValue]) => {
        const normalized = normalizeGoalSnapshot(snapshotValue);
        return normalized ? [[snapshotKey, normalized]] : [];
      })
    );
  } catch {
    return {};
  }
}

const _goalSnapshots = writable<GoalSnapshots>(loadGoalSnapshots());

_goalSnapshots.subscribe((snapshots) => {
  if (browser) {
    window.localStorage.setItem('goalSnapshots', JSON.stringify(snapshots));
  }
});

export const goalSnapshots = _goalSnapshots;

export function buildGoalSnapshotKey(goalType: GoalType, periodKey: string): string {
  return `${goalType}:${periodKey}`;
}

export function createSnapshotForPeriod(
  goalType: GoalType,
  periodKey: string,
  start: Date,
  end: Date
): GoalSnapshot {
  const completed: Record<string, string> = {};
  const partialProgress: Record<string, number> = {};
  const completedAtMap = get(_completedAtMap);
  const allVolumes = get(volumes);
  const catalog = get(catalogVolumes);

  Object.entries(completedAtMap).forEach(([volumeId, completedAt]) => {
    if (completedAt && isDateWithinRange(completedAt, start, end)) {
      completed[volumeId] = completedAt;
    }
  });

  Object.entries(allVolumes ?? {}).forEach(([volumeId, volumeData]) => {
    if (completed[volumeId]) return;

    const totalPages = catalog[volumeId]?.page_count ?? 0;
    if (totalPages <= 0) return;

    const partial = calculatePartialVolumeProgressInPeriod(
      (volumeData as VolumeData).recentPageTurns,
      start,
      end,
      totalPages
    );

    if (partial > 0) {
      partialProgress[volumeId] = partial;
    }
  });

  return {
    goalType,
    periodKey,
    startDate: dateUtils.formatDate(start),
    endDate: dateUtils.formatDate(end),
    closedAt: new Date().toISOString(),
    completed,
    partialProgress
  };
}

export function finalizeGoalSnapshot(
  goalType: GoalType,
  periodKey: string,
  start: Date,
  end: Date
) {
  const snapshotKey = buildGoalSnapshotKey(goalType, periodKey);

  _goalSnapshots.update((snapshots) => {
    if (snapshots[snapshotKey]) return snapshots;

    return {
      ...snapshots,
      [snapshotKey]: createSnapshotForPeriod(goalType, periodKey, start, end)
    };
  });
}

export function finalizeClosedGoalSnapshots() {
  // TODO: This must be finalized from store/app lifecycle, not only from a view mount.
  // Historical goal progress depends on these snapshots being created as soon as a
  // period closes; if this runs only after `ProgressTrackerView` is opened, past-period
  // results can drift based on later volume changes instead of staying frozen.
  const now = new Date();
  const { targets, customGoals: custom } = get(_goalsData);
  const snapshots = get(_goalSnapshots);

  targets.forEach((target) => {
    const period = getPeriodForSelection({
      goalType: target.goalType,
      periodKey: target.periodKey
    });
    if (!period) return;
    if (period.end.getTime() > now.getTime()) return;
    const snapshotKey = buildGoalSnapshotKey(period.goalType, period.periodKey);
    if (snapshots[snapshotKey]) return;
    finalizeGoalSnapshot(period.goalType, period.periodKey, period.start, period.end);
  });

  custom.forEach((goal) => {
    if (!goal.enabled) return;
    const selection: GoalSelection = { goalType: 'custom', customId: goal.id };
    const period = getCustomPeriod(selection, custom);
    if (!period) return;
    if (period.end.getTime() > now.getTime()) return;
    const snapshotKey = buildGoalSnapshotKey('custom', goal.id);
    if (snapshots[snapshotKey]) return;
    finalizeGoalSnapshot('custom', goal.id, period.start, period.end);
  });
}

// ================================
// ACTIVE GOAL PROGRESS
// ================================

export type GoalProgress = {
  title: string;
  targetVolumes: number;
  completedVolumes: number;
  inProgressVolumes: number;
  totalProgress: number;
  progressPercent: number;
  expectedProgressPercent: number;
  status: 'ahead' | 'on-track' | 'behind' | 'far-behind';
  pagesPerDayForGoal: number;
  daysRemaining: number;
  periodLabel: string;
  isClosed: boolean;
};

function getTargetForSelection(
  selection: GoalSelection,
  targets: GoalTarget[],
  custom: CustomGoal[]
): number {
  if (selection.goalType === 'custom') {
    return custom.find((goal) => goal.id === selection.customId)?.targetVolumes ?? 0;
  }

  return (
    targets.find(
      (goal) => goal.goalType === selection.goalType && goal.periodKey === selection.periodKey
    )?.targetVolumes ?? 0
  );
}

function getCustomPeriod(selection: GoalSelection, custom: CustomGoal[]): GoalPeriod | null {
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

function getExpectedProgressPercent(periodStart: Date, periodEnd: Date, now = new Date()): number {
  const totalMs = periodEnd.getTime() - periodStart.getTime();
  if (totalMs <= 0) return 0;
  const elapsedMs = Math.min(Math.max(now.getTime() - periodStart.getTime(), 0), totalMs);
  return (elapsedMs / totalMs) * 100;
}

function getDaysRemainingInPeriod(periodEnd: Date, now = new Date()): number {
  const endMidnight = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), periodEnd.getDate());
  const startMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffInMs = endMidnight.getTime() - startMidnight.getTime();
  return Math.max(0, Math.round(diffInMs / (1000 * 60 * 60 * 24)));
}

export function calculatePartialVolumeProgressInPeriod(
  pageTurns: PageTurn[],
  periodStart: Date,
  periodEnd: Date,
  totalPages: number
): number {
  if (totalPages <= 0 || pageTurns.length === 0) return 0;

  const periodStartTimestamp = periodStart.getTime();
  const periodEndTimestamp = periodEnd.getTime();
  const uniquePagesRead = new Set(
    pageTurns
      .filter(([timestamp]) => timestamp >= periodStartTimestamp && timestamp < periodEndTimestamp)
      .map(([, pageNumber]) => pageNumber)
  ).size;

  if (uniquePagesRead <= 0) return 0;

  return Math.min(uniquePagesRead, totalPages) / totalPages;
}

export const activeGoalProgress = derived(
  [
    activeGoalSelection,
    goalTargets,
    customGoals,
    volumes,
    catalogVolumes,
    goalSnapshots,
    completedAtMap
  ],
  ([
    $selection,
    $targets,
    $customGoals,
    $volumes,
    $catalog,
    $snapshots,
    $completedAtMap
  ]): GoalProgress => {
    const now = new Date();
    const period =
      $selection.goalType === 'custom'
        ? getCustomPeriod($selection, $customGoals)
        : getPeriodForSelection($selection);

    const targetVolumes = getTargetForSelection($selection, $targets, $customGoals) || 0;

    if (!period) {
      return {
        title: 'Reading Goal',
        targetVolumes,
        completedVolumes: 0,
        inProgressVolumes: 0,
        totalProgress: 0,
        progressPercent: 0,
        expectedProgressPercent: 0,
        status: 'behind',
        pagesPerDayForGoal: 0,
        daysRemaining: 0,
        periodLabel: 'Unknown period',
        isClosed: false
      };
    }

    const isClosed = period.end.getTime() <= now.getTime();
    const snapshotKey = buildGoalSnapshotKey(period.goalType, period.periodKey);
    const snapshot = isClosed ? $snapshots[snapshotKey] : null;

    let completedVolumes = 0;
    let inProgressVolumes = 0;
    let totalPartialProgress = 0;
    let totalRemainingPages = 0;

    if (snapshot) {
      completedVolumes = Object.keys(snapshot.completed).length;
      const snapshotPartialProgress = Object.values(snapshot.partialProgress ?? {});
      inProgressVolumes = snapshotPartialProgress.length;
      totalPartialProgress = snapshotPartialProgress.reduce(
        (total, progress) => total + progress,
        0
      );
    } else if ($volumes) {
      Object.entries($volumes).forEach(([volumeId, volumeData]) => {
        const catalogVolume = $catalog[volumeId];
        const totalPages = catalogVolume?.page_count ?? 0;
        const typedVolumeData = volumeData as VolumeData;
        const currentPage = typedVolumeData.progress ?? 0;
        const completedAt = $completedAtMap[volumeId];

        if (completedAt && isDateWithinRange(completedAt, period.start, period.end)) {
          completedVolumes++;
          return;
        }

        if (currentPage > 1 && totalPages > 0) {
          const partialProgress = calculatePartialVolumeProgressInPeriod(
            typedVolumeData.recentPageTurns,
            period.start,
            period.end,
            totalPages
          );

          if (partialProgress > 0) {
            inProgressVolumes++;
            totalPartialProgress += partialProgress;
            totalRemainingPages += totalPages - currentPage;
          }
        }
      });
    }

    const totalProgress = completedVolumes + totalPartialProgress;
    const progressPercent = targetVolumes > 0 ? (totalProgress / targetVolumes) * 100 : 0;

    const expectedProgressPercent = getExpectedProgressPercent(period.start, period.end, now);
    const daysRemaining = getDaysRemainingInPeriod(period.end, now);

    const remainingVolumeEquivalent = Math.max(0, targetVolumes - totalProgress);
    const avgPagesPerVolume =
      totalRemainingPages > 0 && inProgressVolumes > 0
        ? totalRemainingPages / inProgressVolumes
        : 200;
    const estimatedRemainingPages = remainingVolumeEquivalent * avgPagesPerVolume;
    const pagesPerDayForGoal =
      daysRemaining > 0 ? Math.ceil(estimatedRemainingPages / daysRemaining) : 0;

    const progressRatio =
      expectedProgressPercent > 0
        ? progressPercent / expectedProgressPercent
        : progressPercent > 0
          ? 2
          : 1;

    let status: 'ahead' | 'on-track' | 'behind' | 'far-behind';
    if (progressRatio >= 1.1) {
      status = 'ahead';
    } else if (progressRatio >= 0.9) {
      status = 'on-track';
    } else if (progressRatio >= 0.5) {
      status = 'behind';
    } else {
      status = 'far-behind';
    }

    return {
      title: 'Reading Goal',
      targetVolumes,
      completedVolumes,
      inProgressVolumes,
      totalProgress,
      progressPercent,
      expectedProgressPercent,
      status,
      pagesPerDayForGoal,
      daysRemaining,
      periodLabel: period.label,
      isClosed
    };
  }
);

export const activeGoalPeriod = derived(
  [activeGoalSelection, customGoals],
  ([$selection, $customGoals]) => {
    return $selection.goalType === 'custom'
      ? getCustomPeriod($selection, $customGoals)
      : getPeriodForSelection($selection);
  }
);

export const activeGoalSnapshot = derived(
  [activeGoalPeriod, goalSnapshots],
  ([$period, $snapshots]) => {
    if (!$period) return null;
    const key = buildGoalSnapshotKey($period.goalType, $period.periodKey);
    return $snapshots[key] ?? null;
  }
);

// ================================
// VOLUME DEADLINE FUNCTIONS
// ================================

/**
 * Get the deadline for a specific volume
 */
export function getVolumeDeadline(volumeId: string): string | null {
  const settings = get(_goalSettings);
  return settings.volumeDeadlines[volumeId] || null;
}

/**
 * Set a deadline for a specific volume
 */
export function setVolumeDeadline(volumeId: string, deadline: string) {
  _goalSettings.update((settings) => {
    return {
      ...settings,
      volumeDeadlines: {
        ...settings.volumeDeadlines,
        [volumeId]: deadline
      }
    };
  });
}

/**
 * Remove the deadline for a specific volume
 */
export function removeVolumeDeadline(volumeId: string) {
  _goalSettings.update((settings) => {
    const { [volumeId]: _, ...rest } = settings.volumeDeadlines;
    return {
      ...settings,
      volumeDeadlines: rest
    };
  });
}

/**
 * Calculate the fixed total page target for the current reading period.
 *
 * This returns the total target for the whole daily/weekly period, including
 * pages already read in the current period. As a result, the value stays the
 * same while the user makes progress during that period. To show how many pages
 * are left to read before the next reset, subtract `pagesReadInCurrentPeriod`
 * from this total.
 *
 * Example: if the period target is 30 pages and the user has already read 12,
 * this function still returns 30; the remaining pages for the period is 18.
 *
 * @param remainingPages - Total unread pages still left in the volume
 * @param deadline - Deadline date string (YYYY-MM-DD) or null
 * @param mode - 'daily' or 'weekly'
 * @param pagesReadInCurrentPeriod - Pages read since the current period started
 * @param periodStartTimestamp - Timestamp when the current period started
 * @returns Fixed total page target for the period, or null if no deadline
 */
export function calculatePeriodPageTargetTotal(
  remainingPages: number,
  deadline: string | null,
  mode: 'daily' | 'weekly',
  pagesReadInCurrentPeriod: number,
  periodStartTimestamp: number
): number | null {
  if (!deadline || remainingPages <= 0) return null;

  const pagesStillNeeded = Math.max(0, remainingPages);

  // Count the deadline day as an available reading day, so a deadline of
  // tomorrow in daily mode means there are two daily periods remaining:
  // today and tomorrow.
  const periodStart = new Date(periodStartTimestamp);
  const deadlineParts = deadline.split('-').map(Number);
  const deadlineInclusiveEnd = new Date(
    deadlineParts[0],
    deadlineParts[1] - 1,
    deadlineParts[2] + 1
  );

  const msPerPeriod = mode === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const msUntilDeadlineInclusive = deadlineInclusiveEnd.getTime() - periodStart.getTime();
  const periodsRemainingIncludingCurrent = Math.max(
    1,
    Math.ceil(msUntilDeadlineInclusive / msPerPeriod)
  );

  return Math.ceil(
    (pagesReadInCurrentPeriod + pagesStillNeeded) / periodsRemainingIncludingCurrent
  );
}

/**
 * Derived store with deadline info for each volume
 */
export const volumeDeadlines = derived(goalSettings, ($settings) => {
  return $settings.volumeDeadlines;
});
