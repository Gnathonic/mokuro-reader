/**
 * Data-level helpers for `char_offsets`, the per-character placement that
 * current producers (the mokuro fork, the bunko engine runner, GCV layers)
 * write beside `lines_coords`.
 *
 * Entry i of a block's `char_offsets` is `null` or `code points + 1`
 * cumulative integer px along line i's reading axis, measured from its quad's
 * start edge; character k occupies `[offsets[k], offsets[k + 1])`. It is file
 * data, so nothing here trusts it: every function returns `null` rather than
 * throw, and none mutates what it is given — edit history snapshots pages, and
 * a shared array quietly rewritten would corrupt undo.
 *
 * Shared by the renderer (`char-offsets-layout.ts`), the edit ops and the
 * engines, which is why it stays free of DOM and of rendering decisions. See
 * docs/superpowers/plans/2026-09-19-char-offsets.md.
 */

export type LineOffsets = number[] | null;

/**
 * A line loses its placement when more than this share of its real characters
 * had a zero-width cell. Producers leave a few behind (0.65% of characters in
 * mokuro-fork output, 8.6% in paddle-manga layers, in runs up to 8); past this
 * point the repaired cells would be mostly invented, and the fitted path is
 * the more honest rendering.
 */
export const UNPLACED_MAX = 0.4;

/**
 * A real character whose cell is narrower than this share of the line's median
 * non-zero cell is crushed: the file placed it, in 1–3px, and drawn there it is
 * a smear on its neighbour. Whole lines come out that way — most of their
 * glyphs squeezed between two wide cells — while passing the zero-width rule
 * (351 lines of paddle-manga output, 26 of mokuro-fork). A crushed cell counts
 * as unplaced, exactly like a zero one. The half cells of 、 and 。 sit near
 * 0.5 and small kana above that, so a quarter leaves real print alone.
 */
export const CRUSHED_RATIO = 0.25;

/** Producers clamp to the quad, so a placed extent beyond this many times the
 * quad's main extent is corruption, not slack. Same tolerance `layoutLines`
 * allows a fitted line (OVERFLOW_TOL). */
const OVERLONG_RATIO = 1.15;

/**
 * Code points, iterator-counted (surrogate pairs are one) — the unit the
 * contract counts in. `text.length` would be wrong for every 𠮷.
 */
export function codePoints(text: string): string[] {
  return typeof text === 'string' ? [...text] : [];
}

/**
 * Zero width is legitimate only here: the contract gives whitespace an empty
 * span. `\s` already covers the ideographic space; the format characters are
 * added because they take no room in print either, and so are non-spacing and
 * enclosing marks — a decomposed dakuten (U+3099), the U+FE0F after ❤, an
 * ideographic variation selector. Those sit on their base character: counted
 * as unplaced they would cost a short line its placement, and "repaired" they
 * would take half of an unrelated neighbour's cell.
 */
function takesNoRoom(char: string): boolean {
  return /^[\s\u200b-\u200d\u2060\p{Mn}\p{Me}]$/u.test(char);
}

/**
 * The part of the contract that needs no text: integers, from zero or later,
 * never decreasing.
 */
function isOffsetList(offsets: unknown[]): offsets is number[] {
  // An index loop on purpose: Array#every skips holes, and a hole must fail.
  for (let k = 0; k < offsets.length; k++) {
    const value: unknown = offsets[k];
    if (typeof value !== 'number' || !Number.isInteger(value)) return false;
    if (k === 0 ? value < 0 : value < (offsets[k - 1] as number)) return false;
  }
  return true;
}

/**
 * The contract's validation table. Returns the offsets unchanged (the same
 * array) when valid, else null: not an array, wrong length
 * (`codePoints(raw).length + 1`), any non-finite or non-integer value,
 * `offsets[0] < 0`, any decrease, or — when `mainExtent` is given —
 * `offsets[n] - offsets[0] > 1.15 × mainExtent`. An empty line is null: there
 * is no character to place.
 *
 * One rule beyond the table, also only with `mainExtent`: the line must START
 * inside its quad (`offsets[0] <= mainExtent`). The table bounds the span and
 * leaves the start free, but the start shifts the line's origin, so a corrupt
 * one would paint text anywhere on the page — and stretch what can be scrolled
 * and zoomed to reach it. Producers clamp every value to the quad.
 */
export function validLineOffsets(
  raw: string,
  offsets: unknown,
  mainExtent?: number
): number[] | null {
  if (typeof raw !== 'string' || !Array.isArray(offsets)) return null;
  const n = codePoints(raw).length;
  if (n === 0 || offsets.length !== n + 1 || !isOffsetList(offsets)) return null;
  if (mainExtent !== undefined) {
    // A quad that cannot vouch for the extent vouches for nothing.
    if (!Number.isFinite(mainExtent) || mainExtent <= 0) return null;
    if (offsets[0] > mainExtent) return null;
    // Compared as a ratio so an exact 1.15 passes (1.15 * 100 is 114.99…).
    if ((offsets[n] - offsets[0]) / mainExtent > OVERLONG_RATIO) return null;
  }
  return offsets;
}

