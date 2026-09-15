import { describe, it, expect } from 'vitest';
import {
  anchorFraction,
  anchorScreenPosition,
  zoomProgress,
  lerp2,
  nearestZoomLevel,
  nextZoomLevel,
  wheelIntentIsZoom,
  wheelIntentIsGapAdjust,
  gapWheelSteps,
  GAP_WHEEL_STEP_SIZE,
  normalizeWheel,
  wheelTickDelta,
  WheelAccumulator,
  pinchDistance,
  pinchMidpoint,
  isFineWheelEvent,
  WheelStreamClassifier,
  wheelZoomRatio,
  WHEEL_ZOOM_SENSITIVITY
} from './zoom-math';

describe('anchorFraction', () => {
  const rect = { left: 100, top: 200, width: 400, height: 600 };

  it('returns 0.5/0.5 for the rect center', () => {
    expect(anchorFraction(rect, 300, 500)).toEqual({ fx: 0.5, fy: 0.5 });
  });

  it('returns 0/0 for the top-left corner', () => {
    expect(anchorFraction(rect, 100, 200)).toEqual({ fx: 0, fy: 0 });
  });

  it('extrapolates outside the rect', () => {
    const { fx, fy } = anchorFraction(rect, 0, 1100);
    expect(fx).toBe(-0.25);
    expect(fy).toBe(1.5);
  });

  it('guards against zero-size rects', () => {
    const { fx, fy } = anchorFraction({ left: 100, top: 200, width: 0, height: 0 }, 300, 500);
    expect(fx).toBe(0);
    expect(fy).toBe(0);
  });
});

describe('anchorScreenPosition', () => {
  it('is the inverse of anchorFraction', () => {
    const rect = { left: 100, top: 200, width: 400, height: 600 };
    const { fx, fy } = anchorFraction(rect, 250, 380);
    expect(anchorScreenPosition(rect, fx, fy)).toEqual({ x: 250, y: 380 });
  });

  it('tracks the anchor on a scaled rect (zoomed measurement)', () => {
    // Same content point measured after the rect doubled (transform: scale(2))
    const zoomedRect = { left: -50, top: 0, width: 800, height: 1200 };
    expect(anchorScreenPosition(zoomedRect, 0.5, 0.25)).toEqual({ x: 350, y: 300 });
  });
});

describe('zoomProgress', () => {
  it('is 0 at the start zoom', () => {
    expect(zoomProgress(1, 1, 2)).toBe(0);
  });

  it('is 0.5 halfway', () => {
    expect(zoomProgress(1.5, 1, 2)).toBe(0.5);
  });

  it('is 1 at the target', () => {
    expect(zoomProgress(2, 1, 2)).toBe(1);
  });

  it('works zooming out', () => {
    expect(zoomProgress(1.5, 2, 1)).toBe(0.5);
  });

  it('clamps overshoot', () => {
    expect(zoomProgress(2.5, 1, 2)).toBe(1);
    expect(zoomProgress(0.5, 1, 2)).toBe(0);
  });

  it('returns 1 when target equals start (snapTo/pinch degenerate case, never NaN)', () => {
    expect(zoomProgress(1.7, 1.7, 1.7)).toBe(1);
    expect(zoomProgress(1, 1, 1)).toBe(1);
  });
});

describe('lerp2', () => {
  it('interpolates between two points', () => {
    expect(lerp2({ x: 0, y: 100 }, { x: 200, y: 0 }, 0.25)).toEqual({ x: 50, y: 75 });
  });

  it('returns endpoints at t=0 and t=1', () => {
    const a = { x: 3, y: 4 };
    const b = { x: 7, y: 8 };
    expect(lerp2(a, b, 0)).toEqual(a);
    expect(lerp2(a, b, 1)).toEqual(b);
  });

  it('returns the point when both endpoints coincide, even for non-finite t', () => {
    const a = { x: 5, y: 6 };
    expect(lerp2(a, { x: 5, y: 6 }, NaN)).toEqual(a);
  });
});

