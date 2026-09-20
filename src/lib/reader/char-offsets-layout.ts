/**
 * From one line's `char_offsets` entry to the cells the reader renders: one
 * inline-block per character whose inline size is that character's advance, so
 * normal flow reproduces the print's positions with no per-glyph measurement
 * (and no `position: absolute`, which would hand Yomitan a paragraph break
 * between every glyph — issue #254, per character).
 *
 * Pure geometry, no DOM: the viewer (`layoutLines` / TextBoxes.svelte) and the
 * editor (EditableBlock.svelte) both render from `lineCells`, so a line looks
 * the same in either. See docs/superpowers/specs/
 * 2026-09-16-char-offsets-rendering-design.md and the plan beside it.
 */

import { codePoints, repairZeroCells, validLineOffsets } from './char-offsets';

export interface CharCell {
  text: string;
  /** px advance along the reading axis, >= 0 */
  size: number;
}

export interface LineCells {
  /** Parallel to `codePoints(processLine(raw))`; the texts joined ARE that string */
  cells: CharCell[];
  /** `offsets[0]`: shift of the line's main origin from its quad's start edge */
  start: number;
  /** `offsets[n] - offsets[0]`: the line's main-axis advance */
  extent: number;
}

const ELLIPSIS = '…';

/**
 * The reader's ellipsis substitution, in ONE place: a run of three ASCII or
 * three fullwidth periods renders as `…`. Matching is left to right and
 * non-overlapping (`....` → `….`), which `lineCells` has to mirror exactly —
 * the substitution changes the code-point count, and offsets index the raw line.
 */
export function processLine(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\.\.\./g, ELLIPSIS).replace(/．．．/g, ELLIPSIS);
}

/**
 * A cell holding nothing but CSS document white space (space, tab, line feed).
 * The renderers centre a glyph with a flex cell, and a flex container does not
 * render a white-space-only text run at all — `white-space: pre` cannot save
 * it — so the space would drop out of selection and copy ("NO WAY" → "NOWAY")
 * and leave an empty box that aligns to nothing. Such a cell has no glyph to
 * centre, so it renders as the plain inline-block it needs instead. The
 * ideographic space is not document white space and always renders.
 */
export function isBlankCell(text: string): boolean {
  return /^[ \t\n\r\f]+$/.test(text);
}

/**
 * Cells for one line, parallel to `processLine(raw)`, or null when the line has
 * no usable placement — that LINE then takes the fitted path; its block keeps
 * every other line's cells. Never throws.
 *
 * 1. Validate against the RAW line (`validLineOffsets`, with the quad's main
 *    extent for the overlong check).
 * 2. Remap the ellipsis collapse: three raw code points sharing a run become
 *    one `…` cell spanning `[offsets[k], offsets[k + 3])`, however unevenly the
 *    producer split them (the contract splits a shared cell evenly: 14, 14, 13).
 * 3. With `repair` (auto mode), give zero-width cells on real characters a
 *    share of a neighbour (`repairZeroCells`); without it (original mode) the
 *    file renders as-is. Repair runs on the COLLAPSED cells because those are
 *    what paints: a 2px `…` split 0, 1, 1 is not an unplaced character, and a
 *    wholly zero-width `...` is one unplaced character, not three. A line
 *    repair gives up on — too many characters zero-width or crushed into a
 *    pixel or two — is null, so cells that come back under `repair` never
 *    leave a real character at zero width (marks and whitespace keep theirs).
 *
 * A line with no extent at all is null in both modes: every glyph would paint
 * on one point, which is no placement to be faithful to.
 */
export function lineCells(
  raw: string,
  offsets: unknown,
  mainExtent: number,
  opts: { repair: boolean }
): LineCells | null {
  const valid = validLineOffsets(raw, offsets, mainExtent);
  if (!valid) return null;

  const chars = codePoints(raw);
  const texts: string[] = [];
  let bounds: number[] = [valid[0]];
  for (let k = 0; k < chars.length; ) {
    const char = chars[k];
    const isRun = (char === '.' || char === '．') && chars[k + 1] === char && chars[k + 2] === char;
    texts.push(isRun ? ELLIPSIS : char);
    k += isRun ? 3 : 1;
    bounds.push(valid[k]);
  }
  // The scan above and processLine must agree or the cells would not be the
  // text that renders. They do today; this keeps a future substitution added
  // to one and not the other from shipping as misplaced glyphs.
  if (texts.join('') !== processLine(raw)) return null;

  if (bounds[bounds.length - 1] - bounds[0] <= 0) return null;
  if (opts?.repair === true) {
    const repaired = repairZeroCells(texts, bounds);
    if (!repaired) return null;
    bounds = repaired;
  }

  return {
    cells: texts.map((text, k) => ({ text, size: bounds[k + 1] - bounds[k] })),
    start: bounds[0],
    extent: bounds[bounds.length - 1] - bounds[0]
  };
}
