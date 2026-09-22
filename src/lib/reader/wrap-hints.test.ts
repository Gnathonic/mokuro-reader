import { describe, it, expect } from 'vitest';
import { heuristicMeasurer, layoutLines, type LayoutBlock } from './line-coords-layout';
import { WRAP_HINT, fitWrappedFontSize, hintWrappedText, stripWrapHints } from './wrap-hints';

const asuka = 'アスカも手島さんも土田くんも、いつの間にか気を失っちゃってたんでしょ?';

function columns(hinted: string): string[] {
  return hinted.split(WRAP_HINT);
}

describe('hintWrappedText', () => {
  it('leaves a line that fits in one column untouched', () => {
    const text = 'ドン';
    const hinted = hintWrappedText(text, heuristicMeasurer, 100, 50, 50);
    expect(hinted).toBe(text);
  });

  it('breaks a merged balloon on phrase boundaries and never before kinsoku punctuation', () => {
    // 117×232 quad, the size break-anywhere packing picks (~27px, 4 columns).
    const main = 232;
    const cross = 117;
    const anywhere = Math.min(cross / 4, (4 * main) / heuristicMeasurer(asuka));
    const size = fitWrappedFontSize(anywhere, asuka, heuristicMeasurer, main, cross);
    const hinted = hintWrappedText(asuka, heuristicMeasurer, main, cross, size);
    expect(stripWrapHints(hinted)).toBe(asuka);
    const cols = columns(hinted);
    expect(cols.length).toBeGreaterThan(1);
    for (const col of cols) {
      expect(col.startsWith('、')).toBe(false);
      expect(col.startsWith('っ')).toBe(false);
      expect(heuristicMeasurer(col)).toBeLessThanOrEqual(main / size + 1.01);
    }
    expect(cols.length * size).toBeLessThanOrEqual(cross + 0.5);
    // Character fill splits 手島 across columns (アスカも手島さ / んも).
    expect(cols.some((col) => col.includes('手島さ') && !col.includes('手島さん'))).toBe(false);
    expect(cols.join('')).toBe(asuka);
  });

  it('keeps English words whole when a space is the wrap point', () => {
    const text = 'HOW TO MAKE THE RIGHT FUTURE';
    const size = fitWrappedFontSize(40, text, heuristicMeasurer, 80, 200);
    const hinted = hintWrappedText(text, heuristicMeasurer, 80, 200, size);
    for (const col of columns(hinted)) {
      expect(col.trim()).not.toMatch(/^[A-Z]{1,2}$/);
      expect(col.includes('FUTU') && col.trim() !== 'FUTURE').toBe(false);
    }
    expect(hinted).not.toContain(`RI${WRAP_HINT}GHT`);
  });

  it('stores the hinted string on a wrapped layout line', () => {
    const block: LayoutBlock = {
      box: [0, 0, 117, 232],
      vertical: true,
      font_size: 40,
      lines: [asuka],
      lines_coords: [
        [
          [0, 0],
          [117, 0],
          [117, 232],
          [0, 232]
        ]
      ]
    };
    const layout = layoutLines(block, block.lines, heuristicMeasurer)![0];
    expect(layout.wrap).toBe(true);
    expect(layout.hinted).toBeTruthy();
    expect(stripWrapHints(layout.hinted!)).toBe(asuka);
    expect(layout.hinted).toContain(WRAP_HINT);
  });
});
