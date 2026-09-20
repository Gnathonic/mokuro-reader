import { describe, it, expect } from 'vitest';
import {
  ANGLE_DEAD_BAND,
  MAX_SPACING_EM,
  MIN_SPACING_EM,
  PITCH_TOLERANCE_CELLS,
  TILT_MIN_SHIFT,
  gridSpacing,
  inkLength,
  lineFrame,
  linePitches,
  ownPitch,
  sharesPitch,
  lineTransform,
  rectOverlapArea,
  rectsCollide,
  spacingUnits,
  type LinePitch,
  type OrientedRect,
  type PitchVoter
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
      angle: 0,
      tilt: 0
    });
  });

  it('an upright horizontal quad: main = width, cross = height', () => {
    expect(lineFrame(tilted(200, 300, 240, 40, 0), false)).toEqual({
      cx: 200,
      cy: 300,
      main: 240,
      cross: 40,
      angle: 0,
      tilt: 0
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
    // Pokemon Adventures 03 p24: the quad leans 7.64° clockwise, but it is
    // 165 × 97 — barely longer than thick (a merged base + ruby capture, which
    // never turned anyway). Over that length 7.64° moves the end by 22px, a
    // quarter of the thickness: within what corner noise does.
    expect(frame.angle).toBe(0);
    const longer: Quad = [quad[0], quad[1], [1789, 2633], [1693, 2619]];
    expect(lineFrame(longer, true)!.angle).toBeCloseTo(7.64, 1);
  });

  it('keeps upright text pixel-crisp: a tilt inside the dead band is no tilt', () => {
    expect(ANGLE_DEAD_BAND).toBe(2);
    expect(lineFrame(tilted(0, 0, 40, 600, 1.9), true)!.angle).toBe(0);
    expect(lineFrame(tilted(0, 0, 40, 600, -1.9), true)!.angle).toBe(0);
    expect(lineFrame(tilted(0, 0, 40, 600, 2.1), true)!.angle).toBeCloseTo(2.1, 9);
    // the detector's usual wobble: a corner or two off by a few px
    const wobbly: Quad = [
      [697, 125],
      [736, 125],
      [741, 358],
      [703, 358]
    ];
    expect(lineFrame(wobbly, true)!.angle).toBe(0);
  });

  // The angle of a SHORT quad is mostly corner noise: the same 10px error that
  // is invisible on a column reads as degrees on a five-glyph line. A tilt only
  // counts once it carries the line's end across a good part of its thickness.
  describe('the dead band is length-aware', () => {
    it('detector noise on a short line stays upright', () => {
      expect(TILT_MIN_SHIFT).toBe(0.35);
      // a five-glyph shout, level in print, whose quad reads 2.4°
      expect(lineFrame(tilted(0, 0, 64, 243, 2.4), true)!.angle).toBe(0);
      // …and what was measured is still on record, for the editor
      expect(lineFrame(tilted(0, 0, 64, 243, 2.4), true)!.tilt).toBeCloseTo(2.4, 9);
      expect(lineFrame(tilted(0, 0, 243, 64, -2.4), false)!.angle).toBe(0);
      // two-glyph ruby lines from a real page: 9.8° and 11.1° of pure noise
      expect(lineFrame(tilted(0, 0, 31, 50, 9.84), true)!.angle).toBe(0);
      expect(lineFrame(tilted(0, 0, 52, 29, 11.11), true)!.angle).toBe(0);
      // page numbers across a contents page: −2.1° over 487px, level in print
      expect(lineFrame(tilted(0, 0, 487, 70, -2.12), false)!.angle).toBe(0);
    });

    it('real tilts still turn', () => {
      expect(lineFrame(tilted(0, 0, 64, 600, 5), true)!.angle).toBeCloseTo(5, 9);
      expect(lineFrame(tilted(0, 0, 600, 64, -5), false)!.angle).toBeCloseTo(-5, 9);
      expect(lineFrame(tilted(0, 0, 50, 360, 20), true)!.angle).toBeCloseTo(20, 9);
      expect(lineFrame(tilted(0, 0, 50, 360, -35), true)!.angle).toBeCloseTo(-35, 9);
      expect(lineFrame(tilted(0, 0, 360, 50, -15), false)!.angle).toBeCloseTo(-15, 9);
      // a two-glyph SFX needs a real slant, and has one
      expect(lineFrame(tilted(0, 0, 50, 100, 15), true)!.angle).toBeCloseTo(15, 9);
    });

    it('the extents are the quad’s own whether or not it turns', () => {
      const frame = lineFrame(tilted(10, 20, 64, 243, 2.4), true)!;
      expect(frame.main).toBeCloseTo(243, 9);
      expect(frame.cross).toBeCloseTo(64, 9);
      expect(frame.cx).toBeCloseTo(10, 9);
      expect(frame.cy).toBeCloseTo(20, 9);
    });
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

const line = (over: Partial<PitchVoter>): PitchVoter => ({
  main: 640,
  cross: 72,
  advanceEm: 10,
  lead: 0,
  trail: 0,
  count: 10,
  votes: true,
  ...over
});

describe('ownPitch', () => {
  it('with no insets the quad is n full cells: the old main / count', () => {
    expect(ownPitch(line({}))).toEqual({ pitch: 64, em: 64, lead: 0, trail: 0 });
  });

  it('a quad that spans the INK covers n − lead − trail cells', () => {
    // ten 64px cells, a 「 at the start (ink from 0.65) and a 。 at the end
    // (ink to 0.32): the quad runs from 41.6 to 596.5
    const main = 64 * (10 - 0.65 - 0.68);
    const pitch = ownPitch(line({ main, lead: 0.65, trail: 0.68 }))!;
    expect(pitch.pitch).toBeCloseTo(64, 9);
    expect(pitch.em).toBeCloseTo(64, 9);
    expect(pitch.lead).toBe(0.65);
    // the old model squeezed this line by 13%
    expect(main / 10).toBeCloseTo(55.5, 1);
  });

  it('a short bracketed line is as big as the body text around it', () => {
    // 「嫌だ」 measured on a real page: 174px of ink, body pitch 65.5
    const pitch = ownPitch(line({ main: 174, cross: 77, advanceEm: 4, lead: 0.65, trail: 0.63 }))!;
    expect(pitch.pitch).toBeGreaterThan(62);
    expect(pitch.pitch).toBeLessThan(66);
  });

  it('TRACKED text: glyphs as big as the quad is thick, on a step that is wider', () => {
    // four 77px glyphs on a 145.7px step, as on a contents page
    const pitch = ownPitch(
      line({ main: 504, cross: 77, advanceEm: 4, lead: 0.05, trail: 0.05, count: 4 })
    )!;
    expect(pitch.pitch).toBeCloseTo((504 - 77 * 0.9) / 3, 9);
    expect(pitch.pitch).toBeGreaterThan(144);
    expect(pitch.pitch).toBeLessThan(146);
    expect(pitch.em).toBe(77);
  });

  it('solid and tracked meet where the step equals the thickness', () => {
    const at = (cross: number) => ownPitch(line({ cross, lead: 0.1, trail: 0.1 }))!.pitch;
    const solid = 640 / 9.8;
    expect(at(solid + 1e-6)).toBeCloseTo(solid, 4);
    expect(at(solid - 1e-6)).toBeCloseTo(solid, 4);
  });

  it('inkLength is its inverse, solid and tracked', () => {
    for (const cross of [72, 50]) {
      const input = line({ cross, lead: 0.11, trail: 0.68 });
      expect(inkLength(input, ownPitch(input)!.pitch)).toBeCloseTo(640, 9);
    }
  });

  it('a single glyph is never tracked — there is no second glyph to step to', () => {
    const pitch = ownPitch(line({ main: 100, cross: 60, advanceEm: 1, count: 1 }))!;
    expect(pitch).toEqual({ pitch: 100, em: 100, lead: 0, trail: 0 });
  });

  it('insets that would leave no cell to measure are dropped', () => {
    // a quad drawn around a lone 。
    const pitch = ownPitch(line({ main: 20, cross: 20, advanceEm: 1, lead: 0.06, trail: 0.9 }))!;
    expect(pitch).toEqual({ pitch: 20, em: 20, lead: 0, trail: 0 });
    expect(ownPitch(line({ lead: NaN }))!.lead).toBe(0);
  });

  it('has no answer for a line it cannot divide', () => {
    expect(ownPitch(line({ advanceEm: 0 }))).toBeNull();
    expect(ownPitch(line({ main: 0 }))).toBeNull();
    expect(ownPitch(line({ cross: NaN }))).toBeNull();
  });
});

describe('sharesPitch', () => {
  it('is an absolute test, in cells, at the far end of the line', () => {
    expect(PITCH_TOLERANCE_CELLS).toBe(0.75);
    const body = 64;
    // a two-glyph る。 whose quad is 0.44 of a cell too long: 36% off as a
    // pitch, but still the body text
    expect(
      sharesPitch(
        line({ main: 64 * (2 - 0.79 + 0.44), advanceEm: 2, lead: 0.11, trail: 0.68 }),
        body
      )
    ).toBe(true);
    // a 38-glyph column 0.6 of a cell short
    expect(
      sharesPitch(line({ main: 64 * 37.3, advanceEm: 38, lead: 0.05, trail: 0.05 }), body)
    ).toBe(true);
    // …but not five cells short: that text does not belong to that quad
    expect(sharesPitch(line({ main: 64 * 33, advanceEm: 38, lead: 0.05, trail: 0.05 }), body)).toBe(
      false
    );
  });

  it('a line in another size keeps out', () => {
    // eight glyphs of a heading 20% larger than the body
    expect(
      sharesPitch(line({ main: 76.8 * 7.9, cross: 90, advanceEm: 8, lead: 0.05, trail: 0.05 }), 64)
    ).toBe(false);
    expect(sharesPitch(line({}), 0)).toBe(false);
  });
});

describe('linePitches', () => {
  const column = (cells: number, over: Partial<PitchVoter> = {}) =>
    line({
      main: 64 * (cells - 0.1),
      advanceEm: cells,
      count: cells,
      lead: 0.05,
      trail: 0.05,
      ...over
    });

  it('a one-line block keeps its own pitch', () => {
    const [only] = linePitches([column(12)]);
    expect(only!.pitch).toBeCloseTo(64, 9);
  });

  it('the columns of a block share one pitch, anchored at each line’s start', () => {
    // three body columns whose quads end a little early or late, and a short
    // closing line whose quad is 0.4 of a cell too long
    const lines = [
      column(38, { main: 64 * 37.9 + 12 }),
      column(38),
      column(39, { main: 64 * 38.9 - 9 }),
      column(3, { main: 64 * (3 - 0.05 - 0.68 + 0.4), trail: 0.68 })
    ];
    const pitches = linePitches(lines).map((p) => p!.pitch);
    for (const p of pitches) expect(p).toBeCloseTo(64, 9);
    // on its own the short line would have come out 18% too large
    expect(ownPitch(lines[3])!.pitch).toBeGreaterThan(64 * 1.15);
  });

  it('the vote is weighted by glyph count: one long column outvotes short lines', () => {
    const pitches = linePitches([
      column(5, { main: 66 * 4.9 }),
      column(30),
      column(5, { main: 66 * 4.9 })
    ]);
    expect(pitches.map((p) => p!.pitch)).toEqual([64, 64, 64].map((v) => expect.closeTo(v, 9)));
  });

  it('short lines do not vote while a long one does — but a balloon of short lines still agrees on one', () => {
    const tall = column(12);
    const stub = column(2, { main: 64 * 1.9 * 1.3 });
    expect(linePitches([stub, tall, stub])[1]!.pitch).toBeCloseTo(64, 9);
    const balloon = linePitches([
      column(3, { main: 62 * 2.9 }),
      column(3),
      column(3, { main: 66 * 2.9 })
    ]);
    expect(new Set(balloon.map((p) => p!.pitch.toFixed(6))).size).toBe(1);
    expect(balloon[0]!.pitch).toBeCloseTo(64, 9);
  });

  it('a line in another size keeps its own pitch', () => {
    const pitches = linePitches([column(20), column(20), column(8, { main: 80 * 7.9, cross: 90 })]);
    expect(pitches[0]!.pitch).toBeCloseTo(64, 9);
    expect(pitches[2]!.pitch).toBeCloseTo(80, 9);
  });

  it('each print size in a block ends up with ONE pitch: ruby split around its base text', () => {
    // two base columns at 100px and the two halves of their ruby at ~33px —
    // the ruby has more glyphs, so it wins the first vote; the base lines then
    // vote among themselves instead of each keeping its own estimate
    const pitches = linePitches([
      column(5, { main: 100 * 4.9 + 20, cross: 110 }),
      column(5, { main: 100 * 4.9, cross: 110 }),
      column(9, { main: 33 * 8.9, cross: 36 }),
      column(4, { main: 33 * 3.9 + 8, cross: 36 })
    ]).map((p) => p!.pitch);
    expect(pitches[2]).toBeCloseTo(33, 9);
    expect(pitches[3]).toBe(pitches[2]);
    expect(pitches[0]).toBe(pitches[1]);
    expect(pitches[0]).toBeGreaterThan(99);
    expect(pitches[0]).toBeLessThan(105);
  });

  it('a line that does not vote neither gives nor takes the block pitch', () => {
    const pitches = linePitches([column(20), column(20, { main: 70 * 19.9, votes: false })]);
    expect(pitches[0]!.pitch).toBeCloseTo(64, 9);
    expect(pitches[1]!.pitch).toBeCloseTo(70, 9);
  });

  it('a tight-across quad shares the pitch as the tracked line it looks like', () => {
    const [, tight] = linePitches([column(30), column(30, { cross: 54 })]);
    expect(tight!.pitch).toBeCloseTo(64, 9);
    expect(tight!.em).toBe(54);
  });

  it('lines with no geometry get null, and an empty block an empty answer', () => {
    expect(linePitches([])).toEqual([]);
    expect(linePitches([column(10), line({ advanceEm: 0 })])[1]).toBeNull();
  });
});

describe('gridSpacing', () => {
  const solid = (pitch: number, lead = 0): LinePitch => ({ pitch, em: pitch, lead, trail: 0 });

  it('a loose line steps one pitch per glyph, each glyph centred in its step', () => {
    // 8 fullwidth glyphs at 40px on a 50px pitch
    const grid = gridSpacing({ pitch: solid(50), advanceEm: 8, fontSize: 40, count: 8 })!;
    expect(grid.letterSpacing).toBe(10);
    expect(grid.inset).toBe(5);
    for (let k = 0; k < 8; k++) {
      const glyphCentre = grid.inset + k * (40 + grid.letterSpacing) + 20;
      expect(glyphCentre).toBeCloseTo((k + 0.5) * 50, 9);
    }
  });

  it('the first CELL starts before the quad: the ink of the first glyph starts at it', () => {
    // 「 inks the last third of its cell
    const grid = gridSpacing({ pitch: solid(64, 0.65), advanceEm: 4, fontSize: 64, count: 4 })!;
    expect(grid.letterSpacing).toBe(0);
    expect(grid.inset).toBeCloseTo(-0.65 * 64, 9);
    // rendered smaller than the print: still centred on the print's cells
    const small = gridSpacing({ pitch: solid(64, 0.65), advanceEm: 4, fontSize: 56, count: 4 })!;
    expect(small.letterSpacing).toBe(8);
    for (let k = 0; k < 4; k++) {
      const glyphCentre = small.inset + k * 64 + 28;
      expect(glyphCentre).toBeCloseTo(-0.65 * 64 + (k + 0.5) * 64, 9);
    }
  });

  it('a tight pitch closes the glyphs up', () => {
    const grid = gridSpacing({ pitch: solid(36), advanceEm: 10, fontSize: 40, count: 10 })!;
    expect(grid.letterSpacing).toBe(-4);
    expect(grid.inset).toBe(-2);
  });

  it('TRACKED text: the glyphs are flush with the quad’s ends, not centred in n equal shares', () => {
    const pitch = ownPitch(
      line({ main: 504, cross: 77, advanceEm: 4, count: 4, lead: 0.05, trail: 0.05 })
    )!;
    const grid = gridSpacing({ pitch, advanceEm: 4, fontSize: 77, count: 4 })!;
    expect(grid.letterSpacing).toBeCloseTo(pitch.pitch - 77, 9);
    expect(grid.inset).toBeCloseTo(-0.05 * 77, 9);
    // the last glyph's ink ends at the quad's end
    const lastInkEnd = grid.inset + 3 * pitch.pitch + 77 * (1 - 0.05);
    expect(lastInkEnd).toBeCloseTo(504, 9);
  });

  it('half-width characters keep their narrower advance; set solid, the run is advance × pitch long', () => {
    // 第12話: two digits at 0.55em
    const grid = gridSpacing({ pitch: solid(60), advanceEm: 3.1, fontSize: 40, count: 4 })!;
    expect(3.1 * 40 + 4 * grid.letterSpacing).toBeCloseTo(3.1 * 60, 9);
  });

  it('tracking is per CHARACTER: a half-width character is tracked like a fullwidth one', () => {
    // 第12話です, 40px glyphs tracked by 10px: 5.1em of glyphs, 6 characters
    const input = line({ main: 5.1 * 40 + 5 * 10, cross: 40, advanceEm: 5.1, count: 6 });
    const pitch = ownPitch(input)!;
    expect(pitch.pitch).toBeCloseTo(50, 9);
    expect(
      gridSpacing({ pitch, advanceEm: 5.1, fontSize: 40, count: 6 })!.letterSpacing
    ).toBeCloseTo(10, 9);
  });

  it('text set at its own pitch gets no spacing at all', () => {
    expect(gridSpacing({ pitch: solid(40), advanceEm: 8, fontSize: 40, count: 8 })).toEqual({
      letterSpacing: 0,
      inset: 0
    });
    // …float noise included
    expect(gridSpacing({ pitch: solid(40.000001), advanceEm: 8, fontSize: 40, count: 8 })).toEqual({
      letterSpacing: 0,
      inset: 0
    });
    expect(
      gridSpacing({ pitch: solid(40.05), advanceEm: 8, fontSize: 40, count: 8 })!.letterSpacing
    ).toBeGreaterThan(0);
  });

  it('a single character is centred in its cell', () => {
    expect(gridSpacing({ pitch: solid(60), advanceEm: 1, fontSize: 40, count: 1 })).toEqual({
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
      gridSpacing({ pitch: solid(40 * (1 + em)), advanceEm: 10, fontSize: 40, count: 10 });
    expect(at(-0.34)).not.toBeNull();
    expect(at(-0.36)).toBeNull();
    expect(at(1.49)).not.toBeNull();
    expect(at(1.51)).toBeNull();
  });

  it('gives up on anything it cannot divide', () => {
    expect(gridSpacing({ pitch: solid(50), advanceEm: 0, fontSize: 40, count: 0 })).toBeNull();
    expect(gridSpacing({ pitch: solid(50), advanceEm: 2, fontSize: 0, count: 2 })).toBeNull();
    expect(gridSpacing({ pitch: solid(NaN), advanceEm: 2, fontSize: 40, count: 2 })).toBeNull();
    expect(gridSpacing({ pitch: solid(50), advanceEm: NaN, fontSize: 40, count: 2 })).toBeNull();
    expect(gridSpacing({ pitch: solid(0), advanceEm: 2, fontSize: 40, count: 2 })).toBeNull();
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
