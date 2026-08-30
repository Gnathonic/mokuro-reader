import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { volumes as catalogVolumes } from '$lib/catalog';
import { currentView, type View } from '$lib/util/hash-router';
import { backfillCompletedAt } from './completed-at-backfill';
import { customGoals, goalTargets } from './goals-data';
import { getCustomPeriod, getPeriodForSelection } from './periods';
import { finalizeGoalSnapshot } from './snapshots';
import { _goalSnapshots, buildGoalSnapshotKey } from './snapshots-store';
import type { GoalSelection } from './types';

function isVolumeView(view: View) {
  return view.type === 'reader' || view.type === 'volume-text';
}

/**
 * A goal snapshot freezes a closed period's numbers PERMANENTLY — nothing
 * rewrites one once it exists. So it must never be built from a half-loaded
 * app.
 *
 * The catalog store is `undefined` until its first Dexie read resolves, and
 * every page count comes from it. Finalizing before then wrote snapshots whose
 * `partialProgress` was empty by construction (`totalPages <= 0` skips every
 * volume) and whose completions were whatever the boot happened to have — and
 * the first-writer-wins guard in `finalizeGoalSnapshot` then made that the
 * permanent record.
 */
function catalogLoaded(): boolean {
  return get(catalogVolumes) !== undefined;
}

function pageCounts(): Record<string, number> {
  const catalog = get(catalogVolumes) ?? {};
  const counts: Record<string, number> = {};
  for (const [volumeId, metadata] of Object.entries(catalog)) {
    if (typeof metadata?.page_count === 'number') counts[volumeId] = metadata.page_count;
  }
  return counts;
}

export function finalizeClosedGoalSnapshots() {
  if (!catalogLoaded()) return;

  const now = new Date();
  const targets = get(goalTargets);
  const custom = get(customGoals);
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

  const runMaintenance = () => {
    if (!catalogLoaded()) return;
    // Order matters: dating legacy completions first means the snapshot built
    // in the same tick sees them.
    backfillCompletedAt(pageCounts());
    finalizeClosedGoalSnapshots();
  };

  // The catalog resolves asynchronously and usually AFTER mount, so a one-shot
  // call here would always run too early. Wait for it, then stop watching.
  let unsubscribeCatalog: (() => void) | null = null;
  unsubscribeCatalog = catalogVolumes.subscribe((catalog) => {
    if (catalog === undefined) return;
    runMaintenance();
    // Svelte calls the subscriber synchronously on subscribe, so the handle may
    // not be assigned yet; defer the teardown in that case.
    if (unsubscribeCatalog) {
      unsubscribeCatalog();
      unsubscribeCatalog = null;
    } else {
      queueMicrotask(() => {
        unsubscribeCatalog?.();
        unsubscribeCatalog = null;
      });
    }
  });

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      runMaintenance();
    }
  };

  let previousView = get(currentView);
  const unsubscribeView = currentView.subscribe((view) => {
    if (isVolumeView(previousView) && !isVolumeView(view)) {
      runMaintenance();
    }

    previousView = view;
  });

  window.addEventListener('focus', runMaintenance);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    unsubscribeCatalog?.();
    unsubscribeView();
    window.removeEventListener('focus', runMaintenance);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}
