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
        // uniform block sizing tolerates per-quad slack: 1.2x across the
        // line, 1.15x along it (quad tightness varies; print size doesn't)
        expect(l.fontSize).toBeLessThanOrEqual(cross * 1.2 + 0.5);
        if (l.wrap) {
          // wrapped lines fit as N columns inside the quad
          const cols = Math.ceil((advanceEm * l.fontSize) / main);
          expect(cols * l.fontSize).toBeLessThanOrEqual(cross + 0.5);
        } else {
          expect(l.fontSize * advanceEm).toBeLessThanOrEqual(main * 1.15 + 0.5);
        }
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
    const { main, cross } = quadMainCross(fmaHallucination.lines_coords![0], true);
    const advanceEm = heuristicMeasurer(fmaHallucination.lines[0]);
    // 99 chars in a 94x114 quad: wraps into dense columns (like the dense
    // print it misread), but stays inside the quad
    expect(layouts[0].wrap).toBe(true);
    const cols = Math.ceil((advanceEm * layouts[0].fontSize) / main);
    expect(cols * layouts[0].fontSize).toBeLessThanOrEqual(cross + 0.5);
    expect(layouts[0].fontSize).toBeLessThan(15);
  });

  it('wraps a whole-balloon single-line block into columns (Dr Stone p87)', () => {
    // The detector emitted one quad covering the entire 3-column balloon:
    // 9 chars in a 356x390 box. Single-line fit is 43px in a huge box; the
    // geometry-optimal wrap is 3 columns at ~119px — the print layout.
    const drStoneP87: LayoutBlock = {
      box: [1296, 104, 1652, 494],
      vertical: true,
      font_size: 356,
      lines_coords: [
        [
          [1296, 104],
          [1652, 104],
          [1652, 494],
          [1296, 494]
        ]
      ],
      lines: ['人類が全員石化して']
    };
    const layouts = layoutLines(drStoneP87, drStoneP87.lines, heuristicMeasurer)!;
    expect(layouts[0].wrap).toBe(true);
    expect(layouts[0].fontSize).toBeGreaterThan(100);
    // 3 columns at the computed size fit the quad width
    const cols = Math.ceil((9 * layouts[0].fontSize) / 390);
    expect(cols).toBe(3);
    expect(cols * layouts[0].fontSize).toBeLessThanOrEqual(356 + 0.5);
  });

  it('keeps a genuine one-line block single when wrapping buys nothing', () => {
    // Loose quad around a short line: wrapping to 2 columns would not let
    // the text render meaningfully bigger, so it stays one column.
    const block: LayoutBlock = {
      box: [0, 0, 100, 100],
      vertical: true,
      font_size: 60,
      lines_coords: [
        [
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 100]
        ]
      ],
      lines: ['ドン'] // 2 chars: single-line fit 50px, 2-col wrap also 50px
    };
    const layouts = layoutLines(block, block.lines, heuristicMeasurer)!;
    expect(layouts[0].wrap).toBe(false);
    expect(layouts[0].fontSize).toBeCloseTo(50, 1);
  });

  it('centers each clean line on its quad cross axis, anchored at the reading start', () => {
    const layouts = layoutLines(jjkFurigana, jjkFurigana.lines, heuristicMeasurer)!;
    // L3: clean column — quad x [653,692] → column centered at 672.5
    expect(layouts[2].wrap).toBe(false);
    expect(layouts[2].left + layouts[2].fontSize / 2).toBeCloseTo(672.5 - 653, 3);
    expect(layouts[2].top).toBeCloseTo(128 - 123, 5);
  });

  it('wraps a line whose quad is much wider than the block reference size', () => {
    // JJK L1: quad 60px wide (contains a neighbor's ruby ink) but the text
    // only fits at 19.4px while its siblings run at ~33px → treat the quad
    // as holding multiple columns and wrap at the block reference size.
    const layouts = layoutLines(jjkFurigana, jjkFurigana.lines, heuristicMeasurer)!;
    const l = layouts[0];
    expect(l.wrap).toBe(true);
    // The quad bbox starts at x=80 but its first ~2.7px hold the neighboring
    // column's ink, so the container is clipped to that column's right edge
    // and the 2 wrap columns split what remains.
    const neighborEdge = layouts[1].left + layouts[1].fontSize;
    expect(l.left).toBeCloseTo(neighborEdge, 1);
    expect(l.top).toBeCloseTo(0, 5);
    expect(l.width).toBeCloseTo(140 - neighborEdge, 1);
    expect(l.fontSize).toBeCloseTo(l.width / 2, 1);
    expect(l.height).toBeCloseTo(175, 5);
  });

  it('wraps merged base+furigana lines at the block reference size (Dr Stone p32)', () => {
    // Real block: 空は私なら + its ruby だいじょうぶ merged into one 11-char
    // "line" in a two-column-wide quad; sibling 大丈夫 is genuinely printed
    // large (emphasis) and must keep its own fitted size.
    const drStoneP32: LayoutBlock = {
      box: [1523, 754, 1674, 916],
      vertical: true,
      font_size: 56,
      lines_coords: [
        [
          [1562, 762],
          [1660, 754],
          [1674, 907],
          [1575, 916]
        ],
        [
          [1523, 771],
          [1573, 771],
          [1573, 902],
          [1523, 902]
        ]
      ],
      lines: ['空は私ならだいじょうぶ', '大丈夫']
    };
    const layouts = layoutLines(drStoneP32, drStoneP32.lines, heuristicMeasurer)!;
    expect(layouts[0].wrap).toBe(true);
    // reference size ≈ median(candidates) ≈ (14.7 + 43.7) / 2 ≈ 29.2 — the
    // merged line wraps at readable size instead of squeezing to 14.7px
    expect(layouts[0].fontSize).toBeGreaterThan(25);
    expect(layouts[0].fontSize).toBeLessThan(35);
    // 大丈夫 is printed at the SAME size as the base line (its tall quad is
    // just loose) — the block renders uniformly at the reference size
    expect(layouts[1].wrap).toBe(false);
    expect(layouts[1].fontSize).toBeCloseTo(layouts[0].fontSize, 3);
  });

  it('renders every line of a clean block at the same uniform size', () => {
    // Dr Stone 01 p29 block 7: four clean columns; per-quad fitted sizes
    // differ (39-50) only because of quad slack, so they render uniformly.
    const drStoneP29: LayoutBlock = {
      box: [762, 2102, 973, 2346],
      vertical: true,
      font_size: 51,
      lines_coords: [
        [
          [910, 2102],
          [973, 2102],
          [973, 2201],
          [910, 2201]
        ],
        [
          [874, 2110],
          [913, 2110],
          [913, 2346],
          [874, 2346]
        ],
        [
          [817, 2105],
          [869, 2105],
          [869, 2233],
          [817, 2233]
        ],
        [
          [762, 2105],
          [809, 2105],
          [809, 2346],
          [762, 2346]
        ]
      ],
      lines: ['ぬう', 'よりによって', 'こんな', 'マヌケな姿を']
    };
    const layouts = layoutLines(drStoneP29, drStoneP29.lines, heuristicMeasurer)!;
    const sizes = layouts.map((l) => l.fontSize);
    for (const s of sizes) {
      expect(s).toBeCloseTo(sizes[0], 3);
      expect(s).toBeGreaterThan(35);
      expect(s).toBeLessThan(50);
    }
    expect(layouts.every((l) => !l.wrap)).toBe(true);
  });

  it('wraps a merged line even when its quad is just under 2 columns wide (Dr Stone p53)', () => {
    // L2 必要なことはう: merged with ruby ink, 63px quad vs 63.7px old width
    // gate → fell through to a tiny 19.2px single line. Wrapping fits 2
    // columns at 31.5px — the gate must be the achievable benefit, not a
    // fixed width ratio.
    const drStoneP53: LayoutBlock = {
      box: [92, 1123, 308, 1331],
      vertical: true,
      font_size: 50,
      lines_coords: [
        [
          [262, 1129],
          [303, 1129],
          [308, 1328],
          [267, 1328]
        ],
        [
          [216, 1126],
          [254, 1126],
          [254, 1331],
          [216, 1331]
        ],
        [
          [144, 1123],
          [207, 1126],
          [202, 1260],
          [139, 1257]
        ],
        [
          [92, 1132],
          [133, 1132],
          [136, 1331],
          [95, 1331]
        ]
      ],
      lines: ['正確な暦は', 'どうしても', '必要なことはう', '情報だった']
    };
    const layouts = layoutLines(drStoneP53, drStoneP53.lines, heuristicMeasurer)!;
    // the merged line wraps at a readable size instead of 19.2px
    expect(layouts[2].wrap).toBe(true);
    expect(layouts[2].fontSize).toBeGreaterThan(28);
    // three clean lines agree at ~39.8 — their consensus is NOT dragged down
    // to the wrapped line's fit
    for (const i of [0, 1, 3]) {
      expect(layouts[i].wrap).toBe(false);
      expect(layouts[i].fontSize).toBeCloseTo(layouts[0].fontSize, 3);
      expect(layouts[i].fontSize).toBeGreaterThan(37);
    }
  });

  it('does not let ruby fragments outvote the base line (Killing Bites p42)', () => {
    // 「百獣王」 with its katakana gloss split around it: two small ruby
    // lines vs one big base line. A plain median is ruby-dominated and
    // dragged the 76px base down to 31px; the reference must weight lines
    // by quad ink area so the base wins.
    const killingBites: LayoutBlock = {
      box: [336, 71, 498, 466],
      vertical: true,
      font_size: 70,
      lines_coords: [
        [
          [445, 164],
          [495, 164],
          [495, 322],
          [445, 322]
        ],
        [
          [336, 71],
          [454, 71],
          [454, 453],
          [336, 453]
        ],
        [
          [448, 330],
          [489, 330],
          [489, 412],
          [448, 412]
        ]
      ],
      lines: ['＞グオブキ', '「百獣王」', 'ンクス']
    };
    const layouts = layoutLines(killingBites, killingBites.lines, heuristicMeasurer)!;
    // base line renders at its true large size
    expect(layouts[1].wrap).toBe(false);
    expect(layouts[1].fontSize).toBeGreaterThan(70);
    // ruby fragments keep their own small sizes
    expect(layouts[0].fontSize).toBeLessThan(35);
    expect(layouts[2].fontSize).toBeLessThan(30);
  });

  it('hides a line re-captured inside a bigger line quad (Saki 02 p129 あれは)', () => {
    // L1's quad spans both print columns and its text re-contains L0's
    // (あれは…). Rendering both stacks text; the smaller duplicate is hidden
    // and the bigger line wraps over the full region — no text lost.
    const sakiAreha: LayoutBlock = {
      box: [151, 775, 266, 931],
      vertical: true,
      font_size: 68,
      lines_coords: [
        [
          [215, 789],
          [266, 789],
          [266, 874],
          [215, 874]
        ],
        [
          [151, 775],
          [254, 775],
          [254, 931],
          [151, 931]
        ]
      ],
      lines: ['あれは', 'あれはキスではないですよ']
    };
    const layouts = layoutLines(sakiAreha, sakiAreha.lines, heuristicMeasurer)!;
    expect(layouts[0].hidden).toBe(true);
    expect(layouts[1].hidden).toBeFalsy();
    expect(layouts[1].wrap).toBe(true);
  });

  it('partitions overlapped lines with unrelated text into readable bands (Saki 02 p129)', () => {
    // Hallucination cluster: L3's quad contains L0 and L1, L0's contains L1,
    // each with divergent OCR text. Their individual placements are garbage,
    // but the text must stay readable: the cluster's union bbox is split
    // into reading-order bands (sized by text length) and each line wraps
    // inside its own band — all text visible, nothing stacked.
    const sakiGarbage: LayoutBlock = {
      box: [307, 456, 609, 637],
      vertical: false,
      font_size: 81,
      lines_coords: [
        [
          [385, 484],
          [519, 484],
          [519, 593],
          [385, 593]
        ],
        [
          [389, 544],
          [498, 544],
          [498, 581],
          [389, 581]
        ],
        [
          [366, 547],
          [396, 547],
          [396, 598],
          [366, 598]
        ],
        [
          [393, 456],
          [609, 456],
          [609, 637],
          [393, 637]
        ],
        [
          [334, 540],
          [359, 540],
          [359, 595],
          [334, 595]
        ]
      ],
      lines: [
        'いつの年末のはいい',
        'それは．．．おはようござい',
        'いや、',
        '生きたいなのはいいじじゃないこの好きなキスがまだというのはどういう',
        'あ．．．'
      ]
    };
    const layouts = layoutLines(sakiGarbage, sakiGarbage.lines, heuristicMeasurer)!;
    // nothing hidden — all OCR text stays readable even when it is wrong
    for (const l of layouts) expect(l.hidden).toBeFalsy();

    // cluster members (L0, L1, L3) wrap inside bands of the union bbox
    // (horizontal block → bands stacked top-to-bottom in reading order)
    const cluster = [layouts[0], layouts[1], layouts[3]];
    for (const l of cluster) {
      expect(l.wrap).toBe(true);
      expect(l.fontSize).toBeGreaterThan(14); // readable, not sub-pixel
    }
    expect(layouts[0].top).toBeLessThan(layouts[1].top);
    expect(layouts[1].top).toBeLessThan(layouts[3].top);
    // bands do not overlap each other
    expect(layouts[0].top + layouts[0].height).toBeLessThanOrEqual(layouts[1].top + 0.5);
    expect(layouts[1].top + layouts[1].height).toBeLessThanOrEqual(layouts[3].top + 0.5);
    // bands stay inside the cluster's union bbox (x [385,609] − box x 307)
    for (const l of cluster) {
      expect(l.left).toBeGreaterThanOrEqual(385 - 307 - 0.5);
      expect(l.left + l.width).toBeLessThanOrEqual(609 - 307 + 0.5);
    }

    // independent small quads (L2, L4) render in their own quads, readable
    for (const l of [layouts[2], layouts[4]]) {
      expect(l.hidden).toBeFalsy();
      expect(l.fontSize).toBeGreaterThan(8);
    }
  });

  it('still shrinks a line whose quad is far too small for the uniform size', () => {
    // A separately-detected furigana line: half-size chars in a half-size
    // quad. Rendering it at the block reference would double the print size
    // and overflow its quad badly — it keeps its own fitted size.
    const block: LayoutBlock = {
      box: [0, 0, 120, 240],
      vertical: true,
      font_size: 40,
      lines_coords: [
        [
          [80, 0],
          [120, 0],
          [120, 240],
          [80, 240]
        ],
        [
          [60, 0],
          [80, 0],
          [80, 80],
          [60, 80]
        ]
      ],
      lines: ['あいうえおか', 'るびるび'] // ruby line: 4 chars in an 80px quad
    };
    const layouts = layoutLines(block, block.lines, heuristicMeasurer)!;
    expect(layouts[0].fontSize).toBeCloseTo(40, 1); // base at reference
    expect(layouts[1].wrap).toBe(false);
    expect(layouts[1].fontSize).toBeLessThan(25); // ruby stays small
  });

  it('clips a wrapped slanted line to the space its clean neighbor leaves', () => {
    const layouts = layoutLines(pokemonRotated, pokemonRotated.lines, heuristicMeasurer)!;
    // L1 merged 今度は+ruby in a 97px-wide rotated quad → wraps at reference.
    // The slant inflates its axis-aligned bbox (x from 88) ~19px over the
    // upright 手加減 column, so the wrap container starts at that column's
    // right edge instead of the raw bbox.
    expect(layouts[0].wrap).toBe(true);
    const neighborEdge = layouts[1].left + layouts[1].fontSize;
    expect(layouts[0].left).toBeCloseTo(neighborEdge, 1);
    expect(layouts[0].left).toBeGreaterThan(1737 - 1649);
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

describe('no-overlap invariant', () => {
  // Rendered text must NEVER overlap: whatever the quads claim, two visible
  // lines drawing on the same pixels means the layout is wrong.

  interface Rect {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }

  /** The rect the text actually paints, from the layout the reader renders. */
  function renderedRect(
    l: NonNullable<ReturnType<typeof layoutLines>>[number],
    text: string,
    vertical: boolean
  ): Rect {
    if (l.wrap) {
      return { minX: l.left, minY: l.top, maxX: l.left + l.width, maxY: l.top + l.height };
    }
    const advance = heuristicMeasurer(text) * l.fontSize;
    return vertical
      ? { minX: l.left, minY: l.top, maxX: l.left + l.fontSize, maxY: l.top + advance }
      : { minX: l.left, minY: l.top, maxX: l.left + advance, maxY: l.top + l.fontSize };
  }

  function overlapWidth(a: Rect, b: Rect): number {
    const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
    return Math.min(Math.max(ox, 0), Math.max(oy, 0));
  }

  function expectNoOverlaps(block: LayoutBlock) {
    const layouts = layoutLines(block, block.lines, heuristicMeasurer)!;
    const rects = layouts.map((l, i) =>
      l.hidden ? null : renderedRect(l, block.lines[i], block.vertical)
    );
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        if (!rects[i] || !rects[j]) continue;
        expect
          .soft(overlapWidth(rects[i]!, rects[j]!), `lines ${i} and ${j} overlap`)
          .toBeLessThanOrEqual(0.5);
      }
    }
    return layouts;
  }

  // OPM 28 p136 b1: the detector re-captured the 研究施設 caption column as
  // two half-width-offset quads with diverged hallucinated texts. Bbox
  // overlap is 0.41 — far under the 0.7 re-capture gate — so both lines
  // rendered stacked on the same column.
  const opmRecapture: LayoutBlock = {
    box: [267, 23, 515, 635],
    vertical: true,
    font_size: 75,
    lines_coords: [
      [
        [325, 103],
        [399, 103],
        [394, 609],
        [320, 609]
      ],
      [
        [276, 84],
        [352, 84],
        [344, 615],
        [268, 615]
      ]
    ],
    lines: ['けたもえ', 'ログカショ']
  };

  // OPM 28 p176 b0: the 俺の核は line got a wide (~147px) slanted quad —
  // detector noise, the print is upright — whose axis-aligned bbox (191px)
  // swallows the neighboring columns; the merged-column wrap then filled
  // that inflated bbox, painting across 駆動騎士 and 既に限界だ.
  const opmSlantedBbox: LayoutBlock = {
    box: [1355, 147, 1725, 546],
    vertical: true,
    font_size: 91,
    lines_coords: [
      [
        [1623, 177],
        [1710, 177],
        [1710, 432],
        [1623, 432]
      ],
      [
        [1478, 172],
        [1623, 147],
        [1669, 437],
        [1524, 459]
      ],
      [
        [1439, 177],
        [1516, 177],
        [1516, 497],
        [1439, 497]
      ],
      [
        [1360, 177],
        [1415, 177],
        [1409, 546],
        [1355, 546]
      ]
    ],
    lines: ['駆動騎士', '俺の花の花花は', '既に限界だ', 'じき爆発する']
  };

  it('separates an offset re-capture pair below the hide gate (OPM 28 p136)', () => {
    const layouts = expectNoOverlaps(opmRecapture);
    // diverged texts: both must stay visible and readable
    for (const l of layouts) {
      expect(l.hidden).toBeFalsy();
      expect(l.fontSize).toBeGreaterThan(8);
    }
  });

  it('keeps an inflated suspect bbox off its clean neighbors (OPM 28 p176)', () => {
    const layouts = expectNoOverlaps(opmSlantedBbox);
    for (const l of layouts) {
      expect(l.hidden).toBeFalsy();
      expect(l.fontSize).toBeGreaterThan(8);
    }
    // The clean columns are correctly placed — the suspect must yield to
    // them, not the other way round: each stays centered on its own quad.
    const quadCenters = [0, 2, 3].map((i) => {
      const xs = opmSlantedBbox.lines_coords![i].map((p) => p[0]);
      return (Math.min(...xs) + Math.max(...xs)) / 2 - opmSlantedBbox.box[0];
    });
    for (const [k, i] of [0, 2, 3].entries()) {
      expect(Math.abs(layouts[i].left + layouts[i].fontSize / 2 - quadCenters[k])).toBeLessThan(3);
    }
  });

  it('holds for clean fixtures without disturbing them', () => {
    for (const block of [jjkFurigana, hareguuShout]) {
      expectNoOverlaps(block);
    }
  });
});

describe('heuristicMeasurer', () => {
  it('counts fullwidth as 1em and ASCII as ~half', () => {
    expect(heuristicMeasurer('あいう')).toBeCloseTo(3, 5);
    expect(heuristicMeasurer('abc')).toBeLessThan(2);
    expect(heuristicMeasurer('')).toBe(0);
  });
});
