import { describe, it, expect } from 'vitest';
import {
  closestPageToCenter,
  detectHorizontalPage,
  horizontalVisibilityRatio
} from './page-detection';
import type { RectLike } from './zoom-math';

/** Build a vertical strip of page rects as the browser would measure them. */
function verticalStrip(count: number, pageHeight: number, scrollTop: number, zoom = 1): RectLike[] {
  return Array.from({ length: count }, (_, i) => ({
    left: 0,
    top: (i * pageHeight - scrollTop / zoom) * zoom,
    width: 1000 * zoom,
    height: pageHeight * zoom
  }));
}

const container: RectLike = { left: 0, top: 0, width: 1000, height: 800 };

describe('closestPageToCenter', () => {
  it('picks the page under the viewport center', () => {
    // Page 3 spans 3000–4000; scrolled so its middle is at the center.
    const rects = verticalStrip(10, 1000, 3100);
    expect(closestPageToCenter(container, rects, 'y')).toBe(3);
  });

  it('stays correct at 2x zoom (visual rects, not layout offsets)', () => {
    // Same reading position as the previous test but measured under
    // transform: scale(2) — page i spans top = i*2000 - 6200. The old
    // offsetTop-based detection compared unscaled layout offsets against
    // scaled scroll coordinates and reported ~page 7 here.
    const rects = Array.from({ length: 10 }, (_, i) => ({
      left: 0,
      top: i * 2000 - 6200,
      width: 2000,
      height: 2000
    }));
    expect(closestPageToCenter(container, rects, 'y')).toBe(3);
  });

  it('skips missing entries', () => {
    const rects: (RectLike | undefined)[] = verticalStrip(10, 1000, 3100);
    rects[3] = undefined;
    const got = closestPageToCenter(container, rects, 'y');
    expect([2, 4]).toContain(got);
  });

  it('works on the x axis', () => {
    const rects = Array.from({ length: 5 }, (_, i) => ({
      left: i * 600 - 900,
      top: 0,
      width: 600,
      height: 800
    }));
    // centers at -600, 0, 600, 1200, 1800; container center x = 500
    expect(closestPageToCenter(container, rects, 'x')).toBe(2);
  });

  it('returns 0 when no rects are usable', () => {
    expect(closestPageToCenter(container, [undefined, undefined], 'y')).toBe(0);
  });
});

describe('horizontalVisibilityRatio', () => {
  it('is 1 for a fully visible page and 0 for an offscreen one', () => {
    expect(
      horizontalVisibilityRatio({ left: 100, top: 0, width: 400, height: 800 }, container)
    ).toBe(1);
    expect(
      horizontalVisibilityRatio({ left: 1200, top: 0, width: 400, height: 800 }, container)
    ).toBe(0);
  });

  it('is fractional for a partially visible page', () => {
    expect(
      horizontalVisibilityRatio({ left: -200, top: 0, width: 400, height: 800 }, container)
    ).toBe(0.5);
  });

  it('is 0 for a zero-width rect', () => {
    expect(horizontalVisibilityRatio({ left: 0, top: 0, width: 0, height: 800 }, container)).toBe(
      0
    );
  });
});

describe('detectHorizontalPage', () => {
  it('prefers the >95%-visible page closest to the center', () => {
    // Pages 1 and 2 fully visible, page 2 closer to center
    const rects: RectLike[] = [
      { left: -500, top: 0, width: 450, height: 800 },
      { left: 0, top: 0, width: 450, height: 800 },
      { left: 460, top: 0, width: 450, height: 800 },
      { left: 950, top: 0, width: 450, height: 800 }
    ];
    expect(detectHorizontalPage(container, rects, 9)).toBe(2);
  });

  it('falls back to the center-containing page when none is fully visible', () => {
    // One huge zoomed page covering the center
    const rects: RectLike[] = [
      { left: -2500, top: 0, width: 2000, height: 800 },
      { left: -500, top: 0, width: 2000, height: 800 },
      { left: 1500, top: 0, width: 2000, height: 800 }
    ];
    expect(detectHorizontalPage(container, rects, 9)).toBe(1);
  });

  it('stays correct under 2x zoom in RTL (negative lefts)', () => {
    // RTL strip at 2x: page 0 far right offscreen, page 1 spans the viewport
    const rects: RectLike[] = [
      { left: 1100, top: 0, width: 1900, height: 1600 },
      { left: -800, top: 0, width: 1900, height: 1600 },
      { left: -2700, top: 0, width: 1900, height: 1600 }
    ];
    expect(detectHorizontalPage(container, rects, 9)).toBe(1);
  });

  it('returns the fallback when nothing covers the center', () => {
    const rects: RectLike[] = [{ left: 2000, top: 0, width: 400, height: 800 }];
    expect(detectHorizontalPage(container, rects, 7)).toBe(7);
  });
});
