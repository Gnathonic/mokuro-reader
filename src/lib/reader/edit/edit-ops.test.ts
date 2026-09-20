import { describe, expect, it } from 'vitest';
import type { Page } from '$lib/types';
import { validLineOffsets } from '../char-offsets';
import fixture from '../__fixtures__/char-offsets-page.json';
import {
  addBlock,
  flipBlock,
  mergeBlocks,
  moveBlock,
  pageMajorityVertical,
  removeBlocks,
  resizeBlock,
  setBlockLines,
  splitBlock
} from './edit-ops';

const quad = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1]
];

function page(): Page {
  return {
    version: '0.2.1',
    img_width: 200,
    img_height: 300,
    img_path: 'p.png',
    blocks: [
      {
        box: [100, 10, 140, 110],
        vertical: true,
        font_size: 20,
        lines: ['あい', 'うえ'],
        lines_coords: [quad(120, 10, 140, 110), quad(100, 10, 120, 110)],
        // line 0 placed (extent 100 == the quad's main/height), line 1 unplaced
        char_offsets: [[0, 40, 100], null]
      },
      { box: [10, 200, 90, 240], vertical: false, font_size: 18, lines: ['ok'] }
    ]
  };
}

/** Every block's char_offsets, when present, is length-parallel to lines and
 * every non-null entry is a structurally valid line-offsets array. */
function assertParallelCharOffsets(p: Page) {
  for (const block of p.blocks) {
    if (block.char_offsets === undefined) continue;
    expect(block.char_offsets).toHaveLength(block.lines.length);
    block.char_offsets.forEach((entry, i) => {
      if (entry === null) return;
      expect(validLineOffsets(block.lines[i], entry)).not.toBeNull();
    });
  }
}

describe('moveBlock', () => {
  it('translates box and quads, clamps to the image, and leaves other blocks untouched', () => {
    const p = page();
    const out = moveBlock(p, 0, 70, -20);
    expect(out).not.toBe(p);
    expect(out.blocks[1]).toBe(p.blocks[1]);
    expect(out.blocks[0].box).toEqual([160, 0, 200, 100]);
    expect(out.blocks[0].lines_coords![0][0]).toEqual([180, 0]);
    expect(p.blocks[0].box).toEqual([100, 10, 140, 110]);
  });
  it('leaves char_offsets untouched (a move never changes a quad size)', () => {
    const p = page();
    const out = moveBlock(p, 0, 70, -20);
    expect(out.blocks[0].char_offsets).toBe(p.blocks[0].char_offsets);
  });
});

describe('resizeBlock', () => {
  it('scales quads into the new box and rescales font_size by the cross axis', () => {
    const out = resizeBlock(page(), 0, [100, 10, 180, 110]);
    expect(out.blocks[0].box).toEqual([100, 10, 180, 110]);
    // width doubled → vertical font doubles
    expect(out.blocks[0].font_size).toBe(40);
    expect(out.blocks[0].lines_coords![0]).toEqual(quad(140, 10, 180, 110));
  });
  it('scales each line char_offsets by its own main-axis (height, for a vertical block) ratio', () => {
    // main axis (height) unchanged here (only width grows) → factor 1, values preserved
    const out = resizeBlock(page(), 0, [100, 10, 180, 110]);
    expect(out.blocks[0].char_offsets![0]).toEqual([0, 40, 100]);
    expect(out.blocks[0].char_offsets![1]).toBeNull();
  });
  it('doubling the main axis doubles a placed line’s offsets', () => {
    // height 100 → 200 doubles the vertical main axis
    const out = resizeBlock(page(), 0, [100, 10, 180, 210]);
    expect(out.blocks[0].char_offsets![0]).toEqual([0, 80, 200]);
  });
  it('deletes char_offsets when the block has no quads to scale by', () => {
    const p = page();
    delete p.blocks[0].lines_coords;
    const out = resizeBlock(p, 0, [100, 10, 180, 110]);
    expect(out.blocks[0].char_offsets).toBeUndefined();
  });
});

