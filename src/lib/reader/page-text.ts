/**
 * The text of what is on screen, for "Copy page text" (#55).
 *
 * READING order: a spread is two consecutive pages, and the lower index is
 * read first whichever way the book runs — a right-to-left book draws it on
 * the right, a left-to-right book on the left (the reader's `flex-row` /
 * `flex-row-reverse`), so the direction changes where a page is drawn and
 * never which one comes first. Inside a page the blocks keep the file's
 * order, which is mokuro's reading order, and each block is its lines joined
 * as they are stored (one sentence, however the print broke it).
 */
import type { Page } from '$lib/types';

/** The page indices on screen, in reading order. */
export function spreadPageIndices(index: number, secondPage: boolean, pageCount: number): number[] {
  const out: number[] = [];
  if (index >= 0 && index < pageCount) out.push(index);
  if (secondPage && index + 1 >= 0 && index + 1 < pageCount) out.push(index + 1);
  return out;
}

/** One page: a line of text per block, empty blocks dropped. */
export function pageText(page: Page | undefined): string {
  if (!page) return '';
  return page.blocks
    .map((block) => block.lines.join(''))
    .filter((text) => text.trim().length > 0)
    .join('\n');
}

/**
 * The text of `indices`, pages separated by a blank line. `pageAt` is how the
 * caller reads a page: the displayed layer's, or the edit session's working
 * copy while editing.
 */
export function spreadText(
  indices: readonly number[],
  pageAt: (index: number) => Page | undefined
): string {
  return indices
    .map((i) => pageText(pageAt(i)))
    .filter((text) => text.length > 0)
    .join('\n\n');
}
