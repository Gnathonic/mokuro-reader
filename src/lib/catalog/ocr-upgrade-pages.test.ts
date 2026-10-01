import { describe, expect, it } from 'vitest';
import type { Page } from '$lib/types';
import { fitPagesToVolume, sameOcrPages } from './ocr-upgrade-pages';

function page(img_path: string, text: string, extra: Partial<Page> = {}): Page {
  return {
    version: '0.2.1',
    img_width: 400,
    img_height: 600,
    img_path,
    blocks: [{ box: [1, 2, 3, 4], vertical: true, font_size: 20, lines: [text] } as never],
    ...extra
  };
}

describe('sameOcrPages', () => {
  it('ignores img_path, the page version and cumulativeChars', () => {
    const local = [page('vol/001.jpg', 'あ'), page('vol/002.jpg', 'い')];
    const cloud = [
      { ...page('001.webp', 'あ', { version: '0.2.0' }), cumulativeChars: 1 } as Page,
      page('002.webp', 'い')
    ];
    expect(sameOcrPages(cloud, local)).toBe(true);
  });

  it('compares blocks with keys in any order', () => {
    const a = page('1.jpg', 'あ');
    const b = {
      ...a,
      blocks: [{ lines: ['あ'], font_size: 20, vertical: true, box: [1, 2, 3, 4] } as never]
    };
    expect(sameOcrPages([a], [b])).toBe(true);
  });

  it('sees a changed line, a moved box, other dimensions or another page count', () => {
    const base = [page('1.jpg', 'あ')];
    expect(sameOcrPages([page('1.jpg', 'か')], base)).toBe(false);
    expect(
      sameOcrPages(
        [
          { ...base[0], blocks: [{ ...(base[0].blocks[0] as object), box: [9, 9, 9, 9] } as never] }
        ],
        base
      )
    ).toBe(false);
    expect(sameOcrPages([page('1.jpg', 'あ', { img_width: 401 })], base)).toBe(false);
    expect(sameOcrPages([...base, page('2.jpg', 'い')], base)).toBe(false);
  });
});

describe('fitPagesToVolume', () => {
  const local = [page('Vol 1/001.jpg', 'old1'), page('Vol 1/002.jpg', 'old2')];

  it("keeps the volume's own filenames, matched by stem", () => {
    const fitted = fitPagesToVolume([page('002.webp', 'new2'), page('001.webp', 'new1')], local);
    expect(fitted.map((p) => p.img_path)).toEqual(['Vol 1/002.jpg', 'Vol 1/001.jpg']);
    expect(fitted.map((p) => p.blocks[0].lines[0])).toEqual(['new2', 'new1']);
  });

  it('falls back to position when the stems do not line up one-to-one', () => {
    const fitted = fitPagesToVolume([page('a.jpg', 'new1'), page('b.jpg', 'new2')], local);
    expect(fitted.map((p) => p.img_path)).toEqual(['Vol 1/001.jpg', 'Vol 1/002.jpg']);
  });

  it('strips the derived cumulativeChars', () => {
    const fitted = fitPagesToVolume(
      [{ ...page('001.jpg', 'x'), cumulativeChars: 3 } as Page, page('002.jpg', 'y')],
      local
    );
    expect('cumulativeChars' in fitted[0]).toBe(false);
  });
});