describe('setBlockLines', () => {
  it('keeps quads when the line count is unchanged', () => {
    const out = setBlockLines(page(), 0, ['かき', 'くけ']);
    expect(out.blocks[0].lines).toEqual(['かき', 'くけ']);
    expect(out.blocks[0].lines_coords).toHaveLength(2);
  });
  it('drops quads when the line count changes', () => {
    const out = setBlockLines(page(), 0, ['かきくけ']);
    expect(out.blocks[0].lines_coords).toBeUndefined();
  });
  it('reflows char_offsets per line on an unchanged line count, and drops it entirely when the count changes', () => {
    const out = setBlockLines(page(), 0, ['かき', 'くけ']);
    // full replacement of a placed line still yields a valid, reflowed entry
    expect(out.blocks[0].char_offsets![0]).toEqual([0, 50, 100]);
    // the unplaced line has nothing to reflow from and stays null
    expect(out.blocks[0].char_offsets![1]).toBeNull();
    expect(setBlockLines(page(), 0, ['かきくけ']).blocks[0].char_offsets).toBeUndefined();
  });
  it('a one-character text fix keeps every other boundary (same array values, reflowed in place)', () => {
    const p = page();
    p.blocks[0].char_offsets = [[0, 50, 100, 150], null];
    p.blocks[0].lines = ['あいう', 'うえ'];
    const out = setBlockLines(p, 0, ['あんう', 'うえ']);
    expect(out.blocks[0].char_offsets![0]).toEqual([0, 50, 100, 150]);
    // the untouched line keeps its exact array by reference
    expect(out.blocks[0].char_offsets![1]).toBe(p.blocks[0].char_offsets![1]);
  });
});

describe('addBlock / removeBlocks', () => {
  it('adds a block with the page majority writing mode and an estimated size', () => {
    const { page: out, index } = addBlock(page(), [0, 0, 30, 90]);
    expect(index).toBe(2);
    expect(out.blocks[2]).toEqual({
      box: [0, 0, 30, 90],
      vertical: true,
      font_size: 30,
      lines: ['']
    });
  });
  it('removes by index without touching survivors', () => {
    const p = page();
    const out = removeBlocks(p, [0]);
    expect(out.blocks).toEqual([p.blocks[1]]);
  });
});

describe('mergeBlocks', () => {
  it("unions boxes, concatenates lines in reading order, keeps the largest block's mode", () => {
    const p = page();
    p.blocks.push({
      box: [60, 10, 95, 110],
      vertical: true,
      font_size: 22,
      lines: ['おか'],
      lines_coords: [quad(60, 10, 95, 110)]
    });
    const { page: out, index } = mergeBlocks(p, [2, 0]);
    expect(index).toBe(0);
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[0].box).toEqual([60, 10, 140, 110]);
    // vertical: right-to-left → block 0 (xmax 140) before block 2 (xmax 95)
    expect(out.blocks[0].lines).toEqual(['あい', 'うえ', 'おか']);
    expect(out.blocks[0].lines_coords).toHaveLength(3);
    expect(out.blocks[0].font_size).toBe(20);
  });
  it('concats char_offsets in reading order, filling nulls for a source with none', () => {
    const p = page();
    p.blocks.push({
      box: [60, 10, 95, 110],
      vertical: true,
      font_size: 22,
      lines: ['おか'],
      lines_coords: [quad(60, 10, 95, 110)]
    });
    const { page: out } = mergeBlocks(p, [2, 0]);
    expect(out.blocks[0].char_offsets).toEqual([[0, 40, 100], null, null]);
  });
  it('leaves char_offsets absent when no source has any (even though both have quads)', () => {
    const p = page();
    delete p.blocks[0].char_offsets;
    p.blocks.push({
      box: [60, 10, 95, 110],
      vertical: true,
      font_size: 22,
      lines: ['おか'],
      lines_coords: [quad(60, 10, 95, 110)]
    });
    const { page: out } = mergeBlocks(p, [2, 0]);
    expect(out.blocks[0].lines_coords).toHaveLength(3);
    expect(out.blocks[0].char_offsets).toBeUndefined();
  });
  describe('sources that read along different axes', () => {
    // Offsets are distances along the axis the SOURCE's `vertical` flag picks
    // on its quad. The merged block reads every line by ONE flag, so a source
    // that disagrees with it would have its offsets read along the other edge
    // of the same quad.
    function mixed(rowOffsets?: (number[] | null)[]): Page {
      const p = page();
      // short enough to pass validation on EITHER axis of the 20×100 quad, so
      // nothing downstream would catch it: 18 <= 1.15 * 20
      p.blocks[0].char_offsets = [[0, 8, 18], null];
      p.blocks.push({
        box: [10, 200, 190, 260], // larger than block 0 → the merge is horizontal
        vertical: false,
        font_size: 60,
        lines: ['かきく'],
        lines_coords: [quad(10, 200, 190, 260)],
        ...(rowOffsets ? { char_offsets: rowOffsets } : {})
      });
      return p;
    }

    it("nulls a source's entries when its axis is not the merged block's, keeping the rest", () => {
      const p = mixed([[0, 60, 120, 180]]);
      const { page: out } = mergeBlocks(p, [0, 2]);
      const merged = out.blocks[0];
      expect(merged.vertical).toBe(false);
      // horizontal reading order: top to bottom → block 0's two lines first
      expect(merged.lines).toEqual(['あい', 'うえ', 'かきく']);
      expect(merged.lines_coords).toHaveLength(3);
      expect(merged.char_offsets).toEqual([null, null, [0, 60, 120, 180]]);
      // the surviving entry is the source's own array
      expect(merged.char_offsets![2]).toBe(p.blocks[2].char_offsets![0]);
      assertParallelCharOffsets(out);
    });

    it('leaves the key absent when only cross-axis sources had offsets', () => {
      const { page: out } = mergeBlocks(mixed(), [0, 2]);
      expect(out.blocks[0].vertical).toBe(false);
      expect(out.blocks[0].lines_coords).toHaveLength(3);
      expect(out.blocks[0].char_offsets).toBeUndefined();
    });
  });

  it('drops quads if any source lacks them', () => {
    const { page: out } = mergeBlocks(page(), [0, 1]);
    expect(out.blocks[0].lines_coords).toBeUndefined();
    // quads dropped → char_offsets is dropped too, even though block 0 had one
    expect(out.blocks[0].char_offsets).toBeUndefined();
  });
});

