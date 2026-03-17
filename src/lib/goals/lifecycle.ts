import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { currentView, type View } from '$lib/util/hash-router';
import { _goalsData } from './goals-data';
import { getCustomPeriod, getPeriodForSelection } from './periods';
import { _goalSnapshots, buildGoalSnapshotKey, finalizeGoalSnapshot } from './snapshots';
import type { GoalSelection } from './types';

function isVolumeView(view: View) {
  return view.type === 'reader' || view.type === 'volume-text';
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

export function initGoalsLifecycle() {
  if (!browser) {
    return () => {};
  }

  const runSnapshotFinalization = () => {
    finalizeClosedGoalSnapshots();
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      runSnapshotFinalization();
    }
  };

  let previousView = get(currentView);
  const unsubscribe = currentView.subscribe((view) => {
    if (isVolumeView(previousView) && !isVolumeView(view)) {
      runSnapshotFinalization();
    }

    previousView = view;
  });

  runSnapshotFinalization();

  window.addEventListener('focus', runSnapshotFinalization);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    unsubscribe();
    window.removeEventListener('focus', runSnapshotFinalization);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}
