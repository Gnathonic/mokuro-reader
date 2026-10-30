import { viewCap, widenedK, type IdleSettings } from './stats-engine';
import type { LivePause } from './pause-watch';
import type { PauseCount } from './types';

/**
 * What an answer to the "Still reading?" prompt does (phase 3b), apart from
 * the DOM: the reader passes the real effects, tests pass spies.
 */
export interface PauseAnswerEffects {
  /** End the paused view with this answer and reopen it at `now` (`ViewTracker.split`). */
  split(now: number, count: PauseCount): void;
  widenIdleK(k: number): void;
  setPauseDefault(count: PauseCount): void;
  notify(message: string): void;
}

const MIN = 60_000;

/**
 * Every live answer SPLITS the view: the paused view is written now with its
 * `resolve` (one transaction), and the same pages reopen at `now`, so time
 * after the reader came back counts normally. "Still reading" also widens the
 * global `k` far enough for this view, when that can help; under a manual
 * cutoff it only says where to change it. `idle` must be the CURRENT setting
 * (`idleSettings`, not the stats' debounced copy), so a widen never writes a
 * smaller `k` than one already stored.
 */
export function answerPause(
  pause: LivePause,
  count: PauseCount,
  opts: { stillReading: boolean; always: boolean },
  pace: number | null,
  idle: IdleSettings,
  effects: PauseAnswerEffects,
  now: number = Date.now()
): void {
  effects.split(now, count);
  if (opts.stillReading) {
    const k = widenedK(now - pause.since, pause.chars, pace, idle);
    if (k !== null) {
      effects.widenIdleK(k);
      const cap = viewCap(pause.chars, pace, { ...idle, k });
      effects.notify(`Cutoff widened to ~${Math.round(cap / MIN)} min for pages like this`);
    } else if (idle.overrideMs !== null) {
      effects.notify(
        `Manual cutoff is ${Math.round(idle.overrideMs / MIN)} min — change it in Settings`
      );
    }
  }
  if (opts.always) effects.setPauseDefault(count);
}
