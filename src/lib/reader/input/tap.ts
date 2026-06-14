/**
 * Tap vs double-tap discrimination for reader surfaces — the timing logic
 * both scroll readers previously duplicated inline (lastTapTime +
 * setTimeout dances).
 *
 * Two commit policies, matching the two surface families:
 *
 * - 'deferred' (scroll readers): a single tap is held for the double-tap
 *   window and only commits (onTap — overlay toggle) if no second tap
 *   lands; a second tap within the window cancels it and fires onDoubleTap
 *   (zoom toggle) instead. The cost is intentional: the overlay appears
 *   doubleTapDelayMs late so a double-tap never flashes it.
 * - 'immediate' (paged): every tap commits instantly, and a second tap
 *   within the window ALSO fires onDoubleTap. This reproduces the native
 *   click/click/dblclick sequence paged mode was built on: the overlay
 *   toggles on each click (twice for a double-tap — net zero) and the zoom
 *   fires on the second, so there is no overlay latency.
 *
 * The caller reports only qualified taps — clicks already filtered by
 * target role ('page' only) and by the tracker's wasDrag. One exception is
 * handled here because it spans events: after interacting with a text box,
 * the first tap outside is a DISMISSAL (the box closes) and must not toggle
 * anything. Surfaces call noteTextBoxInteraction() when a press lands on a
 * text box; the next tap is swallowed.
 */

/** The double-tap window — shared by both commit policies. */
const DOUBLE_TAP_DELAY_MS = 300;

export interface TapDiscriminatorConfig {
  /** See module doc. Default 'deferred'. */
  commitPolicy?: 'deferred' | 'immediate';
  /**
   * Two taps further apart than this are two singles, not a double —
   * restores the proximity gate native dblclick gave paged mode. Default:
   * unlimited (the scroll readers never had one).
   */
  maxDoubleTapDistancePx?: number;
  /** A lone tap, fired after the window closes. */
  onTap?(x: number, y: number): void;
  /** Second tap within the window, at the second tap's position. */
  onDoubleTap?(x: number, y: number): void;
}

export class TapDiscriminator {
  private config: TapDiscriminatorConfig;
  private lastTapTime: number | null = null;
  private lastTapX = 0;
  private lastTapY = 0;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private swallowNext = false;

  constructor(config: TapDiscriminatorConfig) {
    this.config = config;
  }

  /** A press landed on a text box — the next tap dismisses, not toggles. */
  noteTextBoxInteraction(): void {
    this.swallowNext = true;
  }

  /** Report a qualified tap at viewport coordinates. */
  tap(x: number, y: number): void {
    if (this.swallowNext) {
      this.swallowNext = false;
      // Immediate mode arms anyway: in the old paged code the dismissal
      // only consumed the toggle, so a double-tap right after a text-box
      // interaction still zoomed (click2 toggled + native dblclick fired).
      if (this.config.commitPolicy === 'immediate') {
        this.lastTapTime = performance.now();
        this.lastTapX = x;
        this.lastTapY = y;
      }
      return;
    }

    const delay = DOUBLE_TAP_DELAY_MS;
    const maxDist = this.config.maxDoubleTapDistancePx ?? Infinity;
    const now = performance.now();
    const isSecondTap =
      this.lastTapTime !== null &&
      now - this.lastTapTime < delay &&
      Math.hypot(x - this.lastTapX, y - this.lastTapY) <= maxDist;

    if (this.config.commitPolicy === 'immediate') {
      this.config.onTap?.(x, y);
      if (isSecondTap) {
        this.lastTapTime = null;
        this.config.onDoubleTap?.(x, y);
      } else {
        this.lastTapTime = now;
        this.lastTapX = x;
        this.lastTapY = y;
      }
      return;
    }

    if (isSecondTap) {
      this.lastTapTime = null;
      this.clearPending();
      this.config.onDoubleTap?.(x, y);
      return;
    }

    this.lastTapTime = now;
    this.lastTapX = x;
    this.lastTapY = y;
    this.clearPending();
    this.pending = setTimeout(() => {
      this.pending = null;
      this.config.onTap?.(x, y);
    }, delay);
  }

  /** Drop any pending single tap (component teardown, page change). */
  cancel(): void {
    this.clearPending();
    this.lastTapTime = null;
    this.swallowNext = false;
  }

  private clearPending(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
  }
}
