import { describe, it, expect } from 'vitest';
import { alignPosition, baseTransform, clampTranslate, panEdgeState } from './paged-zoom-layout';

const viewport = { width: 1600, height: 900 };

describe('baseTransform', () => {
  // A typical manga spread: two 700x1000 pages side by side
  const spread = { width: 1400, height: 1000 };
  // A single tall page
  const tall = { width: 700, height: 1000 };

  it('fit-to-screen scales by the limiting axis and centers both axes', () => {
    const t = baseTransform('zoomFitToScreen', tall, viewport, true);
    expect(t.scale).toBeCloseTo(0.9, 6); // 900/1000 limits
    expect(t.x).toBeCloseTo((1600 - 700 * 0.9) / 2, 6);
    expect(t.y).toBeCloseTo(0, 6);
    expect(t.alignX).toBe('center');
    expect(t.alignY).toBe('center');
  });

  it('fit-to-screen limits by width for wide content', () => {
    const wide = { width: 3200, height: 900 };
    const t = baseTransform('zoomFitToScreen', wide, viewport, true);
    expect(t.scale).toBeCloseTo(0.5, 6);
    expect(t.y).toBeCloseTo((900 - 900 * 0.5) / 2, 6);
    expect(t.x).toBeCloseTo(0, 6);
  });

  it('fit-to-width fills the viewport width, top-aligned', () => {
    const t = baseTransform('zoomFitToWidth', spread, viewport, true);
    expect(t.scale).toBeCloseTo(1600 / 1400, 6);
    expect(t.x).toBeCloseTo(0, 6);
    expect(t.y).toBe(0);
    expect(t.alignY).toBe('start');
  });

  it('original is 1:1; fitting axes center, overflowing axes start at the top', () => {
    // tall: width (700) fits the 1600 viewport → centered, never pinned to
    // the corner; height (1000) overflows the 900 viewport → reading start.
    const t = baseTransform('zoomOriginal', tall, viewport, true);
    expect(t.scale).toBe(1);
    expect(t.x).toBe((1600 - 700) / 2);
    expect(t.y).toBe(0);
    expect(t.alignX).toBe('end');
    expect(t.alignY).toBe('start');
  });

  it('original: an overflowing width starts at the reading corner (RTL → right edge)', () => {
    const wide = { width: 2400, height: 800 };
    const rtl = baseTransform('zoomOriginal', wide, viewport, true);
    expect(rtl.x).toBe(1600 - 2400); // right edge of the spread visible
    const ltr = baseTransform('zoomOriginal', wide, viewport, false);
    expect(ltr.x).toBe(0); // left edge visible
    // height fits → centered, not pinned to the top
    expect(rtl.y).toBe((900 - 800) / 2);
  });

  it('original: a page smaller than the viewport centers on both axes', () => {
    const small = { width: 700, height: 800 };
    const t = baseTransform('zoomOriginal', small, viewport, true);
    expect(t.x).toBe((1600 - 700) / 2);
    expect(t.y).toBe((900 - 800) / 2);
  });

  it('keepZoom uses a fit-to-screen base scale; fitting width centers', () => {
    const t = baseTransform('keepZoom', tall, viewport, true);
    expect(t.scale).toBeCloseTo(0.9, 6);
    expect(t.x).toBeCloseTo((1600 - 700 * 0.9) / 2, 6);
    expect(t.y).toBe(0); // height fits exactly — center == top
  });

  it('treats legacy keepZoom aliases like keepZoom', () => {
    const a = baseTransform('keepZoomStart', tall, viewport, true);
    const b = baseTransform('keepZoomTopCorner', tall, viewport, true);
    const k = baseTransform('keepZoom', tall, viewport, true);
    expect(a).toEqual(k);
    expect(b).toEqual(k);
  });

  it('fillScreen on a tall page fills the width and overflows the height, top-aligned', () => {
    const t = baseTransform('zoomFillScreen', tall, viewport, true);
    expect(t.scale).toBeCloseTo(1600 / 700, 6); // max(1600/700, 900/1000)
    expect(t.x).toBeCloseTo(0, 6); // width fills exactly
    expect(t.y).toBe(0); // overflowing height starts at the top
    expect(t.alignY).toBe('start');
  });

  it('fillScreen on a wide spread fills the height and overflows the width at the reading corner', () => {
    const wide = { width: 3200, height: 900 };
    const rtl = baseTransform('zoomFillScreen', wide, viewport, true);
    expect(rtl.scale).toBeCloseTo(1, 6); // max(0.5, 1)
    expect(rtl.y).toBeCloseTo(0, 6); // height fills exactly
    expect(rtl.x).toBe(1600 - 3200); // RTL reading start — right edge visible
    const ltr = baseTransform('zoomFillScreen', wide, viewport, false);
    expect(ltr.x).toBe(0);
  });

  it('fillScreen matches fit-to-screen when aspects match', () => {
    const matching = { width: 3200, height: 1800 };
    const fill = baseTransform('zoomFillScreen', matching, viewport, true);
    const fit = baseTransform('zoomFitToScreen', matching, viewport, true);
    expect(fill.scale).toBeCloseTo(fit.scale, 6);
    expect(fill.x).toBeCloseTo(fit.x, 6);
    expect(fill.y).toBeCloseTo(fit.y, 6);
  });

  it('guards zero-size content', () => {
    const t = baseTransform('zoomFitToScreen', { width: 0, height: 0 }, viewport, true);
    expect(t.scale).toBe(1);
    expect(Number.isFinite(t.x)).toBe(true);
    expect(Number.isFinite(t.y)).toBe(true);
  });
});

