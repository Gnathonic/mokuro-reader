import type { TrackingUnit } from './types';

export interface LocalPassState {
  /** Highest volume/chapter number among volumes completed in the current pass. */
  passProgress: number;
  /** Every local volume of the series is completed. */
  allCompleted: boolean;
  /** Series total is known and passProgress reaches it. */
  passComplete: boolean;
  /** read_count + (allCompleted ? 1 : 0). */
  timesRead: number;
  /** read_count >= 1 && !allCompleted — a later pass is in flight. */
  rereading: boolean;
}

export interface RemoteEntry {
  status: string | null;
  progress: number;
  progressVolumes: number;
  repeat: number;
}

export type ProgressPushEvent = 'completion' | 'restart' | 'sync' | 'read_count';

export interface ProgressPushPlan {
  status?: 'CURRENT' | 'COMPLETED' | 'REPEATING';
  progress?: number;
  progressVolumes?: number;
  repeat?: number;
}

/**
 * Decide what (if anything) to send to AniList. Pure.
 * - read_count: a manual correction of "Read N times" → the repeat count alone,
 *   in EITHER direction. It is the one event that may lower a remote figure
 *   besides a restart, because the user typed the number on purpose.
 * - restart: the one explicit decrease → REPEATING with progress 0. A no-op
 *   (null) when remote already reflects it (status REPEATING, progress 0,
 *   repeat already caught up) — restarting twice must not re-push.
 * - otherwise progress only ever moves forward; status COMPLETED when the pass
 *   reaches the known total, REPEATING while re-reading, CURRENT otherwise.
 *   When progress doesn't move but the desired status is a strict upgrade
 *   over the remote one (→COMPLETED any time the pass is complete; →REPEATING
 *   only when remote is CURRENT/untracked), the status is still pushed alone
 *   — this covers the total being learned after the fact, or the remote
 *   progress being edited by hand. Any other status (PLANNING/PAUSED/DROPPED/
 *   already-COMPLETED/etc.) is left untouched unless progress also increases.
 * - repeat = timesRead - 1, sent only when it would increase.
 * Returns null when nothing would change.
 */
export function planProgressPush(
  local: LocalPassState,
  remote: RemoteEntry | null,
  unit: TrackingUnit,
  event: ProgressPushEvent
): ProgressPushPlan | null {
  const field: 'progress' | 'progressVolumes' =
    unit === 'chapters' ? 'progress' : 'progressVolumes';
  // GraphQL can return null for progress fields it has never tracked; treat
  // that the same as an absent remote entry so a `>` comparison isn't
  // silently short-circuited by `undefined`/`null`.
  const remoteProgress = remote?.[field] ?? 0;
  const remoteRepeat = remote?.repeat ?? 0;
  const desiredRepeat = Math.max(0, local.timesRead - 1);
  const plan: ProgressPushPlan = {};

  if (event === 'read_count') {
    // Nothing else is implied: the pass itself did not move, so status and
    // progress stay exactly as they are.
    return desiredRepeat === remoteRepeat ? null : { repeat: desiredRepeat };
  }

  if (event === 'restart') {
    const alreadyRestarted =
      remote?.status === 'REPEATING' && remoteProgress === 0 && desiredRepeat <= remoteRepeat;
    if (alreadyRestarted) return null;
    plan.status = 'REPEATING';
    plan[field] = 0;
    if (desiredRepeat > remoteRepeat) plan.repeat = desiredRepeat;
    return plan;
  }

  const desiredStatus: ProgressPushPlan['status'] = local.passComplete
    ? 'COMPLETED'
    : local.rereading
      ? 'REPEATING'
      : 'CURRENT';

  if (local.passProgress > remoteProgress) {
    plan[field] = local.passProgress;
    plan.status = desiredStatus;
  } else if (desiredStatus === 'COMPLETED' && remote?.status !== 'COMPLETED') {
    // The pass completed without a fresh progress push (e.g. the series total
    // was learned after progress already matched it, or progress was set by
    // hand on AniList) — still flip the remote to COMPLETED.
    plan.status = 'COMPLETED';
  } else if (
    desiredStatus === 'REPEATING' &&
    (remote?.status === 'CURRENT' || remote?.status == null)
  ) {
    // Only upgrade a remote that was passively CURRENT/untracked into
    // REPEATING; a remote the user paused/dropped/etc. is left alone until
    // real progress is pushed.
    plan.status = 'REPEATING';
  }

  if (desiredRepeat > remoteRepeat) {
    plan.repeat = desiredRepeat;
  }

  return Object.keys(plan).length > 0 ? plan : null;
}
