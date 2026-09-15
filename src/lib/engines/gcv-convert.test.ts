import { describe, expect, it } from 'vitest';
import type { Page } from '$lib/types';
import { gcvToPage, type GcvAnnotateResponse } from './gcv-convert';
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
});
