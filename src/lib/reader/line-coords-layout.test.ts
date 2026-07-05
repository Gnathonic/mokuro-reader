import { describe, it, expect } from 'vitest';
import { layoutLines, heuristicMeasurer, type LayoutBlock } from './line-coords-layout';

// Real blocks captured from mokuro 0.2.2 output (see docs/superpowers/specs/
// 2026-07-04-original-mode-line-coords-design.md for provenance).

// Jujutsukaisen 24 p57 b1 — dialogue with furigana; quads ~1.6x wider than glyphs
const jjkFurigana: LayoutBlock = {
  box: [653, 123, 801, 358],
  vertical: true,
  font_size: 46,
  lines_coords: [
    [
      [733, 123],
      [793, 123],
      [793, 298],
      [733, 298]
    ],
    [
      [697, 125],
      [736, 125],
      [741, 358],
      [703, 358]
    ],
    [
      [653, 128],
      [692, 128],
      [692, 325],
      [653, 325]
    ]
  ],
  lines: ['総則追加で言うのは', '結界の出入りを', '可能にしても']
};

// Hare+Guu 03 p128 b13 — two-line shout, font_size 60 vs ~40px glyphs
const hareguuShout: LayoutBlock = {
  box: [517, 2127, 637, 2296],
  vertical: true,
  font_size: 60,
  lines_coords: [
    [
      [569, 2130],
      [631, 2130],
      [631, 2264],
      [569, 2264]
    ],
    [
      [517, 2127],
      [574, 2127],
      [574, 2296],
      [517, 2296]
    ]
  ],
  lines: ['殺すぞ', 'デカ女！！']
};

// FMA 22 p187 b19 — manga-ocr hallucination: 94x114px quad, 99-char line
const fmaHallucination: LayoutBlock = {
  box: [149, 2078, 243, 2192],
  vertical: true,
  font_size: 94,
  lines_coords: [
    [
      [149, 2078],
      [243, 2078],
      [243, 2192],
      [149, 2192]
    ]
  ],
  lines: [
    'そういうことでスタングが見えなくなったと決めていたんでしょうかもしれて、それをこの通りやらしたようにしていました。よろしくお客様はしかったら、そうですってことを忘れないたらいと思いんだってしたんだ。'
  ]
};

// Pokemon Adventures 03 p24 b8 — first quad rotated (slanted text)
const pokemonRotated: LayoutBlock = {
  box: [1649, 2127, 1855, 2376],
  vertical: true,
  font_size: 70,
  lines_coords: [
    [
      [1759, 2127],
      [1855, 2141],
      [1833, 2305],
      [1737, 2291]
    ],
    [
      [1699, 2146],
      [1767, 2146],
      [1767, 2296],
      [1699, 2296]
    ],
    [
      [1649, 2149],
      [1696, 2149],
      [1701, 2376],
      [1655, 2376]
    ]
  ],
  lines: ['今度はしかげん', '手加減', 'なしだぜ！']
};

function quadMainCross(quad: number[][], vertical: boolean): { main: number; cross: number } {
  const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [p0, p1, p2, p3] = quad;
  const h = mid(p1, p2).map((v, i) => v - mid(p0, p3)[i]);
  const v = mid(p2, p3).map((x, i) => x - mid(p0, p1)[i]);
  const hn = Math.hypot(h[0], h[1]);
  const vn = Math.hypot(v[0], v[1]);
  return vertical ? { main: vn, cross: hn } : { main: hn, cross: vn };
}

