import type { Page } from '$lib/types';

/**
 * @license BSD-3-Clause
 * Copyright (c) 2023, ッツ Reader Authors
 * All rights reserved.
 */

// isNotJapaneseRegex aquired from ttsu reader
// https://github.com/ttu-ttu/ebook-reader/blob/main/apps/web/src/lib/functions/get-character-count.ts

export function countChars(line: string) {
  const japaneseRegex =
    /[○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
  return Array.from(line).filter((char) => japaneseRegex.test(char)).length;
}

// Cache for precomputed cumulative char and line counts
// Key: pages array reference, Value: { chars: cumulative char count array, lines: cumulative line count array }
const cumulativeCountCache = new WeakMap<Page[], { chars: number[]; lines: number[] }>();

/**
 * Get cumulative character count up to (but not including) a page.
 * Uses precomputed cache for O(1) lookup after initial O(n) computation.
 */
export function getCharCount(pages: Page[], currentPage?: number) {
  if (!pages || pages.length === 0) {
    return { charCount: 0, lineCount: 0 };
  }

  // Get or compute cumulative counts
  let cached = cumulativeCountCache.get(pages);
  if (!cached) {
    // Precompute cumulative char and line counts for all pages
    const chars = new Array(pages.length + 1);
    const lines = new Array(pages.length + 1);
    chars[0] = 0;
    lines[0] = 0;

    for (let i = 0; i < pages.length; i++) {
      let pageChars = 0;
      let pageLines = 0;
      const blocks = pages[i].blocks;
      for (let j = 0; j < blocks.length; j++) {
        const blockLines = blocks[j].lines;
        pageLines += blockLines.length;
        for (let k = 0; k < blockLines.length; k++) {
          pageChars += countChars(blockLines[k]);
        }
      }
      chars[i + 1] = chars[i] + pageChars;
      lines[i + 1] = lines[i] + pageLines;
    }

    cached = { chars, lines };
    cumulativeCountCache.set(pages, cached);
  }

  // O(1) lookup
  const max = currentPage ?? pages.length;
  const charCount = cached.chars[Math.min(max, pages.length)];
  const lineCount = cached.lines[Math.min(max, pages.length)];

  return { charCount, lineCount };
}
