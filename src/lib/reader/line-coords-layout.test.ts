import { describe, it, expect } from 'vitest';
import {
  layoutLines as layoutLinesImpl,
  heuristicMeasurer,
  type LayoutBlock,
  type TextMeasurer
} from './line-coords-layout';
import { inkInsets } from './glyph-insets';
import fixturePage from './__fixtures__/char-offsets-page.json';

// Every block the tests below lay out is recorded, so the golden test at the
// end of the file can replay all of them: character placement switched off —
// or simply absent from the block — must leave each layout exactly as it was
// before `char_offsets` existed.
const replayed: { block: LayoutBlock; lines: string[] }[] = [];
function layoutLines(block: LayoutBlock, lines: string[], measure: TextMeasurer) {
  replayed.push({ block, lines });
  return layoutLinesImpl(block, lines, measure);
}

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

// Saki 02 p129: a column re-captured inside a bigger quad whose text re-contains
// it (あれは…), and a hallucination cluster of overlapping quads with divergent
// text. Module-level: the fitted layout and the file-size one both read them.
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
      lines: ['ドン'] // 2 chars: wrapping to 2 columns buys nothing
    };
    const layouts = layoutLines(block, block.lines, heuristicMeasurer)!;
    expect(layouts[0].wrap).toBe(false);
    // the quad hugs the ink of two katakana: 100px is 1.78 cells, not 2
    expect(layouts[0].fontSize).toBeCloseTo(100 / (2 - 0.12 - 0.1), 9);
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
    // ruby fragments keep their own small size — ONE size: they are one line
    // of ruby split around the base text, so they share its pitch
    expect(layouts[0].fontSize).toBeLessThan(35);
    expect(layouts[2].fontSize).toBe(layouts[0].fontSize);
  });

  it('hides a line re-captured inside a bigger line quad (Saki 02 p129 あれは)', () => {
    // L1's quad spans both print columns and its text re-contains L0's
    // (あれは…). Rendering both stacks text; the smaller duplicate is hidden
    // and the bigger line wraps over the full region — no text lost.
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

describe('createCanvasMeasurer', () => {
  const withContext = async (ctx: object | null, run: () => Promise<void>) => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
    try {
      await run();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  };

  // Fixed-pitch print is measured as fixed-pitch: with kerning on, Chromium's
  // canvas reports 38.91em for 39 fullwidth glyphs and every size comes out
  // 0.2% large.
  it('measures with kerning off', async () => {
    const ctx = {
      font: '',
      fontKerning: 'auto',
      measureText: (t: string) => ({ width: t.length * 100 })
    };
    await withContext(ctx, async () => {
      const { createCanvasMeasurer } = await import('./line-coords-layout');
      const measure = createCanvasMeasurer();
      expect(ctx.fontKerning).toBe('none');
      expect(measure('あいう')).toBe(3);
    });
  });

  it('leaves an engine without fontKerning alone', async () => {
    const ctx = { font: '', measureText: (t: string) => ({ width: t.length * 50 }) };
    await withContext(ctx, async () => {
      const { createCanvasMeasurer } = await import('./line-coords-layout');
      expect(createCanvasMeasurer()('あい')).toBe(1);
      expect('fontKerning' in ctx).toBe(false);
    });
  });
});

describe('fittedLineFontSize', () => {
  const rect = (x: number, y: number, w: number, h: number) => [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h]
  ];
  const perChar = (t: string) => t.length;

  it('is the size at which the text fits the quad LENGTH, capped by the thickness', async () => {
    const { fittedLineFontSize } = await import('./line-coords-layout');
    // Chainsaw Man 02 p.9 block 1, quad 7: 483×697, judged vertical, 8 chars —
    // whose ink spans 8 cells less the two hiragana end insets
    const cells = (n: number) => n - 0.11 - 0.1;
    expect(fittedLineFontSize(rect(959, 1885, 483, 697), 'あいうえおかきく', perChar)).toBeCloseTo(
      697 / cells(8),
      5
    );
    // quad 0: 541×99 horizontal, 12 chars
    expect(
      fittedLineFontSize(rect(800, 1710, 541, 99), 'あいうえおかきくけこさし', perChar)
    ).toBeCloseTo(541 / cells(12), 5);
    // a normal quad (thickness smaller than the fitted size) keeps its thickness
    expect(fittedLineFontSize(rect(1500, 1820, 44, 252), 'あい', perChar)).toBe(44);
    // empty text → the thickness
    expect(fittedLineFontSize(rect(0, 0, 40, 200), '', perChar)).toBe(40);
  });
});

// Keep this AFTER every test that goes through the recording `layoutLines`
// above, and keep the char_offsets tests below it (they call layoutLinesImpl):
// the snapshot is the replay list in order, written by the code as it stood
// before placement was wired in.
describe('golden: layouts from before char_offsets', () => {
  const fixtureBlocks = fixturePage.blocks as unknown as LayoutBlock[];
  const allBlocks = () => [
    ...replayed,
    ...fixtureBlocks.map((block) => ({ block, lines: block.lines }))
  ];

  it('lays out every block of this file, and the fixture page, as it always has', () => {
    expect(replayed.length).toBeGreaterThan(20);
    const layouts = allBlocks().map(({ block, lines }) =>
      layoutLinesImpl(block, lines, heuristicMeasurer, { cells: 'off' })
    );
    expect(layouts).toMatchSnapshot();
  });

  it('a block without char_offsets lays out the same in every mode', () => {
    for (const { block, lines } of replayed) {
      expect('char_offsets' in block).toBe(false);
      const off = layoutLinesImpl(block, lines, heuristicMeasurer, { cells: 'off' });
      // strict: not even a `cells: undefined` key may appear
      expect(layoutLinesImpl(block, lines, heuristicMeasurer)).toStrictEqual(off);
      for (const cells of ['repaired', 'as-is'] as const) {
        expect(layoutLinesImpl(block, lines, heuristicMeasurer, { cells })).toStrictEqual(off);
      }
    }
  });

  it("'off' lays a block out as if its char_offsets were not there", () => {
    for (const block of fixtureBlocks) {
      const { char_offsets: _dropped, ...bare } = block;
      expect(
        layoutLinesImpl(block, block.lines, heuristicMeasurer, { cells: 'off' })
      ).toStrictEqual(layoutLinesImpl(bare, bare.lines, heuristicMeasurer));
    }
  });
});

describe('layoutLines with char_offsets', () => {
  const column = (x0: number, x1: number, y0: number, y1: number) => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ];
  const even = (count: number, step: number, start = 0) =>
    Array.from({ length: count + 1 }, (_, k) => start + k * step);
  const sizes = (l: { cells?: { size: number }[] }) => l.cells?.map((cell) => cell.size);

  // A = 8 glyphs down a 50×400 column, B = 5 glyphs down a 50×220 one.
  const pair = (char_offsets: unknown): LayoutBlock => ({
    box: [100, 0, 260, 400],
    vertical: true,
    font_size: 60,
    lines: ['あいうえおかきく', 'さしすせそ'],
    lines_coords: [column(200, 250, 0, 400), column(100, 150, 0, 220)],
    char_offsets
  });

  it('places a vertical line on its cells: start shifts the top, the column stays centred', () => {
    const block = pair([[12, 60, 110, 160, 210, 260, 310, 360, 396], null]);
    const [a, b] = layoutLinesImpl(block, block.lines, heuristicMeasurer)!;
    expect(sizes(a)).toEqual([48, 50, 50, 50, 50, 50, 50, 36]);
    expect(a.cells!.map((cell) => cell.text).join('')).toBe(block.lines[0]);
    // fitted from the PLACED extent: 384px / 8em, under the 50px cross
    expect(a.fontSize).toBe(48);
    expect(a.top).toBe(12);
    expect(a.left).toBe(100 + 25 - 24);
    expect(a.wrap).toBe(false);
    expect(a.hidden).toBeFalsy();
    // the null line takes the fitted path and carries no cells
    expect(b.cells).toBeUndefined();
    expect('cells' in b).toBe(false);
  });

  it('places a horizontal line: start shifts the left, the row stays centred', () => {
    const block: LayoutBlock = {
      box: [10, 20, 310, 60],
      vertical: false,
      font_size: 40,
      lines: ['あいうえお'],
      lines_coords: [column(10, 310, 20, 60)],
      char_offsets: [[20, 70, 120, 170, 220, 270]]
    };
    const [l] = layoutLinesImpl(block, block.lines, heuristicMeasurer)!;
    expect(sizes(l)).toEqual([50, 50, 50, 50, 50]);
    expect(l.fontSize).toBe(40); // min(cross 40, 250 / 5)
    expect(l.left).toBe(20);
    expect(l.top).toBe(0);
  });

  it('keeps its own size instead of the uniform one, but still votes on it', () => {
    // A (the bigger quad) is placed: B follows A's 50px because A still votes.
    const aPlaced = pair([even(8, 50), null]);
    const [a, b] = layoutLinesImpl(aPlaced, aPlaced.lines, heuristicMeasurer)!;
    expect(a.fontSize).toBe(50);
    expect(b.fontSize).toBe(50);
    // B is placed: on the fitted path it would be pulled up to 50 (as 'off'
    // shows); its cells already hold the print size, so it keeps 44.
    const bPlaced = pair([null, even(5, 44)]);
    const placed = layoutLinesImpl(bPlaced, bPlaced.lines, heuristicMeasurer)!;
    const off = layoutLinesImpl(bPlaced, bPlaced.lines, heuristicMeasurer, { cells: 'off' })!;
    expect(off[1].fontSize).toBe(50);
    expect(placed[1].fontSize).toBe(44);
    expect(placed[0]).toStrictEqual(off[0]);
  });

  it('is never a merged-columns suspect and never wraps', () => {
    // jjkFurigana line 0 wraps on the fitted path: a 60px quad for ~19px glyphs
    const off = layoutLinesImpl(jjkFurigana, jjkFurigana.lines, heuristicMeasurer)!;
    expect(off[0].wrap).toBe(true);
    const block = { ...jjkFurigana, char_offsets: [even(9, 19), null, null] };
    const [first] = layoutLinesImpl(block, block.lines, heuristicMeasurer)!;
    expect(first.wrap).toBe(false);
    expect(first.cells).toHaveLength(9);
    expect(first.fontSize).toBe(19);
  });

  it("'repaired' shares a zero-width cell out, 'as-is' renders the file", () => {
    // え has no cell and お has two: the zero cell alone, on a line whose other
    // cells are plausible
    const block: LayoutBlock = {
      box: [100, 0, 150, 240],
      vertical: true,
      font_size: 40,
      lines: ['あいうえおか'],
      lines_coords: [column(100, 150, 0, 240)],
      char_offsets: [[0, 40, 80, 120, 120, 200, 240]]
    };
    const repaired = layoutLinesImpl(block, block.lines, heuristicMeasurer)!;
    const asIs = layoutLinesImpl(block, block.lines, heuristicMeasurer, { cells: 'as-is' })!;
    expect(sizes(repaired[0])).toEqual([40, 40, 40, 40, 40, 40]);
    expect(sizes(asIs[0])).toEqual([40, 40, 40, 0, 80, 40]);
    // geometry does not depend on the mode: same extent, same origin and size
    const { cells: _a, ...repairedBox } = repaired[0];
    const { cells: _b, ...asIsBox } = asIs[0];
    expect(repairedBox).toStrictEqual(asIsBox);
  });

  it("'repaired' fits a squeezed line instead of drawing its cells, 'as-is' renders the file", () => {
    // fixture b0 l0, real data: 地 in 94px, な ポ ン in 22–26px at a ~41px pitch
    // (and ぎ[322,363) と[363,363) 、[363,449) at the tail). Drawn on those cells
    // the glyphs overlap, so auto mode gives the LINE to the fitted path — the
    // block's other lines keep their cells.
    const block = fixturePage.blocks[0] as unknown as LayoutBlock;
    const processed = block.lines.map((line) => line.replace(/．．．/g, '…'));
    const repaired = layoutLinesImpl(block, processed, heuristicMeasurer)!;
    const asIs = layoutLinesImpl(block, processed, heuristicMeasurer, { cells: 'as-is' })!;
    expect(repaired[0].cells).toBeUndefined();
    expect('cells' in repaired[0]).toBe(false);
    expect(sizes(asIs[0])).toEqual([94, 45, 26, 25, 45, 36, 29, 22, 41, 0, 86]);
    for (const i of [1, 2]) {
      expect(sizes(repaired[i])).toBeDefined();
      expect(sizes(repaired[i])).toEqual(sizes(asIs[i]));
    }
  });

  it('takes the cells only when the rendered text is the processed raw line', () => {
    const block = fixturePage.blocks[0] as unknown as LayoutBlock;
    expect(block.lines[2]).toContain('．．．');
    const processed = block.lines.map((line) => line.replace(/．．．/g, '…'));
    const good = layoutLinesImpl(block, processed, heuristicMeasurer)!;
    expect(good[2].cells!.map((cell) => cell.text).join('')).toBe(processed[2]);
    // one cell for the collapsed run: 544 → 585
    expect(good[2].cells!.at(-1)).toEqual({ text: '…', size: 41 });
    // the caller renders something else (here: the raw, uncollapsed line) —
    // cells parallel to the processed text would not be its characters
    const raw = layoutLinesImpl(block, block.lines, heuristicMeasurer)!;
    expect(raw[2].cells).toBeUndefined();
    expect(raw[1].cells).toBeDefined();
  });

  it('degrades a malformed entry to the fitted path, line by line', () => {
    const junk = pair([[0, 50, 40, 150, 200, 250, 300, 350, 400], 'nope']);
    expect(layoutLinesImpl(junk, junk.lines, heuristicMeasurer)).toStrictEqual(
      layoutLinesImpl(junk, junk.lines, heuristicMeasurer, { cells: 'off' })
    );
    // not parallel to lines: the whole field is ignored
    const short = pair([even(8, 50)]);
    expect(layoutLinesImpl(short, short.lines, heuristicMeasurer)).toStrictEqual(
      layoutLinesImpl(short, short.lines, heuristicMeasurer, { cells: 'off' })
    );
  });

  it('a hidden re-capture stays hidden and carries no cells', () => {
    const block: LayoutBlock = {
      box: [100, 0, 200, 400],
      vertical: true,
      font_size: 50,
      lines: ['あれはなんだろう', 'あれは'],
      lines_coords: [column(100, 160, 0, 400), column(105, 155, 0, 150)],
      char_offsets: [even(8, 50), even(3, 50)]
    };
    const layouts = layoutLinesImpl(block, block.lines, heuristicMeasurer)!;
    const off = layoutLinesImpl(block, block.lines, heuristicMeasurer, { cells: 'off' })!;
    expect(off[1].hidden).toBe(true);
    expect(layouts[1]).toStrictEqual(off[1]);
    expect(layouts[0].cells).toHaveLength(8);
  });

  it('holds its ground against a wrapped neighbour, which clips around it', () => {
    // jjkFurigana line 0 wraps and is clipped off line 1's rendered column;
    // placing line 1 must not cost it that trust.
    const block = { ...jjkFurigana, char_offsets: [null, even(7, 33), null] };
    const layouts = layoutLinesImpl(block, block.lines, heuristicMeasurer)!;
    expect(layouts[0].wrap).toBe(true);
    expect(layouts[1].cells).toHaveLength(7);
    expect(layouts[1].wrap).toBe(false);
    expect(layouts[0].left).toBeGreaterThanOrEqual(layouts[1].left + layouts[1].fontSize - 0.5);
  });

  it('keeps its cells through an equal-trust clip: smaller glyphs, never a wrap container', () => {
    const block: LayoutBlock = {
      box: [100, 0, 180, 400],
      vertical: true,
      font_size: 50,
      lines: ['あいうえおかきく', 'さしすせそたちつ'],
      lines_coords: [column(130, 180, 0, 400), column(100, 150, 0, 400)],
      char_offsets: [even(8, 50), even(8, 50)]
    };
    const [right, left] = layoutLinesImpl(block, block.lines, heuristicMeasurer)!;
    for (const l of [right, left]) {
      expect(sizes(l)).toEqual(new Array(8).fill(50));
      expect(l.wrap).toBe(false);
      expect(l.fontSize).toBe(40); // the contested 20px split at its midpoint
      expect(l.top).toBe(0);
    }
    expect(left.left + left.fontSize).toBeLessThanOrEqual(right.left + 0.5);
  });

  it('keeps its cells inside an overlap cluster; only the unplaced members are banded', () => {
    const block: LayoutBlock = {
      box: [100, 0, 180, 400],
      vertical: true,
      font_size: 50,
      lines: ['あいうえおかきく', 'さしすせそたちつ'],
      lines_coords: [column(100, 180, 0, 400), column(100, 170, 0, 400)],
      char_offsets: [even(8, 50), null]
    };
    const alone = { ...block, lines: [block.lines[0]], lines_coords: [block.lines_coords![0]] };
    alone.char_offsets = [even(8, 50)];
    const [placedAlone] = layoutLinesImpl(alone, alone.lines, heuristicMeasurer)!;
    const [placed, banded] = layoutLinesImpl(block, block.lines, heuristicMeasurer)!;
    expect(placed).toStrictEqual(placedAlone);
    expect(banded.wrap).toBe(true);
    expect(banded.cells).toBeUndefined();
    // the band was clipped to the space beside the placed column
    const clear =
      banded.left + banded.width <= placed.left + 0.5 ||
      banded.left >= placed.left + placed.fontSize - 0.5;
    expect(clear).toBe(true);
  });
});

