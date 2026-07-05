# Original mode: per-line rendering from `lines_coords`

**Date:** 2026-07-04
**Branch:** `feat/original-mode-line-coords`
**Status:** prototype

## Problem

Original mode renders every block at `font_size`px anchored at the box corner with
`white-space: nowrap`. But mokuro's `font_size` is the mean detected line-quad
_width_, which for vertical Japanese includes furigana and loose mask margin —
median 1.20× (p95 2.0×) larger than the true character size across a 120-volume /
160k-block scan. The reader's inherited `letter-spacing: 0.1em` and
`line-height: 1.1em` add another ×1.1 per axis. Net: 62% of vertical blocks
overflow their box by >25%; manga-ocr hallucinations overflow up to 90×.
Auto mode works around this but discards line breaks and per-line positions.

Root-cause analysis: see project memory `original-mode-overflow-root-cause` and
https://claude.ai/code/artifact/611aa1cc-41ea-4186-ae7a-83542e5c4032

## Insight

`.mokuro` files carry `lines_coords` — one quadrilateral per OCR line — and the
import pipeline stores blocks verbatim (`processing.ts` `blocks: page.blocks`),
so the data is already in every user's IndexedDB. The quad gives each line's true
position, length, and thickness. `quad_length ÷ text_advance` recovers the true
font size per line.

## Approach (chosen)

Render each line as its own absolutely positioned span at its quad's position,
with a per-line font size derived from quad geometry. Keep the existing one-box
rendering as fallback when `lines_coords` is absent or inconsistent.

Alternatives considered:

- **Block-level shrink only** (cap block font_size so the longest line fits):
  simplest, but keeps CSS-flow line positions, so multi-column balloons with
  uneven columns still misalign, and furigana-as-separate-line renders huge.
- **Fix upstream in mokuro** (emit corrected font_size): right long-term, but
  doesn't help the existing library and loses per-line placement.
- **Per-line transform scale-to-fit**: distorts glyphs; text selection boxes
  misalign with visual text.

## Components

### 1. `src/lib/reader/line-coords-layout.ts` (new, pure)

```ts
export type Quad = number[][]; // 4 × [x, y]
export type TextMeasurer = (text: string) => number; // advance in em units

export interface LineLayout {
  left: number; // px, relative to block box origin
  top: number;
  fontSize: number; // px
}

export function layoutLines(
  block: { box: number[]; vertical: boolean; lines: string[]; lines_coords?: Quad[] },
  lines: string[], // processed (post-ellipsis-substitution) text actually rendered
  measure: TextMeasurer
): LineLayout[] | null;
```

Per line:

