import { browser } from '$app/environment';
import { writable, derived, get } from 'svelte/store';
import { volumes, type VolumeData } from './volume-data';
import { volumes as catalogVolumes } from '$lib/catalog';

// ================================
// TYPES
// ================================

export type AnnualGoal = {
  year: number;
  targetVolumes: number;
};

export type GoalType = 'year' | 'season' | 'month' | 'today' | 'custom';

export type GoalDefinition = {
  id: string;
  type: GoalType;
  name?: string;
  targetVolumes: number;
  enabled: boolean;
  // For custom goals only (YYYY-MM-DD, local date)
  startDate?: string;
  endDate?: string;
};

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
};

type CompletedAtMap = Record<string, string>;

export type VolumeDeadline = {
  volumeId: string;
  deadline: string; // ISO date string (YYYY-MM-DD)
};

export type GoalSettings = {
  annualGoals: AnnualGoal[];
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

  seasonRange: (year: number, seasonIndex: number): { start: Date; end: Date } => {
    const start = new Date(year, seasonIndex * 3, 1);
    const end = new Date(year, seasonIndex * 3 + 3, 1);
    return { start, end };
  },

  monthRange: (year: number, monthIndex: number): { start: Date; end: Date } => {
    const start = new Date(year, monthIndex, 1);
    const end = new Date(year, monthIndex + 1, 1);
    return { start, end };
  }
};

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
  annualGoals: [
    {
      year: currentYear,
      targetVolumes: 52 // Default: 1 volume per week
    }
  ],
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
      annualGoals: parsed.annualGoals || defaultSettings.annualGoals,
      volumeDeadlines: parsed.volumeDeadlines || defaultSettings.volumeDeadlines
    };
  } catch {
    return defaultSettings;
  }
}

const _goalSettings = writable<GoalSettings>(loadGoalSettings());

const GOAL_SETTINGS_UPDATED_AT_KEY = 'goalSettingsUpdatedAt';
const GOALS_DATA_UPDATED_AT_KEY = 'goalsDataUpdatedAt';
const GOAL_SNAPSHOTS_UPDATED_AT_KEY = 'goalSnapshotsUpdatedAt';
const COMPLETED_AT_UPDATED_AT_KEY = 'completedAtUpdatedAt';

function getStoredUpdatedAt(key: string): string {
  if (!browser) return new Date(0).toISOString();
  return window.localStorage.getItem(key) || new Date(0).toISOString();
}

