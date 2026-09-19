# Auto mode: character-exact placement from `char_offsets`

**Date:** 2026-09-16
**Status:** proposed — hand-off from the producer side (mokuro fork + bunko
engine runner); no reader code written yet
**Upstream spec:** `2026-09-16-char-offsets-design.md` in the bunko repo
(`mokuro-webdav-library`), sections "Format" and "mokuro-reader hand-off"
**Builds on:** `2026-07-04-original-mode-line-coords-design.md` (the per-line
renderer) and `2026-07-09-per-line-yomitan-continuity-design.md` (why line spans
must stay in normal flow)

## Problem

Auto mode places each OCR line on its `lines_coords` quad and _fits_ the text
into it: one font size, constant advance per glyph, from `quad main extent ÷
measured em advance`. Good enough to read, never the print. Real typesetting has
variable advances — `、` and `。` take about half a cell, small kana less than a
full one, `!?` prints as one cell from two code points, tracking tightens
mid-line — so the fitted line drifts: the first character sits right, the middle
wanders, the last lands a few pixels off the end. Selection rectangles and
Yomitan hit-testing inherit the drift, so a lookup can land on the neighbouring
glyph in a dense vertical column.

Producers now emit the real answer: the mokuro fork and the bunko engine runner
compute the pixel position of every character (recognizer attention plus an
ink-cell projection) and write it into the sidecar as `char_offsets`. The reader
no longer has to guess where a character is; it only has to render it there.

## Data contract

Fixed upstream — restated here, not amended.

### Per block: `char_offsets`

```json
{
  "box": [685, 180, 886, 656],
  "vertical": true,
  "font_size": 46,
  "lines": ["管理命令されてこそ", "ヒーローになれるのが"],
  "lines_coords": [[[814,183],[861,183],[861,609],[814,609]], ...],
  "char_offsets": [[0, 47, 94, 141, 188, 235, 282, 329, 376, 424], null]
}
```

- `char_offsets` is optional and parallel to `lines`. Entry _i_ is either `null`
  (no placement for that line; render as today) or an integer array of length
  `len(lines[i]) + 1` (length in Unicode **code points**).
- Values are cumulative pixel distances **along the line's reading axis**,
  measured from the line's start edge: the top edge of the quad for vertical
  text, the left edge for horizontal text. Character _k_ occupies
  `[offsets[k], offsets[k+1])`. The last value is the extent of the placed text,
  at most the quad's main extent (as `quadExtents` computes it; for axis-aligned
  quads simply the quad height or width).
- Across the line, characters fill the quad's cross extent; there is **no
  per-character cross position**. One integer per character, not four.
- Glyphs that print as one cell but are several code points (`!?`, `！！`, `...`)
  split the cell evenly. Whitespace code points get a zero-width span.
- Offsets are non-decreasing. Producers clamp to the quad extent; readers treat a
  malformed entry (wrong length, decreasing) as `null`.

### Top level: `char_offsets_method`

`"attn-cells"` (recognizer attention decides membership and order, ink cells give
the boundaries) or `"cells"` (ink cells and width-weighted spacing only). Absent
when no block carries offsets. Diagnostic only: rendering must not depend on it.

## Mapping onto `quadExtents`

`line-coords-layout.ts` already decomposes each quad into `main` (along the
writing direction) and `cross` (across it) via edge-midpoint vectors; the offsets
live on exactly that `main` axis, from the quad's start edge — top for vertical
(`main` = quad height), left for horizontal (`main` = quad width). Character _k_
therefore sits at `bbox.minY + offsets[k]` (vertical) or `bbox.minX + offsets[k]`
(horizontal) relative to the block box, from the bbox `layoutLines` already
computes, and advances `offsets[k+1] - offsets[k]`. `offsets[0]` is usually 0 but
need not be; a non-zero value shifts the line's main origin into its `left`/`top`.

Cross axis is unchanged: the column/row stays centred in the quad's cross extent
(quads carry attached ruby and mask slack; base glyphs sit near the middle), and
font size stays `min(cross, fitted)` — the existing `candidate` — with the glyph
centred in its cell. Cross extent is the only cross-axis information the format
carries, and a cell narrower than its glyph is normal (tight tracking), so cells
do not clip: `overflow: visible`.

## Approach — per-character cells inside the existing line span

**Keep exactly one `<span class="ocr-line">` per line.** Issue #254's constraint
applies unchanged, now per character: Yomitan's DOM text scanner decides line and
sentence boundaries from computed CSS and traversal order, and `position:
absolute | fixed | sticky` injects a hard paragraph break. Per-character absolute
positioning would put `\n\n` between _every glyph_ — no word would scan, and a
selection across the line would come back shredded. The line span stays in normal
flow and is snapped onto its quad by the existing `positionPerLine` action; the
characters live inside it, each in a child span whose **inline size is its
advance**:

```html
<span class="ocr-line positionedLine" style="font-size:47px" ...>
  <span class="ocr-char" style="inline-size:47px">管</span>
  <span class="ocr-char" style="inline-size:47px">理</span>…
</span>
```

