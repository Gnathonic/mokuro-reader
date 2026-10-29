import { writable } from 'svelte/store';
import { typicalDwell, viewCap, type IdleSettings } from './stats-engine';
import type { OpenView } from './view-tracker';

/**
 * Live long-pause detection (phase 3b; spec: "Long pauses"). The open view
 * reaches its cap at `since + cap` — the same cap the engine applies once the
 * view ends — and the reader asks then, to the millisecond, not on the
 * timer's 15 s tick. A view is asked about once; a split's continuation is a
 * new view (new `since`) and is asked about again.
 */

/** The prompt has been up this long past the cap → its "away" copy. */
export const AWAY_AFTER_MS = 2 * 60_000;

/** The open view that has reached its cap: what the prompt shows and answers. */
export interface LivePause {
  volume: string;
  since: number;
  /** Characters on screen. */
  chars: number;
  cap: number;
  /** What "Count typical" counts: `typicalDwell(chars, pace, cap)`. */
  typical: number;
}

/** The pause the reader is asking about now; `null` = no prompt. */
export const livePause = writable<LivePause | null>(null);

/** The open view's cap and typical time, as the engine will count them. */
export function livePauseFor(open: OpenView, pace: number | null, idle: IdleSettings): LivePause {
  const chars = open.view.page_chars.reduce((sum, c) => sum + c, 0);
  const cap = viewCap(chars, pace, idle);
  return {
    volume: open.view.volume,
    since: open.since,
    chars,
    cap,
    typical: typicalDwell(chars, pace, cap)
  };
}

export interface WatchTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

// Late-bound, so fake timers installed after construction still apply.
const globalTimers: WatchTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>)
};

export class PauseWatch {
  private current: LivePause | null = null;
  private timer: unknown = null;
  private fired = false;

  /**
   * @param onCap the open view reached its cap (once per view).
   * @param onClear a pause that fired no longer stands: its view ended,
   *   another opened, or the cap grew past the time so far.
   */
  constructor(
    private readonly onCap: (p: LivePause) => void,
    private readonly onClear: () => void = () => {},
    private readonly timers: WatchTimers = globalTimers,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Re-arm for the open view; call on any liveView / pace / idle change. Never
   * calls `onCap` synchronously (it runs inside store subscriptions).
   */
  update(open: OpenView | null, pace: number | null, idle: IdleSettings): void {
    const next = open ? livePauseFor(open, pace, idle) : null;
    const prev = this.current;
    const sameView =
      prev !== null && next !== null && prev.volume === next.volume && prev.since === next.since;
    if (sameView && prev.cap === next.cap) return;
    this.current = next;

    if (sameView && this.fired) {
      // Asked once per view: a new cap still behind us changes nothing; one
      // that moved past the time so far withdraws the prompt and waits again.
      if (next.since + next.cap <= this.now()) return;
      this.fired = false;
      this.onClear();
      this.arm(next);
      return;
    }

    this.disarm();
    if (this.fired) {
      this.fired = false;
      this.onClear();
    }
    if (next) this.arm(next);
  }

  dispose(): void {
    this.disarm();
    this.current = null;
    this.fired = false;
  }

  private arm(p: LivePause): void {
    const delay = Math.max(0, p.since + p.cap - this.now());
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.current !== p) return;
      this.fired = true;
      this.onCap(p);
    }, delay);
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }
}
