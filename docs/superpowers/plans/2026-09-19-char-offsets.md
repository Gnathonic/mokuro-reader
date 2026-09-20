# char_offsets: character-exact placement in the viewer and the editor

**Date:** 2026-09-19
**Branch:** `feat/char-offsets`, stacked on `feat/ocr-layers-cloud`
**Spec:** `docs/superpowers/specs/2026-09-16-char-offsets-rendering-design.md` (producer hand-off)
plus the decisions below, which win where they differ.

## Decisions (user interview, 2026-09-19)

1. **Zero-width cells on real characters.** The contract says only whitespace is
   zero-width, but real producer output has them: 0.65% of characters in
   mokuro-fork primaries, 8.6% in `paddle-manga` layers, in runs up to 8
   (`ぎ[322,363) と[363,363) 、[363,449)`). **Auto mode repairs them; original
   mode renders the file as-is.** Consequence: placement applies to BOTH `auto`
   and `original` font modes (the spec said auto only). Manual point sizes stay
   untouched — they ignore OCR geometry by design.
2. **Editing a placed line reflows locally**: unchanged prefix and suffix keep
   their cells, the changed middle shares its old span evenly. Undo restores the
   exact old offsets (history snapshots pages).
3. **Edit mode shows cells until a line is focused**; the line being typed in is
   plain text (contenteditable + IME safe) and re-cells on commit.
4. **GCV layers emit `char_offsets`** from the per-symbol boxes, with
   `char_offsets_method: "gcv-symbols"` (diagnostic only upstream, so a new value
   is safe).

Defaults taken without asking (spec open questions): sparse cells centre their
glyph; no debug overlay; no trust difference by method; cells do not clip and the
font size is not capped by the narrowest cell; rotated quads stay axis-aligned
bboxes; DOM weight is measured in the e2e before any lazy-cell mitigation.

## Facts from the real data (83k lines, 46 sidecars on the local bunko demo)

- 0 malformed entries; 0.4% `null` lines; `offsets[0]` is always 0 today (the
  contract still allows non-zero); placed extent ÷ quad main extent: p1 0.83,
  p50 0.98–1.0, max 1.013.
- mokuro-fork primaries carry `char_offsets_method` at the file top level AND on
  every page object; engine sidecars only at the top level.
- ~5% of lines contain `...` / `．．．`, which `TextBoxes.svelte` collapses to `…`
  before rendering — offsets index the RAW line.

## Module contracts

### `src/lib/reader/char-offsets.ts` (new, pure, no DOM)

Data-level helpers shared by the renderer, the edit ops and the engines.

```ts
export type LineOffsets = number[] | null;

/** Code points, iterator-counted (surrogate pairs are one). */
export function codePoints(text: string): string[];

/**
 * The contract's validation table. Returns the offsets unchanged when valid,
 * else null: not an array, wrong length (codePoints(raw).length + 1), any
 * non-finite or non-integer value, offsets[0] < 0, any decrease, or (when
 * mainExtent is given) offsets[n] - offsets[0] > 1.15 * mainExtent.
 * An empty line (n = 0) is null.
 */
export function validLineOffsets(
  raw: string,
  offsets: unknown,
  mainExtent?: number
): number[] | null;

/** block.char_offsets when it is an array parallel to block.lines, else null. */
export function parallelOffsets(block: {
  lines: string[];
  char_offsets?: unknown;
}): LineOffsets[] | null;

/**
 * Auto-mode repair. A maximal run of zero-width NON-whitespace cells borrows the
 * larger of its two neighbouring non-zero cells; the combined span is split
 * evenly over the run plus that neighbour (integers, remainder to the last).
 * Whitespace keeps zero width. Returns null when the line cannot be repaired:
 * every cell is zero, or more than UNPLACED_MAX (0.4) of its non-whitespace
 * characters were zero-width. Input must already be valid. Never mutates.
 */
export function repairZeroCells(chars: string[], offsets: number[]): number[] | null;
// Added after real-data and real-browser verification (2026-09-19). repairZeroCells also gives up (null →
// fitted line) when, on the FINAL widths:
//  - CRUSHED: a real cell < CRUSHED_RATIO (0.25) × max(median non-zero cell, extent / real chars) counts as
//    unplaced, before and after repair;
//  - SQUEEZED: the line has >= 3 wide glyphs (kana, Han, fullwidth forms; not small kana, ー, punctuation) and
//    more than SQUEEZED_MAX (0.25) of them sit in cells < SQUEEZED_RATIO (0.7) × (extent / code points):
//    a bloated neighbour squeezed them and the glyphs would overlap.

/** Scale by a main-axis factor: rounded integers, offsets[0] scaled too, monotone. */
export function scaleOffsets(offsets: number[], factor: number): number[];

/**
 * Text edit reflow. Common prefix and suffix (code points) keep their cells; the
 * changed middle's old span is split evenly over the new middle's characters.
 * A pure insertion (old span 0) widens the region by one character on each side
 * where one exists before splitting. Pure deletion simply drops the cells and
 * lets the following boundary stand (the neighbour absorbs the span). newText
 * empty → null. oldOffsets null/invalid → null. Total extent is preserved.
 */
export function reflowOffsets(
  oldText: string,
  newText: string,
  oldOffsets: LineOffsets
): LineOffsets;
```

