import { describe, expect, it } from 'vitest';
import type { Page } from '$lib/types';
import { alignLayerPages } from './layer-page-align';

function pg(img_path: string, text?: string, extra: Partial<Page> = {}): Page {
  return {
    version: '0.2.1',
    img_width: 100,
    img_height: 200,
    img_path,
    blocks: text ? [{ box: [0, 0, 10, 10], vertical: true, font_size: 10, lines: [text] }] : [],
    ...extra
  };
}

describe('alignLayerPages — a layer file that omits pages', () => {
  const volume = [pg('v/001.jpg', 'あ'), pg('v/002.jpg', 'い'), pg('v/003.jpg', 'う')];

  it('same length → the pages untouched (positional, as it always was)', () => {
    const layer = [pg('x.png', 'a'), pg('y.png', 'b'), pg('z.png', 'c')];
    expect(alignLayerPages(layer, volume)).toBe(layer);
  });

  it('an ordered subset by image path → a blank page where the engine dropped one', () => {
    const layer = [pg('v/001.jpg', 'A'), pg('v/003.jpg', 'C')];
    const aligned = alignLayerPages(layer, volume)!;
    expect(aligned.map((p) => p.img_path)).toEqual(['v/001.jpg', 'v/002.jpg', 'v/003.jpg']);
    expect(aligned.map((p) => p.blocks.map((b) => b.lines[0]))).toEqual([['A'], [], ['C']]);
    // The blank takes the VOLUME page's image facts, never its text.
    expect(aligned[1]).toMatchObject({ img_width: 100, img_height: 200, blocks: [] });
  });

  it('matches across an extension remap and path case (the import renames .jpg → .webp)', () => {
    const local = [pg('V/001.webp'), pg('V/002.webp')];
    const aligned = alignLayerPages([pg('v/002.jpg', 'B')], local)!;
    expect(aligned.map((p) => p.blocks.length)).toEqual([0, 1]);
    // One spelling per page set — the volume's, which is what the images are keyed by.
    expect(aligned.map((p) => p.img_path)).toEqual(['V/001.webp', 'V/002.webp']);
  });

  it('falls back to bare filenames when the folder prefix differs — only while they are unique', () => {
    const aligned = alignLayerPages([pg('other/002.jpg', 'B')], volume)!;
    expect(aligned.map((p) => p.blocks.length)).toEqual([0, 1, 0]);

    const chapters = [pg('c1/001.jpg'), pg('c2/001.jpg')];
    expect(alignLayerPages([pg('zz/001.jpg', 'B')], chapters)).toBeNull();
  });

  it('a page the volume does not have, a repeat, a reordering or MORE pages → null', () => {
    expect(alignLayerPages([pg('v/001.jpg'), pg('v/009.jpg')], volume)).toBeNull();
    expect(alignLayerPages([pg('v/001.jpg'), pg('v/001.jpg')], volume)).toBeNull();
    expect(alignLayerPages([pg('v/003.jpg'), pg('v/001.jpg')], volume)).toBeNull();
    expect(alignLayerPages([...volume, pg('v/004.jpg')], volume)).toBeNull();
    expect(alignLayerPages([], volume)).toBeNull();
  });
});