describe('nearestZoomLevel', () => {
  const levels = [1, 1.5, 2, 3];

  it('snaps to the closest level', () => {
    expect(nearestZoomLevel(levels, 1.7)).toBe(1.5);
    expect(nearestZoomLevel(levels, 1.8)).toBe(2);
    expect(nearestZoomLevel(levels, 5)).toBe(3);
    expect(nearestZoomLevel(levels, 0.2)).toBe(1);
  });

  it('keeps the lower level on an exact tie', () => {
    expect(nearestZoomLevel(levels, 1.75)).toBe(1.5);
  });
});

describe('nextZoomLevel', () => {
  const levels = [1, 1.5, 2, 3];

  it('steps up and down from a level', () => {
    expect(nextZoomLevel(levels, 1.5, 1)).toBe(2);
    expect(nextZoomLevel(levels, 1.5, -1)).toBe(1);
  });

  it('clamps at the ends', () => {
    expect(nextZoomLevel(levels, 3, 1)).toBe(3);
    expect(nextZoomLevel(levels, 1, -1)).toBe(1);
  });

  it('resolves an off-level zoom (e.g. after a pinch) to the adjacent level', () => {
    expect(nextZoomLevel(levels, 1.7, 1)).toBe(2);
    expect(nextZoomLevel(levels, 1.7, -1)).toBe(1.5);
  });

  it('handles off-level zoom beyond the ends', () => {
    expect(nextZoomLevel(levels, 0.5, 1)).toBe(1);
    expect(nextZoomLevel(levels, 0.5, -1)).toBe(1);
    expect(nextZoomLevel(levels, 4, 1)).toBe(3);
    expect(nextZoomLevel(levels, 4, -1)).toBe(3);
  });
});

describe('wheelIntentIsZoom', () => {
  it('requires ctrl/meta by default', () => {
    expect(wheelIntentIsZoom(true, false)).toBe(true);
    expect(wheelIntentIsZoom(false, false)).toBe(false);
  });

  it('inverts with swapWheelBehavior', () => {
    expect(wheelIntentIsZoom(false, true)).toBe(true);
    expect(wheelIntentIsZoom(true, true)).toBe(false);
  });

  it('treats a fine ctrl+wheel as a trackpad pinch, whatever the swap setting', () => {
    expect(wheelIntentIsZoom(true, true, true)).toBe(true);
    expect(wheelIntentIsZoom(true, false, true)).toBe(true);
  });

  it('leaves a fine bare wheel to the swap setting', () => {
    expect(wheelIntentIsZoom(false, true, true)).toBe(true);
    expect(wheelIntentIsZoom(false, false, true)).toBe(false);
  });
});

describe('normalizeWheel', () => {
  it('reads ticks from the legacy wheelDelta, which is 120 per detent everywhere', () => {
    // Gecko kNativeTicksToWheelDelta == Blink kTickMultiplier == WebKit
    // TickMultiplier == 120. Measured identical in Firefox 154 and
    // Chromium 151 for the same physical detent.
    expect(normalizeWheel({ deltaX: 0, deltaY: 132, deltaMode: 0, wheelDeltaY: -120 }).ticks).toBe(
      1
    );
    expect(normalizeWheel({ deltaX: 0, deltaY: 120, deltaMode: 0, wheelDeltaY: -120 }).ticks).toBe(
      1
    );
    expect(normalizeWheel({ deltaX: 0, deltaY: -100, deltaMode: 0, wheelDeltaY: 120 }).ticks).toBe(
      -1
    );
  });

  it('reads a free-spin fragment as an exact eighth of a detent', () => {
    const n = normalizeWheel({ deltaX: 0, deltaY: 16.5, deltaMode: 0, wheelDeltaY: -15 });
    expect(n.ticks).toBeCloseTo(0.125, 10);
  });

  it('takes ticks from the X axis when shift moved the notch there', () => {
    const n = normalizeWheel({ deltaX: -100, deltaY: 0, deltaMode: 0, wheelDeltaX: 120 });
    expect(n.ticks).toBe(-1);
  });

  it('reports no ticks when the platform omits them (Gecko on macOS)', () => {
    expect(normalizeWheel({ deltaX: 0, deltaY: -100, deltaMode: 0 }).ticks).toBeNull();
  });

  it('falls back to pixels-per-detent when ticks are absent', () => {
    const n = normalizeWheel({ deltaX: 0, deltaY: -120, deltaMode: 0 });
    expect(wheelTickDelta(n)).toBe(-1);
  });

  it('keeps per-axis pixels for panning', () => {
    const n = normalizeWheel({ deltaX: -30, deltaY: 12, deltaMode: 0 });
    expect([n.pxX, n.pxY]).toEqual([-30, 12]);
    expect(n.bothAxes).toBe(true);
  });

  it('scales synthetic line and page deltas', () => {
    expect(normalizeWheel({ deltaX: 0, deltaY: -3, deltaMode: 1 }).px).toBe(-66);
    expect(normalizeWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }).px).toBe(800);
  });

  it('memoizes per event, so a second reader cannot re-latch Gecko units', () => {
    const e = { deltaX: 0, deltaY: 132, deltaMode: 0, wheelDeltaY: -120 };
    expect(normalizeWheel(e)).toBe(normalizeWheel(e));
  });
});

