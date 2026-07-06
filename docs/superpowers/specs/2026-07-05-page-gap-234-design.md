# Page gap for paged dual-page mode + ctrl+shift+scroll adjustment (issue #234)

**Date:** 2026-07-05
**Issue:** [#234](https://github.com/Gnathonic/mokuro-reader/issues/234) — Page gap for Dual Page mode
**Branch:** `feat/page-gap-234`

## Problem

Many manga scans don't align cleanly across a two-page spread. Continuous
modes already offer a gap ("Page dividers" toggle + `scrollGap` slider), but
paged dual-page mode renders the two pages flush, so misaligned spreads read
as one broken image. Users want an adjustable gap in paged mode too — and a
quick way to tune it without opening the settings panel.

## Design

### New setting: `pagedGap`

- `pagedGap: number` added to `Settings` (`src/lib/settings/settings.ts`),
  default `0`, range 0–100.
- Independent from `scrollGap`: the two live in different coordinate spaces
  (continuous gap is layout px at fit scale; paged gap is image-pixel space)
  and users may want different tuning per mode.
- Persisted and synced like every other profile setting; profiles without the
  key fall back to the default.

### Rendering (paged mode)

- `Reader.svelte` adds `column-gap: {$settings.pagedGap}px` to the paged flex
  row (the `col-start-1 row-start-1 flex flex-row` div holding the one or two
  `MangaPage`s).
- The gap lives in image-pixel space, pre-camera-transform: it scales with
  zoom like a physical gutter. The reader background (`var(--reader-bg)`)
  shows through, matching continuous mode.
- With a single page displayed `column-gap` is inert — no markup conditionals.
- Works with both `flex-row` and `flex-row-reverse` (RTL/LTR).

### Fit math

- `pagedContentSize` (`Reader.svelte`) must include the gap when a second
  page is shown, or fit-to-screen/width, pan clamping, and swipe edge
  detection are off by the gap width.
- Extract a pure helper into `src/lib/reader/paged-zoom-layout.ts`:
  `spreadContentSize(first: Size, second: Size | null, gap: number): Size` —
  width = sum + gap when `second` present, plain page size otherwise.
- `PagedViewport` re-applies its base on `contentSize` changes, so adjusting
  the gap mid-read re-fits automatically. Zoom anchoring measures DOM rects
  (`[data-page-index]`), so it stays consistent with whatever CSS renders.

### Hotkey: ctrl+shift+scroll (all three reader surfaces)

**Binding principle** (why ctrl+shift): combos with a native browser meaning
are overridden only with the same action tuned for the reader — ctrl+wheel
is zoom, wheel is scroll, shift+wheel is horizontal scroll (paged wheel-pan
already feeds `deltaX`). Gap adjustment therefore takes a combo with no
native meaning in any major browser: ctrl+shift+wheel.

- Each surface's `handleWheel` (`PagedViewport`, `HorizontalScrollReader`,
  `VerticalScrollReader`) checks `(ctrlKey || metaKey) && shiftKey` FIRST —
  before `wheelIntentIsZoom` — and treats it as gap-adjust intent with
  `preventDefault()`.
- Scroll up widens, scroll down narrows (mirrors ctrl+wheel-up = zoom in).
- **Axis quirk:** with shift held, browsers report the wheel delta in
  `deltaX`, not `deltaY`. The helper reads whichever axis is nonzero.
- **Which setting:**
  - Paged surface → `pagedGap`. Works in dual and auto view modes; if a
    single page is currently displayed the value still updates and applies
    on the next spread.
  - Both continuous surfaces → `scrollGap`, and sync
    `pageDividers = gap > 0` (scrolling up from zero enables dividers,
    reaching zero disables them; the M toggle keeps working).
- **Non-collisions:** trackpad pinch arrives as synthetic ctrl+wheel without
  `shiftKey` — never misread. macOS accessibility screen-zoom (Control+scroll,
  off by default) swallows the chord at the OS level, but it equally breaks
  the existing ctrl+wheel zoom, so nothing regresses.

### Wheel-to-gap helper

- `gapWheelStep` lives in `src/lib/reader/zoom-math.ts` next to
  `normalizeWheelDelta`/`wheelIntentIsZoom`.
- Converts a wheel event to a gap delta: ~5px per standard wheel notch,
  normalized by `deltaMode`, sign flipped so scroll-up widens.
- Fractional deltas accumulate across events (surface-local accumulator) so
  trackpad streams of tiny deltas don't stall at zero; result clamped 0–100
  and rounded on write.

### Feedback toast

- Each surface gets an `onGapChange?: (px: number) => void` callback prop
  (consistent with the existing intent-callback pattern; Reader owns
  notifications).
- Reader wires it to the existing keyed `showNotification`:
  "Page gap: 24px" — 2s timeout and Migaku-safe `{#key}` handling for free.

### Settings UI

- `ReaderSettings.svelte`, inside the `isPaged` block: "Page gap: Npx" label
  + `Range` slider (0–100), shown when `$settings.singlePageView !== 'single'`.
  No toggle — 0 means off.
- Both the new paged slider and the existing continuous divider slider get a
  "(Ctrl+Shift+Scroll)" hint, like the existing "(M)"/"(P)" hints.

### Docs

- `docs/INPUT-CONTRACTS.md`: wheel row updated — wheel intent is now
  zoom / gap-adjust / scroll, and the binding principle above recorded.

## Performance

Live adjustment costs the same as dragging the existing sliders: both
continuous readers already key layout on `scrollGap`; the paged surface
re-fits via the `contentSize` signature. Settings writes hit the
localStorage-synced store per step — same as slider drags today.

## Testing

- Unit: `spreadContentSize` (gap only when second page present, zero-gap
  passthrough, height = max of pair).
- Unit: `gapWheelStep` (shift axis-swap, direction, deltaMode normalization,
  clamping at 0 and 100, trackpad accumulation reaching whole px).
- Existing paged-zoom-layout unit + e2e suites are unaffected: they treat
  `contentSize` as opaque input.
- Manual (dev server): dual mode gap renders and re-fits; single page
  unaffected; RTL and LTR; ctrl+shift+scroll in all three surfaces with
  toast; continuous divider auto-toggle at zero; ctrl+wheel zoom and
  shift+wheel horizontal pan unchanged.

## Out of scope

- Per-volume gap overrides (profile-level setting only).
- A visible divider line (background showthrough only, as in continuous).
- Keyboard-key binding for gap (wheel chord + slider suffice).