- Quad main/cross extents via edge-midpoint vectors (same math as
  comic-text-detector's `examine_textblk`, rotation-tolerant):
  vertical → main = ‖bottomMid − topMid‖, cross = ‖rightMid − leftMid‖;
  horizontal → swapped.
- `advanceEm = measure(processedLine)` — total advance in em units.
- `fontSize = min(cross, main / advanceEm)`, floored at 4px.
  - `cross` cap keeps the column no wider than the detected line.
  - `main / advanceEm` cap keeps `chars × size` inside the detected length —
    this also contains hallucinated lines (text ≫ quad → small but bounded).
- Position: anchored at the quad start on the reading axis (top for vertical,
  left for horizontal), **centered on the cross axis** — quads are often wider
  than the glyph column (attached ruby, mask slack, empty margin; e.g. Dr Stone
  01 p27 `本物から` has a 125px quad for ~38px glyphs) and the base glyphs sit
  near the middle, so edge-anchoring can shove a column into its neighbor.
  Relative to the block box origin.
- **Merged-column wrap**: `referenceSize = median(per-line candidates)`. A line
  whose single-line fit is < 0.7 × reference AND whose quad cross is ≥ 1.6 ×
  reference is treated as multiple print columns captured as one OCR "line"
  (typically base text + furigana reading, e.g. Dr Stone 01 p32
  `空は私ならだいじょうぶ`): it renders with `white-space: normal` inside its
  full quad bbox at (near) the reference size, wrapping into columns. Clean
  lines keep their own fitted size — print mixes sizes within a balloon
  (emphasis words like `大丈夫`), so strict uniformity is deliberately not
  enforced.

Returns `null` (→ caller falls back to legacy rendering) when `lines_coords` is
missing, length-mismatched with `lines`, or any quad is malformed/degenerate.

Rotation: magnitudes handle rotated quads; placement is axis-aligned bbox.
Rendering rotated text upright is accepted prototype behavior (future: CSS
`rotate` above a threshold).

### 1b. `src/lib/reader/block-dedupe.ts` (new, pure)

comic-text-detector occasionally emits the same balloon twice: once properly
segmented, once from a second YOLO hit whose seg-lines were claimed by the
first block — that one gets its whole bbox as a single synthetic "line" with a
huge font_size (e.g. Dr Stone 01 p29: 4-line block + 1-line `font_size: 199`
twin; ~19 duplicate pairs per 1000 pages in a 60-volume scan). `dedupeBlocks`
drops a block when another block has identical joined text and box IoU > 0.5,
keeping the one with more lines (tie: the earlier). Applied in the `textBoxes`
derived for all font modes; preserves original `page.blocks` indices for
context-menu/Anki lookups.

### 2. Text measurer (in the same module)

`createCanvasMeasurer(fontFamily)`: `CanvasRenderingContext2D.measureText` at
100px `'Noto Sans JP', sans-serif`, memoized per string. Falls back to a
char-class heuristic (fullwidth 1.0em, halfwidth 0.55em) when canvas is
unavailable (jsdom). Vertical approximation: upright CJK advance ≈ 1em ≈
horizontal measure; rotated Latin advance = horizontal measure. Good to a few
percent; the `cross` cap bounds the error's visual effect.

### 3. `src/lib/types/index.ts`

`Block` gains `lines_coords?: number[][][]` (optional — image-only and stripped
data stay valid).

### 4. `TextBoxes.svelte`

- In the `textBoxes` derived, when `isOriginalMode`, compute
  `lineLayouts = layoutLines(block, processedLines, measurer)` (module-level
  memoized measurer).
- Template, original mode with `lineLayouts`: set `width`/`height` on the
  `.textBox` (hover/tap target = OCR box, as other modes) and render
  `<span class="ocr-line">` with `position:absolute`, per-line `left/top/font-size`,
  `line-height: 1`, `letter-spacing: 0` (print tracking is already inside the
  quad length). Container keeps `writing-mode`, so columns/rows flow correctly
  inside each span. DOM order stays reading order.
- Original mode without layouts: current markup and CSS unchanged.
- Hover-visibility moves with the spans (background on spans; `p` keeps the
  visibility toggle). The `.ocr-line::after { content: '\A' }` Yomitan/Migaku
  continuity trick is preserved (zero layout effect inside positioned spans).
- `.textBox` input-routing contract (double-tap Anki capture, selection drags,
  contenteditable, copy handler) is untouched — same container, same handlers.
- The auto-mode hover fit (`handleTextBoxHover`) already no-ops outside auto.

## Error handling

- Any inconsistency in coords → `null` → legacy path (never throw in render).
- `advanceEm ≤ 0` (empty line) → fontSize = cross.
- Non-finite/zero quad extents → `null`.

## Testing

1. **Unit (vitest, TDD)** — `layoutLines`: real fixtures captured from the
   investigation (JJK furigana block, Hare+Guu shout, FMA hallucination block),
   plus synthetic horizontal/halfwidth/mismatch/degenerate cases. Invariants:
   `fontSize ≤ cross + ε`, `fontSize × advanceEm ≤ main + ε`, positions relative
   to box, `null` fallbacks.
2. **Component (vitest + testing-library)** — original mode with coords renders
   positioned spans; without coords falls back; other modes unaffected.
3. **E2E visual** — import a furigana-heavy volume (Pokémon Adventures 03) into
   the dev app via Playwright (`E2E_PORT`), original mode + always-show OCR,
   screenshot known-overflow pages before/after.

## Out of scope

- Upstream mokuro fix (separate effort).
- Rotated-text rendering, per-line hover UX polish, Migaku deep-testing.
- Auto/manual font-size modes — unchanged.