### `src/lib/reader/char-offsets-layout.ts` (new, pure, no DOM)

```ts
export interface CharCell {
  text: string;
  size: number;
} // size = px advance, >= 0
export interface LineCells {
  cells: CharCell[]; // parallel to codePoints(processedLine); cells[].text joined === processedLine
  start: number; // offsets[0]: shift of the line's main origin
  extent: number; // offsets[n] - offsets[0]
}

/** The reader's ellipsis substitution, in ONE place (TextBoxes imports it). */
export function processLine(raw: string): string; // '...' and '．．．' → '…'

/**
 * Cells for one line, parallel to processLine(raw). Validates (validLineOffsets
 * with extents.main), optionally repairs (repair: true = auto mode; false =
 * original mode, file as-is), then remaps the ellipsis collapse: three raw code
 * points sharing a run become one '…' cell spanning [offsets[k], offsets[k+3]).
 * Any failure → null (that LINE falls back to the fitted path). Never throws.
 */
export function lineCells(
  raw: string,
  offsets: unknown,
  mainExtent: number,
  opts: { repair: boolean }
): LineCells | null;
```

### `layoutLines` (`line-coords-layout.ts`)

`LayoutBlock` gains `char_offsets?`. Signature becomes
`layoutLines(block, processedLines, measure, opts?: { cells?: 'repaired' | 'as-is' | 'off' })`
(default `'repaired'`); `LineLayout` gains `cells?: CharCell[]`. For a line with
cells, per the spec's "Interaction with layoutLines": effective
`advanceEm = extent / fontSize` so `mainSpan` arithmetic holds; never `suspect`,
never wraps; keeps `min(cross, fitted)` and is NOT pulled to the block's uniform
size but still votes on the reference; enters `enforceNoOverlap` with trust 2;
`start` shifts `left` (horizontal) or `top` (vertical); dedupe/hidden runs first
and a hidden line stays hidden. The raw lines are `block.lines` — `processedLines`
stays the rendered text. `'off'` must reproduce today's output byte for byte.

### `TextBoxes.svelte`

- Ellipsis preprocessing calls `processLine`.
- Auto mode: `layoutLines(..., { cells: 'repaired' })`.
- Original mode: when the block has usable `lines_coords` AND at least one line
  yields cells under `'as-is'`, the block takes the per-line path with
  `{ cells: 'as-is' }`; otherwise today's whole-block original rendering, untouched.
