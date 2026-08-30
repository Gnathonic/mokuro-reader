import { derived } from 'svelte/store';
import { volumes } from '../settings/volume-data';
// `volumesWithPlaceholders`, not `volumes`: the plain catalog store holds only
// rows this device has. A volume read to the end on the phone and never
// downloaded here has no row, so its page count read as 0 and it earned no
// goal credit at all. Placeholders carry the page counts from `series.json`.
import { volumesWithPlaceholders as catalogVolumes } from '$lib/catalog';
import { completionsInPeriod, partialProgressInPeriod } from './goal-counting';
import { customGoals, activeGoalSelection, goalTargets } from './goals-data';
import { getDaysRemainingInPeriod, getExpectedProgressPercent } from './goal-math';
import { getCustomPeriod, getPeriodForSelection } from './periods';
import { buildGoalSnapshotKey, goalSnapshots } from './snapshots-store';
import type { CustomGoal, GoalProgress, GoalSelection, GoalTarget } from './types';

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
    const catalog = $catalog ?? {};

    if (snapshot) {
      completedVolumes = Object.keys(snapshot.completed).length;
      const snapshotPartialProgress = Object.values(snapshot.partialProgress ?? {});
      inProgressVolumes = snapshotPartialProgress.length;
      totalPartialProgress = snapshotPartialProgress.reduce(
        (total, progress) => total + progress,
        0
      );
    } else if ($volumes) {
      const nowMs = now.getTime();

      Object.entries($volumes).forEach(([volumeId, volumeData]) => {
        const totalPages = catalog[volumeId]?.page_count ?? 0;
        const currentPage = volumeData.progress ?? 0;

        // A volume finished more than once in the period (read, restarted,
        // read again) counts once per pass — that is what "volumes read this
        // year" means.
        const completions = completionsInPeriod(volumeData, period.start, period.end, nowMs);
        if (completions > 0) {
          completedVolumes += completions;
          return;
        }

        const partialProgress = partialProgressInPeriod(
          volumeData,
          totalPages,
          period.start,
          period.end
        );

        if (partialProgress > 0) {
          inProgressVolumes += 1;
          totalPartialProgress += partialProgress;
          totalRemainingPages += Math.max(0, totalPages - currentPage);
        }
      });
    }

    const totalProgress = completedVolumes + totalPartialProgress;
    const progressPercent = targetVolumes > 0 ? (totalProgress / targetVolumes) * 100 : 0;

    const expectedProgressPercent = getExpectedProgressPercent(period.start, period.end, now);
    const daysRemaining = getDaysRemainingInPeriod(period.end, now);

    // `pagesPerDayForGoal`: volumes still needed, times the average length of
    // what is actually in progress. The 200-page fallback is a guess, and this
    // is not rendered anywhere today — it stays because the type is public, but
    // do not put it on screen without replacing the fallback with a real
    // catalog-wide average.
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

    let status: GoalProgress['status'];
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
