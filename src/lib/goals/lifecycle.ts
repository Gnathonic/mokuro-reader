import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { volumesWithPlaceholders as catalogVolumes } from '$lib/catalog';
import { volumesWithTrash } from '../settings/volume-data';
import { currentView, type View } from '$lib/util/hash-router';
import { backfillCompletedAt } from './completed-at-backfill';
import { customGoals, goalTargets, rollForwardStaleSelection } from './goals-data';
import { pruneDeadlinesForDeletedVolumes } from './goal-settings';
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

  /*
   * Never throws.
   *
   * This runs synchronously inside two store subscribers and two DOM listeners.
   * An exception escaping a Svelte store drain aborts the drain, so the
   * subscribers queued behind it never run — a fault in goals bookkeeping would
   * take out reactivity elsewhere in the app, which is wildly out of proportion
   * to what this does. Nothing here is load-bearing enough to be worth that:
   * every step is idempotent and retried on the next focus.
   */
  const runMaintenance = () => {
    try {
      runMaintenanceUnguarded();
    } catch (error) {
      console.warn('[goals] maintenance pass failed; will retry on next focus:', error);
    }
  };

  const runMaintenanceUnguarded = () => {
    if (!catalogLoaded()) return;
    // Recurring, because this is the only pass that ever runs AFTER the cloud
    // listing lands — the boot pass fires the moment the local Dexie catalog
    // resolves, which is always before it. Cheap when there is nothing to do:
    // it early-returns on its completion key and never touches the store
    // unless it has a stamp to write.
    backfillCompletedAt(pageCounts());
    // Recurring, so a tab left open across midnight or New Year rolls over —
    // but it never moves a period the user pinned by choosing it from the
    // dropdown. See `rollForwardStaleSelection`.
    rollForwardStaleSelection();
    finalizeClosedGoalSnapshots();
    // Deadlines outlive their volumes, and now that they sync they would grow
    // in every device's goals.json forever. Driven off the reading records'
    // own tombstones — see the note on the prune for why catalog absence is
    // NOT a safe signal here.
    pruneDeadlinesForDeletedVolumes(get(volumesWithTrash));
  };

  const runBootMaintenance = () => {
    try {
      // The boot pass is the one that SPENDS a deferral. See the note in
      // `backfillCompletedAt`: counting on every focus exhausted the budget in
      // a few tab switches, and counting only here would expire it having never
      // seen a cloud page count.
      backfillCompletedAt(pageCounts(), { countDeferral: true });
    } catch (error) {
      console.warn('[goals] completedAt backfill failed:', error);
    }
    runMaintenance();
  };

  // The catalog resolves asynchronously and usually AFTER mount, so a one-shot
  // call here would always run too early. Wait for it, then stop watching.
  let unsubscribeCatalog: (() => void) | null = null;
  unsubscribeCatalog = catalogVolumes.subscribe((catalog) => {
    if (catalog === undefined) return;
    runBootMaintenance();
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
