/**
 * "Mouse wheel: turns pages" in paged mode (#55) — the YACReader-style wheel.
 * Pure stream state; PagedViewport owns the actuation.
 *
 * - A plain VERTICAL wheel turns pages: down = next, up = previous (reading
 *   order). A horizontal wheel still pans.
 * - **Edge-gated per stream**, like swipe-to-flip (#186): if a zoomed page
 *   could still pan in the wheel's direction when the stream began, the
 *   whole stream pans. A stream ends after `WHEEL_STREAM_IDLE_MS` without
 *   events, or when the direction flips.
 * - **Rate**: a notched wheel turns one page per notch (`WheelNotchStepper`,
 *   so Firefox's line deltas and Windows' 120 px are one notch alike); a
 *   fine stream (trackpad, precision wheel — `WheelStreamClassifier`) turns
 *   ONE page per stream, after `FINE_TURN_TRAVEL` px of travel so a resting
 *   finger's jitter turns nothing. Its momentum tail stays in the stream.
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

export class WheelPageTurner {
  private lastTime = -Infinity;
  private direction = 0;
  private panning = false;
  private turned = false;
  private travel = 0;
  private notches = new WheelNotchStepper();

  constructor(private idleMs = WHEEL_STREAM_IDLE_MS) {}

  /**
   * @param fine this stream's classification (`WheelStreamClassifier`,
   *   classified once per event by the caller)
   * @param edges where the page can still pan — read lazily, only when a new
   *   stream starts
   */
  step(e: WheelLike, fine: boolean, edges: () => VerticalEdges): WheelPageAction {
    // deltaMode before the deltas: Firefox fixes an event's unit at first read.
    const { deltaMode, deltaX, deltaY } = e;
    const dx = normalizeWheelDelta(deltaX, deltaMode);
    const dy = normalizeWheelDelta(deltaY, deltaMode);
    if (dy === 0 || Math.abs(dx) > Math.abs(dy)) return 'pan';

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
      return direction > 0 ? 'forward' : 'backward';
    }

    // Positive steps = wheel up = backward.
    const steps = this.notches.steps({ deltaY, deltaMode, timeStamp: e.timeStamp });
    if (steps === 0) return 'hold';
    return steps < 0 ? 'forward' : 'backward';
  }
}
