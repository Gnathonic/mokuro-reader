import { describe, expect, it } from 'vitest';
import type { Page } from '$lib/types';
import { validLineOffsets } from '$lib/reader/char-offsets';
import { quadExtents } from '$lib/reader/line-coords-layout';
import { gcvToPage, type GcvAnnotateResponse, type GcvSymbol } from './gcv-convert';
import vertical from './__fixtures__/gcv-vertical.json';
import horizontal from './__fixtures__/gcv-horizontal.json';

const page = (w = 400, h = 600): Page => ({
  version: '0.2.1',
  img_width: w,
  img_height: h,
  img_path: '001.png',
  blocks: [{ box: [0, 0, 1, 1], vertical: true, font_size: 1, lines: ['old'] }]
});

describe('gcvToPage', () => {
  it('vertical bubble: two lines, vertical, font from symbol width, furigana dropped, quads per line', () => {
    const out = gcvToPage(vertical as GcvAnnotateResponse, page());
    expect(out.blocks).toHaveLength(1);
    const b = out.blocks[0];
    expect(b.vertical).toBe(true);
    expect(b.lines).toEqual(['こんにちは', 'せかい']);
    expect(b.font_size).toBe(20);
    expect(b.lines_coords).toHaveLength(2);
    expect(b.lines_coords![0]).toEqual([
      [300, 40],
      [320, 40],
      [320, 150],
      [300, 150]
    ]);
    expect(b.box).toEqual([260, 40, 320, 150]);
    // image facts kept, old blocks replaced
    expect(out.img_path).toBe('001.png');
    expect(out.img_width).toBe(400);
  });

  it('horizontal block: lines split on EOL_SURE_SPACE/LINE_BREAK, spaces on SPACE breaks', () => {
    const out = gcvToPage(horizontal as GcvAnnotateResponse, page());
    const b = out.blocks[0];
    expect(b.vertical).toBe(false);
    expect(b.lines).toEqual(['ＣＯＮＴＥＮＴＳ', '２０１７ ８']);
    expect(b.font_size).toBe(30);
  });

  it('rescales coordinates when the request image was downscaled', () => {
    const out = gcvToPage(vertical as GcvAnnotateResponse, page(800, 1200), 0.5);
    expect(out.blocks[0].box).toEqual([520, 80, 640, 300]);
    expect(out.blocks[0].font_size).toBe(40);
    expect(out.blocks[0].lines_coords![0][0]).toEqual([600, 80]);
  });

  it('an empty response yields a page with no blocks', () => {
    expect(gcvToPage({ responses: [{}] }, page()).blocks).toEqual([]);
  });

  it('drops furigana even with only two lines (main + ruby, no third line to pull the median up)', () => {
    // A vertical symbol's "extent" is box width. Main glyphs are 20px wide,
    // the ruby line beside them ~45% that width — with only two lines the
    // old median-of-extents was their mean, which dragged the threshold low
    // enough to keep the ruby line.
    const mainSymbol = (y: number, brk?: string) => ({
      text: '水',
      boundingBox: {
        vertices: [
          { x: 300, y },
          { x: 320, y },
          { x: 320, y: y + 20 },
          { x: 300, y: y + 20 }
        ]
      },
      ...(brk ? { property: { detectedBreak: { type: brk } } } : {})
    });
    const rubySymbol = (y: number, brk?: string) => ({
      text: 'み',
      boundingBox: {
        vertices: [
          { x: 291, y },
          { x: 300, y },
          { x: 300, y: y + 9 },
          { x: 291, y: y + 9 }
        ]
      },
      ...(brk ? { property: { detectedBreak: { type: brk } } } : {})
    });
    const response: GcvAnnotateResponse = {
      responses: [
        {
          fullTextAnnotation: {
            pages: [
              {
                blocks: [
                  {
                    boundingBox: {
                      vertices: [
                        { x: 291, y: 40 },
                        { x: 320, y: 40 },
                        { x: 320, y: 80 },
                        { x: 291, y: 80 }
                      ]
                    },
                    paragraphs: [
                      {
                        words: [
                          {
                            symbols: [mainSymbol(40), mainSymbol(60, 'LINE_BREAK')]
                          },
                          {
                            symbols: [rubySymbol(40), rubySymbol(49, 'LINE_BREAK')]
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        }
      ]
    };

    const out = gcvToPage(response, page());
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0].lines).toEqual(['水水']);
  });
});

type Rect = [number, number, number, number];

/** A symbol as the API sends it: four corners, the break hint only when there is one. */
const sym = (text: string, [x0, y0, x1, y1]: Rect, brk?: string): GcvSymbol => ({
  text,
  boundingBox: {
    vertices: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 }
    ]
  },
  ...(brk ? { property: { detectedBreak: { type: brk } } } : {})
});

/** One block, one paragraph, one word; no block box, so it is the union of the lines. */
const respond = (symbols: GcvSymbol[]): GcvAnnotateResponse => ({
  responses: [
    { fullTextAnnotation: { pages: [{ blocks: [{ paragraphs: [{ words: [{ symbols }] }] }] }] } }
  ]
});

/**
 * What every produced page owes the reader: offsets parallel to the lines, each
 * entry valid for its line against that line's quad, and the method stamped
 * exactly when there is something to describe. Returns how many entries it saw
 * so a test cannot pass by producing nothing.
 */
function expectOffsetsContract(out: Page): number {
  let entries = 0;
  for (const b of out.blocks) {
    if (b.char_offsets === undefined) continue;
    expect(b.char_offsets).toHaveLength(b.lines.length);
    expect(b.char_offsets.some((entry) => entry !== null)).toBe(true);
    b.char_offsets.forEach((entry, i) => {
      if (entry === null) return;
      entries++;
      const main = quadExtents(b.lines_coords![i], b.vertical)!.main;
      expect(validLineOffsets(b.lines[i], entry, main)).toBe(entry);
      expect(entry[entry.length - 1]).toBeLessThanOrEqual(main);
    });
  }
  expect(out.char_offsets_method).toBe(entries > 0 ? 'gcv-symbols' : undefined);
  return entries;
}

describe('gcvToPage char_offsets', () => {
  it('vertical fixture: cells from the symbol boxes along y, the furigana line takes its entry with it', () => {
    const out = gcvToPage(vertical as GcvAnnotateResponse, page());
    expect(out.blocks[0].lines).toEqual(['こんにちは', 'せかい']);
    expect(out.blocks[0].char_offsets).toEqual([
      [0, 22, 44, 66, 88, 110],
      [0, 22, 44, 66]
    ]);
    expect(out.char_offsets_method).toBe('gcv-symbols');
    expect(expectOffsetsContract(out)).toBe(2);
  });

  it('horizontal fixture: cells along x; a SPACE break is a zero-width cell at the gap midpoint', () => {
    const out = gcvToPage(horizontal as GcvAnnotateResponse, page());
    expect(out.blocks[0].lines).toEqual(['ＣＯＮＴＥＮＴＳ', '２０１７ ８']);
    expect(out.blocks[0].char_offsets).toEqual([
      [0, 30, 60, 90, 120, 150, 180, 210, 240],
      // ７ ends at 220, ８ starts at 250: one boundary at 235, and the space sits on it
      [0, 30, 60, 90, 135, 135, 180]
    ]);
    expect(expectOffsetsContract(out)).toBe(2);
  });

  it('scaled path: offsets grow with the quads (fixture sent at half size)', () => {
    const out = gcvToPage(vertical as GcvAnnotateResponse, page(800, 1200), 0.5);
    expect(out.blocks[0].char_offsets).toEqual([
      [0, 44, 88, 132, 176, 220],
      [0, 44, 88, 132]
    ]);
    expect(expectOffsetsContract(out)).toBe(2);
  });

  it('proportional Latin: each boundary is the midpoint of the gap, so advances follow the print', () => {
    const out = gcvToPage(
      respond([
        sym('W', [100, 50, 128, 80]),
        sym('i', [130, 50, 138, 80]),
        sym('l', [140, 50, 148, 80], 'LINE_BREAK')
      ]),
      page()
    );
    expect(out.blocks[0].lines).toEqual(['Wil']);
    expect(out.blocks[0].vertical).toBe(false);
    expect(out.blocks[0].char_offsets).toEqual([[0, 29, 39, 48]]);
    expect(expectOffsetsContract(out)).toBe(1);
  });

  it('scaled path re-clamps: corners and offsets round separately, and the quad has the last word', () => {
    // x 101 → 253 (252.5 rounds up) and 148 → 370: the quad is 117 wide, while
    // the last offset 47 scales to 117.5 → 118.
    const out = gcvToPage(
      respond([sym('W', [101, 50, 128, 80]), sym('l', [130, 50, 148, 80], 'LINE_BREAK')]),
      page(1000, 1000),
      0.4
    );
    expect(out.blocks[0].lines_coords![0][0]).toEqual([253, 125]);
    expect(out.blocks[0].char_offsets).toEqual([[0, 70, 117]]);
    expect(expectOffsetsContract(out)).toBe(1);
  });

  it('a symbol with an omitted x (the API drops zero coordinates) starts at 0, never NaN', () => {
    const atEdge: GcvSymbol = {
      text: 'A',
      boundingBox: { vertices: [{ y: 10 }, { x: 20, y: 10 }, { x: 20, y: 30 }, { y: 30 }] }
    };
    const out = gcvToPage(respond([atEdge, sym('B', [22, 10, 40, 30], 'LINE_BREAK')]), page());
    expect(out.blocks[0].lines_coords![0][0]).toEqual([0, 10]);
    expect(out.blocks[0].char_offsets).toEqual([[0, 21, 40]]);
    expect(expectOffsetsContract(out)).toBe(1);
  });

  it('a vertical line at the top edge: every y of the first symbol omitted or zero', () => {
    const atTop: GcvSymbol = {
      text: '\u6c34',
      boundingBox: { vertices: [{ x: 300 }, { x: 320 }, { x: 320, y: 20 }, { x: 300, y: 20 }] }
    };
    const out = gcvToPage(
      respond([atTop, sym('\u6c34', [300, 24, 320, 44], 'LINE_BREAK')]),
      page()
    );
    expect(out.blocks[0].vertical).toBe(true);
    expect(out.blocks[0].char_offsets).toEqual([[0, 22, 44]]);
    expect(expectOffsetsContract(out)).toBe(1);
  });

  it('a symbol with no vertices is dropped with its text, and the rest stays parallel', () => {
    const boxless: GcvSymbol = { text: 'X' };
    const out = gcvToPage(
      respond([sym('A', [100, 10, 120, 30]), boxless, sym('B', [120, 10, 140, 30], 'LINE_BREAK')]),
      page()
    );
    expect(out.blocks[0].lines).toEqual(['AB']);
    expect(out.blocks[0].char_offsets).toEqual([[0, 20, 40]]);
    expect(expectOffsetsContract(out)).toBe(1);
  });

  it('overlapping symbol boxes meet at the midpoint of the overlap', () => {
    const out = gcvToPage(
      respond([sym('A', [100, 10, 130, 40]), sym('B', [124, 10, 150, 40], 'LINE_BREAK')]),
      page()
    );
    expect(out.blocks[0].char_offsets).toEqual([[0, 27, 50]]);
    expect(expectOffsetsContract(out)).toBe(1);
  });

  it('a multi-code-point symbol splits its span evenly; a surrogate pair is one cell', () => {
    const out = gcvToPage(
      respond([
        sym('\u{20bb7}', [100, 10, 130, 40]),
        sym('!?', [130, 10, 161, 40]),
        sym('A', [161, 10, 191, 40], 'LINE_BREAK')
      ]),
      page()
    );
    expect(out.blocks[0].lines).toEqual(['\u{20bb7}!?A']);
    // 31px over two code points: 15.5 rounds up, the pair still ends at 61
    expect(out.blocks[0].char_offsets).toEqual([[0, 30, 46, 61, 91]]);
    expect(expectOffsetsContract(out)).toBe(1);
  });

  it('trimmed characters take their cells with them (a trailing SPACE break at the paragraph end)', () => {
    const out = gcvToPage(
      respond([sym('A', [100, 10, 120, 30]), sym('B', [120, 10, 140, 30], 'SPACE')]),
      page()
    );
    expect(out.blocks[0].lines).toEqual(['AB']);
    expect(out.blocks[0].char_offsets).toEqual([[0, 20, 40]]);
    expect(expectOffsetsContract(out)).toBe(1);
  });

  it('a textless symbol widens the quad but owns no cell: offsets[0] is where the text starts', () => {
    const out = gcvToPage(
      respond([
        sym('', [90, 10, 100, 30]),
        sym('A', [100, 10, 120, 30]),
        sym('B', [120, 10, 140, 30], 'LINE_BREAK')
      ]),
      page()
    );
    expect(out.blocks[0].lines_coords![0][0]).toEqual([90, 10]);
    expect(out.blocks[0].char_offsets).toEqual([[10, 30, 50]]);
    expect(expectOffsetsContract(out)).toBe(1);
  });

  it('symbols that run backwards along the axis (two columns read as one line) are not guessed at', () => {
    // No break between the columns: down the first, then back up to the second.
    const out = gcvToPage(
      respond([
        sym('\u3042', [300, 40, 320, 60]),
        sym('\u3044', [300, 60, 320, 80]),
        sym('\u3046', [300, 80, 320, 100]),
        sym('\u3048', [270, 40, 290, 60]),
        sym('\u304a', [270, 60, 290, 80], 'LINE_BREAK')
      ]),
      page()
    );
    expect(out.blocks[0].lines).toHaveLength(1);
    expect(out.blocks[0].char_offsets).toBeUndefined();
    expect(out.char_offsets_method).toBeUndefined();
    expect(expectOffsetsContract(out)).toBe(0);
  });

  it('a box swallowed by its predecessor leaves no honest boundary: null, not an empty cell', () => {
    // B's centre is past A's, but B ends (135) before the A|B midpoint (140).
    const out = gcvToPage(
      respond([sym('A', [100, 10, 150, 40]), sym('B', [130, 10, 135, 40], 'LINE_BREAK')]),
      page()
    );
    expect(out.blocks[0].lines).toEqual(['AB']);
    expect(out.blocks[0].char_offsets).toBeUndefined();
    expect(expectOffsetsContract(out)).toBe(0);
  });

  it('a line lying across the block axis is null; the block keeps the entries of its other lines', () => {
    // Two vertical columns and a horizontal caption in one block: the block is
    // vertical, so the reader would lay the caption along y, where its symbols
    // all share one span.
    const column = (x: number) => [
      sym('\u3042', [x, 40, x + 20, 60]),
      sym('\u3044', [x, 60, x + 20, 80]),
      sym('\u3046', [x, 80, x + 20, 100], 'LINE_BREAK')
    ];
    const out = gcvToPage(
      respond([
        ...column(300),
        ...column(270),
        sym('A', [270, 110, 290, 130]),
        sym('B', [290, 110, 310, 130], 'LINE_BREAK')
      ]),
      page()
    );
    expect(out.blocks[0].vertical).toBe(true);
    expect(out.blocks[0].lines).toHaveLength(3);
    expect(out.blocks[0].char_offsets).toEqual([[0, 20, 40, 60], [0, 20, 40, 60], null]);
    expect(expectOffsetsContract(out)).toBe(2);
  });

  it('a page with no text has no method', () => {
    expect(gcvToPage({ responses: [{}] }, page()).char_offsets_method).toBeUndefined();
  });
});