/**
 * `block.char_offsets` when it is an array parallel to `block.lines`, else
 * null. The array itself comes back whenever its entries are all arrays or
 * nulls (so callers can compare by reference); an entry of any other shape
 * degrades to null in a copy — one junk line must not cost the block its
 * placement, the same line-not-block rule rendering follows. Entries are NOT
 * validated against their text here; `validLineOffsets` does that per line.
 */
export function parallelOffsets(block: {
  lines: string[];
  char_offsets?: unknown;
}): LineOffsets[] | null {
  const offsets = block?.char_offsets;
  if (!Array.isArray(offsets) || !Array.isArray(block.lines)) return null;
  if (offsets.length !== block.lines.length) return null;
  const clean = (entry: unknown) => entry === null || Array.isArray(entry);
  if (Array.from(offsets, clean).every(Boolean)) return offsets as LineOffsets[];
  return Array.from(offsets, (entry) => (Array.isArray(entry) ? (entry as number[]) : null));
}

/**
 * `count` integer widths filling `span`: equal shares, remainder to the last.
 */
function evenWidths(span: number, count: number): number[] {
  const share = Math.floor(span / count);
  const widths = new Array<number>(count).fill(share);
  widths[count - 1] = span - share * (count - 1);
  return widths;
}

/** Middle value; the mean of the middle two for an even count. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Auto-mode repair for zero-width cells on real characters. The contract
 * reserves zero width for whitespace, but producers emit it on glyphs too —
 * `ぎ[322,363) と[363,363) 、[363,449)`: the ink-cell projection saw と and 、
 * as one cell and handed all of it to 、. Rendered as-is, と paints on top of
 * its neighbour.
 *
 * A maximal run of zero-width cells borrows the LARGER of its two non-zero
 * neighbours — the merged cell is the wide one; on a tie the following cell,
 * as in the real case above — and the borrowed span is split evenly over the
 * run's real characters plus that neighbour (integers, remainder to the last).
 * Whitespace keeps its zero width wherever it sits. Runs resolve left to right
 * against the widths as repaired so far, so two runs around one neighbour
 * share it without ever creating pixels: the total extent is preserved.
 *
 * Returns the input array when nothing needed repair, and null when the line
 * cannot be repaired: every cell is zero, more than UNPLACED_MAX of its
 * non-whitespace characters were unplaced — zero-width, or crushed below
 * CRUSHED_RATIO of the line's median non-zero cell — or a run's neighbour has
 * fewer pixels than it has sharers. Crushed cells only count toward that
 * decision; they are never widened, because unlike a zero cell there is no
 * merged neighbour to say where their pixels went. That last split would leave zero cells behind —
 * and, with the neighbour in front, zero the neighbour itself, a cell the file
 * HAD placed. Real lines that hit it (0.08%) are glyphs crushed between 1–2px
 * cells, where there is no placement worth keeping. So a non-null result never
 * has a zero cell on a real character and never takes a placed cell away.
 * `offsets` must already be valid for `chars`. Never mutates.
 */
export function repairZeroCells(chars: string[], offsets: number[]): number[] | null {
  const n = chars.length;
  if (n === 0 || !Array.isArray(offsets) || offsets.length !== n + 1) return null;
  if (offsets[n] - offsets[0] <= 0) return null;

  const widths = chars.map((_, k) => offsets[k + 1] - offsets[k]);
  const real = chars.map((char) => !takesNoRoom(char));
  const realCount = real.filter(Boolean).length;
  // The extent is non-zero, so there is a non-zero cell to take a median of.
  // Zero cells stay out of it: they would drag the bar down on exactly the
  // lines that have the most missing.
  const crushedBelow = CRUSHED_RATIO * median(widths.filter((width) => width > 0));
  const zero = real.filter((isReal, k) => isReal && widths[k] === 0).length;
  const crushed = real.filter(
    (isReal, k) => isReal && widths[k] > 0 && widths[k] < crushedBelow
  ).length;
  if (zero + crushed > UNPLACED_MAX * realCount) return null;
  if (zero === 0) return offsets;

  for (let i = 0; i < n; i++) {
    if (widths[i] !== 0) continue;
    let end = i;
    while (end < n && widths[end] === 0) end++;
    const members: number[] = [];
    for (let k = i; k < end; k++) if (real[k]) members.push(k);
    if (members.length > 0) {
      // The extent is non-zero, so a zero run always has a non-zero cell on
      // at least one side.
      const before = i > 0 ? widths[i - 1] : 0;
      const after = end < n ? widths[end] : 0;
      const sharers = after >= before ? [...members, end] : [i - 1, ...members];
      const donor = after >= before ? end : i - 1;
      // fewer pixels than sharers: someone would get floor(span / count) = 0
      if (widths[donor] < sharers.length) return null;
      const shares = evenWidths(widths[donor], sharers.length);
      sharers.forEach((k, s) => (widths[k] = shares[s]));
    }
    // skip the run AND the cell that ended it (non-zero by construction)
    i = end;
  }

  const repaired = [offsets[0]];
  for (let k = 0; k < n; k++) repaired.push(repaired[k] + widths[k]);
  return repaired;
}

