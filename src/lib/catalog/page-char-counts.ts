/**
 * The one definition of "how many characters does this mokuro have" — shared
 * by the import pipeline, the cloud OCR upgrade, the series backfill, the OCR
 * editor and the layer sidecar writers. Pure: safe to import from a Worker.
 */
export function countCharsInLines(lines: unknown): number {
  if (!Array.isArray(lines)) return 0;
  const japaneseRegex =
    /[○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
  let total = 0;
  for (const line of lines) {
    if (typeof line !== 'string') continue;
    total += Array.from(line).filter((char) => japaneseRegex.test(char)).length;
  }
  return total;
}

export function buildPageCharCounts(pages: unknown[]): {
  totalChars: number;
  cumulative: number[];
} {
  let totalChars = 0;
  const cumulative: number[] = [];

  for (const page of pages) {
    let pageChars = 0;
    const blocks = (page as { blocks?: unknown[] })?.blocks;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        pageChars += countCharsInLines((block as { lines?: unknown[] })?.lines);
      }
    }
    totalChars += pageChars;
    cumulative.push(totalChars);
  }

  return { totalChars, cumulative };
}
