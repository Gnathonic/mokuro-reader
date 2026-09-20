import { describe, it, expect } from 'vitest';
import {
  ANGLE_DEAD_BAND,
  MAX_SPACING_EM,
  MIN_SPACING_EM,
  gridSpacing,
  lineFrame,
  lineTransform,
  rectOverlapArea,
  rectsCollide,
  spacingUnits,
  type OrientedRect
} from './line-grid';
import { quadExtents, type Quad } from './line-coords-layout';

/**
 * An upright w × h rectangle centred on (cx, cy), turned by `deg` the way CSS
 * `rotate()` turns it: clockwise on screen, y pointing down. Corner order is
 * the file's: TL, TR, BR, BL of the UPRIGHT rectangle.
 */
function tilted(cx: number, cy: number, w: number, h: number, deg: number): Quad {
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

describe('lineFrame', () => {
  it('an upright vertical quad: centre, main = height, cross = width, no angle', () => {
    expect(lineFrame(tilted(200, 300, 40, 240, 0), true)).toEqual({
      cx: 200,
      cy: 300,
      main: 240,
      cross: 40,
      angle: 0
    });
  });

  it('an upright horizontal quad: main = width, cross = height', () => {
    expect(lineFrame(tilted(200, 300, 240, 40, 0), false)).toEqual({
      cx: 200,
      cy: 300,
      main: 240,
      cross: 40,
      angle: 0
    });
  });

  // THE sign convention: the angle is the CSS rotate() that turns upright text
  // onto the quad — positive is clockwise on screen. A vertical line leaning
  // clockwise has its foot to the LEFT of its head; a horizontal one has its
  // end BELOW its start.
  it.each([10, -10, 45, -45, 20, -35])(
    'a vertical quad turned %d° reports that angle and its own-frame extents',
    (deg) => {
      const quad = tilted(500, 400, 50, 300, deg);
      const frame = lineFrame(quad, true)!;
      expect(frame.angle).toBeCloseTo(deg, 9);
      expect(frame.main).toBeCloseTo(300, 9);
      expect(frame.cross).toBeCloseTo(50, 9);
      expect(frame.cx).toBeCloseTo(500, 9);
      expect(frame.cy).toBeCloseTo(400, 9);
      // the foot (bottom-edge midpoint) goes left for a clockwise lean
      const footX = (quad[2][0] + quad[3][0]) / 2;
      expect(Math.sign(500 - footX)).toBe(Math.sign(deg));
    }
  );

  it.each([10, -10, 45, -45])('a horizontal quad turned %d° reports that angle', (deg) => {
    const quad = tilted(500, 400, 300, 50, deg);
    const frame = lineFrame(quad, false)!;
    expect(frame.angle).toBeCloseTo(deg, 9);
    expect(frame.main).toBeCloseTo(300, 9);
    expect(frame.cross).toBeCloseTo(50, 9);
    // the end (right-edge midpoint) goes down for a clockwise turn
    const endY = (quad[1][1] + quad[2][1]) / 2;
    expect(Math.sign(endY - 400)).toBe(Math.sign(deg));
  });

  it('agrees with quadExtents, which it shares its construction with', () => {
    const quad: Quad = [
      [1759, 2127],
      [1855, 2141],
      [1833, 2305],
      [1737, 2291]
    ];
    const frame = lineFrame(quad, true)!;
    expect({ main: frame.main, cross: frame.cross }).toEqual(quadExtents(quad, true));
    // Pokemon Adventures 03 p24: the slanted shout leans clockwise
    expect(frame.angle).toBeCloseTo(7.64, 1);
  });

  it('keeps upright text pixel-crisp: a tilt inside the dead band is no tilt', () => {
    expect(ANGLE_DEAD_BAND).toBe(2);
    expect(lineFrame(tilted(0, 0, 40, 240, 1.9), true)!.angle).toBe(0);
    expect(lineFrame(tilted(0, 0, 40, 240, -1.9), true)!.angle).toBe(0);
    expect(lineFrame(tilted(0, 0, 40, 240, 2.1), true)!.angle).toBeCloseTo(2.1, 9);
    // the detector's usual wobble: a corner or two off by a few px
    const wobbly: Quad = [
      [697, 125],
      [736, 125],
      [741, 358],
      [703, 358]
    ];
    expect(lineFrame(wobbly, true)!.angle).toBe(0);
  });

  // The angle is measured against the BLOCK's writing axis, from the quad's own
  // corner order. mokuro mixes orientations inside a block: a flat quad in a
  // vertical block still has its top edge first, so its main axis is the short
  // top-to-bottom one and it is not "turned 90°" — it renders as today.
  it('a horizontal line in a vertical block is not a rotation', () => {
    const frame = lineFrame(tilted(300, 300, 240, 40, 0), true)!;
    expect(frame.angle).toBe(0);
    expect(frame.main).toBe(40);
    expect(frame.cross).toBe(240);
  });

  it('never turns text upside down: the angle is normalised to (-90°, 90°]', () => {
    // corner order starting at the bottom-right: the main vector points UP
    const [tl, tr, br, bl] = tilted(0, 0, 40, 240, 10);
    const flipped = lineFrame([br, bl, tl, tr], true)!;
    expect(flipped.angle).toBeCloseTo(10, 9);
    // a genuine quarter turn stays a quarter turn (which side is a rounding
    // matter at exactly ±90°); past it, the text flips back to readable
    expect(Math.abs(lineFrame(tilted(0, 0, 40, 240, 90), true)!.angle)).toBeCloseTo(90, 9);
    expect(Math.abs(lineFrame(tilted(0, 0, 40, 240, -90), true)!.angle)).toBeCloseTo(90, 9);
    expect(lineFrame(tilted(0, 0, 40, 240, 100), true)!.angle).toBeCloseTo(-80, 9);
    expect(lineFrame(tilted(0, 0, 40, 240, -100), true)!.angle).toBeCloseTo(80, 9);
  });

  it('degenerate and malformed quads have no frame', () => {
    expect(lineFrame([[0, 0]] as Quad, true)).toBeNull();
    expect(lineFrame(undefined as unknown as Quad, true)).toBeNull();
    expect(
      lineFrame(
        [
          [0, 0],
          [10, 0],
          [10, NaN],
          [0, 10]
        ],
        true
      )
    ).toBeNull();
    // zero thickness
    expect(
      lineFrame(
        [
          [5, 0],
          [5, 0],
          [5, 100],
          [5, 100]
        ],
        true
      )
    ).toBeNull();
    // zero length
    expect(
      lineFrame(
        [
          [0, 7],
          [50, 7],
          [50, 7],
          [0, 7]
        ],
        false
      )
    ).toBeNull();
  });
});

describe('spacingUnits', () => {
  it('counts what the browser spaces: one unit per character, none for marks riding on one', () => {
    expect(spacingUnits('あいう')).toBe(3);
    expect(spacingUnits('12話')).toBe(3);
    expect(spacingUnits('𠮷野家')).toBe(3);
    // decomposed dakuten, a variation selector, a ZWJ
    expect(spacingUnits('か\u3099き')).toBe(2);
    expect(spacingUnits('\u2764\ufe0f')).toBe(1);
    expect(spacingUnits('')).toBe(0);
  });
});

describe('gridSpacing', () => {
  it('a loose quad shares its slack out evenly, half a share before the first glyph', () => {
    // 8 fullwidth glyphs at 40px = 320px of text in a 400px quad
    const grid = gridSpacing({ main: 400, advanceEm: 8, fontSize: 40, count: 8 })!;
    expect(grid.letterSpacing).toBe(10);
    expect(grid.inset).toBe(5);
    // glyph k is centred in cell k of the uniform grid
    const step = 400 / 8;
    for (let k = 0; k < 8; k++) {
      const glyphCentre = grid.inset + k * (40 + grid.letterSpacing) + 20;
      expect(glyphCentre).toBeCloseTo((k + 0.5) * step, 9);
    }
  });

  it('a tight quad closes the glyphs up — the run starts before the quad by half a share', () => {
    // 10 glyphs at 40px = 400px of text in a 360px quad
    const grid = gridSpacing({ main: 360, advanceEm: 10, fontSize: 40, count: 10 })!;
    expect(grid.letterSpacing).toBe(-4);
    expect(grid.inset).toBe(-2);
    const lastGlyphEnd = grid.inset + 9 * (40 + grid.letterSpacing) + 40;
    expect(lastGlyphEnd).toBe(362);
  });

  it('half-width characters keep their narrower advance; the slack is still shared per character', () => {
    // 第12話: two digits at 0.55em
    const grid = gridSpacing({ main: 200, advanceEm: 3.1, fontSize: 40, count: 4 })!;
    expect(grid.letterSpacing).toBeCloseTo((200 - 124) / 4, 9);
    expect(grid.inset).toBeCloseTo(grid.letterSpacing / 2, 9);
  });

  it('text that already fills its quad gets no spacing at all', () => {
    expect(gridSpacing({ main: 320, advanceEm: 8, fontSize: 40, count: 8 })).toEqual({
      letterSpacing: 0,
      inset: 0
    });
    // …measurer noise included: a canvas reports 7.99999em for eight glyphs
    expect(gridSpacing({ main: 320, advanceEm: 7.99999, fontSize: 40, count: 8 })).toEqual({
      letterSpacing: 0,
      inset: 0
    });
    expect(
      gridSpacing({ main: 320, advanceEm: 7.99, fontSize: 40, count: 8 })!.letterSpacing
    ).toBeGreaterThan(0);
  });

  it('a single character is centred in its quad', () => {
    expect(gridSpacing({ main: 60, advanceEm: 1, fontSize: 40, count: 1 })).toEqual({
      letterSpacing: 20,
      inset: 10
    });
  });

  // Beyond these the quad or the text is wrong — a hallucinated line crammed
  // into a small quad, two characters in a quad drawn around a whole column —
  // and a grid would only spread the mistake out. The line renders as before.
  it('gives up outside the clamps', () => {
    expect(MIN_SPACING_EM).toBe(-0.35);
    expect(MAX_SPACING_EM).toBe(1.5);
    const at = (em: number) =>
      gridSpacing({ main: 10 * 40 * (1 + em), advanceEm: 10, fontSize: 40, count: 10 });
    expect(at(-0.34)).not.toBeNull();
    expect(at(-0.36)).toBeNull();
    expect(at(1.49)).not.toBeNull();
    expect(at(1.51)).toBeNull();
  });

  it('gives up on anything it cannot divide', () => {
    expect(gridSpacing({ main: 100, advanceEm: 0, fontSize: 40, count: 0 })).toBeNull();
    expect(gridSpacing({ main: 100, advanceEm: 2, fontSize: 0, count: 2 })).toBeNull();
    expect(gridSpacing({ main: NaN, advanceEm: 2, fontSize: 40, count: 2 })).toBeNull();
    expect(gridSpacing({ main: 100, advanceEm: NaN, fontSize: 40, count: 2 })).toBeNull();
    expect(gridSpacing({ main: 0, advanceEm: 2, fontSize: 40, count: 2 })).toBeNull();
  });
});

describe('oriented rectangles', () => {
  const rect = (cx: number, cy: number, w: number, h: number, angle = 0): OrientedRect => ({
    cx,
    cy,
    width: w,
    height: h,
    angle
  });

  it('measures axis-aligned overlap like a bbox test does', () => {
    expect(rectOverlapArea(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBeCloseTo(25, 9);
    expect(rectOverlapArea(rect(0, 0, 10, 10), rect(20, 0, 10, 10))).toBe(0);
    expect(rectOverlapArea(rect(0, 0, 10, 10), rect(0, 0, 4, 4))).toBeCloseTo(16, 9);
  });

  it('two parallel tilted columns do not overlap although their bboxes do', () => {
    // 50 × 300 columns at 35°, one pitch (60px) apart across the lean
    const t = (35 * Math.PI) / 180;
    const a = rect(500, 500, 50, 300, 35);
    const b = rect(500 - 60 * Math.cos(t), 500 - 60 * Math.sin(t), 50, 300, 35);
    expect(rectOverlapArea(a, b)).toBe(0);
    expect(rectsCollide(a, b, 0.5)).toBe(false);
    // …while the same two centres, upright, are 60·cos35° ≈ 49px apart: they touch
    expect(rectsCollide({ ...a, angle: 0 }, { ...b, angle: 0 }, 0.5)).toBe(true);
  });

  it('a tilted rectangle collides with what it actually crosses, not with its bbox', () => {
    const sfx = rect(0, 0, 40, 400, 45);
    // inside the bbox corner, outside the rectangle
    expect(rectsCollide(sfx, rect(120, 120, 30, 30), 0.5)).toBe(false);
    // on the diagonal
    expect(rectsCollide(sfx, rect(-100, 100, 30, 30), 0.5)).toBe(true);
  });

  it('touching within the tolerance is not a collision', () => {
    expect(rectsCollide(rect(0, 0, 10, 10), rect(9.8, 0, 10, 10), 0.5)).toBe(false);
    expect(rectsCollide(rect(0, 0, 10, 10), rect(9, 0, 10, 10), 0.5)).toBe(true);
  });
});

describe('lineTransform', () => {
  it('an upright line is the plain translate it has always been', () => {
    expect(
      lineTransform({
        natural: { left: 3, top: 40, width: 30, height: 200 },
        target: { left: 100, top: 20 },
        vertical: true
      })
    ).toEqual({ transform: 'translate(97px, -20px)', origin: '' });
  });

  it('the grid inset moves the run along the reading axis only', () => {
    expect(
      lineTransform({
        natural: { left: 0, top: 0, width: 30, height: 200 },
        target: { left: 100, top: 20 },
        inset: 5,
        vertical: true
      }).transform
    ).toBe('translate(100px, 25px)');
    expect(
      lineTransform({
        natural: { left: 0, top: 0, width: 200, height: 30 },
        target: { left: 100, top: 20 },
        inset: -2,
        vertical: false
      }).transform
    ).toBe('translate(98px, 20px)');
  });

  it('a rotated line turns about the centre of its own-frame box', () => {
    // frame box 60 × 300 at (100, 50): centre (130, 200). The span is 40 thick
    // (its font size) and 290 long, and the grid starts it 5px in.
    const { transform, origin } = lineTransform({
      natural: { left: 10, top: 0, width: 40, height: 290 },
      target: { left: 100, top: 50 },
      box: { width: 60, height: 300 },
      inset: 5,
      rotation: 20,
      vertical: true
    });
    // across: centred in the box (100 + (60-40)/2 = 110); along: 50 + 5
    expect(transform).toBe('translate(100px, 55px) rotate(20deg)');
    // the box centre, in the span's own coordinates: (130-110, 200-55)
    expect(origin).toBe('20px 145px');
  });

  it('a rotated horizontal line: the same, with the axes swapped', () => {
    const { transform, origin } = lineTransform({
      natural: { left: 0, top: 10, width: 290, height: 40 },
      target: { left: 100, top: 50 },
      box: { width: 300, height: 60 },
      inset: 5,
      rotation: -35,
      vertical: false
    });
    expect(transform).toBe('translate(105px, 50px) rotate(-35deg)');
    expect(origin).toBe('145px 20px');
  });
});
