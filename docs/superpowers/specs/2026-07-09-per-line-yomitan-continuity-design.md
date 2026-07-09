# Per-line layout: restore Yomitan/Migaku text continuity (issue #254)

## Problem

Issue #254: since v1.7.5, Yomitan can no longer scan a word that spans two
lines of an OCR text box, and mining to Anki captures only one line in the
Sentence field. The same class of bug was previously #124.

### Root cause

The per-line auto layout shipped in v1.7.5 (PR #243) renders each OCR line as
its own `position: absolute` span (`.positionedLine` in `TextBoxes.svelte`).

Yomitan's DOM text scanner (`ext/js/dom/dom-text-scanner.js#getElementSeekInfo`)
decides line/sentence boundaries **entirely from computed CSS + DOM traversal
order — never from geometry** — and it inspects `style.position` _before_
`display`:

```js
switch (style.position) {
  case 'absolute':
  case 'fixed':
  case 'sticky':
    newlines = 2; // hard paragraph break
}
```

So every per-line span boundary injects `\n\n`. That newline (a) caps the
forward term match, so a word split across lines can't be matched, and (b)
terminates sentence extraction at the first line (`sentenceTerminateAtNewlines`,
default on). These are exactly the two reported symptoms.

Two facts established from Yomitan source that shape the fix:

- The `.textBox` `::after { content: '\A' }` "continuity trick" never affected
  Yomitan. Yomitan walks only real text nodes and ignores generated content;
  the `\A` is purely the human-visible newline in a revealed box. Legacy auto
  mode stayed continuous because its line spans were plain `display: inline`
  (no `position`), so Yomitan read them as one run.
- The **block-level** `position: absolute` on `.textBox` (one per OCR block) is
  correct and must stay: it makes separate speech bubbles separate sentences.
  The regression is the _second_, per-line layer of `absolute` inside the block.

`inline-block`, `transform`, and `position: relative` are all confirmed against
Yomitan source to keep text continuous (`inline-block` truncates to `inline` in
`doesCSSDisplayChangeLayout`; `transform` is never read; `relative` is not in
the `position` switch).

## Goal

Keep the per-line placement improvement (each line rendered at its detected
`lines_coords` quad with a geometry-fitted font size, the no-overlap invariant,
per-line sizing) **and** restore Yomitan/Migaku continuity within a block.

## Approach — transform-repositioned inline lines

Stop giving line spans `position: absolute`. Render each line as
`display: inline-block` in normal flow, then snap it onto its quad with a
per-line `transform: translate(dx, dy)` computed from a measured natural
position. Exactly one `position: absolute` per block (`.textBox`) remains.

There is no way to get exact placement _and_ inline continuity without
measuring: inline elements inherently advance the flow, and every zero-advance
trick (absolute, float) re-blockifies and re-breaks Yomitan. Measurement is the
price of keeping both, and it has direct precedent in the reader's zoom
architecture (measurement-based correction).

### DOM / CSS changes (`TextBoxes.svelte` only)

- `.positionedLine`: drop `position: absolute` → `display: inline-block`. The
  `left`/`top` inline styles are replaced by `transform: translate(dx, dy)`
  set by the measurement action (below).
- Wrapped lines keep explicit `width`/`height` + `white-space: normal`
  (inline-block honors both).
- Drop the `::after { content: '\A' }` rule in per-line mode — each line is now
  positioned explicitly, so the visible newline is unnecessary, and Yomitan
  never saw it anyway.
- `layoutLines` and `LineLayout { left, top, fontSize, wrap, width, height,
hidden }` are **unchanged**. `left`/`top` are already the target quad origin
  relative to the block box. `enforceNoOverlap`, block dedupe, and per-line
  sizing are all untouched.

### Measurement mechanism (the new part)

A Svelte action on `.textBox` performs a **batched read-then-write** pass:

1. Read every line span's natural in-flow origin (`offsetLeft`/`offsetTop`
   relative to `.textBox`, which is the offsetParent because the box is
   `position: absolute`). These are layout px = image px and **zoom-invariant**
   — the reader applies zoom as an ancestor transform, so the box's internal
   coordinate space stays in image px; no dividing by scale.
2. Apply every transform: `translate(LineLayout.left − offsetLeft,
LineLayout.top − offsetTop)`.

Reading all before writing avoids layout thrash and is correct: transforms are
paint-only and do not re-layout, so natural positions are stable once read.

**When it runs:** on mount when the box has layout (`displayOCR` on), re-run if
the box toggles out of `display:none`. It runs while the box is still
`visibility:hidden`, so glyphs are already on their quads before hover reveals
them (no visible jump). Reveal is also when Yomitan needs hit-testable glyphs,
and `transform` participates in hit-testing, so `caretRangeFromPoint` lands on
the correct glyph.

### Edge cases

- Hidden lines (intra-block overlap dupes) stay omitted from the DOM; their text
  is subsumed by a kept line, so continuity is unaffected.
- Interleaved split-ruby DOM order is a pre-existing data-order quirk (identical
  to legacy) — out of scope.
- `lineLayouts === null` (pre-`lines_coords` / image-only imports) → unchanged
  legacy hover-fit path.
- `offsetLeft/Top` round to integer px. If that proves visibly coarser than the
  current fractional placement, fall back to `getBoundingClientRect()` ÷
  measured zoom scale. Decide empirically during verification.

## Testing / verification

- jsdom has no real layout (`offsetLeft`/`getBoundingClientRect` return 0), so
  the measurement itself can't be unit-tested there.
- Regression guard (cheap): assert per-line spans are **not**
  `position: absolute`.
- Playwright (real browser layout): each line's painted rect lands on its quad;
  no rendered rects overlap.
- Acceptance test (real Yomitan): hover a word split across two lines → it
  scans; mine to Anki → Sentence field contains the whole block. Run via the
  `verify` skill / browser automation with Yomitan installed before declaring
  the issue fixed.

## Scope

- `src/lib/components/Reader/TextBoxes.svelte`: per-line render + new
  measurement action + CSS.
- New/updated tests as above.
- The pure `line-coords-layout.ts` module is untouched.
- Branch: `fix/254-yomitan-line-continuity` off `develop`.
