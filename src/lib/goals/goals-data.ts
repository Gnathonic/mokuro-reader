import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';
import { generateUUID } from '$lib/util/uuid';
import { persistToLocalStorage } from './persist';
import { buildYearKey } from './date-utils';
import {
  buildGoalKey,
  nextGoalTimestamp,
  parseCustomGoals,
  parseTargets,
  type CustomGoalEntry,
  type GoalTargetEntry,
  type GoalTypeKey
} from './goals-file';
import { getCurrentPeriodKey, getPeriodForSelection, hasValidCustomGoalDateRange } from './periods';
import { isCustomGoalDateRangeLocked } from './snapshots-store';
import type { CustomGoal, GoalSelection, GoalTarget, GoalType } from './types';

/**
 * Goals are stored as KEYED RECORDS with per-entry `lastUpdated` stamps and
 * `deletedOn` tombstones, because they sync (root `goals.json`). Arrays cannot
 * merge per key, and a hard delete resurrects: remove a goal on the phone,
 * sync from the laptop that still has it, and it comes back — forever.
 *
 * The PUBLIC stores keep the array/scalar shapes the UI already consumes; the
 * tombstoned records stay internal. Same split as `volumesWithTrash`/`volumes`.
 */

export const GOALS_STORAGE_KEY = 'goalsData';

/** Bumped when the persisted shape changes, so migration runs exactly once. */
const GOALS_STORAGE_VERSION = 1;

export interface GoalsStoreState {
  targets: Record<string, GoalTargetEntry>;
  customGoals: Record<string, CustomGoalEntry>;
  /**
   * Which goal card is on screen. Deliberately NOT in `goals.json`: syncing it
   * would mean opening Manage Goals on the phone silently switches the card on
   * the laptop, and every such tap would dirty the file and force an upload.
   */
  activeSelection: GoalSelection;
  /**
   * The user chose a period that had ALREADY ENDED when they chose it — the
   * period dropdown offers past ones deliberately.
   *
   * Without this, roll-forward cannot tell "left over from last year" from
   * "just picked, on purpose", and snatched the page back to the present the
   * moment the user alt-tabbed away and returned.
   */
  selectionPinned?: boolean;
}

/**
 * NO TARGETS.
 *
 * The year goal used to default to 52 here, as persisted state — so the store
 * was non-empty for everyone from the first module evaluation, and the first
 * sync wrote a `goals.json` into the cloud folder of every user in the world,
 * including everyone who never opens the tracker. A file nobody asked for, in
 * everybody's library, mtime-churning across their devices.
 *
 * The 52 is a starting value for the goal the user actually creates, minted by
 * `ensureCurrentYearTarget()` when they open the tracker. Until then there is
 * no goal, nothing to sync, and no file.
 */
function defaultState(now = new Date()): GoalsStoreState {
  return {
    targets: {},
    customGoals: {},
    activeSelection: { goalType: 'year', periodKey: buildYearKey(now.getFullYear()) }
  };
}

function isGoalSelection(value: unknown): value is GoalSelection {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.goalType === 'custom') return typeof v.customId === 'string';
  return typeof v.goalType === 'string' && typeof v.periodKey === 'string';
}

/**
 * Migrate the pre-sync shape (`targets`/`customGoals` as arrays of bare
 * objects) to keyed, stamped records.
 *
 * Stamps come from each entry's own `createdAt`, NEVER from `now`: a migration
 * stamped `now` would outrank every other device's real edits on the first
 * sync, so whichever device upgraded last would win everything.
 */