// The uniform grid and rotation (line-grid.ts). These call layoutLinesImpl with
// cells 'off' — what the viewer's auto mode passes — so they stay out of the
// "before char_offsets" replay above and carry a golden of their own.
describe('layoutLines on the fixed-pitch grid', () => {
  const column = (x0: number, x1: number, y0: number, y1: number) => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ];
  /** The quad a detector draws around `text` set solid at `pitch` with its
   * first CELL starting at `cellTop`: it hugs the ink, not the cells. */
  const inkColumn = (x0: number, x1: number, cellTop: number, text: string, pitch: number) => {
    const { lead, trail } = inkInsets(text, true);
    return column(
      x0,
      x1,
      cellTop + lead * pitch,
      cellTop + (Array.from(text).length - trail) * pitch
    );
  };
  const auto = (block: LayoutBlock, lines = block.lines) =>
    layoutLinesImpl(block, lines, heuristicMeasurer, { cells: 'off' })!;
  /** Centre of glyph k along the reading axis (block px), all-fullwidth text. */
  const glyphCentre = (
    l: { top: number; inset: number; letterSpacing: number; fontSize: number },
    k: number
  ) => l.top + l.inset + k * (l.fontSize + l.letterSpacing) + l.fontSize / 2;

  it('a line ending in 。 is not squeezed: every glyph sits on the print’s cell', () => {
    // ten 64px cells from y = 100, in a quad 72 thick
    const text = '「あいうえおかき」。';
    const block: LayoutBlock = {
      box: [0, 0, 72, 900],
      vertical: true,
      font_size: 64,
      lines: [text],
      lines_coords: [inkColumn(0, 72, 100, text, 64)]
    };
    const [l] = auto(block);
    expect(l.fontSize).toBeCloseTo(64, 9);
    expect(l.letterSpacing).toBe(0);
    // `top` is still the quad's start; the run starts a 「-inset before it
    expect(l.top).toBeCloseTo(100 + 0.65 * 64, 9);
    expect(l.inset).toBeCloseTo(-0.65 * 64, 9);
    for (let k = 0; k < 10; k++) expect(glyphCentre(l, k)).toBeCloseTo(100 + (k + 0.5) * 64, 9);
    // the model this replaces: main / count
    const main = 64 * (10 - 0.65 - 0.68);
    expect(main / 10).toBeLessThan(0.87 * 64);
  });

  it('the lines of a block share ONE pitch, anchored at each line’s own start', () => {
    // two body columns and a short closing line; the detector ended the first
    // column 14px late and drew the short line's quad 20px too long
    const lines = [
      'あいうえおかきくけこさしすせそたちつてと',
      'なにぬねのはひふへほまみむめもやゆよらり',
      '「嫌だ」'
    ];
    const quads = [
      inkColumn(200, 272, 100, lines[0], 64),
      inkColumn(100, 172, 100, lines[1], 64),
      inkColumn(0, 72, 100, lines[2], 64)
    ];
    quads[0][2][1] += 14;
    quads[0][3][1] += 14;
    quads[2][2][1] += 20;
    quads[2][3][1] += 20;
    const block: LayoutBlock = {
      box: [0, 0, 272, 1500],
      vertical: true,
      font_size: 64,
      lines,
      lines_coords: quads
    };
    const layouts = auto(block);
    for (const l of layouts) {
      expect(l.fontSize).toBeCloseTo(64, 9);
      expect(l.letterSpacing).toBe(0);
    }
    lines.forEach((text, i) => {
      for (let k = 0; k < Array.from(text).length; k++) {
        expect(glyphCentre(layouts[i], k)).toBeCloseTo(100 + (k + 0.5) * 64, 9);
      }
    });
    // alone, the short line's own quad would have made it 12% too large
    const [alone] = auto({ ...block, lines: [lines[2]], lines_coords: [quads[2]] });
    expect(alone.fontSize).toBeGreaterThan(64 * 1.1);
  });

  it('a short bracketed line is as large as the body text, not two thirds of it', () => {
    // measured on a real page: 「嫌だ」 in a 77 × 174 quad beside 64px text.
    // main / count is 43.5px.
    const block: LayoutBlock = {
      box: [0, 0, 77, 174],
      vertical: true,
      font_size: 70,
      lines: ['「嫌だ」'],
      lines_coords: [column(0, 77, 0, 174)]
    };
    const [l] = auto(block);
    expect(l.fontSize).toBeGreaterThan(64 * 0.95);
    expect(l.fontSize).toBeLessThan(64 * 1.05);
  });

  it('a line in a smaller size than its block closes up: negative spacing within the clamp', () => {
    // a 36px aside beside 40px body text: the block renders at one size (40),
    // the aside on its own pitch
    const lines = ['あいうえおかきくけこさしすせそ', 'たちつてとなにぬねの'];
    const block: LayoutBlock = {
      box: [100, 0, 190, 700],
      vertical: true,
      font_size: 40,
      lines,
      lines_coords: [inkColumn(150, 190, 0, lines[0], 40), inkColumn(100, 140, 0, lines[1], 36)]
    };
    const [, c] = auto(block);
    expect(c.fontSize).toBeCloseTo(40, 9);
    expect(c.letterSpacing).toBeCloseTo(-4, 9);
    for (let k = 0; k < 10; k++) expect(glyphCentre(c, k)).toBeCloseTo((k + 0.5) * 36, 9);
  });

  it('TRACKED text — glyphs on a step wider than they are — is flush with the quad’s ends', () => {
    // 四三二一 across a contents page: 77px glyphs on a 145px step
    const block: LayoutBlock = {
      box: [0, 0, 504, 77],
      vertical: false,
      font_size: 77,
      lines: ['四三二一'],
      lines_coords: [column(0, 504, 0, 77)]
    };
    const [l] = auto(block);
    expect(l.fontSize).toBe(77);
    const step = l.fontSize + l.letterSpacing;
    expect(step).toBeCloseTo((504 - 77 * 0.9) / 3, 9);
    // first ink at the quad's start, last ink at its end
    expect(l.left + l.inset + 0.05 * 77).toBeCloseTo(0, 9);
    expect(l.left + l.inset + 3 * step + 77 * 0.95).toBeCloseTo(504, 9);
  });

  it('a half-width mixed line keeps its narrow advances: tracking is per character', () => {
    const mixed: LayoutBlock = {
      box: [100, 0, 140, 240],
      vertical: true,
      font_size: 40,
      lines: ['第12話です'],
      lines_coords: [column(100, 140, 0, 240)]
    };
    const [l] = auto(mixed);
    expect(l.fontSize).toBe(40); // capped by the quad's thickness
    // 4 fullwidth + 2 digits at 0.55em = 5.1em of 40px glyphs, whose ink
    // (第 0.05, す 0.10 short of their cells) spans the quad: the rest of the
    // length is the tracking between the six characters
    expect(l.letterSpacing).toBeCloseTo((240 - 40 * (5.1 - 0.05 - 0.1)) / 5, 9);
    expect(l.inset).toBeCloseTo(-0.05 * 40, 9);
    // the last glyph's ink ends where the quad does
    expect(l.inset + 5.1 * 40 + 5 * l.letterSpacing - 0.1 * 40).toBeCloseTo(240, 9);
  });

  it('gives up outside the clamps: two characters in a quad drawn around a whole column', () => {
    const block: LayoutBlock = {
      box: [100, 0, 140, 300],
      vertical: true,
      font_size: 40,
      lines: ['あい'],
      lines_coords: [column(100, 140, 0, 300)]
    };
    const [l] = auto(block);
    // (300 - 80) / 2 = 110px = 2.75em: the line renders as it did before
    expect(l).toStrictEqual({
      left: 0,
      top: 0,
      fontSize: 40,
      wrap: false,
      width: 40,
      height: 300,
      rotation: 0,
      letterSpacing: 0,
      inset: 0
    });
  });

  it('never spreads a run into a neighbour the unspaced text was clear of', () => {
    // two quads in one column whose ends overlap by 80px: A's text (200px at
    // the block size) stops short of B, its quad does not
    const stacked: LayoutBlock = {
      box: [100, 0, 140, 420],
      vertical: true,
      font_size: 40,
      lines: ['あいうえお', 'かきくけこ'],
      lines_coords: [column(100, 140, 0, 300), column(100, 140, 220, 420)]
    };
    const [a, b] = auto(stacked);
    expect(a).toMatchObject({ fontSize: 40, top: 0, letterSpacing: 0, inset: 0 });
    // B's grid (2px a glyph) reaches nothing, and stays
    expect(b).toMatchObject({ fontSize: 40, top: 220 });
    expect(b.letterSpacing).toBeGreaterThan(0);
    expect(b.letterSpacing).toBeLessThan(3);
    // …and alone, the same line does take the grid
    const alone = {
      ...stacked,
      lines: [stacked.lines[0]],
      lines_coords: [column(100, 140, 0, 300)]
    };
    expect(auto(alone)[0].letterSpacing).toBeCloseTo((300 - 40 * (1 - 0.11 - 0.1)) / 4 - 40, 9);
  });

  it('wrapped, banded and hidden lines carry no spacing and no rotation', () => {
    for (const block of [jjkFurigana, pokemonRotated, fmaHallucination]) {
      for (const l of auto(block)) {
        if (!l.wrap && !l.hidden) continue;
        expect(l).toMatchObject({ rotation: 0, letterSpacing: 0, inset: 0 });
      }
    }
    // Pokemon Adventures 03 p24: the 7.6° quad is a merged base+ruby capture.
    // It wraps inside its bbox, and a wrap container does not turn.
    const [slanted] = auto(pokemonRotated);
    expect(slanted.wrap).toBe(true);
    expect(slanted.rotation).toBe(0);
  });

  it('leaves text with collapsible white space alone: the measurer and the browser disagree on it', () => {
    const spaced: LayoutBlock = {
      box: [0, 0, 400, 40],
      vertical: false,
      font_size: 40,
      lines: ['NO  WAY '],
      lines_coords: [column(0, 400, 0, 40)]
    };
    expect(auto(spaced)[0]).toMatchObject({ letterSpacing: 0, inset: 0 });
    expect(auto({ ...spaced, lines: ['NO WAY'] })[0].letterSpacing).toBeGreaterThan(0);
  });
});