describe('WheelAccumulator', () => {
  it('emits one zoom-in step for a single detent up', () => {
    expect(new WheelAccumulator().add(-1, 1000)).toBe(1);
  });

  it('emits one zoom-out step for a detent down', () => {
    expect(new WheelAccumulator().add(1, 1000)).toBe(-1);
  });

  it('emits several steps when the browser coalesced several detents', () => {
    // Both engines coalesce a backlog by SUMMING ticks, so a multi-detent
    // event is a real multi-detent gesture and must not be capped.
    expect(new WheelAccumulator().add(-2, 1000)).toBe(2);
  });

  it('accumulates a free-spinning wheel into exactly one rung per detent', () => {
    const acc = new WheelAccumulator();
    let steps = 0;
    for (let i = 0; i < 8; i++) steps += acc.add(-0.125, 1000 + i * 12);
    expect(steps).toBe(1);
  });

  it('accumulates sub-detent trackpad travel until a whole step', () => {
    const acc = new WheelAccumulator();
    let steps = 0;
    for (let i = 0; i < 12; i++) steps += acc.add(-1 / 12, 1000 + i * 16);
    expect(steps).toBe(1);
  });

  it('resets after an idle gap', () => {
    const acc = new WheelAccumulator();
    acc.add(-0.9, 1000);
    expect(acc.add(-0.3, 1500)).toBe(0);
  });

  it('resets when the direction flips', () => {
    const acc = new WheelAccumulator();
    acc.add(-0.9, 1000);
    expect(acc.add(0.6, 1016)).toBe(0);
    expect(acc.add(0.6, 1032)).toBe(-1);
  });

  it('keeps the remainder after emitting steps', () => {
    const acc = new WheelAccumulator();
    expect(acc.add(-1.5, 1000)).toBe(1);
    expect(acc.add(-0.5, 1016)).toBe(1);
  });
});

describe('pinchDistance / pinchMidpoint', () => {
  it('computes distance and midpoint of two points', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 30, y: 40 }
    ];
    expect(pinchDistance(pts)).toBe(50);
    expect(pinchMidpoint(pts)).toEqual({ x: 15, y: 20 });
  });

  it('returns safe values with fewer than two points', () => {
    expect(pinchDistance([{ x: 5, y: 5 }])).toBe(0);
    expect(pinchMidpoint([])).toEqual({ x: 0, y: 0 });
  });
});

