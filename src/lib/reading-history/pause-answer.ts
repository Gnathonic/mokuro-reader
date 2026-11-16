import { viewCap, widenedK, type IdleSettings } from './stats-engine';
import type { LivePause } from './pause-watch';
import type { PauseCount } from './types';

/**
 * What an answer to the long-pause prompt does (phase 3b), apart from the
 * DOM: the reader passes the real effects, tests pass spies.
 */
export interface PauseAnswerEffects {
  /**
   * End the paused view with this answer (`null` = unanswered: it counts up to
   * its cutoff) and reopen it at `now` (`ViewTracker.split`).
   */
  split(now: number, count: PauseCount | null): void;
  widenIdleK(k: number): void;
  /** Turn the prompt off (`setAskOnLongPause(false)`). */
  stopAsking(): void;
  notify(message: string): void;
}

/**
 * The prompt's buttons. `still-reading`: count all of it, the timer goes on,
 * and the automatic cutoff learns this pace. `keep`: the time so far counts
 * up to the cutoff (what an unanswered pause counts anyway), the timer goes
 * on. `all` / `none`: the time so far counts in full / not at all.
 * `stop-asking`: `keep`, and the prompt is turned off.
 */
export type PauseAnswer = 'still-reading' | 'keep' | 'all' | 'none' | 'stop-asking';

const MIN = 60_000;

const COUNTS: Record<PauseAnswer, PauseCount | null> = {
  'still-reading': 'full',
  keep: null,
  all: 'full',
  none: 'none',
  'stop-asking': null
};

/**
 * Every live answer SPLITS the view: the paused view is written now (with its
 * `resolve`, if any, in one transaction), and the same pages reopen at `now`,
 * so time after the reader came back counts normally. "Still reading" also
 * widens the global `k` far enough for this view, when that can help; under a
 * fixed cutoff it only says where to change it. `idle` must be the CURRENT
 * setting (`idleSettings`, not the stats' debounced copy), so a widen never
 * writes a smaller `k` than one already stored.
 */
export function answerPause(
  pause: LivePause,
  answer: PauseAnswer,
  pace: number | null,
  idle: IdleSettings,
  effects: PauseAnswerEffects,
  now: number = Date.now()
): void {
  effects.split(now, COUNTS[answer]);
  if (answer === 'stop-asking') {
    effects.stopAsking();
    effects.notify('The reader won’t ask again. Turn it back on in Settings → Reading timer.');
    return;
  }
  if (answer !== 'still-reading') return;
  const k = widenedK(now - pause.since, pause.chars, pace, idle);
  if (k !== null) {
    effects.widenIdleK(k);
    const cap = viewCap(pause.chars, pace, { ...idle, k });
    effects.notify(
      `Pages like this now get about ${Math.round(cap / MIN)} min before the timer stops.`
    );
  } else if (idle.overrideMs !== null) {
    effects.notify(
      `The timer stops after ${Math.round(idle.overrideMs / MIN)} min on every page. Change it in Settings → Reading timer.`
    );
  }
}