describe('splitBlock', () => {
  it('produces two blocks with the lines divided and the box cut at the quad boundary', () => {
    const { page: out, indices } = splitBlock(page(), 0, 1);
    expect(indices).toEqual([0, 1]);
    expect(out.blocks[0].lines).toEqual(['あい']);
    expect(out.blocks[1].lines).toEqual(['うえ']);
    expect(out.blocks[0].box).toEqual([120, 10, 140, 110]);
    expect(out.blocks[1].box).toEqual([100, 10, 120, 110]);
    expect(out.blocks[0].lines_coords).toHaveLength(1);
    expect(out.blocks[2].lines).toEqual(['ok']);
  });
  it('is a no-op for an out-of-range cut', () => {
    const p = page();
    expect(splitBlock(p, 0, 0).page).toBe(p);
    expect(splitBlock(p, 0, 2).page).toBe(p);
  });
  it('slices char_offsets across the cut, and omits it on a source that had none', () => {
    const { page: out } = splitBlock(page(), 0, 1);
    expect(out.blocks[0].char_offsets).toEqual([[0, 40, 100]]);
    expect(out.blocks[1].char_offsets).toEqual([null]);
    expect(out.blocks[2].char_offsets).toBeUndefined();
  });
});

describe('flipBlock', () => {
  it('toggles vertical and leaves the box alone by default', () => {
    const out = flipBlock(page(), 0);
    expect(out.blocks[0].vertical).toBe(false);
    expect(out.blocks[0].box).toEqual([100, 10, 140, 110]);
  });
  it('swaps the box aspect about its centre when asked', () => {
    const out = flipBlock(page(), 0, true);
    expect(out.blocks[0].box).toEqual([70, 40, 170, 80]);
  });
  it('leaves char_offsets alone by default, and drops it with the quads on swapBox', () => {
    const p = page();
    expect(flipBlock(p, 0).blocks[0].char_offsets).toBe(p.blocks[0].char_offsets);
    expect(flipBlock(p, 0, true).blocks[0].char_offsets).toBeUndefined();
  });
});

