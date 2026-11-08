/**
 * "Mouse wheel: turns pages" in paged mode (#55) — the YACReader-style wheel.
 * Pure stream state; PagedViewport owns the actuation.
 *
 * - A plain VERTICAL wheel turns pages: down = next, up = previous (reading
 *   order). A horizontal wheel still pans.
 * - **Edge-gated per stream**, like swipe-to-flip (#186): if a zoomed page
 *   could still pan in the wheel's direction when the stream began, the
 *   whole stream pans. A stream ends after `WHEEL_STREAM_IDLE_MS` without
 *   events, when the direction flips, or — notched — when a notch turned the
 *   page: the next notch reads the NEW page's edges, so a spin onto a page
 *   taller than the viewport pans it instead of skipping it.
 * - **Rate**: a notched wheel turns one page per notch (`WheelNotchStepper`,
 *   so Firefox's line deltas and Windows' 120 px are one notch alike); a
 *   fine stream (trackpad, precision wheel — `WheelStreamClassifier`) turns
 *   ONE page per stream, after `FINE_TURN_TRAVEL` px of travel so a resting
 *   finger's jitter turns nothing. Its momentum tail stays in the stream.
 *
 * - **Runs and the volume edge.** A RUN is every turn-mode event with no idle
 *   gap, across streams and across the reader remount a volume change does
 *   (`WheelRun`, one per wheel). The consumer lets only a run's FIRST turn
 *   leave the volume, and closes the run when it does: a notched flick's
 *   leftover notches neither throw the reader out of the book nor turn the
 *   next volume's pages.
 *
 * Ctrl/meta+wheel never reaches here (it zooms — a fine ctrl+wheel is a
 * pinch, #259), nor does the ctrl+shift gap chord.
 */

import { WHEEL_STREAM_IDLE_MS, WheelNotchStepper, normalizeWheelDelta } from '../zoom-math';

/** Fine (trackpad) travel, px, before a stream turns its one page. */
export const FINE_TURN_TRAVEL = 60;

/**
 * - `pan`: pan the page with this event, as the wheel does without the setting
 * - `forward` / `backward`: turn one page in reading order
 * - `hold`: swallow the event — part of a turning stream that turns nothing now
 */
export type WheelPageAction = 'pan' | 'forward' | 'backward' | 'hold';

export interface VerticalEdges {
  canRevealUp: boolean;
  canRevealDown: boolean;
}

type WheelLike = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'timeStamp'>;

/**
 * One wheel's run: turn-mode wheel events with no `idleMs` gap between them.
 * Outlives a viewport (a volume change remounts the reader mid-flick), so the
 * app keeps ONE (`sharedWheelRun`); tests pass their own.
 */
export class WheelRun {
  private lastTime = -Infinity;
  private turns = 0;
  private closed = false;

  constructor(private idleMs = WHEEL_STREAM_IDLE_MS) {}

  /** Every turn-mode vertical wheel event, in order. False = the run is closed. */
  touch(timeStamp: number): boolean {
    // A clock that went backwards is another document's time origin.
    if (timeStamp - this.lastTime > this.idleMs || timeStamp < this.lastTime) {
      this.turns = 0;
      this.closed = false;
    }
    this.lastTime = timeStamp;
    return !this.closed;
  }

  /** A turn happened; true when it is the run's first. */
  noteTurn(): boolean {
    return this.turns++ === 0;
  }

  /** Swallow the rest of this run (it left the volume). */
  close(): void {
    this.closed = true;
  }
}

export const sharedWheelRun = new WheelRun();

export class WheelPageTurner {
  private lastTime = -Infinity;
  private direction = 0;
  private panning = false;
  private turned = false;
  private travel = 0;
  private notches = new WheelNotchStepper();
  private firstTurn = false;

  constructor(
    private idleMs = WHEEL_STREAM_IDLE_MS,
    private run: WheelRun = sharedWheelRun
  ) {}

  /**
   * Whether the turn `step` just returned is its run's first — the only turn
   * allowed to leave the volume.
   */
  get turnOpensRun(): boolean {
    return this.firstTurn;
  }

  /** The consumer left the volume on this run's turn: hold the rest of the run. */
  closeRun(): void {
    this.run.close();
  }

  /**
   * @param fine this stream's classification (`WheelStreamClassifier`,
   *   classified once per event by the caller)
   * @param edges where the page can still pan — read lazily, only when a new
   *   stream starts (incl. the notch after a notched turn)
   */
  step(e: WheelLike, fine: boolean, edges: () => VerticalEdges): WheelPageAction {
    // deltaMode before the deltas: Firefox fixes an event's unit at first read.
    const { deltaMode, deltaX, deltaY } = e;
    const dx = normalizeWheelDelta(deltaX, deltaMode);
    const dy = normalizeWheelDelta(deltaY, deltaMode);
    if (dy === 0 || Math.abs(dx) > Math.abs(dy)) return 'pan';
    if (!this.run.touch(e.timeStamp)) {
      // A closed run (it left the volume) swallows everything until idle.
      this.lastTime = e.timeStamp;
      return 'hold';
    }

    const direction = Math.sign(dy);
    if (e.timeStamp - this.lastTime > this.idleMs || direction !== this.direction) {
      this.direction = direction;
      this.turned = false;
      this.travel = 0;
      const at = edges();
      this.panning = direction > 0 ? at.canRevealDown : at.canRevealUp;
    }
    this.lastTime = e.timeStamp;
    if (this.panning) return 'pan';

    if (fine) {
      if (this.turned) return 'hold';
      this.travel += Math.abs(dy);
      if (this.travel < FINE_TURN_TRAVEL) return 'hold';
      this.turned = true;
      this.firstTurn = this.run.noteTurn();
      return direction > 0 ? 'forward' : 'backward';
    }

    // Positive steps = wheel up = backward.
    const steps = this.notches.steps({ deltaY, deltaMode, timeStamp: e.timeStamp });
    if (steps === 0) return 'hold';
    // The turn ends the stream: the next notch gates on the new page's edges.
    this.lastTime = -Infinity;
    this.firstTurn = this.run.noteTurn();
    return steps < 0 ? 'forward' : 'backward';
  }
}
