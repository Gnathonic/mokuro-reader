/**
 * Pure zoom math for the continuous-mode targeted zoom — no DOM, fully testable.
 *
 * The continuous readers zoom by applying transform: scale(zoom) to a wrapper
 * and correcting scroll per frame from *measured* geometry: an anchor is
 * captured as a fractional position inside a page element's rect, and each
 * frame the difference between where that anchor actually is and where it
 * should be is applied as a relative scroll delta. Relative deltas behave
 * identically in LTR and RTL scroll containers.
 *
 * See docs/superpowers/specs/2026-06-09-continuous-targeted-zoom-design.md.
 */

export interface Point {
  x: number;
  y: number;
}

/** The subset of DOMRect the math needs (testable without a DOM). */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Fractional position of a screen point within a rect.
 * Values outside [0, 1] are valid (linear extrapolation); zero-size rects
 * yield 0 to avoid division by zero.
 */
export function anchorFraction(rect: RectLike, x: number, y: number): { fx: number; fy: number } {
  return {
    fx: rect.width > 0 ? (x - rect.left) / rect.width : 0,
    fy: rect.height > 0 ? (y - rect.top) / rect.height : 0
  };
}

/**
 * Where a fractional anchor currently sits on screen, given a fresh rect
 * measurement. The rect comes from getBoundingClientRect, which reflects
 * transforms — so this is exact at any zoom.
 */
export function anchorScreenPosition(rect: RectLike, fx: number, fy: number): Point {
  return {
    x: rect.left + fx * rect.width,
    y: rect.top + fy * rect.height
  };
}

/**
 * Animation progress of the zoom between start and target, clamped to [0, 1].
 *
 * Returns 1 when start === target: pinch drives the animator via snapTo where
 * start == target on every move, and 0/0 = NaN would survive clamping and
 * poison the scroll write (browsers coerce NaN scroll values to 0).
 */
export function zoomProgress(current: number, start: number, target: number): number {
  if (start === target) return 1;
  const t = (current - start) / (target - start);
  return Math.max(0, Math.min(1, t));
}

/**
 * Linear interpolation between two points. When the endpoints coincide the
 * result is that point regardless of t (guards non-finite t).
 */
export function lerp2(from: Point, to: Point, t: number): Point {
  if (from.x === to.x && from.y === to.y) return { x: from.x, y: from.y };
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t
  };
}

/** Closest level to a zoom value; the lower level wins exact ties. */
export function nearestZoomLevel(levels: readonly number[], zoom: number): number {
  return levels.reduce((prev, curr) =>
    Math.abs(curr - zoom) < Math.abs(prev - zoom) ? curr : prev
  );
}

/**
 * The next level stepping up or down from a zoom value.
 * Off-level values (e.g. after a pinch) resolve to the adjacent level in the
 * step direction; values beyond the ends clamp to the nearest end.
 */
export function nextZoomLevel(levels: readonly number[], zoom: number, direction: 1 | -1): number {
  const idx = levels.indexOf(zoom);
  if (idx >= 0) {
    const next = Math.max(0, Math.min(levels.length - 1, idx + direction));
    return levels[next];
  }
  if (direction > 0) {
    for (const level of levels) {
      if (level > zoom) return level;
    }
    return levels[levels.length - 1];
  }
  for (let i = levels.length - 1; i >= 0; i--) {
    if (levels[i] < zoom) return levels[i];
  }
  return levels[0];
}

/**
 * Whether a wheel event means zoom, matching paged-mode semantics:
 * ctrl/meta+wheel zooms by default; swapWheelBehavior inverts so bare wheel
 * zooms and ctrl/meta+wheel scrolls.
 *
 * `fine` (a trackpad stream — see WheelStreamClassifier) overrides the swap
 * for ctrl/meta: Chrome and Firefox deliver a trackpad PINCH as a synthetic
 * ctrl+wheel, and a pinch means zoom on every surface regardless of what the
 * user chose for their mouse wheel. Only Safari has real pinch events
 * (gesturestart/change/end — see pointer-tracker.ts), so without this a
 * Mac user with the swap on has no working pinch at all (#259). A coarse
 * ctrl+wheel is a genuine keyboard chord and keeps the swap semantics.
 */
export function wheelIntentIsZoom(
  ctrlOrMeta: boolean,
  swapWheelBehavior: boolean,
  fine = false
): boolean {
  if (fine && ctrlOrMeta) return true;
  return swapWheelBehavior ? !ctrlOrMeta : ctrlOrMeta;
}

/** Normalize a wheel delta to pixels across deltaMode values. */
export function normalizeWheelDelta(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * 40; // lines (Firefox)
  if (deltaMode === 2) return deltaY * 800; // pages
  return deltaY;
}

/** Upper bound shared by the gap sliders and the wheel chord (px). */
export const MAX_PAGE_GAP = 100;

/** Wheel px per 1px of gap: one classic ~100px notch adjusts by 5px. */
export const GAP_WHEEL_STEP_SIZE = 20;

/**
 * Whether a wheel event means "adjust the page gap": ctrl/meta+shift+wheel.
 * Checked BEFORE the zoom intent — combos with a native browser meaning
 * (ctrl+wheel zoom, shift+wheel horizontal scroll) keep that meaning tuned
 * for the reader; the gap chord is unbound in every major browser.
 */
export function wheelIntentIsGapAdjust(
  e: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>
): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey;
}

