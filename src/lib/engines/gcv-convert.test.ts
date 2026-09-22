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
