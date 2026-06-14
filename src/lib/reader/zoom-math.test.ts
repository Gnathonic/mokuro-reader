import { describe, it, expect } from 'vitest';
import {
  anchorFraction,
  anchorScreenPosition,
  zoomProgress,
  lerp2,
  nearestZoomLevel,
  nextZoomLevel,
  wheelIntentIsZoom,
  normalizeWheelDelta,
  WheelAccumulator,
  pinchDistance,
  pinchMidpoint
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
});

describe('normalizeWheelDelta', () => {
  it('passes pixel deltas through (deltaMode 0)', () => {
    expect(normalizeWheelDelta(-100, 0)).toBe(-100);
  });

  it('converts line deltas (deltaMode 1, Firefox)', () => {
    expect(normalizeWheelDelta(-3, 1)).toBe(-120);
  });

  it('converts page deltas (deltaMode 2)', () => {
    expect(normalizeWheelDelta(1, 2)).toBe(800);
  });
});

describe('WheelAccumulator', () => {
  it('emits one zoom-in step for a single mouse-wheel notch up', () => {
    const acc = new WheelAccumulator();
    expect(acc.add(-120, 1000)).toBe(1);
  });

  it('emits one zoom-out step for a notch down', () => {
    const acc = new WheelAccumulator();
    expect(acc.add(120, 1000)).toBe(-1);
  });

  it('emits multiple steps for a large delta', () => {
    const acc = new WheelAccumulator();
    expect(acc.add(-240, 1000)).toBe(2);
  });

  it('accumulates small trackpad deltas until the step size', () => {
    const acc = new WheelAccumulator();
    let steps = 0;
    let t = 1000;
    for (let i = 0; i < 12; i++) {
      steps += acc.add(-10, t);
      t += 16;
    }
    expect(steps).toBe(1);
  });

  it('resets after an idle gap', () => {
    const acc = new WheelAccumulator();
    acc.add(-90, 1000);
    // 90 accumulated, but 500ms later the remnant is stale
    expect(acc.add(-30, 1500)).toBe(0);
  });

  it('resets when the direction flips', () => {
    const acc = new WheelAccumulator();
    acc.add(-90, 1000);
    expect(acc.add(60, 1016)).toBe(0);
    expect(acc.add(60, 1032)).toBe(-1);
  });

  it('keeps the remainder after emitting steps', () => {
    const acc = new WheelAccumulator();
    expect(acc.add(-150, 1000)).toBe(1);
    expect(acc.add(-50, 1016)).toBe(1);
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
