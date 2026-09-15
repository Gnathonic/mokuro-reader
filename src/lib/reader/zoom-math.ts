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

/**
 * Native wheel ticks per detent. Gecko's kNativeTicksToWheelDelta, Blink's
 * kTickMultiplier and WebKit's TickMultiplier are all 120, so `wheelDeltaY`
 * counts physical detents identically in every engine — the one quantity in
 * the wheel API that is about the *device* rather than about scroll policy.
 */
export const WHEEL_DELTA_PER_TICK = 120;

/**
 * Pixels per line for a LINE-mode event. Unreachable from real Gecko input —
 * normalizeWheel reads `deltaY` before `deltaMode`, which pins Gecko to PIXEL
 * mode — so this only serves synthetic events. 22 is the measured Gecko
 * conversion at a default 16px browser font, not the folklore 40.
 */
export const FALLBACK_PX_PER_LINE = 22;

/** Pixels per PAGE-mode unit, when no container height is available. */
export const FALLBACK_PX_PER_PAGE = 800;

/**
 * Pixels standing in for one detent when the platform reports no ticks
 * (Gecko on macOS emits none). Chromium's Linux detent exactly; Gecko's
 * pixel-mode detent measures 132, a 1.10x residual.
 */
export const FALLBACK_PX_PER_TICK = 120;

/**
 * The wheel-event shape the normalizer reads — real WheelEvents satisfy it,
 * and tests construct it directly. `wheelDelta*` are the legacy per-axis
 * detent counts: non-standard, but implemented by all three engines and the
 * only device-derived quantity the wheel API exposes.
 */
export interface WheelDeltaSource {
  deltaX?: number;
  deltaY: number;
  deltaMode: number;
  wheelDeltaX?: number;
  wheelDeltaY?: number;
}

/** One wheel event, normalized once. See {@link normalizeWheel}. */
export interface NormalizedWheel {
  /** Detents of physical rotation, signed like deltaY. Null if unreported. */
  ticks: number | null;
  /** Signed CSS-pixel travel on the dominant axis (deltaY, else deltaX). */
  px: number;
  /** Signed CSS-pixel travel per axis, for panning and scroll forwarding. */
  pxX: number;
  pxY: number;
  /** True when both axes moved at once — no mouse does that. */
  bothAxes: boolean;
}

/**
 * Per-event memo. Gecko decides an event's UNITS from whichever delta
 * property is touched first and latches that for every listener, so the read
 * below must happen exactly once per event; a second reader in a different
 * order would otherwise see different numbers from the same event.
 */
const normalizedWheels = new WeakMap<object, NormalizedWheel>();

/**
 * The single place wheel deltas are read.
 *
 * Gecko ships a compat shim (`mDeltaModeCheckingState`, bug 1392460) that
 * reports LINE units to code which asks for `deltaMode` first and PIXEL units
 * to code which asks for a delta first — measured on one machine, same
 * detent: `deltaMode` first gives `{mode: 1, deltaY: 6}`, `deltaY` first gives
 * `{mode: 0, deltaY: 132}`. The latch is per-event and shared, so a stray
 * `console.log(e.deltaMode)` in any other listener silently changes the units
 * everyone else sees. Reading `wheelDeltaY` is neutral — it never touches the
 * latch — so ticks and pixels can both be taken from the same event.
 *
 * Order below is load-bearing: ticks first (free), then a delta to pin PIXEL
 * mode, and only then `deltaMode`.
 */
export function normalizeWheel(e: WheelDeltaSource): NormalizedWheel {
  const cached = normalizedWheels.get(e as object);
  if (cached) return cached;

  const wheelDeltaX = e.wheelDeltaX;
  const wheelDeltaY = e.wheelDeltaY;
  const deltaX = e.deltaX ?? 0;
  const deltaY = e.deltaY;
  const deltaMode = e.deltaMode;

  const scale = deltaMode === 1 ? FALLBACK_PX_PER_LINE : deltaMode === 2 ? FALLBACK_PX_PER_PAGE : 1;
  const pxX = deltaX * scale;
  const pxY = deltaY * scale;

  // Shift+wheel moves the notch to the X axis in Chromium, so take ticks
  // from whichever axis actually moved. wheelDelta* runs opposite to delta*;
  // negate so ticks read like a delta.
  const legacyDelta = deltaY !== 0 ? wheelDeltaY : (wheelDeltaX ?? wheelDeltaY);
  const ticks =
    typeof legacyDelta === 'number' && legacyDelta !== 0
      ? -legacyDelta / WHEEL_DELTA_PER_TICK
      : null;

  const normalized: NormalizedWheel = {
    ticks,
    px: deltaY !== 0 ? pxY : pxX,
    pxX,
    pxY,
    bothAxes: deltaX !== 0 && deltaY !== 0
  };
  normalizedWheels.set(e as object, normalized);
  return normalized;
}

/**
 * Travel in detents — the currency both the zoom ladder and the gap chord
 * step in. Falls back to pixels only when the platform reports no ticks.
 */
export function wheelTickDelta(n: NormalizedWheel): number {
  return n.ticks !== null ? n.ticks : n.px / FALLBACK_PX_PER_TICK;
}

/** Upper bound shared by the gap sliders and the wheel chord (px). */
export const MAX_PAGE_GAP = 100;

/** Gap px per detent: one notch adjusts the gap by 5px. */
export const GAP_PX_PER_TICK = 5;

