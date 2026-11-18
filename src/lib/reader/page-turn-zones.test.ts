import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_ZONES,
  ZONE_REACH_PX,
  pointInRect,
  pointOverPage,
  screenStripTurns,
  type ClientRect
} from './page-turn-zones';

describe('screenStripTurns (#54)', () => {
  it('over the page: the page-edge control, so it turns either way', () => {
    expect(screenStripTurns(true, true)).toBe(true);
    expect(screenStripTurns(true, false)).toBe(true);
  });

  it('over the background: only with the background toggle on', () => {
    expect(screenStripTurns(false, true)).toBe(true);
    expect(screenStripTurns(false, false)).toBe(false);
  });
});

describe('pointInRect', () => {
  const r = { left: 10, right: 20, top: 5, bottom: 15 };
  it.each([
    [10, 5, true],
    [20, 15, true],
    [15, 10, true],
    [9.9, 10, false],
    [15, 15.1, false]
  ])('(%s, %s) → %s', (x, y, expected) => expect(pointInRect(x, y, r)).toBe(expected));
});

describe('pointOverPage', () => {
  afterEach(() => document.getElementById('manga-panel')?.remove());

  it('is false with no paged panel', () => {
    expect(pointOverPage(5, 5)).toBe(false);
  });

  it("tests the panel's client rect", () => {
    const panel = document.createElement('div');
    panel.id = 'manga-panel';
    panel.getBoundingClientRect = () => ({ left: 100, right: 700, top: 0, bottom: 900 }) as DOMRect;
    document.body.appendChild(panel);
    expect(pointOverPage(100, 450)).toBe(true);
    expect(pointOverPage(99, 450)).toBe(false);
    expect(pointOverPage(701, 450)).toBe(false);
  });
});

/**
 * Resolve a zone's inline `left/right/top/bottom/width/height` against a
 * containing block of `w`×`h` at the origin — what `position: fixed` under the
 * transformed camera wrapper does with it.
 */
function resolve(style: string, w: number, h: number): ClientRect {
  const decl = Object.fromEntries(
    style
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => d.split(':').map((p) => p.trim()) as [string, string])
  );
  const len = (v: string | undefined, of: number) =>
    v === undefined ? undefined : v.endsWith('%') ? (parseFloat(v) / 100) * of : parseFloat(v);
  const axis = (start?: number, end?: number, size?: number, of = 0): [number, number] => {
    if (start !== undefined && end !== undefined) return [start, of - end];
    if (start !== undefined) return [start, start + size!];
    return [of - end! - size!, of - end!];
  };
  const [left, right] = axis(len(decl.left, w), len(decl.right, w), len(decl.width, w), w);
  const [top, bottom] = axis(len(decl.top, h), len(decl.bottom, h), len(decl.height, h), h);
  return { left, right, top, bottom };
}

describe('BACKGROUND_ZONES: the whole area outside the spread (#54)', () => {
  // A narrow portrait page and a wide landscape spread, in camera px.
  it.each([
    [600, 900],
    [1800, 1200],
    [108, 8000]
  ])('a %sx%s spread', (w, h) => {
    const rects = BACKGROUND_ZONES.map((z) => ({ ...z, rect: resolve(z.style, w, h) }));
    const inside = (x: number, y: number, r: ClientRect) =>
      x > r.left && x < r.right && y > r.top && y < r.bottom;

    // A grid over the spread and far around it (one reach out, minus a margin).
    const far = ZONE_REACH_PX * 0.9;
    const xs = [-far, -5000, -1, 0.5, w * 0.25, w / 2 - 0.5, w / 2 + 0.5, w * 0.75, w - 0.5];
    const ys = [-far, -3000, -1, 0.5, h / 2, h - 0.5, h + 1, h + 3000, far + h];
    for (const x of [...xs, w + 1, w + 5000, w + far]) {
      for (const y of ys) {
        const hits = rects.filter((z) => inside(x, y, z.rect));
        const onSpread = x > 0 && x < w && y > 0 && y < h;
        if (onSpread) {
          // Never onto the page: the page-edge strip is the slider's region.
          expect(hits, `(${x}, ${y}) is on the page`).toEqual([]);
          continue;
        }
        // Exactly one zone, and it turns toward the side the point is on.
        expect(hits.length, `(${x}, ${y}) outside the page`).toBe(1);
        expect(hits[0].side).toBe(x < w / 2 ? 'left' : 'right');
      }
    }
  });

  it('turns left on the left half and right on the right half', () => {
    expect(BACKGROUND_ZONES.map((z) => z.side)).toEqual([
      'left',
      'right',
      'left',
      'right',
      'left',
      'right'
    ]);
  });
});
