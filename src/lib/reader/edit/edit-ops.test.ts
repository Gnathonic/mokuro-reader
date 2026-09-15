import { describe, expect, it } from 'vitest';
import type { Page } from '$lib/types';
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
        lines_coords: [quad(120, 10, 140, 110), quad(100, 10, 120, 110)]
      },
      { box: [10, 200, 90, 240], vertical: false, font_size: 18, lines: ['ok'] }
    ]
  };
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
});

describe('resizeBlock', () => {
  it('scales quads into the new box and rescales font_size by the cross axis', () => {
    const out = resizeBlock(page(), 0, [100, 10, 180, 110]);
    expect(out.blocks[0].box).toEqual([100, 10, 180, 110]);
    // width doubled → vertical font doubles
    expect(out.blocks[0].font_size).toBe(40);
    expect(out.blocks[0].lines_coords![0]).toEqual(quad(140, 10, 180, 110));
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
  it('drops quads if any source lacks them', () => {
    const { page: out } = mergeBlocks(page(), [0, 1]);
    expect(out.blocks[0].lines_coords).toBeUndefined();
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
        lines: Array.from({ length: 13 }, (_, i) => `line${i}`),
        lines_coords: quads
      }
    ]
  };
}

describe('lineGeometry', () => {
  it('derives orientation from the quad aspect and font size from the cross axis', () => {
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
    // median of the 13 line sizes (44 ×9, 60, 80, 90, 99) → 44
    expect(out.blocks[1].font_size).toBe(44);
  });
});

describe('healBlockFontSize', () => {
  it('replaces an oversized block font_size with the median line size', () => {
    const out = healBlockFontSize(tocPage(), 1);
    expect(out.blocks[1].font_size).toBe(44);
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
    expect(out.blocks[1].lines[0]).toBe('line1');
    const p = tocPage();
    expect(removeLine(p, 0, 0)).toBe(p);
  });
});
