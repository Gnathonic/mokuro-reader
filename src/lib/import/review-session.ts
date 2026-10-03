/**
 * The image-only review SESSION (#285): one queue of series steps shared by
 * every import that needs a decision. `importFiles` calls (and the queue's
 * in-place fallback) APPEND groups; the dialog shows the first pending one as
 * "Series k of n" and decides it. A second drop while a review is open joins
 * it instead of replacing it.
 *
 * Decisions are callbacks, never awaited here: the import service enqueues an
 * approved series at once and the dialog moves on to the next step.
 */

import { get, writable } from 'svelte/store';
import type { GroupNaming, ReviewGroup } from './image-only-review';

export type GroupDecision = { action: 'import'; naming: GroupNaming } | { action: 'skip' };
export type OnGroupDecision = (groupId: string, decision: GroupDecision) => void;

export interface ReviewSessionState {
  pending: { group: ReviewGroup; onDecision: OnGroupDecision }[];
  /** Steps already decided in this session, for "Series k of n". */
  decided: number;
}

export const reviewSession = writable<ReviewSessionState>({ pending: [], decided: 0 });

export function appendReviewGroups(groups: ReviewGroup[], onDecision: OnGroupDecision): void {
  if (groups.length === 0) return;
  reviewSession.update((s) => ({
    ...s,
    pending: [...s.pending, ...groups.map((group) => ({ group, onDecision }))]
  }));
}

/** The step on screen, or null when no review is open. */
export function currentStep(
  state: ReviewSessionState
): { group: ReviewGroup; step: number; total: number } | null {
  const head = state.pending[0];
  if (!head) return null;
  return {
    group: head.group,
    step: state.decided + 1,
    total: state.decided + state.pending.length
  };
}

function notify(entry: ReviewSessionState['pending'][number], decision: GroupDecision): void {
  try {
    entry.onDecision(entry.group.id, decision);
  } catch (error) {
    console.error('[Import] Review decision failed:', error);
  }
}

export function decideCurrent(decision: GroupDecision): void {
  const { pending, decided } = get(reviewSession);
  const [head, ...rest] = pending;
  if (!head) return;
  // Move on first: a callback that appends (the queue's fallback) lands behind.
  reviewSession.set(
    rest.length > 0 ? { pending: rest, decided: decided + 1 } : { pending: [], decided: 0 }
  );
  notify(head, decision);
}

export function skipAllRemaining(): void {
  const { pending } = get(reviewSession);
  reviewSession.set({ pending: [], decided: 0 });
  for (const entry of pending) notify(entry, { action: 'skip' });
}