/**
 * Signed gap change (px) for a gap-adjust wheel event; positive widens
 * (wheel up). With shift held Chromium reports the notch in deltaX while
 * Firefox keeps deltaY — read whichever is nonzero. Feed each surface's own
 * WheelAccumulator(GAP_WHEEL_STEP_SIZE) so trackpad streams accumulate
 * instead of stalling below one step.
 */
export function gapWheelSteps(
  e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'timeStamp'>,
  acc: WheelAccumulator
): number {
  const raw = e.deltaY !== 0 ? e.deltaY : e.deltaX;
  return acc.add(normalizeWheelDelta(raw, e.deltaMode), e.timeStamp);
}

/**
 * Accumulates normalized wheel deltas into discrete zoom level steps.
 *
 * One classic mouse notch (|deltaY| ≈ 100–120 px) emits one step immediately;
 * trackpad streams of small deltas accumulate until the step size. The
 * accumulator resets after an idle gap or when the scroll direction flips.
 *
 * Returns zoom steps: positive = zoom in (wheel up / negative deltaY).
 */
export class WheelAccumulator {
  private acc = 0;
  private lastTime = -Infinity;

  constructor(
    private stepSize = 100,
    private idleResetMs = 250
  ) {}

  add(deltaPx: number, timestampMs: number): number {
    if (timestampMs - this.lastTime > this.idleResetMs) this.acc = 0;
    if (this.acc !== 0 && Math.sign(deltaPx) !== Math.sign(this.acc)) this.acc = 0;
    this.lastTime = timestampMs;
    this.acc += deltaPx;

    const steps = Math.trunc(this.acc / this.stepSize);
    this.acc -= steps * this.stepSize;
    return steps === 0 ? 0 : -steps;
  }
}

/**
 * Largest per-event delta (px) that still reads as fine-grained. A notched
 * wheel reports a whole notch at once — 100 in Chromium, 120 on Windows,
 * ~102 for Firefox's pixel mode — so anything well below that came from a
 * device reporting continuous travel.
 */
export const FINE_WHEEL_MAX_DELTA = 50;

/** Idle gap (ms) that ends a wheel stream for classification purposes. */
export const WHEEL_STREAM_IDLE_MS = 250;

/**
 * Whether one wheel event carries positive evidence of a fine-grained
 * (trackpad, precision wheel, synthetic pinch) source rather than a notched
 * mouse wheel. Absence of evidence is not evidence of a mouse — see
 * WheelStreamClassifier, which is what callers should use.
 */
export function isFineWheelEvent(e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>): boolean {
  // Line and page deltas are a notched wheel by construction: a precision
  // device has sub-line travel to report and never picks those units.
  if (e.deltaMode !== 0) return false;
  const { deltaX, deltaY } = e;
  if (!Number.isInteger(deltaX) || !Number.isInteger(deltaY)) return true;
  // No mouse drives both axes at once; a trackpad barely avoids it.
  if (deltaX !== 0 && deltaY !== 0) return true;
  const magnitude = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  return magnitude > 0 && magnitude < FINE_WHEEL_MAX_DELTA;
}

/**
 * Classifies a wheel STREAM as fine-grained or notched, sticky until the
 * stream goes idle.
 *
 * Sticky because the evidence is one-sided. A trackpad flick starts with
 * small deltas and then hands off to momentum, which reports large round
 * numbers indistinguishable from notches; a mouse never reports the small
 * ones. So evidence only ever upgrades a stream to fine, and the verdict
 * holds for the rest of the gesture.
 *
 * Erring toward fine is the safe direction: a precision wheel misread as a
 * trackpad gets smooth zoom, which is what its owner wanted anyway. The
 * reverse is the #259 bug.
 */
export class WheelStreamClassifier {
  private fine = false;
  private lastTime = -Infinity;

  constructor(private idleResetMs = WHEEL_STREAM_IDLE_MS) {}

  classify(e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'timeStamp'>): boolean {
    if (e.timeStamp - this.lastTime > this.idleResetMs) this.fine = false;
    this.lastTime = e.timeStamp;
    if (!this.fine && isFineWheelEvent(e)) this.fine = true;
    return this.fine;
  }
}

/**
 * Zoom ratio per pixel of fine wheel travel. 100px of travel is ~1.65x,
 * a shade faster than the level ladder's ~1.4x per notch — a trackpad user
 * asks for the same zoom range with less finger travel (#259).
 */
export const WHEEL_ZOOM_SENSITIVITY = 0.005;

/**
 * Continuous zoom multiplier for one fine wheel event: scale-invariant
 * (exponential), so the same finger travel covers the same ratio at any
 * zoom, splitting a gesture across events changes nothing, and scrolling
 * back lands exactly where it started.
 */
export function wheelZoomRatio(deltaPx: number, sensitivity = WHEEL_ZOOM_SENSITIVITY): number {
  return Math.exp(-deltaPx * sensitivity);
}

/** Distance between the first two points; 0 when fewer than two. */
export function pinchDistance(points: readonly Point[]): number {
  if (points.length < 2) return 0;
  const dx = points[1].x - points[0].x;
  const dy = points[1].y - points[0].y;
  return Math.hypot(dx, dy);
}

/** Midpoint of the first two points; origin when fewer than two. */
export function pinchMidpoint(points: readonly Point[]): Point {
  if (points.length < 2) return { x: 0, y: 0 };
  return {
    x: (points[0].x + points[1].x) / 2,
    y: (points[0].y + points[1].y) / 2
  };
}