describe('alignPosition', () => {
  it('computes start/center/end from the current sizes', () => {
    expect(alignPosition('start', 1200, 1600)).toBe(0);
    expect(alignPosition('center', 1200, 1600)).toBe(200);
    expect(alignPosition('end', 1200, 1600)).toBe(400);
  });
});

describe('clampTranslate', () => {
  it('centers a fitting axis at the CURRENT scaled size', () => {
    // fitToScreen tall page zoomed to 1.5x: width 1134 still fits 1600 —
    // the lock must center the *scaled* width, not reuse the level-1 position.
    const clamped = clampTranslate({ x: -400, y: -500 }, { width: 1134, height: 1350 }, viewport);
    expect(clamped.x).toBeCloseTo((1600 - 1134) / 2, 6);
    expect(clamped.y).toBe(-450); // overflowing axis clamps to [900-1350, 0]
  });

  it('centers fitting axes in every mode — a fitting page can never pin to an edge', () => {
    // The old behavior locked fitting axes to the mode alignment, welding
    // zoomOriginal/keepZoom pages to the top corner (the reported bug).
    const clamped = clampTranslate({ x: 1100, y: 700 }, { width: 750, height: 600 }, viewport);
    expect(clamped.x).toBe((1600 - 750) / 2);
    expect(clamped.y).toBe((900 - 600) / 2);
  });

  it('clamps an overflowing axis so content edges never pass viewport edges', () => {
    const scaled = { width: 3200, height: 1800 };
    expect(clampTranslate({ x: 50, y: 10 }, scaled, viewport)).toEqual({ x: 0, y: 0 });
    expect(clampTranslate({ x: -2000, y: -1000 }, scaled, viewport)).toEqual({
      x: 1600 - 3200,
      y: 900 - 1800
    });
    expect(clampTranslate({ x: -800, y: -400 }, scaled, viewport)).toEqual({
      x: -800,
      y: -400
    });
  });

  it('coerces non-finite translates inside bounds', () => {
    const clamped = clampTranslate(
      { x: NaN, y: Infinity },
      { width: 3200, height: 1800 },
      viewport
    );
    expect(Number.isFinite(clamped.x)).toBe(true);
    expect(Number.isFinite(clamped.y)).toBe(true);
    expect(clamped.x).toBeLessThanOrEqual(0);
    expect(clamped.x).toBeGreaterThanOrEqual(1600 - 3200);
    expect(clamped.y).toBeLessThanOrEqual(0);
    expect(clamped.y).toBeGreaterThanOrEqual(900 - 1800);
  });
});

describe('panEdgeState', () => {
  it('reports both edges hidden when zoomed content is panned to the middle', () => {
    const s = panEdgeState({ x: -800, y: 0 }, { width: 3200, height: 900 }, viewport);
    expect(s.canRevealLeft).toBe(true);
    expect(s.canRevealRight).toBe(true);
  });

  it('reports the left edge flush when panned fully right', () => {
    const s = panEdgeState({ x: 0, y: 0 }, { width: 3200, height: 900 }, viewport);
    expect(s.canRevealLeft).toBe(false);
    expect(s.canRevealRight).toBe(true);
  });

  it('reports the right edge flush when panned fully left', () => {
    const s = panEdgeState({ x: 1600 - 3200, y: 0 }, { width: 3200, height: 900 }, viewport);
    expect(s.canRevealLeft).toBe(true);
    expect(s.canRevealRight).toBe(false);
  });

  it('reports nothing to reveal when content fits', () => {
    const s = panEdgeState({ x: 200, y: 0 }, { width: 1200, height: 900 }, viewport);
    expect(s.canRevealLeft).toBe(false);
    expect(s.canRevealRight).toBe(false);
  });
});
