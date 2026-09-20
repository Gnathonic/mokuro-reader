import { describe, expect, it } from 'vitest';
import {
  clampBox,
  estimateFontSize,
  lineGeometry,
  lineGrid,
  lineHandlePoints,
  quadBounds,
  readingOrder,
  rectQuad,
  resizeQuadEdge,
  scaleQuads,
  splitBoxAtLine,
  translateQuads,
  unionBox
} from './block-geometry';
import { lineFrame } from '../line-grid';

describe('clampBox', () => {
  it('clamps to the image and keeps at least 1px extent', () => {
    expect(clampBox([-5, 10, 50, 20], 40, 40)).toEqual([0, 10, 40, 20]);
    expect(clampBox([10, 10, 10, 10], 40, 40)).toEqual([10, 10, 11, 11]);
  });
  it('re-orders inverted corners', () => {
    expect(clampBox([30, 30, 10, 10], 100, 100)).toEqual([10, 10, 30, 30]);
  });
});

describe('quads', () => {
  const quad = [
    [
      [10, 10],
      [20, 10],
      [20, 30],
      [10, 30]
    ]
  ];
  it('translates every point', () => {
    expect(translateQuads(quad, 5, -5)).toEqual([
      [
        [15, 5],
        [25, 5],
        [25, 25],
        [15, 25]
      ]
    ]);
    expect(translateQuads(undefined, 1, 1)).toBeUndefined();
  });
  it('scales points affinely from one box to another', () => {
    expect(scaleQuads(quad, [10, 10, 20, 30], [0, 0, 20, 40])).toEqual([
      [
        [0, 0],
        [20, 0],
        [20, 40],
        [0, 40]
      ]
    ]);
  });
});

describe('unionBox / splitBoxAtLine', () => {
  it('unions', () => {
    expect(
      unionBox([
        [0, 0, 10, 10],
        [5, 5, 20, 8]
      ])
    ).toEqual([0, 0, 20, 10]);
  });
  it('splits a vertical box right-to-left by line count when there are no quads', () => {
    // 4 lines, split after line 1 → first block keeps the RIGHT quarter
    expect(splitBoxAtLine([0, 0, 40, 100], true, 1, 4)).toEqual([
      [30, 0, 40, 100],
      [0, 0, 30, 100]
    ]);
  });
  it('splits a horizontal box top-to-bottom by line count', () => {
    expect(splitBoxAtLine([0, 0, 100, 40], false, 2, 4)).toEqual([
      [0, 0, 100, 20],
      [0, 20, 100, 40]
    ]);
  });
  it('splits at the quad boundary when quads exist', () => {
    const quads = [
      [
        [30, 0],
        [40, 0],
        [40, 100],
        [30, 100]
      ],
      [
        [0, 0],
        [12, 0],
        [12, 100],
        [0, 100]
      ]
    ];
    expect(splitBoxAtLine([0, 0, 40, 100], true, 1, 2, quads)).toEqual([
      [21, 0, 40, 100],
      [0, 0, 21, 100]
    ]);
  });
});

describe('estimateFontSize', () => {
  it('uses the cross-writing axis divided by line count, clamped', () => {
    expect(estimateFontSize([0, 0, 60, 200], true, 2)).toBe(30);
    expect(estimateFontSize([0, 0, 200, 60], false, 3)).toBe(20);
    expect(estimateFontSize([0, 0, 4, 4], true, 1)).toBe(8);
    expect(estimateFontSize([0, 0, 1000, 1000], false, 1)).toBe(200);
  });
});

describe('readingOrder', () => {
  it('orders vertical blocks right-to-left, horizontal top-to-bottom', () => {
    const blocks = [{ box: [0, 0, 10, 10] }, { box: [50, 0, 60, 10] }, { box: [20, 20, 30, 30] }];
    expect(readingOrder(blocks, true)).toEqual([1, 2, 0]);
    expect(readingOrder(blocks, false)).toEqual([0, 1, 2]);
  });
});

