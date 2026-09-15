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