describe('layoutLines with tilted quads', () => {
  /** w × h upright rectangle about (cx, cy), turned like CSS rotate(deg). */
  const tilted = (cx: number, cy: number, w: number, h: number, deg: number) => {
    const t = (deg * Math.PI) / 180;
    return [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2]
    ].map(([dx, dy]) => [
      cx + dx * Math.cos(t) - dy * Math.sin(t),
      cy + dx * Math.sin(t) + dy * Math.cos(t)
    ]);
  };
  const boxOf = (quads: number[][][]) => {
    const xs = quads.flat().map((p) => p[0]);
    const ys = quads.flat().map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const auto = (block: LayoutBlock) =>
    layoutLinesImpl(block, block.lines, heuristicMeasurer, { cells: 'off' })!;

  const sfx = (deg: number, vertical = true): LayoutBlock => {
    const quad = vertical ? tilted(500, 400, 50, 360, deg) : tilted(500, 400, 360, 50, deg);
    return {
      box: boxOf([quad]),
      vertical,
      font_size: 50,
      lines: ['ドドドドドド'],
      lines_coords: [quad]
    };
  };

  it.each([20, -35])(
    'a vertical line tilted %d° lies in its own frame, centred on the quad',
    (deg) => {
      const block = sfx(deg);
      const [l] = auto(block);
      expect(l.rotation).toBeCloseTo(deg, 9);
      // the own-frame box: cross × main, centred on the quad centre
      expect(l.width).toBeCloseTo(50, 9);
      expect(l.height).toBeCloseTo(360, 9);
      expect(l.left + l.width / 2).toBeCloseTo(500 - block.box[0], 9);
      expect(l.top + l.height / 2).toBeCloseTo(400 - block.box[1], 9);
      expect(l.wrap).toBe(false);
      // sized from the quad's OWN extents, not its inflated bbox: 6 katakana
      // 50px thick in 360px of ink — tracked, flush with both ends
      expect(l.fontSize).toBeCloseTo(50, 9);
      expect(l.letterSpacing).toBeCloseTo((360 - 50 * (1 - 0.12 - 0.1)) / 5 - 50, 9);
      expect(l.inset).toBeCloseTo(-0.12 * 50, 9);
    }
  );

  it('a horizontal line tilted -10°', () => {
    const block = sfx(-10, false);
    const [l] = auto(block);
    expect(l.rotation).toBeCloseTo(-10, 9);
    expect(l.width).toBeCloseTo(360, 9);
    expect(l.height).toBeCloseTo(50, 9);
    expect(l.left + l.width / 2).toBeCloseTo(500 - block.box[0], 9);
    expect(l.top + l.height / 2).toBeCloseTo(400 - block.box[1], 9);
  });

  it('corner noise on a short line is not a rotation: 2.4° over 243px stays upright', () => {
    // a five-glyph shout, level in print, whose detector quad reads 2.4°
    const quad = tilted(500, 400, 64, 243, 2.4);
    const block: LayoutBlock = {
      box: boxOf([quad]),
      vertical: true,
      font_size: 64,
      lines: ['「だめだ！」'],
      lines_coords: [quad]
    };
    const [l] = auto(block);
    expect(l.rotation).toBe(0);
    expect(l.top).toBe(0);
    // …while a real 5° slant on a long column turns
    const long = tilted(500, 400, 64, 600, 5);
    const [turned] = auto({
      ...block,
      box: boxOf([long]),
      lines: ['あいうえおかきくけ'],
      lines_coords: [long]
    });
    expect(turned.rotation).toBeCloseTo(5, 9);
  });

  it('a tilt inside the dead band changes nothing at all', () => {
    const upright = auto(sfx(0))[0];
    const wobbly = sfx(1.5);
    const [l] = auto(wobbly);
    expect(l.rotation).toBe(0);
    // today's anchoring: the bbox start, centred across the bbox
    const xs = wobbly.lines_coords![0].map((p) => p[0]);
    expect(l.top).toBe(0);
    expect(l.left).toBeCloseTo((Math.max(...xs) - Math.min(...xs)) / 2 - l.fontSize / 2, 9);
    expect(upright.rotation).toBe(0);
  });

  it('parallel slanted columns are neither re-captures of each other nor banded, and all turn', () => {
    // three 50×300 columns at 35°, one 60px pitch apart across the lean. Their
    // bboxes share ~75% of the smaller one: by the bbox test, a garbage cluster.
    const t = (35 * Math.PI) / 180;
    const quads = [0, 1, 2].map((k) =>
      tilted(600 - k * 60 * Math.cos(t), 400 - k * 60 * Math.sin(t), 50, 300, 35)
    );
    const block: LayoutBlock = {
      box: boxOf(quads),
      vertical: true,
      font_size: 50,
      lines: ['あいうえおか', 'きくけこさし', 'すせそたちつ'],
      lines_coords: quads
    };
    const layouts = auto(block);
    for (const l of layouts) {
      expect(l.hidden).toBeFalsy();
      expect(l.wrap).toBe(false);
      expect(l.rotation).toBeCloseTo(35, 9);
      expect(l.fontSize).toBeCloseTo(50, 9);
    }
  });

  it('a turned line that would cross a clean neighbour falls back to the upright layout, both clear', () => {
    // a 45° line lying right across an upright column
    const column = [
      [480, 200],
      [520, 200],
      [520, 600],
      [480, 600]
    ];
    const crossing = tilted(500, 400, 40, 400, 45);
    const block: LayoutBlock = {
      box: boxOf([column, crossing]),
      vertical: true,
      font_size: 40,
      lines: ['あいうえおかきくけこ', 'さしすせそたちつてと'],
      lines_coords: [column, crossing]
    };
    const layouts = auto(block);
    expect(layouts[0].rotation).toBe(0);
    expect(layouts[1].rotation).toBe(0);
    // the upright layout is the bbox-anchored one the overlap rules know
    expect(layouts[1].top).toBe(Math.min(...crossing.map((p) => p[1])) - block.box[1]);
  });

  it('a wrap container yields to a turned line: clipped around it, never the other way', () => {
    // a merged-columns quad (wraps) whose right part a 20° line leans through
    const merged = [
      [300, 200],
      [460, 200],
      [460, 500],
      [300, 500]
    ];
    const leaning = tilted(450, 350, 40, 300, 20);
    const clean = [
      [600, 200],
      [640, 200],
      [640, 520],
      [600, 520]
    ];
    const block: LayoutBlock = {
      box: boxOf([merged, leaning, clean]),
      vertical: true,
      font_size: 40,
      lines: ['あいうえおかきくけこさしすせそたちつてと', 'なにぬねのは', 'まみむめもやゆよ'],
      lines_coords: [merged, leaning, clean]
    };
    const [wrapped, turned] = auto(block);
    expect(wrapped.wrap).toBe(true);
    expect(wrapped.rotation).toBe(0);
    expect(turned.rotation).toBeCloseTo(20, 9);
    expect(turned.wrap).toBe(false);
    // the container ends left of everything the turned line covers
    const reach = (300 * Math.sin((20 * Math.PI) / 180) + 40 * Math.cos((20 * Math.PI) / 180)) / 2;
    expect(wrapped.left + wrapped.width).toBeLessThanOrEqual(450 - block.box[0] - reach + 0.5);
  });

  it("a rotated line with cells ('as-is') turns too: own-frame box, the start shift as its inset", () => {
    const quad = tilted(500, 400, 50, 400, 20);
    const block: LayoutBlock = {
      box: boxOf([quad]),
      vertical: true,
      font_size: 50,
      lines: ['あいうえおかきく'],
      lines_coords: [quad],
      char_offsets: [[12, 60, 110, 160, 210, 260, 310, 360, 396]]
    };
    const [l] = layoutLinesImpl(block, block.lines, heuristicMeasurer, { cells: 'as-is' })!;
    expect(l.cells).toHaveLength(8);
    expect(l.rotation).toBeCloseTo(20, 9);
    expect(l.inset).toBe(12);
    expect(l.letterSpacing).toBe(0);
    expect(l.height).toBeCloseTo(400, 9);
    expect(l.top + l.height / 2).toBeCloseTo(400 - block.box[1], 9);
    // and with the offsets ignored (auto mode), the same line rides the grid
    const [gridded] = auto(block);
    expect(gridded.cells).toBeUndefined();
    expect(gridded.rotation).toBeCloseTo(20, 9);
  });

  it('golden: tilted and letter-spaced layouts', () => {
    const t = (35 * Math.PI) / 180;
    const slanted = [0, 1].map((k) =>
      tilted(600 - k * 60 * Math.cos(t), 400 - k * 60 * Math.sin(t), 50, 300, 35)
    );
    const blocks: LayoutBlock[] = [
      sfx(20),
      sfx(-35),
      sfx(-10, false),
      {
        box: boxOf(slanted),
        vertical: true,
        font_size: 50,
        lines: ['あいうえお', 'きくけこさし'],
        lines_coords: slanted
      },
      {
        box: [100, 0, 190, 320],
        vertical: true,
        font_size: 40,
        lines: ['あいうえおかきく', 'さしすせ'],
        lines_coords: [
          [
            [150, 0],
            [190, 0],
            [190, 320],
            [150, 320]
          ],
          [
            [100, 0],
            [140, 0],
            [140, 200],
            [100, 200]
          ]
        ]
      },
      {
        box: [0, 0, 300, 40],
        vertical: false,
        font_size: 40,
        lines: ['第12話です'],
        lines_coords: [
          [
            [0, 0],
            [300, 0],
            [300, 40],
            [0, 40]
          ]
        ]
      }
    ];
    expect(blocks.map(auto)).toMatchSnapshot();
  });
});

