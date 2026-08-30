import { get } from 'svelte/store';
import { volumes } from '../settings/volume-data';
// Placeholders included, for the same reason `active-progress` uses them: a
// volume read on another device and never downloaded here has no catalog row,
// and a snapshot is permanent — undercounting one is not recoverable.
import { volumesWithPlaceholders as catalogVolumes } from '$lib/catalog';
import { completionEventsFor } from './completed-at';
import { dateUtils } from './date-utils';
import { partialProgressInPeriod } from './goal-counting';
import { isDateWithinRange } from './periods';
import { _goalSnapshots, buildGoalSnapshotKey } from './snapshots-store';
import type { GoalSnapshot, GoalType } from './types';

/**
 * Freeze what a closed period counted.
 *
 * Uses the SAME rules as the live total (`goal-counting.ts`), so a period's
 * number does not change the moment it closes and the UI switches from the
 * live branch to this snapshot. The two used to differ — the live branch
 * additionally required `currentPage > 1` before granting partial credit — and
 * the discrepancy was baked in permanently, because nothing ever rewrites a
 * snapshot.
 */
export function createSnapshotForPeriod(
  goalType: GoalType,
  periodKey: string,
  start: Date,
  end: Date
): GoalSnapshot {
  const completed: Record<string, string> = {};
  const partialProgress: Record<string, number> = {};
  const allVolumes = get(volumes) ?? {};
  const catalog = get(catalogVolumes) ?? {};
  const now = Date.now();

  Object.entries(allVolumes).forEach(([volumeId, volumeData]) => {
    // Archived passes count too, dated when the pass finished. One stamp per
    // volume: a volume finished twice in the period keeps the FIRST. The map is
    // "which volumes were finished here", and its size is exactly what the live
    // header counts (`isCompletedInPeriod`, one per volume) — the two units
    // have to match or the number changes when the period closes.
    const inPeriod = completionEventsFor(volumeData, now)
      .filter((stamp) => isDateWithinRange(stamp, start, end))
      .sort();

    if (inPeriod.length > 0) {
      completed[volumeId] = inPeriod[0];
      return;
    }

    const partial = partialProgressInPeriod(
      volumeData,
      catalog[volumeId]?.page_count ?? 0,
      start,
      end
    );
    if (partial > 0) partialProgress[volumeId] = partial;
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
