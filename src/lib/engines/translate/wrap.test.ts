import { describe, expect, it } from 'vitest';
import { wrapTranslatedBlock } from './wrap';

describe('wrapTranslatedBlock', () => {
  const block = {
    box: [0, 0, 110, 200],
    vertical: true,
    font_size: 20,
    lines: ['あ'],
    lines_coords: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1]
      ]
    ]
  };
  it('keeps the box, goes horizontal, drops quads, wraps at floor(width / (fs*0.55)) chars', () => {
    // 110 / (20*0.55) = 10 chars per line
    const out = wrapTranslatedBlock(block, 'hello brave new world');
    expect(out.box).toEqual([0, 0, 110, 200]);
    expect(out.vertical).toBe(false);
    expect(out.lines_coords).toBeUndefined();
    expect(out.font_size).toBe(20);
    expect(out.lines).toEqual(['hello', 'brave new', 'world']);
  });
  it('drops the quads: they place the OCR lines, not the translated ones', () => {
    const out = wrapTranslatedBlock(block, 'hello brave new world');
    expect(out.lines).toHaveLength(3);
    expect('lines_coords' in out).toBe(false);
  });
  it('a block without quads wraps the same', () => {
    const { lines_coords: _quads, ...bare } = block;
    void _quads;
    const out = wrapTranslatedBlock(bare, 'hello brave new world');
    expect(out.lines).toEqual(['hello', 'brave new', 'world']);
  });
  it('shrinks the font until the lines fit the height, stopping where 3 lines fit', () => {
    // box 100×48: at fs 20 → 9 chars/line, 4 lines × 24 = 96 > 48 → shrink
    const out = wrapTranslatedBlock(
      { ...block, box: [0, 0, 100, 48] },
      'one two three four five six'
    );
    expect(out.font_size).toBeLessThan(20);
    expect(out.font_size).toBeGreaterThanOrEqual(Math.floor(48 / 3 / 1.2));
  });
  it('a word longer than the line is hard-split', () => {
    const out = wrapTranslatedBlock({ ...block, box: [0, 0, 55, 200] }, 'abcdefghij');
    expect(out.lines).toEqual(['abcde', 'fghij']);
  });
  it('empty text yields one empty line', () => {
    expect(wrapTranslatedBlock(block, '   ').lines).toEqual(['']);
  });
});
