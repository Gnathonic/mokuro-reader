import { describe, expect, it } from 'vitest';
import { dedupeBlocks } from './block-dedupe';
import type { Block } from '$lib/types';

// Real duplicate pair from Dr Stone 01 p28 (blocks 7 and 8): the detector
// emitted the same balloon twice — once properly segmented into 4 lines,
// once as a single synthetic whole-box "line" with font_size 199.
const properBlock: Block = {
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

const duplicateBlock: Block = {
  box: [765, 2109, 964, 2344],
  vertical: true,
  font_size: 199,
  lines_coords: [
    [
      [765, 2109],
      [964, 2109],
      [964, 2344],
      [765, 2344]
    ]
  ],
  lines: ['ぬうよりによってこんなマヌケな姿を']
};

const unrelatedBlock: Block = {
  box: [100, 100, 200, 300],
  vertical: true,
  font_size: 40,
  lines: ['別のセリフ']
};

describe('dedupeBlocks', () => {
  it('drops the single-line duplicate and keeps the segmented block', () => {
    const kept = dedupeBlocks([properBlock, duplicateBlock, unrelatedBlock]);
    expect(kept.map((k) => k.blockIndex)).toEqual([0, 2]);
    expect(kept[0].block).toBe(properBlock);
  });

  it('keeps the segmented block regardless of array order', () => {
    const kept = dedupeBlocks([duplicateBlock, properBlock]);
    expect(kept).toHaveLength(1);
    expect(kept[0].block).toBe(properBlock);
    expect(kept[0].blockIndex).toBe(1);
  });

  it('preserves original block indices for downstream page.blocks lookups', () => {
    const kept = dedupeBlocks([unrelatedBlock, duplicateBlock, properBlock]);
    expect(kept.map((k) => k.blockIndex)).toEqual([0, 2]);
  });

  it('does not merge same text in different places (repeated SFX)', () => {
    const sfxA: Block = { box: [0, 0, 60, 200], vertical: true, font_size: 40, lines: ['ドン'] };
    const sfxB: Block = {
      box: [900, 1500, 960, 1700],
      vertical: true,
      font_size: 40,
      lines: ['ドン']
    };
    expect(dedupeBlocks([sfxA, sfxB])).toHaveLength(2);
  });

  it('does not merge overlapping blocks with different text', () => {
    const a: Block = { box: [0, 0, 100, 100], vertical: true, font_size: 30, lines: ['あい'] };
    const b: Block = { box: [10, 10, 110, 110], vertical: true, font_size: 30, lines: ['うえ'] };
    expect(dedupeBlocks([a, b])).toHaveLength(2);
  });

  it('keeps one of two identical single-line detections', () => {
    const a: Block = { box: [0, 0, 100, 100], vertical: true, font_size: 30, lines: ['通路'] };
    const b: Block = { box: [5, 5, 103, 102], vertical: true, font_size: 32, lines: ['通路'] };
    const kept = dedupeBlocks([a, b]);
    expect(kept).toHaveLength(1);
    expect(kept[0].blockIndex).toBe(0);
  });

  it('ignores blocks with empty text', () => {
    const a: Block = { box: [0, 0, 100, 100], vertical: true, font_size: 30, lines: [''] };
    const b: Block = { box: [0, 0, 100, 100], vertical: true, font_size: 30, lines: [''] };
    expect(dedupeBlocks([a, b])).toHaveLength(2);
  });

  it('handles pages with no duplicates without changes', () => {
    const kept = dedupeBlocks([properBlock, unrelatedBlock]);
    expect(kept.map((k) => k.block)).toEqual([properBlock, unrelatedBlock]);
  });
});
