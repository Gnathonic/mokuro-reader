import { describe, expect, it } from 'vitest';
import type { Page } from '$lib/types';
import { pageText, spreadPageIndices, spreadText } from './page-text';

function page(...blocks: string[][]): Page {
  return {
    version: '0.2.1',
    img_width: 100,
    img_height: 100,
    img_path: 'p.png',
    blocks: blocks.map((lines) => ({ box: [0, 0, 10, 10], vertical: true, font_size: 10, lines }))
  };
}

const PAGES = [
  page(['表紙']),
  page(['一ページ', '目'], ['二つ目の箱']),
  page(['二ページ目']),
  page([' '], []),
  page(['最後'])
];
const at = (i: number) => PAGES[i];

describe('spreadPageIndices', () => {
  it('a single page is that page', () => {
    expect(spreadPageIndices(1, false, PAGES.length)).toEqual([1]);
  });

  it('a spread is the two pages, lower index first', () => {
    expect(spreadPageIndices(1, true, PAGES.length)).toEqual([1, 2]);
  });

  it('never runs past either end of the volume', () => {
    expect(spreadPageIndices(4, true, PAGES.length)).toEqual([4]);
    expect(spreadPageIndices(5, true, PAGES.length)).toEqual([]);
    expect(spreadPageIndices(-1, true, PAGES.length)).toEqual([0]);
    expect(spreadPageIndices(0, false, 0)).toEqual([]);
  });
});

describe('pageText', () => {
  it('joins a block’s lines into one line and keeps the blocks in file order', () => {
    expect(pageText(PAGES[1])).toBe('一ページ目\n二つ目の箱');
  });

  it('drops empty blocks, and is empty for a page with no text or no page', () => {
    expect(pageText(PAGES[3])).toBe('');
    expect(pageText(undefined)).toBe('');
  });
});

describe('spreadText: reading order', () => {
  it('single page', () => {
    expect(spreadText(spreadPageIndices(2, false, PAGES.length), at)).toBe('二ページ目');
  });

  it('a spread reads the lower page first, a blank line between the pages', () => {
    expect(spreadText(spreadPageIndices(1, true, PAGES.length), at)).toBe(
      '一ページ目\n二つ目の箱\n\n二ページ目'
    );
  });

  it('right-to-left and left-to-right: the same order, because only where a page is DRAWN differs', () => {
    // The reader draws page[index] on the right of a right-to-left spread and
    // on the left of a left-to-right one; either way it is the one read first.
    // So the order takes no direction at all — there is no parameter for one
    // to get wrong — and both books copy "page 2, then page 3".
    expect(spreadPageIndices).toHaveLength(3);
    const text = spreadText(spreadPageIndices(1, true, PAGES.length), at);
    expect(text.indexOf('一ページ目')).toBeLessThan(text.indexOf('二ページ目'));
  });

  it('a page with no text leaves no blank gap', () => {
    expect(spreadText([2, 3], at)).toBe('二ページ目');
    expect(spreadText([3, 4], at)).toBe('最後');
    expect(spreadText([3], at)).toBe('');
  });

  it('reads pages through the caller: an edit session’s working copy wins', () => {
    const edited = page(['直した']);
    expect(spreadText([1, 2], (i) => (i === 1 ? edited : PAGES[i]))).toBe('直した\n\n二ページ目');
  });
});
