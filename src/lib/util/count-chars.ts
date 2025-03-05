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

export function getCharCount(pages: Page[], currentPage?: number) {
  let charCount = 0;
  let lineCount = 0;

  if (pages && pages.length > 0) {
    const max = currentPage || pages.length;

    for (let i = 0; i < max; i++) {
      const blocks = pages[i].blocks;

      blocks.forEach((block) => {
        lineCount += block.lines.length;
        block.lines.forEach((line) => {
          charCount += countChars(line);
        });
      });
    }
  }

  return { charCount, lineCount };
}