// ORIGINAL font mode, for a block the file does not place character by
// character: `size: 'file'`. The PLACEMENT is auto's — each line on its quad's
// frame, the block's pitch grid, the ink insets, the rotation — and the SIZE is
// the file's block font_size, CAPPED by the file's own line geometry where the
// two contradict each other (mokuro's font_size is the quad's thickness, ruby
// and mask slack included: median +20%, p95 2×; at that size on the real pitch
// the glyphs draw on top of each other). Nothing else second-guesses the file:
// no wrap containers, no bands, no nudging or clipping, and a tilt is never
// refused. The one heuristic kept is the one without which the view is
// unreadable: a re-captured duplicate stays hidden (its text is inside the line
// that hides it, so nothing the file says goes missing).
describe("layoutLines at the file's font size (original mode)", () => {
  const tilted = (cx: number, cy: number, w: number, h: number, deg: number) => {
    const t = (deg * Math.PI) / 180;
    return [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2]
    ].map(([dx, dy]) => [
      cx + dx * Math.cos(t) - dy * Math.sin(t),
      cy + dx * Math.sin(t) + dy * Math.cos(t)
    ]);
  };
  const boxOf = (quads: number[][][]) => {
    const xs = quads.flat().map((p) => p[0]);
    const ys = quads.flat().map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const auto = (block: LayoutBlock) =>
    layoutLinesImpl(block, block.lines, heuristicMeasurer, { cells: 'off' })!;
  const original = (block: LayoutBlock) =>
    layoutLinesImpl(block, block.lines, heuristicMeasurer, { cells: 'off', size: 'file' })!;

  // Quads hug the ink (hiragana: 0.11 / 0.10 of the end cells empty). Line 0:
  // 8 glyphs set solid on a 40px step from y = 0. Line 1: 4 glyphs of the same
  // print size tracked out to a 56px step. The FILE says 42px — 5% over the
  // step, which is what a consistent mokuro file looks like (fixture block 1).
  const loose: LayoutBlock = {
    box: [100, 0, 190, 320],
    vertical: true,
    font_size: 42,
    lines: ['あいうえおかきく', 'さしすせ'],
    lines_coords: [
      [
        [150, 4.4],
        [190, 4.4],
        [190, 316],
        [150, 316]
      ],
      [
        [100, 4.4],
        [140, 4.4],
        [140, 204],
        [100, 204]
      ]
    ]
  };

  it('every line is on its quad at the file’s size; the spacing is what is left of the pitch', () => {
    const [full, short] = original(loose);
    const [fittedFull] = auto(loose);
    expect(fittedFull.fontSize).toBeCloseTo(40, 6);
    for (const l of [full, short]) {
      expect(l.fontSize).toBe(42);
      expect(l.wrap).toBe(false);
      expect(l.rotation).toBe(0);
      // anchored at the quad's start, as in auto…
      expect(l.top).toBeCloseTo(4.4, 9);
      // …the first glyph CENTRED on the print's first glyph: half the size
      // difference earlier, on top of the first cell's ink inset
      expect(l.inset).toBeCloseTo((40 - 42) / 2 - 0.11 * 40, 6);
    }
    // centred ACROSS the quad at the size it renders at
    expect(full.left).toBeCloseTo(170 - 21 - 100, 9);
    expect(short.left).toBeCloseTo(120 - 21 - 100, 9);
    // a 40px step under 42px glyphs, a 56px step under 42px glyphs
    expect(full.letterSpacing).toBeCloseTo(40 - 42, 6);
    expect(short.letterSpacing).toBeCloseTo(56 - 42, 6);
    // so glyph k of the solid line is centred on print cell k: 20 + 40k
    for (let k = 0; k < 8; k++) {
      const start = full.top + full.inset + k * (42 + full.letterSpacing);
      expect(start + 21).toBeCloseTo(20 + 40 * k, 6);
    }
  });

  // THE CAP. When the file's font size and the file's own line geometry
  // contradict each other, the geometry wins: a line renders no bigger than
  // closes its glyphs up by FILE_MIN_SPACING_EM (−0.05em) on its pitch, nor
  // bigger than CROSS_SLACK × its quad's thickness.
  describe('the file’s size yields to the file’s geometry', () => {
    const stock = (fixturePage.blocks as unknown as LayoutBlock[]).map((b) => {
      const { char_offsets: _stripped, ...bare } = b;
      return bare as LayoutBlock;
    });
    const spacingEm = (l: { letterSpacing: number; fontSize: number }) =>
      l.letterSpacing / l.fontSize;

    it('fixture block 2 (font_size 155 on a 111px pitch): glyphs no longer collide', () => {
      const block = stock[2];
      expect(block.font_size).toBe(155);
      const [pitch] = auto(block).map((l) => l.fontSize);
      expect(pitch).toBeCloseTo(111.33, 1);
      const layouts = original(block);
      // was 155px at −43.7px (−0.28em): 〝 on 新, 〟 on 齟
      for (const l of layouts) {
        expect(l.fontSize).toBeLessThan(155);
        expect(l.fontSize).toBeCloseTo(pitch / 0.95, 6);
        expect(spacingEm(l)).toBeGreaterThanOrEqual(-0.05 - 1e-9);
        expect(l.letterSpacing).toBeCloseTo(pitch - pitch / 0.95, 6);
        expect(l.wrap).toBe(false);
      }
      // one size for the bubble
      expect(new Set(layouts.map((l) => l.fontSize)).size).toBe(1);
    });

    it('solid-set print keeps the file’s size EXACTLY (fixture block 1: 59px on a 56.2px pitch)', () => {
      const layouts = original(stock[1]);
      for (const l of layouts) {
        expect(l.fontSize).toBe(59);
        expect(spacingEm(l)).toBeGreaterThanOrEqual(-0.05);
        expect(spacingEm(l)).toBeLessThan(0);
      }
      // …and so does a synthetic block whose size IS its step
      for (const l of original({ ...loose, font_size: 40 })) expect(l.fontSize).toBe(40);
      expect(original({ ...loose, font_size: 40 })[0].letterSpacing).toBe(0);
    });

    it('a font_size SMALLER than the pitch is kept, with positive spacing', () => {
      const [full, short] = original({ ...loose, font_size: 36 });
      expect(full.fontSize).toBe(36);
      expect(short.fontSize).toBe(36);
      expect(full.letterSpacing).toBeCloseTo(40 - 36, 6);
      expect(short.letterSpacing).toBeCloseTo(56 - 36, 6);
    });

    it('on the whole stock page: spacing never below −0.05em, one size per block, never above font_size', () => {
      for (const block of stock) {
        const layouts = original(block).filter((l) => !l.hidden);
        for (const l of layouts) {
          expect(l.fontSize).toBeLessThanOrEqual(block.font_size);
          expect(spacingEm(l)).toBeGreaterThanOrEqual(-0.05 - 1e-9);
        }
        expect(new Set(layouts.map((l) => l.fontSize)).size).toBe(1);
      }
    });

    // Three columns of one bubble, 40px print set solid; the file says 60.
    const column = (x: number, cross: number, glyphs: number): number[][] => [
      [x, 4.4],
      [x + cross, 4.4],
      [x + cross, 40 * glyphs - 4],
      [x, 40 * glyphs - 4]
    ];
    const bubble = (third: { text: string; cross: number }): LayoutBlock => ({
      box: [0, 0, 150, 320],
      vertical: true,
      font_size: 60,
      lines: ['あいうえおかきく', 'さしすせそたち', third.text],
      lines_coords: [
        column(100, 40, 8),
        column(50, 40, 7),
        column(0, third.cross, [...third.text].length)
      ]
    });

    it('the block is capped by its TIGHTEST FULL line, not line by line: one size per bubble', () => {
      // all three on the 40px step; the third column's quad is only 30px thick
      const layouts = original(bubble({ text: 'なにぬねのはひふ', cross: 30 }));
      for (const l of layouts) expect(l.fontSize).toBeCloseTo(30 * 1.2, 9);
      // without the thin column: the pitch decides, for all three alike
      for (const l of original(bubble({ text: 'なにぬねのはひふ', cross: 40 })))
        expect(l.fontSize).toBeCloseTo(40 / 0.95, 9);
    });

    it('a SHORT line too thin for the block’s size does not drag the block down: it alone goes lower', () => {
      const [a, b, short] = original(bubble({ text: 'なに', cross: 24 }));
      expect(a.fontSize).toBeCloseTo(40 / 0.95, 9);
      expect(b.fontSize).toBeCloseTo(40 / 0.95, 9);
      expect(short.fontSize).toBeCloseTo(24 * 1.2, 9);
    });

    it('a line on its OWN pitch (ruby beside its base text) is capped by that pitch, the body by the body’s', () => {
      const block: LayoutBlock = {
        box: [0, 0, 110, 320],
        vertical: true,
        font_size: 60,
        lines: ['あいうえおかきく', 'さしすせそたち', 'かなかなかな'],
        lines_coords: [
          column(60, 40, 8),
          column(10, 40, 7),
          // 16px ruby: six glyphs hugging their ink from y = 100
          [
            [102, 100 + 0.11 * 16],
            [118, 100 + 0.11 * 16],
            [118, 100 + 16 * 6 - 0.1 * 16],
            [102, 100 + 16 * 6 - 0.1 * 16]
          ]
        ]
      };
      const [a, b, ruby] = original(block);
      expect(a.fontSize).toBeCloseTo(40 / 0.95, 6);
      expect(b.fontSize).toBe(a.fontSize);
      expect(ruby.fontSize).toBeCloseTo(16 / 0.95, 6);
    });

    it('tracked print (step wider than the quad is thick): the quad’s thickness caps the size, the spacing stays positive', () => {
      // 40px glyphs on a 56px step; the file says 80
      const tracked: LayoutBlock = {
        ...loose,
        font_size: 80,
        lines: [loose.lines[1]],
        lines_coords: [loose.lines_coords![1]]
      };
      const [line] = original(tracked);
      expect(line.fontSize).toBeCloseTo(40 * 1.2, 9);
      expect(line.letterSpacing).toBeCloseTo(56 - 48, 6);
      // beside a solid column of the same print it takes the BLOCK's size
      const [full, short] = original({ ...loose, font_size: 80 });
      expect(full.fontSize).toBeCloseTo(40 / 0.95, 9);
      expect(short.fontSize).toBe(full.fontSize);
      expect(short.letterSpacing).toBeCloseTo(56 - 40 / 0.95, 6);
    });

    it('a line whose own pitch came out a little tighter caps the BLOCK: no column in a size of its own', () => {
      // fixture block 0: the third column (…) is on a 42.0px step of its own
      // beside two on 44.5px — 44.2px for all three, not 46.8 / 46.8 / 44.2
      const layouts = original(stock[0]);
      expect(new Set(layouts.map((l) => l.fontSize)).size).toBe(1);
      expect(layouts[0].fontSize).toBeCloseTo(44.18, 1);
      expect(layouts[0].letterSpacing).toBeGreaterThan(0);
      expect(spacingEm(layouts[2])).toBeCloseTo(-0.05, 9);
    });
  });

  it.each([
    ['vertical', true, 20],
    ['vertical', true, -35],
    ['horizontal', false, -15]
  ] as const)('a tilted %s line turns %d°, at the file’s size', (_name, vertical, deg) => {
    const quad = vertical ? tilted(500, 400, 50, 360, deg) : tilted(500, 400, 360, 50, deg);
    const block: LayoutBlock = {
      box: boxOf([quad]),
      vertical,
      font_size: 44,
      lines: ['ドドドドドド'],
      lines_coords: [quad]
    };
    const [l] = original(block);
    const [fitted] = auto(block);
    expect(fitted.fontSize).toBeCloseTo(50, 9);
    expect(l.fontSize).toBe(44);
    expect(l.rotation).toBeCloseTo(deg, 9);
    // the same own-frame box as auto: cross × main about the quad's centre
    expect([l.left, l.top, l.width, l.height]).toEqual([
      fitted.left,
      fitted.top,
      fitted.width,
      fitted.height
    ]);
    // the quad's step (64.2px: 50px katakana tracked over 360px of ink), less
    // the file's glyph size; the first glyph centred on the print's
    const step = 50 + (360 - 50 * (6 - 0.12 - 0.1)) / 5;
    expect(l.letterSpacing).toBeCloseTo(step - 44, 9);
    expect(l.inset).toBeCloseTo((50 - 44) / 2 - 0.12 * 50, 9);
    // an overstated size turns just the same, capped by the quad's thickness
    const [over] = original({ ...block, font_size: 90 });
    expect(over.fontSize).toBeCloseTo(50 * 1.2, 9);
    expect(over.rotation).toBeCloseTo(deg, 9);
    expect(over.letterSpacing).toBeCloseTo(step - 60, 9);
  });

  it('an inflated file size yields to the quads — and still nothing is wrapped, moved or clipped', () => {
    // Jujutsukaisen 24 p57: font_size 46 around ~24–34px print. Auto wraps
    // line 0 (its quad took in a neighbour's ruby) and fits the rest.
    const fitted = layoutLinesImpl(jjkFurigana, jjkFurigana.lines, heuristicMeasurer, {
      cells: 'off'
    })!;
    expect(fitted.some((l) => l.wrap)).toBe(true);
    const layouts = original(jjkFurigana);
    layouts.forEach((l, i) => {
      const xs = jjkFurigana.lines_coords![i].map((p) => p[0]);
      const ys = jjkFurigana.lines_coords![i].map((p) => p[1]);
      expect(l.hidden).toBeFalsy();
      expect(l.wrap).toBe(false);
      expect(l.fontSize).toBeLessThan(jjkFurigana.font_size);
      // on its own quad — start edge, centred across — moved by no neighbour
      expect(l.top).toBeCloseTo(Math.min(...ys) - jjkFurigana.box[1], 9);
      expect(l.left).toBeCloseTo(
        (Math.min(...xs) + Math.max(...xs)) / 2 - l.fontSize / 2 - jjkFurigana.box[0],
        9
      );
      // every line is on the grid now: 46px glyphs on a ~25px step used to be
      // past MIN_SPACING_EM, an unspaced oversize run across its neighbours
      expect(l.letterSpacing).not.toBe(0);
      expect(l.letterSpacing / l.fontSize).toBeGreaterThanOrEqual(-0.05 - 1e-9);
      // and no column is wider than the geometry can carry
      expect(l.fontSize).toBeLessThanOrEqual((Math.max(...xs) - Math.min(...xs)) * 1.2 + 1e-9);
    });
  });

  it('a re-captured duplicate stays hidden — and the line that re-contains it does not wrap', () => {
    const [duplicate, whole] = original(sakiAreha);
    expect(duplicate.hidden).toBe(true);
    expect(whole.hidden).toBeFalsy();
    expect(whole.wrap).toBe(false);
    // twelve glyphs the file puts in ONE 156px line: a run that long, not the
    // 816px the file's 68px would make of it (auto wraps it instead)
    expect(whole.fontSize).toBeLessThan(68);
    expect(whole.fontSize * 12).toBeLessThanOrEqual(156 / 0.9);
  });

  it('overlapping lines with DIFFERENT text are what the file says: each on its own quad, no bands', () => {
    const layouts = original(sakiGarbage);
    layouts.forEach((l, i) => {
      const ys = sakiGarbage.lines_coords![i].map((p) => p[1]);
      const xs = sakiGarbage.lines_coords![i].map((p) => p[0]);
      expect(l.hidden).toBeFalsy();
      expect(l.wrap).toBe(false);
      expect(l.fontSize).toBeLessThanOrEqual(81);
      expect(l.left).toBeCloseTo(Math.min(...xs) - sakiGarbage.box[0], 9);
      expect(l.top).toBeCloseTo((Math.min(...ys) + Math.max(...ys)) / 2 - l.fontSize / 2 - 456, 9);
    });
  });

  it('a tilt is never refused: lines whose quads cross still turn (auto sets them upright)', () => {
    // two 50px columns at 35° whose quads are only 40px apart across the lean
    const t = (35 * Math.PI) / 180;
    const quads = [0, 1].map((k) =>
      tilted(600 - k * 40 * Math.cos(t), 400 - k * 40 * Math.sin(t), 50, 300, 35)
    );
    const block: LayoutBlock = {
      box: boxOf(quads),
      vertical: true,
      font_size: 90,
      lines: ['あいうえおか', 'きくけこさし'],
      lines_coords: quads
    };
    expect(auto(block).some((l) => l.rotation === 0)).toBe(true);
    for (const l of original(block)) {
      expect(l.rotation).toBeCloseTo(35, 9);
      expect(l.fontSize).toBeLessThan(90);
      expect(l.wrap).toBe(false);
    }
  });

  it('a file with no usable font_size keeps the fitted sizes (and still invents nothing)', () => {
    for (const font_size of [0, -3, Number.NaN, undefined as unknown as number]) {
      const layouts = original({ ...jjkFurigana, font_size });
      const fitted = auto({ ...jjkFurigana, font_size });
      layouts.forEach((l, i) => {
        expect(l.wrap).toBe(false);
        expect(l.fontSize).toBeGreaterThan(10);
        expect(l.fontSize).toBeLessThan(46);
        if (!fitted[i].wrap) expect(l.fontSize).toBeCloseTo(fitted[i].fontSize, 9);
      });
    }
  });

  it("without the option nothing changes: 'fitted' is the default", () => {
    for (const block of [loose, jjkFurigana, sakiAreha, sakiGarbage]) {
      expect(
        layoutLinesImpl(block, block.lines, heuristicMeasurer, { cells: 'off', size: 'fitted' })
      ).toEqual(auto(block));
    }
  });

  it('golden: file-size layouts', () => {
    expect(
      [loose, jjkFurigana, sakiAreha, sakiGarbage, pokemonRotated].map(original)
    ).toMatchSnapshot();
  });
});