- `.ocr-char { display: inline-block; inline-size: <advance>px; text-align:
center; overflow: visible; line-height: 1; letter-spacing: 0; }`
- Offsets are **cumulative and contiguous** (cell _k_ ends where _k+1_ begins),
  so normal flow at those exact inline sizes reproduces the exact positions — no
  per-character measurement, unlike the line-level snap, which needs it because a
  line's natural origin is only knowable after layout.
- `inline-size` and `text-align: center` are logical: width and horizontal
  centring in `horizontal-tb`, height and vertical centring in `vertical-rl`
  (still on `.textBox`, unchanged). One rule serves both writing modes.
- A zero-width cell (whitespace) is `inline-size: 0`; the character stays in the
  DOM so copy and Yomitan see it. `display: inline-block` truncates to `inline`
  in Yomitan's `doesCSSDisplayChangeLayout` — continuity-safe, the same fact the
  line-level fix relies on.
- The line span's natural advance becomes `offsets[n] - offsets[0]`, not
  `advanceEm × fontSize`; anything reasoning about the line's main span
  (`enforceNoOverlap`'s `mainSpan`) must use it. Cleanest is an effective
  `advanceEm = (offsets[n] - offsets[0]) / fontSize` for offset lines, so the
  existing arithmetic stays correct with no second code path.

**Text preprocessing gotcha.** `TextBoxes.svelte` substitutes ellipses before
rendering (`...` and `．．．` → `…`), changing the code-point count, so **offsets
index the raw `block.lines[i]`, not `processedLines[i]`**. The collapse is
well-defined against the contract: three code points sharing one cell become one
cell spanning `[offsets[k], offsets[k+3])`. `char-offsets-layout.ts` does the
substitution itself, remapping as it goes, and returns cells parallel to the
processed text; a mismatch after remapping fails validation → `null`.

### Alternatives considered

- **`letter-spacing` per line.** One scalar cannot express variable advances;
  `、` at half a cell and `!?` at one shared cell are exactly what the format
  exists to describe. Rejected: it cannot represent the data.
- **Absolutely positioned character spans outside the line span.** Exact and
  measurement-free, and what a first sketch reaches for — but it is the #254
  regression multiplied by the character count: a paragraph break between every
  glyph, so Yomitan scans nothing, sentence extraction stops at the first
  character, selection and copy across the line break. Rejected on the reader's
  hardest constraint.
- **Per-character `transform: translate`.** Continuity-safe, but a transform does
  not remove flow advance, so every cell would still need a measured correction —
  strictly worse than sizing the cells, which is exact and free. Per-character
  font scaling to fill each cell is worse still: it distorts glyphs and the cross
  extent is shared anyway.

## Interaction with `layoutLines`

Offsets do not replace `layoutLines`; they refine one branch of it.

- **Trusted like clean lines.** An offset line is never a merged-columns suspect
  and never wraps: its main extent is measured, not fitted, so `SUSPECT_RATIO`
  (quad ≥ 1.6× its own fitted size) no longer describes it. It enters
  `enforceNoOverlap` with `trust = 2`, so lower-trust neighbours clip around it.
- **Uniform block sizing.** An offset line keeps `min(cross, fitted)` and is
  **not** pulled to the block's uniform size — the print size is already in its
  cells. It still votes on the block reference (weighted by quad ink area) so the
  remaining `null` lines in a mixed block stay consistent.
- **Hidden lines stay hidden.** Dedupe runs on bboxes and text before any offset
  is consulted; a suppressed re-capture stays suppressed either way.
- **Overlap clusters.** A cluster member with offsets keeps its cells and
  `trust = 2`; the diverged-overlap band partition applies only to `null`
  members. A fully-offset block should produce no clusters — that is the point —
  but the path must stay correct if it does.

## Validation and fallback rules

`char-offsets-layout.ts` validates each entry before anything renders, and any
failure degrades that **line** (not the block) to the fitted path. It never
throws. A block may mix cell-rendered and fitted lines and must still look
coherent — hence the shared block reference for the fitted ones.

| condition                                                                                                                              | result                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `char_offsets` absent, or entry `null`                                                                                                 | that line uses today's fitted path |
| not an array of finite integers of length `[...rawLine].length + 1` (code points, counted with the iterator, after the ellipsis remap) | line → `null`                      |
| `offsets[0] < 0`, or values decreasing                                                                                                 | line → `null`                      |
| `offsets[n] - offsets[0] > 1.15 × extents.main` (producers clamp, so this catches corruption only)                                     | line → `null`                      |
| `lines_coords` missing/degenerate                                                                                                      | whole block → legacy, as today     |

## Type changes

```ts
// Block: per-line character placement, parallel to `lines`
char_offsets?: (number[] | null)[];
// Page: "attn-cells" | "cells" — diagnostic only, never changes rendering
char_offsets_method?: string;
```

No import-pipeline change is needed for rendering: `MokuroBlock` is
`{ lines?: string[]; [key: string]: unknown }` and `processing.ts` stores
`blocks: page.blocks` verbatim, so `char_offsets` already reaches IndexedDB in
volumes imported since producers began emitting it. One caveat: pages there are
rebuilt field-by-field (`version`, `img_width`, `img_height`, `img_path`,
`blocks`) and `char_offsets_method` is a **file top-level** key, so carrying it
through costs one line — optional for v1, since nothing renders from it.

## Test plan

1. **Unit — `src/lib/reader/char-offsets-layout.ts` (new, pure)**, mirroring
   `line-coords-layout.test.ts`. Exports roughly
   `charCells(rawLine, processedLine, offsets, extents, vertical)` →
   `{ char, start, size }[] | null`. Cases: vertical and horizontal happy paths
   (cells contiguous, `start === offsets[0]`, last `start + size === offsets[n]`);
   variable advances (`、` half cell) preserved; `!?` and `...`→`…` collapse
   remapping; zero-width whitespace; every validation failure returning `null`
   (short, long, decreasing, NaN, overlong); surrogate pairs.
2. **Fixture page.** One real page JSON from the bench volume — vertical,
   furigana-heavy, with offsets, one `null` line and one block without
   `char_offsets` — shared by the unit and component tests so mixed blocks are
   covered.
3. **Component (vitest + testing-library).** A block with offsets renders one
   `.ocr-line` per line holding `[...line].length` `.ocr-char` spans;
   `lineSpan.textContent === processedLine` (the invariant selection and Yomitan
   depend on); a `null` line renders as bare text; a block without offsets
   matches today's output. Guard: no `.ocr-char` is `position: absolute`.
4. **Playwright (real layout).** Fixture volume, auto mode, always-show OCR.
   (a) Select from before the first character to past the last: the copied string
   is the whole line — the guard against the rejected alternative. (b) Each
   character's painted rect lies inside its line's quad, main-axis centre within
   ~2px of `(offsets[k] + offsets[k+1]) / 2`. (c) Screenshot vs today's renderer.
5. **Acceptance (manual, real Yomitan).** A word spanning two lines of an offset
   block still scans and still mines the whole block as the sentence — the #254
   acceptance, re-run because the DOM changed.

## Rollout

Auto mode only, no new setting; `original` and manual sizes are untouched. Pure
enhancement: `char_offsets` absent or `null` → today's code path, unchanged, for
the whole existing library. Nothing to migrate; volumes gain placement when they
are regenerated with a current producer. Land the pure module with its tests
first, then wire `TextBoxes.svelte`, so the geometry is proven before the DOM
changes.

## Open questions for the reader maintainers

1. **Sparse cells.** When a cell is much wider than its glyph (a gap in the
   print, a merged empty run), centre the glyph (proposed), start-align it, or
   letter-space the run? Centring suits `、。` and ruby gaps but may look odd on
   a wide trailing cell.
2. **Debug overlay.** Worth a "show character boxes" dev toggle outlining each
   cell and showing `char_offsets_method`? It would make producer regressions
   visible without a screenshot diff, at the cost of a settings entry.
3. **Trust by method.** Should `"cells"` (no attention, CPU producers) get a
   tighter overlong-extent tolerance than `"attn-cells"`? Currently identical.
4. **DOM weight.** One span per character multiplies OCR-layer nodes ~10–20×.
   Measure on a dense page first; mitigation is to build cells only in view.
5. **Rotated quads.** Offsets run along the rotated main axis while placement is
   still the axis-aligned bbox (accepted since 2026-07-04) — the first feature
   that makes a CSS `rotate` worth revisiting. Related: cap the font size by the
   _narrowest_ cell so glyphs never collide, or keep overflow with centring
   (proposed — tight tracking is real print)?

## Issue text

**Title:** Auto mode: render per-character positions from the new `char_offsets`
sidecar field

The mokuro fork and the bunko engine runner now emit `char_offsets` in `.mokuro`
files: per block, an array parallel to `lines`, each entry either `null` or
`len(line) + 1` integers giving the cumulative pixel position of every character
along the line's reading axis from the quad's start edge (top for vertical, left
for horizontal). Character _k_ occupies `[offsets[k], offsets[k+1])`; characters
fill the quad's cross extent, so there is no per-character cross position. A
top-level `char_offsets_method` (`"attn-cells"` or `"cells"`) records how they
were made. Old files are unaffected — the field is simply absent.

Auto mode currently _fits_ each line into its quad with one advance per glyph, so
the text drifts against the print (`、` and `!?` are the obvious offenders), and
selection / Yomitan hit-testing drift with it. Proposed rendering: keep exactly
one `<span class="ocr-line">` per line — per character `position: absolute` would
reintroduce #254 once per glyph and shred selection — and put each character in
an `inline-block` child whose logical `inline-size` is `offsets[k+1] -
offsets[k]`, centred, at `font-size = min(quad cross extent, fitted size)`.
Cumulative contiguous offsets mean normal flow reproduces exact positions with no
per-character measurement; `null` or malformed offsets fall back to today's path.

Design doc: `docs/superpowers/specs/2026-09-16-char-offsets-rendering-design.md`.
