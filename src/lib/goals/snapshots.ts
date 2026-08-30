import { get } from 'svelte/store';
import { volumes } from '../settings/volume-data';
import { volumes as catalogVolumes } from '$lib/catalog';
import { _completedAtMap } from './completed-at';
import { dateUtils } from './date-utils';
import { calculatePartialVolumeProgressInPeriod } from './goal-math';
import { isDateWithinRange } from './periods';
import { _goalSnapshots, buildGoalSnapshotKey } from './snapshots-store';
import type { GoalSnapshot, GoalType } from './types';

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
  const catalog = get(catalogVolumes) ?? {};

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

  const closedAt = new Date().toISOString();
  return {
    goalType,
    periodKey,
    startDate: dateUtils.formatDate(start),
    endDate: dateUtils.formatDate(end),
    closedAt,
    completed,
    partialProgress,
    lastUpdated: closedAt
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
