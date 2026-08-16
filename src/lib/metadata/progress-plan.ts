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

export type ProgressPushEvent = 'completion' | 'restart' | 'sync';

export interface ProgressPushPlan {
  status?: 'CURRENT' | 'COMPLETED' | 'REPEATING';
  progress?: number;
  progressVolumes?: number;
  repeat?: number;
}

/**
 * Decide what (if anything) to send to AniList. Pure.
 * - restart: the one explicit decrease → REPEATING with progress 0.
 * - otherwise progress only ever moves forward; status COMPLETED when the pass
 *   reaches the known total, REPEATING while re-reading, CURRENT otherwise.
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
  const remoteProgress = remote ? remote[field] : 0;
  const remoteRepeat = remote?.repeat ?? 0;
  const desiredRepeat = Math.max(0, local.timesRead - 1);
  const plan: ProgressPushPlan = {};

  if (event === 'restart') {
    plan.status = 'REPEATING';
    plan[field] = 0;
    if (desiredRepeat > remoteRepeat) plan.repeat = desiredRepeat;
    return plan;
  }

  if (local.passProgress > remoteProgress) {
    plan[field] = local.passProgress;
    plan.status = local.passComplete ? 'COMPLETED' : local.rereading ? 'REPEATING' : 'CURRENT';
  }
  if (desiredRepeat > remoteRepeat) {
    plan.repeat = desiredRepeat;
  }

  return Object.keys(plan).length > 0 ? plan : null;
}