function migrateLegacyState(parsed: Record<string, unknown>, now: number): GoalsStoreState {
  const epoch = new Date(0).toISOString();

  const targets: Record<string, unknown> = {};
  if (Array.isArray(parsed.targets)) {
    for (const entry of parsed.targets) {
      if (!entry || typeof entry !== 'object') continue;
      const t = entry as Record<string, unknown>;
      if (typeof t.goalType !== 'string' || typeof t.periodKey !== 'string') continue;
      targets[buildGoalKey(t.goalType, t.periodKey)] = {
        ...t,
        lastUpdated: typeof t.createdAt === 'string' ? t.createdAt : epoch
      };
    }
  }

  const customGoals: Record<string, unknown> = {};
  if (Array.isArray(parsed.customGoals)) {
    for (const entry of parsed.customGoals) {
      if (!entry || typeof entry !== 'object') continue;
      const g = entry as Record<string, unknown>;
      if (typeof g.id !== 'string') continue;
      customGoals[g.id] = {
        ...g,
        lastUpdated: typeof g.createdAt === 'string' ? g.createdAt : epoch
      };
    }
  }

  return {
    targets: parseTargets(targets, now),
    customGoals: parseCustomGoals(customGoals, now),
    activeSelection: isGoalSelection(parsed.activeSelection)
      ? parsed.activeSelection
      : defaultState().activeSelection
  };
}

function loadGoalsState(): GoalsStoreState {
  if (!browser) return defaultState();

  const stored = window.localStorage.getItem(GOALS_STORAGE_KEY);
  if (!stored) return defaultState();

  // Inside the try on purpose: this runs in the module body, so an uncaught
  // throw on a truncated key white-screens the app with no way back but
  // clearing site data.
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return defaultState();

    const record = parsed as Record<string, unknown>;
    const now = Date.now();

    if (record.version !== GOALS_STORAGE_VERSION) {
      return migrateLegacyState(record, now);
    }

    return {
      targets: parseTargets(record.targets, now),
      customGoals: parseCustomGoals(record.customGoals, now),
      activeSelection: isGoalSelection(record.activeSelection)
        ? record.activeSelection
        : defaultState().activeSelection,
      selectionPinned: record.selectionPinned === true
    };
  } catch {
    return defaultState();
  }
}

const _goalsStore = writable<GoalsStoreState>(loadGoalsState());

persistToLocalStorage(_goalsStore, GOALS_STORAGE_KEY, (state) =>
  JSON.stringify({ version: GOALS_STORAGE_VERSION, ...state })
);

/** Internal: includes tombstones. Sync and the lifecycle read this. */
export const goalsWithTrash = _goalsStore;

function live<T extends { deletedOn?: string }>(section: Record<string, T>): T[] {
  return Object.values(section).filter((entry) => !entry.deletedOn);
}

export const goalTargets = derived(_goalsStore, ($state): GoalTarget[] =>
  live($state.targets).map(({ goalType, periodKey, targetVolumes, createdAt }) => ({
    goalType,
    periodKey,
    targetVolumes,
    createdAt
  }))
);

export const customGoals = derived(_goalsStore, ($state): CustomGoal[] =>
  live($state.customGoals)
    .map(({ id, name, targetVolumes, startDate, endDate, enabled, createdAt }) => ({
      id,
      name,
      targetVolumes,
      startDate,
      endDate,
      enabled,
      createdAt
    }))
    // Insertion order is not shared across devices; sort so every device
    // renders the same list.
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
);

export const activeGoalSelection = derived(_goalsStore, ($state) => $state.activeSelection);

/** Replace both synced sections wholesale — the sync merge's write-back. */
export function setGoalSections(
  targets: Record<string, GoalTargetEntry>,
  customGoalEntries: Record<string, CustomGoalEntry>
) {
  _goalsStore.update((state) => ({ ...state, targets, customGoals: customGoalEntries }));
}

export function setGoalTarget(
  goalType: Exclude<GoalType, 'custom'>,
  periodKey: string,
  targetVolumes: number
) {
  if (!Number.isInteger(targetVolumes) || targetVolumes <= 0) return;

  _goalsStore.update((state) => {
    const key = buildGoalKey(goalType, periodKey);
    const existing = state.targets[key];

    return {
      ...state,
      targets: {
        ...state.targets,
        [key]: {
          goalType: goalType as GoalTypeKey,
          periodKey,
          targetVolumes,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          lastUpdated: nextGoalTimestamp(existing?.lastUpdated)
        }
      }
    };
  });
}