/** Detents per gap step, so one notch emits GAP_PX_PER_TICK steps of 1px. */
export const GAP_WHEEL_STEP_SIZE = 1 / GAP_PX_PER_TICK;

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
 * (wheel up). Steps in detents through the shared chokepoint, so one notch
 * moves the gap by GAP_PX_PER_TICK on every browser. With shift held
 * Chromium reports the notch in deltaX while Firefox keeps deltaY;
 * normalizeWheel already picks whichever axis moved. Feed each surface's own
 * WheelAccumulator(GAP_WHEEL_STEP_SIZE) so trackpad streams accumulate
 * instead of stalling below one step.
 */
export function gapWheelSteps(
  e: WheelDeltaSource & { timeStamp: number },
  acc: WheelAccumulator
): number {
  return acc.add(wheelTickDelta(normalizeWheel(e)), e.timeStamp);
}

/**
 * Accumulates wheel travel into discrete steps.
 *
 * Units are the caller's: zoom and the gap chord both feed it detents
 * (wheelTickDelta), so one detent is one step and a free-spinning wheel's
 * eight sub-detent fragments add up to exactly the same thing. The
 * accumulator resets after an idle gap or when the direction flips.
 *
 * A single event may legitimately carry several steps — both engines
 * coalesce a backlog by *summing* deltas and ticks — so nothing is capped.
 *
 * Returns steps: positive = zoom in (wheel up / negative deltaY).
 */
const STEP_EPS = 1e-9;

export class WheelAccumulator {
  private acc = 0;
  private lastTime = -Infinity;

  constructor(
    private stepSize = 1,
    private idleResetMs = 250
  ) {}

  add(delta: number, timestampMs: number): number {
    if (timestampMs - this.lastTime > this.idleResetMs) this.acc = 0;
    if (this.acc !== 0 && Math.sign(delta) !== Math.sign(this.acc)) this.acc = 0;
    this.lastTime = timestampMs;
    this.acc += delta;

    // Nudge by an epsilon before truncating: fractional detents are summed
    // in floating point, so six 20/120 fragments land on 0.9999999999999999
    // and would silently lose a whole step.
    const steps = Math.trunc((this.acc + Math.sign(this.acc) * STEP_EPS) / this.stepSize);
    this.acc -= steps * this.stepSize;
    return steps === 0 ? 0 : -steps;
  }
}

/**
 * Largest per-event delta (px) that still reads as fine-grained. Only used
 * where ticks are unavailable — see FINE_WHEEL_MAX_TICKS, which is the real
 * rule. A detent measures 120px in Chromium, 132 in Gecko's pixel mode (a
 * function of the *browser's default-font* preference, not page CSS and not
 * display scale — 258px at a 32px default), and 100 in Chromium on Windows.
 */
export const FINE_WHEEL_MAX_DELTA = 50;

/**
 * Largest per-event travel, in detents, that still reads as fine-grained.
 *
 * Sub-detent travel is what a precision device reports and a notched wheel
 * cannot. A free-spinning wheel fragments one detent into eight 0.125-tick
 * events, which sit above this line on purpose: they are still a wheel, and
 * accumulating them lands on exactly the same rung as one ratcheted detent.
 */
export const FINE_WHEEL_MAX_TICKS = 0.1;

/** Idle gap (ms) that ends a wheel stream for classification purposes. */
export const WHEEL_STREAM_IDLE_MS = 250;

/**
 * Whether one wheel event carries positive evidence of a fine-grained
 * (trackpad, precision wheel, synthetic pinch) source rather than a notched
 * mouse wheel. Absence of evidence is not evidence of a mouse — see
 * WheelStreamClassifier, which is what callers should use.
 *
 * Sub-detent travel is the evidence. Pixel magnitude is not: the pixels
 * attached to one detent are a scroll-policy answer, not a measurement, and
 * range from 100 (Chromium/Windows) to 258 (Gecko at a 32px default font)
 * for the identical physical action. Judging a mouse by them classified
 * every Gecko wheel as a trackpad (#272) — and still misreads a real notched
 * mouse on Chromium/macOS, whose detent is 4.0002px.
 *
 * `ctrlOrMeta` suppresses the tick rule because a synthetic pinch's tick
 * count is a fiction — Blink stamps +/-1 on a pinch whatever its magnitude —
 * so pinch is judged by its (small, fractional) pixels, as before.
 */
export function isFineWheelEvent(e: WheelDeltaSource, ctrlOrMeta = false): boolean {
  const n = normalizeWheel(e);
  // No mouse drives both axes at once; a trackpad barely avoids it.
  if (n.bothAxes) return true;
  if (n.ticks !== null && !ctrlOrMeta) {
    const ticks = Math.abs(n.ticks);
    return ticks > 0 && ticks < FINE_WHEEL_MAX_TICKS;
  }
  // No ticks reported (Gecko on macOS) or a pinch: fall back to pixels.
  if (e.deltaMode !== 0) return false;
  const magnitude = Math.abs(n.px);
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

  classify(e: WheelDeltaSource & { timeStamp: number }, ctrlOrMeta = false): boolean {
    if (e.timeStamp - this.lastTime > this.idleResetMs) this.fine = false;
    this.lastTime = e.timeStamp;
    if (!this.fine && isFineWheelEvent(e, ctrlOrMeta)) this.fine = true;
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