describe('layoutLines', () => {
  it('sizes every line to fit its own quad in both axes', () => {
    for (const block of [jjkFurigana, hareguuShout, pokemonRotated]) {
      const layouts = layoutLines(block, block.lines, heuristicMeasurer);
      expect(layouts).not.toBeNull();
      layouts!.forEach((l, i) => {
        const { main, cross } = quadMainCross(block.lines_coords![i], block.vertical);
        const advanceEm = heuristicMeasurer(block.lines[i]);
        expect(l.fontSize).toBeLessThanOrEqual(cross + 0.5);
        expect(l.fontSize * advanceEm).toBeLessThanOrEqual(main + 0.5);
        // sanity: real dialogue lines land at readable sizes
        expect(l.fontSize).toBeGreaterThanOrEqual(10);
      });
    }
  });

  it('shrinks well below the broken block font_size on furigana-inflated blocks', () => {
    const layouts = layoutLines(jjkFurigana, jjkFurigana.lines, heuristicMeasurer)!;
    // block font_size is 46; true glyphs are ~20-30px (quads include ruby columns)
    for (const l of layouts) {
      expect(l.fontSize).toBeLessThan(46);
    }
  });

  it('contains hallucinated lines inside their quad instead of overflowing 90x', () => {
    const layouts = layoutLines(fmaHallucination, fmaHallucination.lines, heuristicMeasurer)!;
    const { main } = quadMainCross(fmaHallucination.lines_coords![0], true);
    const advanceEm = heuristicMeasurer(fmaHallucination.lines[0]);
    expect(layouts[0].fontSize * advanceEm).toBeLessThanOrEqual(main + 0.5);
    // 99 chars in a 114px quad: about 1px per char — tiny but contained
    expect(layouts[0].fontSize).toBeLessThan(3 * (114 / advanceEm));
  });

  it('centers each line on its quad cross axis, anchored at the reading start', () => {
    const layouts = layoutLines(jjkFurigana, jjkFurigana.lines, heuristicMeasurer)!;
    // Quads are wider than the glyph column (ruby, mask slack); the base
    // glyphs sit near the middle, so the column is centered horizontally.
    // L1: quad x [733,793], fs = 175/9 → centered at 763
    const fs0 = 175 / 9;
    expect(layouts[0].left).toBeCloseTo(763 - fs0 / 2 - 653, 3);
    expect(layouts[0].top).toBeCloseTo(123 - 123, 5); // reading axis: quad top
    // L3: quad x [653,692], fs = 197/6 → centered at 672.5
    const fs2 = 197 / 6;
    expect(layouts[2].left).toBeCloseTo(672.5 - fs2 / 2 - 653, 3);
    expect(layouts[2].top).toBeCloseTo(128 - 123, 5);
  });

  it('uses the rotated quad bbox for placement of slanted lines', () => {
    const layouts = layoutLines(pokemonRotated, pokemonRotated.lines, heuristicMeasurer)!;
    // rotated first quad: bbox x [1737,1855], centered at 1796; y-min = 2127
    expect(layouts[0].left + layouts[0].fontSize / 2).toBeCloseTo(1796 - 1649, 3);
    expect(layouts[0].top).toBeCloseTo(0, 5);
  });

  it('keeps neighboring columns apart when one quad is much wider than its glyphs', () => {
    // Dr Stone 01 p26 b11: quad 1 is 125px wide (base 本物 + ruby ほんもの +
    // empty margin) but its glyphs are ~38px; left-anchoring drew the column
    // in the margin, colliding with the みたい～ column to its left.
    const drStone: LayoutBlock = {
      box: [770, 2455, 929, 2691],
      vertical: true,
      font_size: 87,
      lines_coords: [
        [
          [804, 2455],
          [929, 2455],
          [929, 2608],
          [804, 2608]
        ],
        [
          [771, 2477],
          [820, 2477],
          [820, 2690],
          [771, 2690]
        ]
      ],
      lines: ['本物から', 'みたい～']
    };
    const layouts = layoutLines(drStone, drStone.lines, heuristicMeasurer)!;
    const spans = layouts.map((l) => [l.left, l.left + l.fontSize]);
    const gap = Math.max(spans[0][0] - spans[1][1], spans[1][0] - spans[0][1]);
    expect(gap).toBeGreaterThan(10); // columns must not overlap
  });

  it('handles horizontal blocks with the axes swapped', () => {
    const horizontal: LayoutBlock = {
      box: [100, 200, 400, 260],
      vertical: false,
      font_size: 50,
      lines_coords: [
        [
          [100, 200],
          [400, 200],
          [400, 260],
          [100, 260]
        ]
      ],
      lines: ['ABCDEF']
    };
    const layouts = layoutLines(horizontal, horizontal.lines, heuristicMeasurer)!;
    const advanceEm = heuristicMeasurer('ABCDEF');
    expect(layouts[0].fontSize).toBeLessThanOrEqual(60 + 0.5); // cross = height
    expect(layouts[0].fontSize * advanceEm).toBeLessThanOrEqual(300 + 0.5);
  });

  it('gives an empty line the quad cross size', () => {
    const block: LayoutBlock = {
      box: [0, 0, 50, 100],
      vertical: true,
      font_size: 50,
      lines_coords: [
        [
          [0, 0],
          [50, 0],
          [50, 100],
          [0, 100]
        ]
      ],
      lines: ['']
    };
    const layouts = layoutLines(block, block.lines, heuristicMeasurer)!;
    expect(layouts[0].fontSize).toBeCloseTo(50, 0);
  });

  it('measures the processed text passed in, not block.lines', () => {
    const block: LayoutBlock = {
      box: [0, 0, 50, 300],
      vertical: true,
      font_size: 50,
      lines_coords: [
        [
          [0, 0],
          [50, 0],
          [50, 300],
          [0, 300]
        ]
      ],
      lines: ['あ．．．'] // renders as あ… (2 chars) after ellipsis substitution
    };
    const processed = ['あ…'];
    const layouts = layoutLines(block, processed, heuristicMeasurer)!;
    // 2em advance in a 300px quad → capped by cross (50), not squeezed to 75-ish by 4 chars
    expect(layouts[0].fontSize).toBeCloseTo(50, 0);
  });

  describe('fallback to null', () => {
    it('when lines_coords is missing', () => {
      const { lines_coords: _drop, ...rest } = jjkFurigana;
      expect(layoutLines(rest, rest.lines, heuristicMeasurer)).toBeNull();
    });

    it('when lines_coords length mismatches lines', () => {
      const block = { ...jjkFurigana, lines_coords: jjkFurigana.lines_coords!.slice(0, 2) };
      expect(layoutLines(block, block.lines, heuristicMeasurer)).toBeNull();
    });

    it('when a quad is malformed', () => {
      const block = {
        ...hareguuShout,
        lines_coords: [
          hareguuShout.lines_coords![0],
          [
            [517, 2127],
            [574, 2127]
          ]
        ]
      };
      expect(layoutLines(block, block.lines, heuristicMeasurer)).toBeNull();
    });

    it('when a quad is degenerate (zero extent)', () => {
      const block: LayoutBlock = {
        box: [0, 0, 50, 100],
        vertical: true,
        font_size: 50,
        lines_coords: [
          [
            [10, 10],
            [10, 10],
            [10, 10],
            [10, 10]
          ]
        ],
        lines: ['あ']
      };
      expect(layoutLines(block, block.lines, heuristicMeasurer)).toBeNull();
    });
  });
});

describe('heuristicMeasurer', () => {
  it('counts fullwidth as 1em and ASCII as ~half', () => {
    expect(heuristicMeasurer('あいう')).toBeCloseTo(3, 5);
    expect(heuristicMeasurer('abc')).toBeLessThan(2);
    expect(heuristicMeasurer('')).toBe(0);
  });
});