// Persist to localStorage
_goalSettings.subscribe((settings) => {
  if (browser) {
    window.localStorage.setItem('goalSettings', JSON.stringify(settings));
    window.localStorage.setItem(GOAL_SETTINGS_UPDATED_AT_KEY, new Date().toISOString());
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
    window.localStorage.setItem(GOALS_DATA_UPDATED_AT_KEY, new Date().toISOString());
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
  _goalsData.update((data) => {
    const cryptoApi = ensureCrypto();
    const id = cryptoApi?.randomUUID?.() ?? `custom-${Date.now()}`;
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
  _goalsData.update((data) => ({
    ...data,
    customGoals: data.customGoals.map((goal) => (goal.id === updatedGoal.id ? updatedGoal : goal))
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
// COMPLETED-AT MAP (LOCAL ONLY)
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

function persistCompletedAtMapToVolumes(map: CompletedAtMap) {
  if (!browser) return;

  const stored = window.localStorage.getItem('volumes');
  if (!stored) return;

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return;

    const volumesPayload = parsed as Record<string, Record<string, unknown>>;
    Object.entries(map).forEach(([volumeId, completedAt]) => {
      if (!volumesPayload[volumeId]) return;
      volumesPayload[volumeId] = {
        ...volumesPayload[volumeId],
        completedAt
      };
    });

    window.localStorage.setItem('volumes', JSON.stringify(volumesPayload));
    window.localStorage.setItem(COMPLETED_AT_UPDATED_AT_KEY, new Date().toISOString());
  } catch {
    // Ignore storage errors
  }
}

function ensureCrypto(): Crypto | null {
  if (typeof crypto !== 'undefined') return crypto;
  return null;
}

const _completedAtMap = writable<CompletedAtMap>(loadCompletedAtMapFromVolumes());
export const completedAtMap = derived(_completedAtMap, ($map) => $map);

function isVolumeCompleted(volumeData: VolumeData, totalPages: number): boolean {
  return volumeData.completed || (totalPages > 0 && volumeData.progress >= totalPages);
}

derived([volumes, catalogVolumes], ([$volumes, $catalog]) => ({
  volumes: $volumes,
  catalog: $catalog
})).subscribe(({ volumes: $volumes, catalog: $catalog }) => {
  if (!browser || !$volumes) return;

  let nextMap: CompletedAtMap | null = null;

  _completedAtMap.update((map) => {
    let updated = map;

    Object.entries($volumes).forEach(([volumeId, volumeData]) => {
      if (map[volumeId]) return;

      const totalPages = $catalog[volumeId]?.page_count ?? 0;
      if (!isVolumeCompleted(volumeData as VolumeData, totalPages)) return;

      if (updated === map) {
        updated = { ...map };
      }

      updated[volumeId] = volumeData.lastProgressUpdate || new Date().toISOString();
    });

    nextMap = updated;
    return updated;
  });

  if (!nextMap) return;

  Promise.resolve().then(() => {
    persistCompletedAtMapToVolumes(nextMap as CompletedAtMap);
  });
});

// ================================
// GOAL SNAPSHOTS (CLOSED PERIODS)
// ================================

type GoalSnapshots = Record<string, GoalSnapshot>;

function loadGoalSnapshots(): GoalSnapshots {
  if (!browser) return {};

  const stored = window.localStorage.getItem('goalSnapshots');
  if (!stored) return {};

  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const _goalSnapshots = writable<GoalSnapshots>(loadGoalSnapshots());

_goalSnapshots.subscribe((snapshots) => {
  if (browser) {
    window.localStorage.setItem('goalSnapshots', JSON.stringify(snapshots));
    window.localStorage.setItem(GOAL_SNAPSHOTS_UPDATED_AT_KEY, new Date().toISOString());
  }
});

export const goalSnapshots = _goalSnapshots;

export function getGoalSettingsUpdatedAt(): string {
  return getStoredUpdatedAt(GOAL_SETTINGS_UPDATED_AT_KEY);
}

export function getGoalsDataUpdatedAt(): string {
  return getStoredUpdatedAt(GOALS_DATA_UPDATED_AT_KEY);
}

export function getGoalSnapshotsUpdatedAt(): string {
  return getStoredUpdatedAt(GOAL_SNAPSHOTS_UPDATED_AT_KEY);
}

export function getCompletedAtUpdatedAt(): string {
  return getStoredUpdatedAt(COMPLETED_AT_UPDATED_AT_KEY);
}

export function setGoalSettingsFromSync(settings: GoalSettings, updatedAt: string) {
  _goalSettings.set(settings);
  if (browser) {
    window.localStorage.setItem('goalSettings', JSON.stringify(settings));
    window.localStorage.setItem(GOAL_SETTINGS_UPDATED_AT_KEY, updatedAt);
  }
}

export function setGoalsDataFromSync(data: GoalsData, updatedAt: string) {
  _goalsData.set(data);
  if (browser) {
    window.localStorage.setItem('goalsData', JSON.stringify(data));
    window.localStorage.setItem(GOALS_DATA_UPDATED_AT_KEY, updatedAt);
  }
}

export function setGoalSnapshotsFromSync(snapshots: GoalSnapshots, updatedAt: string) {
  _goalSnapshots.set(snapshots);
  if (browser) {
    window.localStorage.setItem('goalSnapshots', JSON.stringify(snapshots));
    window.localStorage.setItem(GOAL_SNAPSHOTS_UPDATED_AT_KEY, updatedAt);
  }
}

export function mergeCompletedAtMapFromSync(map: CompletedAtMap, updatedAt: string) {
  _completedAtMap.update((current) => {
    const merged = { ...current };
    Object.entries(map).forEach(([volumeId, completedAt]) => {
      if (!completedAt) return;
      const existing = merged[volumeId];
      if (!existing) {
        merged[volumeId] = completedAt;
        return;
      }
      const existingTime = new Date(existing).getTime();
      const incomingTime = new Date(completedAt).getTime();
      if (
        !Number.isNaN(incomingTime) &&
        (Number.isNaN(existingTime) || incomingTime < existingTime)
      ) {
        merged[volumeId] = completedAt;
      }
    });
    return merged;
  });

  if (browser) {
    window.localStorage.setItem(COMPLETED_AT_UPDATED_AT_KEY, updatedAt);
    const snapshot = get(_completedAtMap);
    persistCompletedAtMapToVolumes(snapshot);
  }
}

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
  const completedAtMap = get(_completedAtMap);

  Object.entries(completedAtMap).forEach(([volumeId, completedAt]) => {
    if (completedAt && isDateWithinRange(completedAt, start, end)) {
      completed[volumeId] = completedAt;
    }
  });

  return {
    goalType,
    periodKey,
    startDate: dateUtils.formatDate(start),
    endDate: dateUtils.formatDate(end),
    closedAt: new Date().toISOString(),
    completed
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

  const [startYear, startMonth, startDay] = goal.startDate.split('-').map(Number);
  const [endYear, endMonth, endDay] = goal.endDate.split('-').map(Number);
  if (!startYear || !startMonth || !startDay || !endYear || !endMonth || !endDay) return null;

  const start = new Date(startYear, startMonth - 1, startDay);
  const end = new Date(endYear, endMonth - 1, endDay + 1);
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

export const activeGoalProgress = derived(
  [activeGoalSelection, goalTargets, customGoals, volumes, catalogVolumes, goalSnapshots],
  ([$selection, $targets, $customGoals, $volumes, $catalog, $snapshots]): GoalProgress => {
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
    } else if ($volumes) {
      const completedAtMap = get(_completedAtMap);
      Object.entries($volumes).forEach(([volumeId, volumeData]) => {
        const catalogVolume = $catalog[volumeId];
        const totalPages = catalogVolume?.page_count ?? 0;
        const currentPage = (volumeData as VolumeData).progress ?? 0;
        const completedAt = completedAtMap[volumeId];

        if (completedAt && isDateWithinRange(completedAt, period.start, period.end)) {
          completedVolumes++;
          return;
        }

        if (currentPage > 1 && totalPages > 0) {
          const lastUpdate = (volumeData as VolumeData).lastProgressUpdate;
          if (lastUpdate && isDateWithinRange(lastUpdate, period.start, period.end)) {
            inProgressVolumes++;
            totalPartialProgress += currentPage / totalPages;
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
// ANNUAL GOAL FUNCTIONS
// ================================

/**
 * Get the annual goal for a specific year
 */
export function getAnnualGoal(year: number = new Date().getFullYear()): number {
  const settings = get(_goalSettings);
  const goal = settings.annualGoals.find((g) => g.year === year);
  return goal?.targetVolumes ?? 52;
}

/**
 * Set the annual goal for a specific year
 */
export function setAnnualGoal(targetVolumes: number, year: number = new Date().getFullYear()) {
  _goalSettings.update((settings) => {
    const existingIndex = settings.annualGoals.findIndex((g) => g.year === year);

    const updatedGoals = [...settings.annualGoals];
    if (existingIndex >= 0) {
      updatedGoals[existingIndex] = { ...updatedGoals[existingIndex], targetVolumes };
    } else {
      updatedGoals.push({ year, targetVolumes });
    }

    return { ...settings, annualGoals: updatedGoals };
  });
}

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
 * Calculate pages per day needed to meet a deadline
 */
export function calculatePagesPerDay(
  remainingPages: number,
  deadline: string | null
): number | null {
  if (!deadline || remainingPages <= 0) return null;

  const daysRemaining = dateUtils.calculateDaysRemaining(deadline);
  if (daysRemaining <= 0) return remainingPages; // All pages today!

  return Math.ceil(remainingPages / daysRemaining);
}

// ================================
// DERIVED STORES
// ================================

/**
 * Derived store with deadline info for each volume
 */
export const volumeDeadlines = derived(goalSettings, ($settings) => {
  return $settings.volumeDeadlines;
});

/**
 * Derived store for current year's annual goal
 */
export const currentAnnualGoal = derived(goalSettings, ($settings) => {
  const year = new Date().getFullYear();
  const goal = $settings.annualGoals.find((g) => g.year === year);
  return goal?.targetVolumes ?? 52;
});

export type AnnualGoalProgress = {
  targetVolumes: number;
  completedVolumes: number;
  inProgressVolumes: number;
  totalProgress: number; // Completed + partial progress from in-progress volumes
  progressPercent: number;
  expectedProgressPercent: number;
  status: 'ahead' | 'on-track' | 'behind' | 'far-behind';
  pagesPerDayForGoal: number;
  daysRemaining: number;
};

/**
 * Derived store that calculates annual goal progress
 */
export const annualGoalProgress = derived(
  [goalSettings, volumes, catalogVolumes],
  ([$settings, $volumes, $catalogVolumes]): AnnualGoalProgress => {
    const year = new Date().getFullYear();
    const today = new Date();
    const goal = $settings.annualGoals.find((g: AnnualGoal) => g.year === year);
    const targetVolumes = goal?.targetVolumes ?? 52;

    let completedVolumes = 0;
    let inProgressVolumes = 0;
    let totalPartialProgress = 0;
    let totalRemainingPages = 0;

    if ($volumes) {
      Object.entries($volumes).forEach(([volumeId, volumeData]) => {
        const catalogVolume = $catalogVolumes[volumeId];
        const totalPages = catalogVolume?.page_count ?? 0;
        const currentPage = (volumeData as VolumeData).progress ?? 0;

        if ((volumeData as VolumeData).completed || (totalPages > 0 && currentPage >= totalPages)) {
          completedVolumes++;
        } else if (currentPage > 1 && totalPages > 0) {
          // In progress (page 1 counts as not started)
          inProgressVolumes++;
          totalPartialProgress += currentPage / totalPages;
          totalRemainingPages += totalPages - currentPage;
        }
      });
    }

    const totalProgress = completedVolumes + totalPartialProgress;
    const progressPercent = targetVolumes > 0 ? (totalProgress / targetVolumes) * 100 : 0;

    const daysIntoYear = dateUtils.daysIntoYear(today);
    const totalDays = dateUtils.daysInYear(today);
    const expectedProgressPercent = (daysIntoYear / totalDays) * 100;

    const daysRemaining = dateUtils.calculateDaysRemaining(dateUtils.endOfYear(year));

    // Calculate pages per day needed to hit goal
    // Remaining volumes needed = targetVolumes - completedVolumes - partial progress
    const remainingVolumeEquivalent = Math.max(0, targetVolumes - totalProgress);
    // Estimate average pages per volume (rough estimate)
    const avgPagesPerVolume =
      totalRemainingPages > 0 && inProgressVolumes > 0
        ? totalRemainingPages / inProgressVolumes
        : 200; // Default estimate

    const estimatedRemainingPages = remainingVolumeEquivalent * avgPagesPerVolume;
    const pagesPerDayForGoal =
      daysRemaining > 0 ? Math.ceil(estimatedRemainingPages / daysRemaining) : 0;

    // Determine status based on how close we are to expected progress
    const progressRatio =
      expectedProgressPercent > 0
        ? progressPercent / expectedProgressPercent
        : progressPercent > 0
          ? 2
          : 1; // If early in year, any progress is "ahead"

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
      targetVolumes,
      completedVolumes,
      inProgressVolumes,
      totalProgress,
      progressPercent,
      expectedProgressPercent,
      status,
      pagesPerDayForGoal,
      daysRemaining
    };
  }
);