export function removeGoalTarget(goalType: Exclude<GoalType, 'custom'>, periodKey: string) {
  _goalsStore.update((state) => {
    const key = buildGoalKey(goalType, periodKey);
    const existing = state.targets[key];
    if (!existing) return state;

    // Tombstone, not delete: a hard delete is undone by the next sync with any
    // device that still holds the goal.
    const stamp = nextGoalTimestamp(existing.lastUpdated);
    return {
      ...state,
      targets: {
        ...state.targets,
        [key]: { ...existing, lastUpdated: stamp, deletedOn: stamp }
      }
    };
  });
}

export function setActiveGoalSelection(selection: GoalSelection) {
  // Pinned when it is already in the past at the moment of choosing. A custom
  // goal is always deliberate, and has no "current" counterpart to roll to.
  const pinned =
    selection.goalType === 'custom' ||
    selection.periodKey !== getCurrentPeriodKey(selection.goalType);

  _goalsStore.update((state) => ({
    ...state,
    activeSelection: selection,
    selectionPinned: pinned
  }));
}

/**
 * Why a goal was rejected, or `null` when it was accepted.
 *
 * These used to be bare `return`s. The caller cleared and closed the form
 * unconditionally, so transposing the start and end dates — or typing a
 * fractional target — silently discarded everything the user had entered, with
 * no message and nothing to retry from.
 */
export type GoalRejection = 'name' | 'target' | 'range' | 'missing' | 'locked';

export function createCustomGoal(goal: Omit<CustomGoal, 'id' | 'createdAt'>): GoalRejection | null {
  if (!goal.name.trim()) return 'name';
  if (!Number.isInteger(goal.targetVolumes) || goal.targetVolumes <= 0) return 'target';
  if (!hasValidCustomGoalDateRange(goal.startDate, goal.endDate)) return 'range';

  _goalsStore.update((state) => {
    const id = generateUUID();
    const stamp = new Date().toISOString();
    return {
      ...state,
      customGoals: {
        ...state.customGoals,
        [id]: { ...goal, name: goal.name.trim(), id, createdAt: stamp, lastUpdated: stamp }
      },
      activeSelection: { goalType: 'custom', customId: id }
    };
  });

  return null;
}

export function updateCustomGoal(updatedGoal: CustomGoal): GoalRejection | null {
  if (!updatedGoal.name.trim()) return 'name';
  if (!Number.isInteger(updatedGoal.targetVolumes) || updatedGoal.targetVolumes <= 0) {
    return 'target';
  }
  if (!hasValidCustomGoalDateRange(updatedGoal.startDate, updatedGoal.endDate)) return 'range';

  const current = get(_goalsStore).customGoals[updatedGoal.id];
  if (!current || current.deletedOn) return 'missing';

  // A snapshot froze a number over this exact range, so the range cannot move —
  // say so rather than accepting the edit and silently reverting the dates,
  // which looked to the user as though their typing had been lost.
  const movingDates =
    updatedGoal.startDate !== current.startDate || updatedGoal.endDate !== current.endDate;
  if (movingDates && isCustomGoalDateRangeLocked(current)) return 'locked';

  _goalsStore.update((state) => {
    const existing = state.customGoals[updatedGoal.id];
    if (!existing || existing.deletedOn) return state;

    // A closed or already-snapshotted goal keeps its dates: the snapshot froze
    // a period, and moving the period afterwards would make the frozen number
    // describe a range it was never computed over.
    const locked = isCustomGoalDateRangeLocked(existing);

    return {
      ...state,
      customGoals: {
        ...state.customGoals,
        [updatedGoal.id]: {
          ...existing,
          ...updatedGoal,
          name: updatedGoal.name.trim(),
          id: existing.id,
          createdAt: existing.createdAt,
          ...(locked ? { startDate: existing.startDate, endDate: existing.endDate } : {}),
          lastUpdated: nextGoalTimestamp(existing.lastUpdated)
        }
      }
    };
  });

  return null;
}