describe('wheelIntentIsGapAdjust', () => {
  it('requires ctrl or meta plus shift', () => {
    expect(wheelIntentIsGapAdjust({ ctrlKey: true, metaKey: false, shiftKey: true })).toBe(true);
    expect(wheelIntentIsGapAdjust({ ctrlKey: false, metaKey: true, shiftKey: true })).toBe(true);
  });

  it('rejects partial chords', () => {
    expect(wheelIntentIsGapAdjust({ ctrlKey: true, metaKey: false, shiftKey: false })).toBe(false);
    expect(wheelIntentIsGapAdjust({ ctrlKey: false, metaKey: false, shiftKey: true })).toBe(false);
    expect(wheelIntentIsGapAdjust({ ctrlKey: false, metaKey: false, shiftKey: false })).toBe(false);
  });
});

describe('gapWheelSteps', () => {
  const acc = () => new WheelAccumulator(GAP_WHEEL_STEP_SIZE);

  it('one notch widens by 5px when shift swaps the delta to deltaX (Chromium)', () => {
    const px = gapWheelSteps(
      { deltaX: -100, deltaY: 0, deltaMode: 0, wheelDeltaX: 120, timeStamp: 1000 },
      acc()
    );
    expect(px).toBe(5);
  });

  it('prefers deltaY when the browser keeps it there (Firefox)', () => {
    const px = gapWheelSteps(
      { deltaX: 7, deltaY: -132, deltaMode: 0, wheelDeltaY: 120, timeStamp: 1000 },
      acc()
    );
    expect(px).toBe(5);
  });

  it('gives a Firefox notch the same 5px as a Chromium one', () => {
    // The whole point of the detent currency: 132px and 120px are the same
    // physical action, so they must move the gap by the same amount.
    const ff = gapWheelSteps(
      { deltaX: 0, deltaY: 132, deltaMode: 0, wheelDeltaY: -120, timeStamp: 1000 },
      acc()
    );
    const cr = gapWheelSteps(
      { deltaX: 0, deltaY: 120, deltaMode: 0, wheelDeltaY: -120, timeStamp: 1000 },
      acc()
    );
    expect(ff).toBe(cr);
    expect(ff).toBe(-5);
  });

  it('accumulates a trackpad stream of sub-step deltas into whole px', () => {
    const a = acc();
    let total = 0;
    for (let i = 0; i < 4; i++) {
      total += gapWheelSteps({ deltaX: 0, deltaY: -6, deltaMode: 0, timeStamp: 1000 + i * 16 }, a);
    }
    expect(total).toBe(1);
  });
});

describe('isFineWheelEvent', () => {
  const ev = (deltaY: number, deltaX = 0, deltaMode = 0) => ({ deltaX, deltaY, deltaMode });
  /** A real detent: whatever pixels the engine chose, plus its tick count. */
  const detent = (deltaY: number, wheelDeltaY = -120) => ({
    deltaX: 0,
    deltaY,
    deltaMode: 0,
    wheelDeltaY
  });

  it('rejects a detent whatever pixel value the engine attached to it (#272)', () => {
    // The identical physical notch, as measured across engines and settings.
    expect(isFineWheelEvent(detent(120))).toBe(false); // Chromium/Linux
    expect(isFineWheelEvent(detent(100))).toBe(false); // Chromium/Windows
    expect(isFineWheelEvent(detent(132))).toBe(false); // Gecko, 16px default font
    expect(isFineWheelEvent(detent(258))).toBe(false); // Gecko, 32px default font
    expect(isFineWheelEvent(detent(4.0002))).toBe(false); // Chromium/macOS
  });

  it('rejects a free-spin fragment — still a wheel, eight to the detent', () => {
    expect(isFineWheelEvent(detent(16.5, -15))).toBe(false);
  });

  it('accepts sub-detent travel', () => {
    expect(isFineWheelEvent(detent(1, -6))).toBe(true);
    expect(isFineWheelEvent(detent(2.5, -3))).toBe(true);
  });

  it('accepts simultaneous two-axis deltas — no mouse steers both at once', () => {
    expect(isFineWheelEvent({ deltaX: 3, deltaY: -110, deltaMode: 0, wheelDeltaY: 120 })).toBe(
      true
    );
  });

  it('judges a pinch by pixels, because its tick count is a fiction', () => {
    // Blink stamps wheel_ticks_y = +/-1 on a synthetic pinch whatever its
    // magnitude, so the tick rule would call every pinch a notched wheel.
    expect(isFineWheelEvent({ deltaX: 0, deltaY: -3, deltaMode: 0, wheelDeltaY: 120 }, true)).toBe(
      true
    );
    // A real ctrl+wheel keyboard chord carries a full notch of pixels.
    expect(
      isFineWheelEvent({ deltaX: 0, deltaY: -120, deltaMode: 0, wheelDeltaY: 120 }, true)
    ).toBe(false);
  });

  describe('without ticks (Gecko on macOS, synthetic events)', () => {
    it('falls back to pixel magnitude', () => {
      expect(isFineWheelEvent(ev(-100))).toBe(false);
      expect(isFineWheelEvent(ev(-8))).toBe(true);
    });

    it('rejects line and page deltas — only a notched wheel reports them', () => {
      expect(isFineWheelEvent(ev(-3, 0, 1))).toBe(false);
      expect(isFineWheelEvent(ev(-1, 0, 2))).toBe(false);
    });
  });

  it('reads no evidence from an empty delta', () => {
    expect(isFineWheelEvent(ev(0))).toBe(false);
  });
});