- Manual sizes: unchanged.
- A line with cells renders `<span class="ocr-char" style:inline-size>` children
  inside its ONE `.ocr-line` span, with no whitespace text nodes between them —
  `lineSpan.textContent === processedLine` is the invariant Yomitan, selection and
  copy rely on. `.ocr-char { display: inline-block; text-align: center; overflow:
visible; line-height: 1; letter-spacing: 0 }`. Never `position: absolute`
  (issue #254, per glyph). `positionPerLine` keeps snapping the line span.

### Edit ops (`src/lib/reader/edit/edit-ops.ts`)

`char_offsets` stays parallel to `lines` through every op, exactly like
`lines_coords`: move → unchanged; `resizeBlock` / `resizeLine` → `scaleOffsets` by
each line's own main-axis factor (old vs new `quadExtents().main`); `setBlockLines`
with an unchanged line count → per-line `reflowOffsets` (unchanged text keeps its
array by reference), changed count → delete; `mergeBlocks` → concat only when
every source is parallel (a source without offsets contributes `null`s if at
least one source has them); `splitBlock` → slice; `insertLine` → splice `null`;
`removeLine` → filter; `placeLines`, `flipBlock(swapBox)` → delete; `addBlock` →
none. A block never ends up with a `char_offsets` array of the wrong length —
when in doubt, delete the key.

### `EditableBlock.svelte`

A line that is not being edited and has cells (same `lineCells`, `repair` =
font mode is not `original`) renders the cell spans inside its positioned line
element, with `start` as inline-start padding; the line being edited (and every
line while the block's editor is open, if simpler and consistent) is plain text.
The `initText` action becomes the single owner of the line's DOM: it renders
either cells or plain text, and its `update()` keeps the "never fight the caret"
guard for the editing case. `textContent` of a celled line equals the processed
text; the draft/commit path keeps reading the RAW text (never the processed one —
committing must not turn `...` into `…` in the stored data).

### Engines

- `gcv-convert.ts`: per line, project each symbol box onto the line's reading
  axis; boundary between neighbours = midpoint of the gap; `offsets[0]` = first
  symbol's start edge relative to the line quad's start edge; integers,
  non-decreasing, clamped to the quad main extent. Symbols must be parallel to
  the code points of the emitted line text, else that line is `null`. Page gets
  `char_offsets_method: 'gcv-symbols'` when any line has offsets. `scaleBlock`
  scales offsets with the same factor.
- `translate/wrap.ts`: drop `char_offsets` together with `lines_coords`.

### Import / export round trip

`char_offsets_method` lives on the `Page` (as mokuro-fork already writes it).
Import (`processing.ts` `parseMokuroFile` + the page map, `import/types.ts`
`ProcessedPage`) copies a page-level value and stamps the file's top-level value
onto pages that lack one; `layer-import.ts` `readLayerFile` does the same. The
single writer `buildMokuroMetadata` (`util/mokuro-metadata.ts`) emits a top-level
`char_offsets_method` — the first page's value — only when at least one block has
a non-null offsets entry. Blocks are already stored verbatim, so `char_offsets`
itself needs no pipeline change.

## Tasks

1. **Foundation** — `types/index.ts` (`Block.char_offsets`,
   `Page.char_offsets_method`), both pure modules with full unit tests, fixture
   `src/lib/reader/__fixtures__/char-offsets-page.json` (real page: One-Punch Man
   bench volume p3 — variable advances, a zero-width `と`, a `．．．` run; plus one
   line set to `null` and one block with `char_offsets` removed, noted in a
   sibling README line in the test).
2. **Viewer** — `layoutLines` integration + `TextBoxes.svelte` + component tests.
3. **Edit ops** — `edit-ops.ts` + tests (every op, parallelism property test).
4. **Editor render** — `EditableBlock.svelte` + `EditOverlay` tests.
5. **Engines** — `gcv-convert.ts`, `wrap.ts` + tests.
6. **Round trip** — import/export/layer-import + tests.
7. **E2E** — `e2e/char-offsets.spec.ts`: whole-line selection string, per-character
   rect within ~2px of its cell centre, no absolute `.ocr-char`, original-vs-auto
   zero-cell behaviour, edit-mode cells ↔ plain text on focus, reflow after a
   one-character fix, DOM node count + layout time on a dense page.
8. **Adversarial review** of the branch diff, fixes, full verification.