describe('quad helpers', () => {
  it('rectQuad / quadBounds round-trip and medianLineFontSize', async () => {
    const { rectQuad, quadBounds, medianLineFontSize } = await import('./block-geometry');
    expect(quadBounds(rectQuad(5, 6, 10, 20))).toEqual([5, 6, 15, 26]);
    expect(
      medianLineFontSize([
        rectQuad(0, 0, 40, 200),
        rectQuad(0, 0, 500, 90),
        rectQuad(0, 0, 30, 300)
      ])
    ).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Tilted quads: the editor shows a line in its quad's own frame, like the
// viewer (`line-grid.ts`), and its geometry ops must keep the tilt.
// ---------------------------------------------------------------------------

/** An upright w × h rectangle centred on (cx, cy), turned clockwise by `deg`
 * (CSS `rotate()`); corner order TL, TR, BR, BL of the upright rectangle. */
function tilted(cx: number, cy: number, w: number, h: number, deg: number): number[][] {
  const t = (deg * Math.PI) / 180;
  const corner = (dx: number, dy: number) => [
    cx + dx * Math.cos(t) - dy * Math.sin(t),
    cy + dx * Math.sin(t) + dy * Math.cos(t)
  ];
  return [
    corner(-w / 2, -h / 2),
    corner(w / 2, -h / 2),
    corner(w / 2, h / 2),
    corner(-w / 2, h / 2)
  ];
}
const perChar = (t: string) => [...t].length;
const angleOf = (quad: number[][], vertical: boolean) => lineFrame(quad, vertical)!.angle;

describe('lineGeometry — tilted quads', () => {
  it('an upright quad has no rotation and its own-frame box IS its bbox', () => {
    const g = lineGeometry(rectQuad(100, 50, 40, 240), 'あいうえおか', perChar);
    expect(g.rotation).toBe(0);
    expect(g.box).toEqual({ left: 100, top: 50, width: 40, height: 240 });
    expect(g.main).toBe(240);
    expect(g.vertical).toBe(true);
  });

  it('a wobble inside the dead band stays upright: today’s geometry, untouched', () => {
    const quad = tilted(200, 300, 40, 240, 1.5);
    const g = lineGeometry(quad);
    const [x0, y0, x1, y1] = quadBounds(quad);
    expect(g.rotation).toBe(0);
    expect(g.box).toEqual({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
    expect(g).toMatchObject({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
  });

  it('a tilted vertical quad: the angle, and a main × cross box centred on the quad centre', () => {
    const quad = tilted(200, 300, 40, 240, 20);
    const g = lineGeometry(quad, 'あいうえおか', perChar);
    expect(g.vertical).toBe(true);
    expect(g.rotation).toBeCloseTo(20, 6);
    expect(g.main).toBeCloseTo(240, 6);
    expect(g.box.width).toBeCloseTo(40, 6);
    expect(g.box.height).toBeCloseTo(240, 6);
    expect(g.box.left + g.box.width / 2).toBeCloseTo(200, 6);
    expect(g.box.top + g.box.height / 2).toBeCloseTo(300, 6);
    // the bbox stays what it always was: selection, drag origin, box growth
    const [x0, y0, x1, y1] = quadBounds(quad);
    expect(g).toMatchObject({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
    // fitted along the quad's OWN length (240 / 6), capped by its own thickness
    expect(g.fontSize).toBe(40);
  });

  it('a tilted horizontal quad', () => {
    const g = lineGeometry(tilted(300, 100, 240, 30, -15), 'あいうえおかきく', perChar);
    expect(g.vertical).toBe(false);
    expect(g.rotation).toBeCloseTo(-15, 6);
    expect(g.box.width).toBeCloseTo(240, 6);
    expect(g.box.height).toBeCloseTo(30, 6);
    expect(g.fontSize).toBe(30);
  });

  it('past 45° the bbox lies about the orientation: the quad’s own extents decide', () => {
    // a column leaning 60°: its bbox is wider than tall, the line is still a column
    const quad = tilted(300, 300, 40, 240, 60);
    const [x0, y0, x1, y1] = quadBounds(quad);
    expect(x1 - x0).toBeGreaterThan(y1 - y0);
    const g = lineGeometry(quad, 'あいうえおか', perChar);
    expect(g.vertical).toBe(true);
    expect(g.rotation).toBeCloseTo(60, 6);
    expect(g.main).toBeCloseTo(240, 6);
    expect(g.fontSize).toBe(40);
    // without text: the quad's own thickness, not the bbox's
    expect(lineGeometry(quad).fontSize).toBe(40);
  });
});

describe('lineGrid', () => {
  it('spreads a loose line over its quad: spacing after every glyph, half of one before the first', () => {
    const g = lineGeometry(rectQuad(0, 0, 40, 300), 'あいうえおか', perChar);
    expect(g.fontSize).toBe(40);
    expect(lineGrid(g, 'あいうえおか', perChar)).toEqual({ letterSpacing: 10, inset: 5 });
  });
  it('absorbs the whole-px rounding of the font size', () => {
    // 250 / 6 = 41.67 → 42px glyphs, 252px of advance in 250px of quad
    const g = lineGeometry(rectQuad(0, 0, 60, 250), 'あいうえおか', perChar);
    expect(g.fontSize).toBe(42);
    const grid = lineGrid(g, 'あいうえおか', perChar);
    expect(grid.letterSpacing).toBeCloseTo(-2 / 6, 9);
    expect(grid.inset).toBeCloseTo(-1 / 6, 9);
  });
  it('uses the tilted quad’s own main extent', () => {
    const g = lineGeometry(tilted(300, 300, 40, 300, 30), 'あいうえおか', perChar);
    const grid = lineGrid(g, 'あいうえおか', perChar);
    expect(grid.letterSpacing).toBeCloseTo(10, 6);
  });
  it('gives up (no spacing) on an empty line, a pathological one, and collapsible white space', () => {
    const g = lineGeometry(rectQuad(0, 0, 40, 300), 'あ', perChar);
    expect(lineGrid(g, '', perChar)).toEqual({ letterSpacing: 0, inset: 0 });
    // one 40px glyph in 300px: 6.5em of spacing says the quad is wrong
    expect(lineGrid(g, 'あ', perChar)).toEqual({ letterSpacing: 0, inset: 0 });
    expect(lineGrid(g, ' あい', perChar)).toEqual({ letterSpacing: 0, inset: 0 });
  });
});

describe('resizeQuadEdge', () => {
  it('upright vertical: end moves the bottom edge, side the LEFT edge — as the handles always did', () => {
    const quad = rectQuad(100, 50, 40, 240);
    expect(resizeQuadEdge(quad, true, 'end', 7, 30)).toEqual(rectQuad(100, 50, 40, 270));
    expect(resizeQuadEdge(quad, true, 'side', -12, 99)).toEqual(rectQuad(88, 50, 52, 240));
  });
  it('upright horizontal: end moves the right edge, side the BOTTOM edge', () => {
    const quad = rectQuad(100, 50, 240, 40);
    expect(resizeQuadEdge(quad, false, 'end', 30, 7)).toEqual(rectQuad(100, 50, 270, 40));
    expect(resizeQuadEdge(quad, false, 'side', 99, 12)).toEqual(rectQuad(100, 50, 240, 52));
  });
  it('a tilted quad keeps its angle: the extent changes, the centre follows the dragged edge', () => {
    const quad = tilted(300, 300, 40, 240, 25);
    const t = (25 * Math.PI) / 180;
    const down = [-Math.sin(t), Math.cos(t)]; // the line's own reading axis
    // drag 50px along the line's axis (plus a sideways component that must not count)
    const dx = 50 * down[0] + 9 * Math.cos(t);
    const dy = 50 * down[1] + 9 * Math.sin(t);
    const out = resizeQuadEdge(quad, true, 'end', dx, dy);
    const frame = lineFrame(out, true)!;
    expect(frame.angle).toBeCloseTo(25, 6);
    expect(frame.main).toBeCloseTo(290, 6);
    expect(frame.cross).toBeCloseTo(40, 6);
    expect(frame.cx).toBeCloseTo(300 + 25 * down[0], 6);
    expect(frame.cy).toBeCloseTo(300 + 25 * down[1], 6);
    // the head of the line did not move
    expect(out[0][0]).toBeCloseTo(quad[0][0], 9);
    expect(out[1][1]).toBeCloseTo(quad[1][1], 9);

    const thicker = resizeQuadEdge(quad, true, 'side', -20 * Math.cos(t), -20 * Math.sin(t));
    const side = lineFrame(thicker, true)!;
    expect(side.angle).toBeCloseTo(25, 6);
    expect(side.cross).toBeCloseTo(60, 6);
    expect(side.main).toBeCloseTo(240, 6);
  });
  it('whatever corner the file lists first, the END is the edge the text runs to', () => {
    const quad = tilted(300, 300, 40, 240, 25);
    const fromBottomRight = [quad[2], quad[3], quad[0], quad[1]];
    const t = (25 * Math.PI) / 180;
    const out = resizeQuadEdge(fromBottomRight, true, 'end', -50 * Math.sin(t), 50 * Math.cos(t));
    expect(lineFrame(out, true)!.main).toBeCloseTo(290, 6);
    expect(angleOf(out, true)).toBeCloseTo(25, 6);
  });
  it('never collapses or mirrors the quad: an edge stops 1px short of the opposite one', () => {
    const out = resizeQuadEdge(tilted(300, 300, 40, 240, 25), true, 'end', 300, -900);
    const frame = lineFrame(out, true)!;
    expect(frame.main).toBeCloseTo(1, 6);
    expect(frame.angle).toBeCloseTo(25, 4);
  });
});

describe('lineHandlePoints', () => {
  it('upright: where the two handles have always been', () => {
    const v = lineGeometry(rectQuad(100, 50, 40, 240));
    expect(lineHandlePoints(v)).toEqual({ end: { x: 120, y: 290 }, side: { x: 100, y: 170 } });
    const h = lineGeometry(rectQuad(100, 50, 240, 40));
    expect(lineHandlePoints(h)).toEqual({ end: { x: 340, y: 70 }, side: { x: 220, y: 90 } });
  });
  it('tilted: on the turned quad’s own end and side edges', () => {
    const g = lineGeometry(tilted(300, 300, 40, 240, 30));
    const t = (30 * Math.PI) / 180;
    const { end, side } = lineHandlePoints(g);
    expect(end.x).toBeCloseTo(300 - 120 * Math.sin(t), 6);
    expect(end.y).toBeCloseTo(300 + 120 * Math.cos(t), 6);
    expect(side.x).toBeCloseTo(300 - 20 * Math.cos(t), 6);
    expect(side.y).toBeCloseTo(300 - 20 * Math.sin(t), 6);
  });
});