describe('pageMajorityVertical', () => {
  it('is true when at least half the blocks are vertical, true for an empty page', () => {
    expect(pageMajorityVertical(page())).toBe(true);
    expect(pageMajorityVertical({ ...page(), blocks: [] })).toBe(true);
    expect(pageMajorityVertical({ ...page(), blocks: [page().blocks[1]] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Line-centric ops — fixture modelled on a real table-of-contents block
// (Chainsaw Man 02 p.9: 13 lines, `vertical:false`, font_size 295, quads of
// MIXED orientation, several overlapping).
// ---------------------------------------------------------------------------
import {
  insertLine,
  moveLine,
  placeLines,
  removeLine,
  resizeLine,
  healBlockFontSize
} from './edit-ops';
import { lineGeometry, rectQuad } from './block-geometry';

function tocPage(): Page {
  const quads = [
    rectQuad(800, 1710, 541, 99), // 0 horizontal
    rectQuad(1500, 1820, 44, 252), // 1 vertical
    rectQuad(1440, 1820, 44, 300), // 2 vertical
    rectQuad(1380, 1820, 44, 280), // 3 vertical
    rectQuad(1320, 1820, 44, 260), // 4 vertical
    rectQuad(1260, 1820, 44, 400), // 5 vertical
    rectQuad(1000, 1720, 38, 908), // 6 vertical, full height
    rectQuad(1010, 1750, 40, 500), // 7 vertical, overlaps 6
    rectQuad(940, 1820, 44, 300), // 8 vertical
    rectQuad(880, 1820, 44, 300), // 9 vertical
    rectQuad(820, 1820, 44, 300), // 10 vertical
    rectQuad(800, 2500, 500, 90), // 11 horizontal
    rectQuad(800, 2560, 300, 80) // 12 horizontal
  ];
  return {
    version: '0.2.1',
    img_width: 1746,
    img_height: 2800,
    img_path: '009.jpg',
    blocks: [
      { box: [100, 100, 200, 300], vertical: true, font_size: 30, lines: ['前'] },
      {
        box: [760, 1704, 1561, 2655],
        vertical: false,
        font_size: 295,
        // 8 fullwidth chars per line: the heuristic measurer advances 1em each
        lines: Array.from({ length: 13 }, () => 'あいうえおかきく'),
        lines_coords: quads
      }
    ]
  };
}

describe('lineGeometry', () => {
  it('derives orientation from the quad aspect and font size from the cross axis without text', () => {
    expect(lineGeometry(rectQuad(800, 1710, 541, 99))).toEqual({
      left: 800,
      top: 1710,
      width: 541,
      height: 99,
      vertical: false,
      fontSize: 99
    });
    expect(lineGeometry(rectQuad(1500, 1820, 44, 252))).toMatchObject({
      vertical: true,
      fontSize: 44
    });
  });
  it('with text, the font size is the FITTED size (text fits the quad length), never more than the thickness', () => {
    const perChar = (t: string) => t.length;
    // a fat mis-detected quad: 483×697 vertical, 8 chars → ~87, not 483
    expect(lineGeometry(rectQuad(959, 1885, 483, 697), 'あいうえおかきく', perChar).fontSize).toBe(
      87
    );
    // 541×99 horizontal, 12 chars → 45, not 99
    expect(
      lineGeometry(rectQuad(800, 1710, 541, 99), 'あいうえおかきくけこさし', perChar).fontSize
    ).toBe(45);
    // a normal quad is unchanged
    expect(lineGeometry(rectQuad(1500, 1820, 44, 252), 'あい', perChar).fontSize).toBe(44);
  });
});

describe('moveLine', () => {
  it('translates one quad, leaves the others, and grows the box to contain it', () => {
    const p = tocPage();
    const out = moveLine(p, 1, 1, 100, -200);
    expect(out.blocks[1].lines_coords![1]).toEqual(rectQuad(1600, 1620, 44, 252));
    expect(out.blocks[1].lines_coords![0]).toEqual(p.blocks[1].lines_coords![0]);
    // box grew up and right; never shrank
    expect(out.blocks[1].box).toEqual([760, 1620, 1644, 2655]);
    expect(p.blocks[1].box).toEqual([760, 1704, 1561, 2655]);
  });
  it('stops at the image edge', () => {
    const out = moveLine(tocPage(), 1, 1, 10000, 0);
    expect(out.blocks[1].lines_coords![1][1][0]).toBe(1746);
  });
});

describe('resizeLine', () => {
  it('replaces the quad, grows the box, and heals the block font size to the line median', () => {
    const p = tocPage();
    const out = resizeLine(p, 1, 6, rectQuad(1000, 1720, 60, 1000));
    expect(out.blocks[1].lines_coords![6]).toEqual(rectQuad(1000, 1720, 60, 1000));
    expect(out.blocks[1].box[3]).toBe(2720);
    // median of the 13 FITTED line sizes (8 chars each): the tall vertical
    // quads fit at their length / 8 (252/8≈32 … 400/8=50, 908/8≈114,
    // 1000/8=125), the horizontal ones at 541/8≈68, 500/8≈63, 300/8≈38,
    // each capped by its thickness → sorted median is 38
    expect(out.blocks[1].font_size).toBe(38);
  });
  it('scales char_offsets by the new/old main-axis ratio (×2 → doubled)', () => {
    const p = page();
    const out = resizeLine(p, 0, 0, quad(120, 10, 140, 210)); // height 100 → 200
    expect(out.blocks[0].char_offsets![0]).toEqual([0, 80, 200]);
    expect(out.blocks[0].char_offsets![1]).toBeNull(); // other lines untouched
  });
});

describe('healBlockFontSize', () => {
  it('replaces an oversized block font_size with the median FITTED line size', () => {
    const out = healBlockFontSize(tocPage(), 1);
    // same sizes as above with quad 6 at 908/8≈114 (capped 38) and quad 7 at
    // 500/8≈63 (capped 40) → median 38
    expect(out.blocks[1].font_size).toBe(38);
  });
  it('is a no-op without quads', () => {
    const p = tocPage();
    expect(healBlockFontSize(p, 0)).toBe(p);
  });
});

describe('placeLines', () => {
  it('divides a vertical block into right-to-left columns, one per line', () => {
    const p = tocPage();
    p.blocks[0].lines = ['a', 'b', 'c'];
    const out = placeLines(p, 0);
    // box [100,100,200,300], width 100 → 3 columns of 33.3, first on the RIGHT
    const q = out.blocks[0].lines_coords!;
    expect(q).toHaveLength(3);
    expect(q[0][0][0]).toBeCloseTo(166.67, 1);
    expect(q[0][1][0]).toBe(200);
    expect(q[2][0][0]).toBe(100);
    expect(q[0][0][1]).toBe(100);
    expect(q[0][2][1]).toBe(300);
    expect(out.blocks[0].font_size).toBe(33);
  });
  it('divides a horizontal block into top-to-bottom rows', () => {
    const p = tocPage();
    p.blocks[0] = { box: [0, 0, 300, 90], vertical: false, font_size: 50, lines: ['a', 'b', 'c'] };
    const q = placeLines(p, 0).blocks[0].lines_coords!;
    expect(q[0]).toEqual(rectQuad(0, 0, 300, 30));
    expect(q[2]).toEqual(rectQuad(0, 60, 300, 30));
  });
  it('leaves a block that already has quads alone', () => {
    const p = tocPage();
    expect(placeLines(p, 1)).toBe(p);
  });
  it('deletes char_offsets: a freshly divided grid has no relation to any old placement', () => {
    const p = tocPage();
    p.blocks[0].lines = ['a', 'b'];
    p.blocks[0].char_offsets = [
      [0, 5],
      [0, 5]
    ];
    expect(placeLines(p, 0).blocks[0].char_offsets).toBeUndefined();
  });
});

describe('insertLine / removeLine', () => {
  it('inserts an empty line after the given one with a quad one advance further along', () => {
    const p = tocPage();
    // vertical line 1 (x 1500..1544) → the next column sits to its LEFT
    const out = insertLine(p, 1, 1);
    expect(out.blocks[1].lines).toHaveLength(14);
    expect(out.blocks[1].lines[2]).toBe('');
    expect(out.blocks[1].lines_coords![2]).toEqual(rectQuad(1456, 1820, 44, 252));
    // horizontal line 12 (y 2560..2640) → the next row sits BELOW, and the box grows
    const out2 = insertLine(p, 1, 12);
    expect(out2.blocks[1].lines_coords![13]).toEqual(rectQuad(800, 2640, 300, 80));
    expect(out2.blocks[1].box[3]).toBe(2720);
  });
  it('inserting into a block without quads just inserts the line', () => {
    const out = insertLine(tocPage(), 0, 0);
    expect(out.blocks[0].lines).toEqual(['前', '']);
    expect(out.blocks[0].lines_coords).toBeUndefined();
  });
  it('removes the line and its quad, but never the last line', () => {
    const out = removeLine(tocPage(), 1, 0);
    expect(out.blocks[1].lines).toHaveLength(12);
    expect(out.blocks[1].lines_coords).toHaveLength(12);
    expect(out.blocks[1].lines_coords![0]).toEqual(rectQuad(1500, 1820, 44, 252));
    const p = tocPage();
    expect(removeLine(p, 0, 0)).toBe(p);
  });
  it('splices a null into char_offsets on insert, and filters it out on remove', () => {
    const p = tocPage();
    p.blocks[1].char_offsets = p.blocks[1].lines.map((_, i) =>
      i === 1 ? [0, 10, 20, 30, 40, 50, 60, 70, 80] : null
    );
    const out = insertLine(p, 1, 1);
    expect(out.blocks[1].char_offsets).toHaveLength(14);
    expect(out.blocks[1].char_offsets![1]).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80]);
    expect(out.blocks[1].char_offsets![2]).toBeNull(); // the newly spliced entry

    const removed = removeLine(out, 1, 2);
    expect(removed.blocks[1].char_offsets).toHaveLength(13);
    expect(removed.blocks[1].char_offsets![1]).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80]);
  });
  it('deletes an out-of-parallel char_offsets rather than propagate it', () => {
    const p = tocPage();
    p.blocks[1].char_offsets = [[0, 1]]; // wrong length for 13 lines
    expect(insertLine(p, 1, 0).blocks[1].char_offsets).toBeUndefined();
    expect(removeLine(p, 1, 0).blocks[1].char_offsets).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Property test on the real fixture: char_offsets must stay parallel to lines
// — absent, or an array of the right length whose non-null entries are
// structurally valid — after EVERY op in a mixed, realistic sequence.
// ---------------------------------------------------------------------------

describe('char_offsets stays parallel through a mixed sequence of ops', () => {
  it('holds after every step on the real fixture page', () => {
    let p: Page = JSON.parse(JSON.stringify(fixture));
    assertParallelCharOffsets(p);

    p = moveBlock(p, 0, 10, -5);
    assertParallelCharOffsets(p);

    // grows the vertical block's main axis (height) → its offsets scale, not just its font
    const b1 = p.blocks[1].box;
    p = resizeBlock(p, 1, [b1[0], b1[1], b1[2] + 40, b1[3] + 120]);
    assertParallelCharOffsets(p);

    p = resizeLine(p, 2, 0, rectQuad(1400, 1690, 90, 500));
    assertParallelCharOffsets(p);

    // a one-character fix on a placed line, text unchanged elsewhere
    const [line0, line1, line2] = p.blocks[0].lines;
    p = setBlockLines(p, 0, [line0.replace('ぎ', 'き'), line1, line2]);
    assertParallelCharOffsets(p);

    p = insertLine(p, 1, 0);
    assertParallelCharOffsets(p);
    p = removeLine(p, 1, 1); // remove the line just inserted
    assertParallelCharOffsets(p);

    const split = splitBlock(p, 2, 1);
    p = split.page;
    assertParallelCharOffsets(p);

    const merged = mergeBlocks(p, split.indices);
    p = merged.page;
    assertParallelCharOffsets(p);
    // block 3 (no char_offsets in the fixture) is back at its original index
    expect(p.blocks[3].char_offsets).toBeUndefined();

    p = flipBlock(p, 3, true); // drops quads + char_offsets
    assertParallelCharOffsets(p);

    p = placeLines(p, 3); // gives the now quad-less block a fresh grid
    assertParallelCharOffsets(p);
    expect(p.blocks[3].char_offsets).toBeUndefined();
  });
});