/**
 * Scale by a main-axis factor, for a line whose quad was resized: rounded
 * integers, `offsets[0]` scaled too (it is a distance from the quad's start
 * edge like the rest). Rounding is monotone, so the result stays
 * non-decreasing; cells may collapse to zero under a small factor. A factor
 * that means nothing (negative, NaN, infinite — a degenerate old quad) leaves
 * the values as they were: rendering validates again, and inventing numbers
 * here would only hide the problem.
 *
 * The same goes for the entry. Arithmetic coerces (`null` → 0, `'40'` → 80) and
 * rounding forgives (-1 × 0.3 → -0, a decrease collapsing into a tie), so
 * scaling a malformed entry would launder it into one that validates, and a
 * line on the fitted path would come out of a resize with invented cells that
 * are then saved and exported. Anything that is not an offset list comes back
 * as an untouched copy, and so does a product past integer range (a finite
 * factor from a near-degenerate quad still reaches Infinity, which JSON stores
 * as null).
 */
export function scaleOffsets(offsets: number[], factor: number): number[] {
  if (!Array.isArray(offsets)) return [];
  if (!Number.isFinite(factor) || factor < 0 || !isOffsetList(offsets)) return [...offsets];
  // `|| 0` keeps -0 (a -0 factor) out of the stored data
  const scaled = offsets.map((value) => Math.round(value * factor) || 0);
  return scaled.every(Number.isSafeInteger) ? scaled : [...offsets];
}

/**
 * Text edit reflow: what the offsets of `oldText` become once the line reads
 * `newText`. The common prefix and suffix (in code points) keep their cells —
 * they are still the print's — and the changed middle's old span is split
 * evenly over the new middle's characters, so fixing one misread character
 * moves no boundary at all.
 *
 * - Pure insertion: the old span is empty, so the region first widens by one
 *   character on each side where one exists, and those neighbours share their
 *   cells with the newcomers.
 * - Still empty: when the edit ADDS real characters (a glyph typed between
 *   zero-width spaces, or over one) and the region has no span to give them,
 *   it keeps widening until it reaches a cell that has. A real character with
 *   an empty span paints on top of its neighbour, and costs a short line its
 *   placement in auto mode. Whitespace never triggers this — zero width is
 *   what the contract gives it — and neither does fixing a character whose
 *   cell was already empty: that moves no boundary, like any other fix.
 * - Pure deletion: the cells are dropped and the boundary after them stands —
 *   the preceding character absorbs the span, or the first survivor when the
 *   deletion was at the line start.
 *
 * Either way `offsets[0]` and the last offset never move: the total extent is
 * preserved, and the result has `codePoints(newText).length + 1` entries.
 * Identical text returns the same array. `newText` empty → null; `oldOffsets`
 * null or not valid for `oldText` → null. Never mutates.
 */
export function reflowOffsets(
  oldText: string,
  newText: string,
  oldOffsets: LineOffsets
): LineOffsets {
  const offsets = validLineOffsets(oldText, oldOffsets);
  if (!offsets || typeof newText !== 'string') return null;
  if (oldText === newText) return offsets;
  const oldChars = codePoints(oldText);
  const newChars = codePoints(newText);
  const n = oldChars.length;
  const m = newChars.length;
  if (m === 0) return null;

  let prefix = 0;
  while (prefix < n && prefix < m && oldChars[prefix] === newChars[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    oldChars[n - 1 - suffix] === newChars[m - 1 - suffix]
  ) {
    suffix++;
  }

  // Old boundaries [lo, hi] bracket the changed region; `count` new characters
  // go between them.
  let lo = prefix;
  let hi = n - suffix;
  let count = m - prefix - suffix;

  if (count === 0) {
    // Pure deletion. The boundary at `hi` stands; the one at `lo` goes, unless
    // it is the line start — then the boundary after the first survivor goes.
    return prefix > 0
      ? [...offsets.slice(0, lo), ...offsets.slice(hi)]
      : [offsets[0], ...offsets.slice(hi + 1)];
  }

  const realIn = (chars: string[]) => chars.filter((char) => !takesNoRoom(char)).length;
  const addsReal =
    realIn(newChars.slice(prefix, m - suffix)) > realIn(oldChars.slice(prefix, n - suffix));
  const starved = () => addsReal && offsets[hi] === offsets[lo];

  if (lo === hi || starved()) {
    // Borrow a neighbour on each side that has one: once for a pure insertion,
    // and again for as long as newcomers still have no pixels to share.
    do {
      if (lo > 0) {
        lo--;
        count++;
      }
      if (hi < n) {
        hi++;
        count++;
      }
    } while (starved() && (lo > 0 || hi < n));
  }

  const middle: number[] = [];
  let boundary = offsets[lo];
  for (const width of evenWidths(offsets[hi] - offsets[lo], count).slice(0, -1)) {
    boundary += width;
    middle.push(boundary);
  }
  return [...offsets.slice(0, lo + 1), ...middle, ...offsets.slice(hi)];
}
