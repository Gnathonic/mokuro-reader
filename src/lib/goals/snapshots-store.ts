/**
 * The goal-snapshot STORE, split from the snapshot BUILDER in `snapshots.ts`.
 *
 * The builder needs the catalog (page counts), which pulls in Dexie and the
 * cloud manager. The sync layer needs the store and nothing else, and importing
 * it through a module that reaches IndexedDB would drag a database into every
 * sync test — and did, until this split.
 */
import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import { isCustomGoalClosed } from './periods';
import { parseSnapshots } from './goals-file';
import type { CustomGoal, GoalSnapshot, GoalType } from './types';

type GoalSnapshots = Record<string, GoalSnapshot>;

export const GOAL_SNAPSHOTS_STORAGE_KEY = 'goalSnapshots';

const GOAL_SNAPSHOTS_STORAGE_VERSION = 1;

/**
 * Migrate the pre-sync shape (a bare `Record<key, GoalSnapshot>` with no
 * `lastUpdated`). `closedAt` is always present and always in the past, so it is
 * the honest stamp — never `now`, which would make the last device to upgrade
 * win every snapshot merge.
 */
function migrateLegacySnapshots(raw: unknown): GoalSnapshots {
  if (!raw || typeof raw !== 'object') return {};
  const stamped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    stamped[key] = { ...v, lastUpdated: typeof v.closedAt === 'string' ? v.closedAt : undefined };
  }
  return parseSnapshots(stamped);
}

function loadGoalSnapshots(): GoalSnapshots {
  if (!browser) return {};

  const stored = window.localStorage.getItem(GOAL_SNAPSHOTS_STORAGE_KEY);
  if (!stored) return {};

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return {};

    const record = parsed as Record<string, unknown>;
    if (record.version !== GOAL_SNAPSHOTS_STORAGE_VERSION) {
      return migrateLegacySnapshots(record.snapshots ?? record);
    }

    return parseSnapshots(record.snapshots);
  } catch {
    return {};
  }
}

export const _goalSnapshots = writable<GoalSnapshots>(loadGoalSnapshots());

_goalSnapshots.subscribe((snapshots) => {
  if (browser) {
    window.localStorage.setItem(
      GOAL_SNAPSHOTS_STORAGE_KEY,
      JSON.stringify({ version: GOAL_SNAPSHOTS_STORAGE_VERSION, snapshots })
    );
  }
});

export const goalSnapshots = _goalSnapshots;

/** Replace the section wholesale — the sync merge's write-back. */
export function setGoalSnapshots(snapshots: GoalSnapshots) {
  _goalSnapshots.set(snapshots);
}

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