describe('WheelStreamClassifier', () => {
  it('stays coarse for a Firefox notched wheel reporting fractional pixels (#272)', () => {
    const c = new WheelStreamClassifier();
    // Three detents, Firefox pixel mode on a scaled display.
    expect(c.classify({ deltaX: 0, deltaY: -204.8, deltaMode: 0, timeStamp: 1000 })).toBe(false);
    expect(c.classify({ deltaX: 0, deltaY: -204.8, deltaMode: 0, timeStamp: 1120 })).toBe(false);
    expect(c.classify({ deltaX: 0, deltaY: -204.8, deltaMode: 0, timeStamp: 1240 })).toBe(false);
  });

  it('stays coarse for a notched-wheel stream', () => {
    const c = new WheelStreamClassifier();
    expect(c.classify({ deltaX: 0, deltaY: -100, deltaMode: 0, timeStamp: 1000 })).toBe(false);
    expect(c.classify({ deltaX: 0, deltaY: -100, deltaMode: 0, timeStamp: 1050 })).toBe(false);
  });

  it('holds the fine verdict through momentum spikes later in the stream', () => {
    const c = new WheelStreamClassifier();
    expect(c.classify({ deltaX: 0, deltaY: -3, deltaMode: 0, timeStamp: 1000 })).toBe(true);
    // macOS momentum turns a flick into large round deltas mid-gesture.
    expect(c.classify({ deltaX: 0, deltaY: -240, deltaMode: 0, timeStamp: 1016 })).toBe(true);
  });

  it('re-classifies after the stream goes idle', () => {
    const c = new WheelStreamClassifier();
    c.classify({ deltaX: 0, deltaY: -3, deltaMode: 0, timeStamp: 1000 });
    expect(c.classify({ deltaX: 0, deltaY: -120, deltaMode: 0, timeStamp: 2000 })).toBe(false);
  });
});

describe('wheelZoomRatio', () => {
  it('zooms in on wheel-up and out on wheel-down', () => {
    expect(wheelZoomRatio(-100)).toBeGreaterThan(1);
    expect(wheelZoomRatio(100)).toBeLessThan(1);
    expect(wheelZoomRatio(0)).toBe(1);
  });

  it('is exponential, so a split gesture equals the whole one', () => {
    const whole = wheelZoomRatio(-90);
    const split = wheelZoomRatio(-30) * wheelZoomRatio(-60);
    expect(split).toBeCloseTo(whole, 10);
  });

  it('is symmetric — scrolling back undoes the zoom exactly', () => {
    expect(wheelZoomRatio(-40) * wheelZoomRatio(40)).toBeCloseTo(1, 10);
  });

  it('moves immediately for a small nudge', () => {
    expect(wheelZoomRatio(-10)).toBeCloseTo(Math.exp(10 * WHEEL_ZOOM_SENSITIVITY), 10);
  });
});