export function removeCustomGoal(customId: string) {
  _goalsStore.update((state) => {
    const existing = state.customGoals[customId];
    if (!existing) return state;

    const stamp = nextGoalTimestamp(existing.lastUpdated);
    const nextSelection: GoalSelection =
      state.activeSelection.goalType === 'custom' && state.activeSelection.customId === customId
        ? { goalType: 'year', periodKey: getCurrentPeriodKey('year') }
        : state.activeSelection;

    return {
      ...state,
      customGoals: {
        ...state.customGoals,
        [customId]: { ...existing, lastUpdated: stamp, deletedOn: stamp }
      },
      activeSelection: nextSelection
    };
  });
}

/**
 * Reset the selection when it names a custom goal that no longer exists.
 *
 * The selection is per-device and deliberately outside `goals.json`, so a
 * custom goal deleted on another device leaves this device pointing at nothing:
 * `getCustomPeriod` returns null and the card renders "Read 0 volumes in
 * Unknown period" with no hint that the goal is gone.
 */
export function dropDanglingCustomSelection() {
  const state = get(_goalsStore);
  const selection = state.activeSelection;
  if (selection.goalType !== 'custom') return;

  const goal = state.customGoals[selection.customId];
  if (goal && !goal.deletedOn) return;

  setActiveGoalSelection({ goalType: 'year', periodKey: getCurrentPeriodKey('year') });
}

/**
 * If the stored selection points at a period that has already ended, move it to
 * the current one of the same kind.
 *
 * `activeSelection` is per-device and persisted, and nothing ever advanced it.
 * A user whose selection was `{year, 2026}` opened the tracker on 1 Jan 2027 to
 * a page with Currently Reading and Future Reads simply GONE — both are gated
 * on the goal not being closed — and no explanation. Picking "Today" once made
 * it happen every following day, and "Month" from the 1st of the next month.
 *
 * Runs on every maintenance pass, so a tab left open across midnight or New
 * Year rolls over rather than going blank. It never moves a PINNED selection —
 * one the user chose from the dropdown when it was already past — which is what
 * makes deliberately reviewing a closed period possible at all.
 */
export function rollForwardStaleSelection(now = new Date()) {
  const state = get(_goalsStore);
  const selection = state.activeSelection;
  if (state.selectionPinned) return;
  if (selection.goalType === 'custom') return;

  const period = getPeriodForSelection(selection);
  if (period && period.end.getTime() > now.getTime()) return;

  const periodKey = getCurrentPeriodKey(selection.goalType);
  if (periodKey === selection.periodKey) return;

  setActiveGoalSelection({ goalType: selection.goalType, periodKey });
}

/**
 * Mint this year's target if the user has none — called when they OPEN the
 * tracker, never at app start.
 *
 * On demand for two reasons: a target baked in at module evaluation gave every
 * user in the world a `goals.json` they never asked for (see `defaultState`),
 * and it froze the year, so a tab left open across New Year showed a goal card
 * for a year with no target and no way to notice.
 */
export function ensureCurrentYearTarget(defaultTarget = 52) {
  const periodKey = getCurrentPeriodKey('year');
  const key = buildGoalKey('year', periodKey);

  _goalsStore.update((state) => {
    const existing = state.targets[key];
    // Present, or deliberately removed — either way, leave it alone.
    if (existing) return state;

    /*
     * STAMPED AT THE EPOCH, not `now`, because this is a placeholder rather
     * than a user's edit.
     *
     * `setGoalTarget` would stamp it `Date.now()`, and the merge is
     * newest-wins: a device that opens the tracker before its first goals sync
     * lands — trivially reachable, since the startup sync is skipped entirely
     * while a Drive token is expired — would mint 52, out-rank the 100 the
     * user actually set on their laptop last month, and upload it. The real
     * goal would be silently replaced everywhere with no error and no way back.
     *
     * At the epoch it loses to any real edit from any device, and the
     * keep-local tie-break means two untouched devices still agree.
     */
    const epoch = new Date(0).toISOString();
    return {
      ...state,
      targets: {
        ...state.targets,
        [key]: {
          goalType: 'year',
          periodKey,
          targetVolumes: defaultTarget,
          createdAt: epoch,
          lastUpdated: epoch
        }
      }
    };
  });
}
