import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import { volumes } from '../settings/volume-data';
import { volumes as catalogVolumes } from '$lib/catalog';
import { _completedAtMap } from './completed-at';
import { dateUtils } from './date-utils';
import { calculatePartialVolumeProgressInPeriod } from './goal-math';
import { isCustomGoalClosed, isDateWithinRange } from './periods';
import type { CustomGoal, GoalSnapshot, GoalType } from './types';

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

export const _goalSnapshots = writable<GoalSnapshots>(loadGoalSnapshots());

_goalSnapshots.subscribe((snapshots) => {
  if (browser) {
    window.localStorage.setItem('goalSnapshots', JSON.stringify(snapshots));
  }
});

export const goalSnapshots = _goalSnapshots;

export function buildGoalSnapshotKey(goalType: GoalType, periodKey: string): string {
  return `${goalType}:${periodKey}`;
}

export function isCustomGoalDateRangeLocked(
  goal: Pick<CustomGoal, 'id' | 'startDate' | 'endDate'>,
  now = new Date()
): boolean {
  if (isCustomGoalClosed(goal, now)) return true;

  const snapshotKey = buildGoalSnapshotKey('custom', goal.id);
  return Boolean(get(_goalSnapshots)[snapshotKey]);
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
      volumeData.recentPageTurns,
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
