# Targeted Zoom in Continuous Reading Modes (Issue #195)

**Date:** 2026-06-09
**Issue:** [#195](https://github.com/Gnathonic/mokuro-reader/issues/195) — Double tap zoom, pinch zoom, and wheel zoom all need to be implemented in both continuous modes. Current attempts result in issues with aberrant paging and are unusable and thus disabled.

## Background

Both continuous readers (`VerticalScrollReader.svelte`, `HorizontalScrollReader.svelte`) already contain a zoom architecture introduced in `74db024` and disabled in `d7f4e55` ("zoom targeting math causes position loss and page jumps"):

- A wrapper element gets `transform: scale(zoom)` with `transform-origin: top left` (GPU-composited, no reflow of the page strip).
- A spacer element gets explicit dimensions so the scroll container's scroll range covers the visually scaled content.
- An `Animator` interpolates zoom per frame; each frame recomputes an absolute scroll position from a captured anchor via `computeScrollPosition()` (`zoom-math.ts`).
- Wheel / pinch / double-tap handlers exist but are commented out.

## Root causes of "position loss and page jumps"

The original targeting failed for identifiable, fixable reasons — all stemming from computing **absolute** scroll positions from a **stale model** of the layout:

1. **Wrapper offset assumed to be (0,0).** `computeScrollPosition()` takes a fixed wrapper offset of 0, but:
   - Horizontal: the wrapper is vertically positioned by `align-items: center` / `flex-start` (flips on `userZoom > 1`, which only updates on animation settle → guaranteed jump at settle).
   - Vertical: pages are centered with `mx-auto` inside a wrapper whose layout width tracks the spacer width (`viewportWidth * zoom`) — pages **re-center themselves horizontally every frame** as the spacer grows, invalidating the captured anchor.
2. **RTL scroll coordinates.** The horizontal reader sets `direction: rtl` on the scroll container. In RTL, `scrollLeft` is `0` at the right edge and goes **negative** leftward. The math produces positive LTR values which the browser clamps to `0` → instant jump to the first page. This alone makes horizontal zoom unusable for RTL manga (the default).
3. **Page detection in the wrong coordinate space.** Vertical `detectCurrentPage()` compares `el.offsetTop` (unscaled layout space) against `scrollTop` (scaled visual space). At 2× zoom on page 10 it detects ~page 20. The reported page drives progress/stat tracking and the base for keyboard navigation, so misdetection corrupts read stats and makes paging jump wildly ("aberrant paging").
4. **Page detection runs mid-gesture.** The scroll-settle handler (150 ms) fires during zoom animation while layout is in flux; the horizontal reader syncs `navTarget` from it, so subsequent keyboard nav starts from a garbage page.
5. **Browser scroll anchoring.** Spacer dimension changes are layout mutations; the browser's native scroll anchoring can adjust scroll positions behind our back (no `overflow-anchor: none` is set).
6. **RTL overflow reachability.** Per CSS Overflow, content overflowing past the _inline-start_ edge of a scroller is unreachable (the same rule that makes left-overflow unreachable in LTR). In the RTL horizontal reader, inline-start is the **right** edge — and the wrapper scales from `transform-origin: top left`, pushing `(zoom−1)·stripWidth` of content rightward past the scroll origin. At 2×, roughly the first half of an RTL volume is physically unscrollable; no scroll math can reach it. The origin side must match the scroll-origin side: `transform-origin: top right` under RTL.
7. **Layout-dependent page boxes (vertical fit-to-width).** Pages use `width: 100%` of a wrapper whose layout width tracks the spacer (`viewportWidth · zoom`), so the page _layout boxes themselves_ resize every frame while the inner image stays fixed — content scales as zoom² with growing gaps, and no anchor in page-box space stays glued to image content. The wrapper's layout width must be pinned to `viewportWidth` while zoomed so child layout is zoom-invariant and only the transform scales it.

## Approaches considered

**A. Measurement-based per-frame anchor correction (chosen).** Keep the transform+spacer architecture. Stop predicting absolute scroll positions; instead, every frame: apply zoom, force layout, _measure_ where the anchor actually is (`getBoundingClientRect`, which reflects transforms, alignment, centering, and RTL), and apply a **relative** scroll correction (`scrollLeft += actual − desired`). Relative deltas have identical semantics in LTR and RTL. The anchor is captured as a **fractional position inside a page element** (not the wrapper), so layout shifts (e.g. `mx-auto` re-centering) cannot invalidate it. Self-healing: any frame's error is corrected the next frame.

**B. CSS `zoom` property instead of `transform: scale`.** `zoom` affects layout, so scroll geometry follows automatically and most of the math disappears. Rejected: it reflows the entire page strip (potentially hundreds of pages) every animation frame; the project already abandoned a PixiJS reader (`d080d36`) because plain DOM + native scroll outperformed cleverness, and the transform approach was deliberately chosen for GPU compositing (`fd0baff`).

**C. Virtual viewport (transform-only pan+zoom, no native scroll).** Rejected: large rearchitecture, loses native scroll/inertia and the scroll-based progress tracking; the PixiJS history shows this path was already explored and abandoned.

## Design

### Shared controller

Both readers duplicate ~150 lines of zoom/pinch state. Extract one tested implementation:

- **`src/lib/reader/zoom-math.ts`** (extended; pure, unit-tested):
  - `anchorFraction(rect, x, y)` → fractional anchor within a rect (can be <0/>1; linear extrapolation is fine).
  - `anchorScreenPosition(rect, fx, fy)` → where that anchor currently is on screen.
  - `zoomProgress(current, start, target)` → clamped 0–1.
  - `lerp2(from, to, t)` → interpolated screen target.
  - `nearestZoomLevel(levels, z)` / `nextZoomLevel(levels, target, dir)`.
  - `wheelIntentIsZoom(ctrlOrMeta, swapWheelBehavior)`.
  - `normalizeWheelDelta(deltaY, deltaMode)` + accumulator step logic (pure; timestamps passed in).
  - `pinchDistance(points)` / `pinchMidpoint(points)`.
  - The existing `computeScrollPosition`/`screenToContent`/`contentToScreen` are superseded; verified consumers are only the two readers and `zoom-math.test.ts` — remove all three and their tests.
- **`src/lib/reader/zoom-controller.ts`** (new): `ContinuousZoomController` owning zoom state, the `Animator`, anchor state, pinch state, and wheel accumulation. The component supplies a config:
  - `getScrollContainer()`, `getPageElements()`, `getViewport()`
  - `applyZoomLayout(zoom)` — reader-specific spacer dims + wrapper transform
  - `onZoomedChange(zoomed)` — drives `userZoom`-gated layout/drag state in the component
  - `onSettled(zoom)` — cleanup + page re-detection hook
  - API: `wheelZoom(e)`, `pinchStart/Move/End(points)`, `toggleZoom(x, y)` (double-tap), `cycleZoom(dir, x?, y?)`, `reset()` (instant 1×), `finishNow()` (snap to target + settle), `isActive`, `currentZoom`, `zoomTarget`, `destroy()`.
- **`src/lib/reader/zoom-layout.ts`** (new): the reader-specific layout appliers (`applyVerticalZoomLayout`, `applyHorizontalZoomLayout` + alignment) — element-parametrized and Svelte-free so the components and the e2e suite drive the **same** code; the wrapper width pin and RTL transform-origin rules live only here.
- **`src/lib/reader/page-detection.ts`** (new): pure rect-based current-page detection (`closestPageToCenter`, `detectHorizontalPage`, `horizontalVisibilityRatio`), unit-tested with zoomed-rect fixtures so the "aberrant paging" regression class stays pinned by tests.

### Frame step (the core fix)

Per animator frame (and per pinch move, via `snapTo` for 1:1 tracking):

1. `applyZoomLayout(zoom)` — spacer dims + `transform: scale(zoom)` + alignment (all imperative, same task, before any measurement).
2. Force layout (`void container.scrollWidth`).
3. Measure the anchored page element's rect; `actual = anchorScreenPosition(rect, fx, fy)`.
4. `desired = lerp2(fromScreen, toScreen, zoomProgress(zoom, startZoom, targetZoom))`.
5. `container.scrollLeft += actual.x − desired.x; container.scrollTop += actual.y − desired.y` (relative → identical semantics in LTR and RTL; browser clamping at reachable edges degrades gracefully).

**Degenerate-case guards (NaN landmine):** `zoomProgress(current, start, target)` returns **1 when `start === target`** — otherwise pinch (driven via `snapTo`, where start == target on every move, e.g. pinching inward at min zoom) computes 0/0 = NaN, which survives `Math.min/max` clamping _and_ `lerp2` even when `from === to` (`0·NaN = NaN`), and a NaN scroll write coerces to 0 — a teleport to the scroll origin. Belt-and-braces: the controller skips the scroll write unless both deltas are finite.

**Reader-specific `applyZoomLayout`:**

- _Both:_ spacer dimensions derive from **measured wrapper layout size × zoom** (not viewport size) so all three `continuousZoomDefault` modes get a correct scroll range; cleared at 1×.
- _Vertical:_ pin `wrapper.style.width = viewportWidth px` while zoomed (root cause 7); spacer `width = viewportWidth·zoom`, `minHeight = wrapperHeight·zoom + viewportHeight` (wrapper height is zoom-invariant once the width is pinned).
- _Horizontal:_ `transform-origin: top right` when RTL, `top left` when LTR (root cause 6); spacer `width = wrapperWidth·zoom`, `height = wrapperHeight·zoom`. Cross-axis alignment of the spacer/wrapper is computed per frame as a pure function of measured geometry — `flex-start` when the wrapper's visual height (`offsetHeight·zoom`) exceeds the container height, `center` otherwise — applied imperatively in the same task as the transform so the measurement step sees post-alignment layout. (This replaces the `userZoom > 1` Svelte-state flip, whose async flush caused the settle jump, and incidentally fixes the pre-existing unreachable-top bug for taller-than-viewport pages at 1×.) The wrapper's _cell_ alignment (between pages of different heights) stays `center` always — it never affects reachability and flipping it reflows the strip mid-gesture.

Anchor capture (gesture start): pick the page element containing/nearest the gesture point, store fractional coords. Re-capture whenever a new gesture or wheel step begins — continuity holds because the previous frames kept that content pinned.

### Settle, interruption, and exclusivity rules

- **Pinch must settle explicitly.** `Animator.snapTo` never fires `onSettle`, so `pinchEnd` runs the same settle routine as animated zoom: snap `zoomTarget` to the nearest level (bookkeeping; the visual zoom stays where the user left it — except releases between 1 and 1.05, which animate back to exactly 1× so a near-unzoomed view doesn't linger with zoomed layout), run 1× cleanup when `currentZoom ≤ 1 + ε`, re-run page detection + `reportProgress()`.
- **`finishNow()`:** any competing scroll intent — keyboard nav, the external `currentPage` effect, scroll-intent wheel, a new drag — arriving while `controller.isActive` first snaps the zoom to its target and runs the settle routine synchronously, then proceeds against settled geometry. This prevents two rAF loops (zoom correction vs `ScrollAnimator`) from fighting and prevents user input from being silently reverted by the correction loop. After an interrupt the component re-syncs the `ScrollAnimator` to the container (`sync()`): scroll events from the correction frames arrive asynchronously, so without it the next `scrollBy` would animate from a stale position and undo the final correction. Wheel zoom also cancels a held-button drag for the same reason.
- **Component resets are silent.** `reset()` (zoom-mode change, layout-setting change, resize) skips the anchor correction, leaving the scroll offset in stale zoomed-space coordinates — so the components suppress the settle report around it, capture the page to restore **before** resetting, and re-anchor afterward. Reporting there would detect a page roughly zoom× past the real one and corrupt progress/stats.
- **Settle cleanup is conditional:** the cross-axis scroll reset at 1× only applies when no cross-axis scroll range remains after cleanup (`scrollWidth/Height ≤ client + 1`) — `zoomOriginal`/`fitToWidth` content legitimately scrolls on that axis at 1×.
- **Pinch re-baselines on pointer-set changes:** if a third finger lands or one of three lifts while two remain, re-baseline `startDist`/`startZoom` and re-capture the anchor at the new midpoint — otherwise the pair-distance ratio jumps discontinuously.
- **In horizontal, `onSettled` overrides `navTarget`** (and clears `navIsKeyboard`): an interrupted keyboard nav refers to a destination never reached.

### Gesture semantics

- **Wheel zoom** (`Ctrl`/`Meta` + wheel, or bare wheel when `swapWheelBehavior`, matching paged mode): steps through `ZOOM_LEVELS = [1, 1.5, 2, 3]`, anchored at the cursor (`from = to = cursor`), animated. Deltas normalized by `deltaMode` (lines ×40, pages ×800) and accumulated with a 100 px step size + idle/direction reset, so one mouse notch = one level step and trackpad streams don't fly through all levels at once.
- **Wheel scroll under `swapWheelBehavior`**: when swap is on, the _modifier_+wheel combination is the scroll intent and **must actually scroll** — the vertical reader gains an explicit `preventDefault` + `scrollTop += normalizedDelta` branch (today its non-zoom path is a no-op, which under swap would leave the user with no wheel scrolling at all and ctrl+wheel falling through to browser page zoom); the horizontal reader applies its existing deltaY→scrollLeft conversion in that branch. Parity note (same as paged mode): trackpad pinch arrives as ctrl+wheel, so under swap it is classified as scroll.
- **Double-tap / double-click**: toggle — when `currentZoom ≤ 1 + ε`, zoom to 2× sampling the tap point and animating it toward the viewport center (`from = tap`, `to = center`, interpolated so it pans while zooming, no first-frame jump); otherwise reset to 1× (`from = to = tap`). The predicate is the **animator's current value** (user-visible state), not `zoomTarget` — after a pinch to 1.2× whose target snapped to 1, a double-tap must reset, not zoom in. Matches paged-mode "zoom in / reset" semantics; replaces the old 4-level cycle, which made getting back out tedious. Existing single-tap-vs-double-tap timing and text-box guards stay in the components.
- **Pinch (pointer events)**: continuous (not level-stepped), clamped to [1, 3]. Anchor = content under the **initial** midpoint, pinned to the **live** midpoint (`from = to = current midpoint`) → combined pan+zoom in one gesture. Applied via `snapTo` (no easing lag). Release runs the settle routine (above). Pinch start cancels drag (existing behavior) and `finishNow()`s any active animation.
- **Safari desktop trackpad pinch**: Safari never synthesizes ctrl+wheel; it fires proprietary `gesturestart/gesturechange/gestureend` events and browser-zooms the page unless they're `preventDefault`ed. The readers listen for these and feed `baseZoom · e.scale` anchored at `(e.clientX, e.clientY)` through the same pinch path. (Untestable in this environment; isolated to three listeners.)
- **Level-step guard**: a wheel/cycle step is a no-op only when `next === zoomTarget && |currentZoom − next| < ε` — after a pinch ends at 2.6 (target snapped to 3), a further zoom-in wheel must still animate 2.6 → 3 rather than dead-zone.

### Aberrant paging fixes

- Vertical `detectCurrentPage()` switches to visual space: compare `getBoundingClientRect()` centers against the container rect center (how the horizontal reader already does it) — correct at any zoom.
- The scroll-settle handler skips detection while `controller.isActive` (animating or pinching); the settle routine re-runs detection + `reportProgress()` so progress updates exactly once, with correct geometry.
- `ScrollAnimator` gets a `stop()`; any zoom gesture stops in-flight keyboard scroll animations, and conversely any scroll intent `finishNow()`s the zoom (see exclusivity rules).
- `overflow-anchor: none` on both scroll containers (spacer resizes are real scroll-anchoring triggers in Chrome/Firefox).
- Vertical `pageFitsVertically()` uses the element's _visual_ rect height instead of `offsetHeight · userZoom` — correct for any zoom value including non-level pinch results.

### Layout-state changes (no more settle jump)

Alignment is no longer driven by Svelte state (`userZoom > 1`) with its async flush; it is computed and applied imperatively inside `applyZoomLayout` (see above), so every frame's measurement sees the real layout and there is no settle flip left to jump. The component keeps a boolean `isZoomed` state (updated via `onZoomedChange`) solely for cross-axis drag gating, which additionally allows cross-axis drag whenever cross-axis scroll range exists at 1×.

### Interaction hygiene

- Zoom resets to 1× (instant, via the settle routine) on `continuousZoomDefault` mode change (Z key) and on viewport resize/orientation change — both already re-anchor to the current page; layering user zoom on top of those transitions is undefined territory.
- Drag panning, keyboard nav, volume-boundary nav: unchanged semantics; they operate on visual rects and remain correct under zoom.

### Peripheral fixes (flagged during review, same area)

- Reader.svelte's paged-mode image-cache `$effect` is gated off in continuous mode (continuous readers create their own per-page blob URLs and never consume the cache; the effect just wastes a ±5-page decode window keyed off the reported page).
- `continuousVisibleCount` resets to 1 when the effective scroll mode is vertical (only the horizontal reader reports visible counts; switching horizontal→vertical previously left a stale "n,n+1" page display).

## Error handling

- Anchor element missing (shouldn't happen — all page divs stay mounted): the gesture is ignored. Zooming with no measurable anchor has no meaningful target.
- Zoom gesture with no scroll container / before mount: ignore.
- Pinch with <2 pointers, zero start distance: ignore (existing guards).

## Testing

1. **Unit (vitest/jsdom):** all new pure functions in `zoom-math.ts` (including the `zoomProgress` start==target degenerate case); controller logic with stubbed elements (fake rects/scroll offsets), including: RTL relative-correction equivalence, anchor stability across frames, "pinch clamped at min zoom leaves scroll untouched" (the NaN case), wheel accumulation thresholds, post-pinch wheel step out of the dead zone, pinch pan+zoom pinning, pinch-end settle bookkeeping, pinch pointer-set re-baselining, `finishNow` semantics.
2. **E2E (Playwright):** `e2e/zoom.spec.ts` is rewritten as a hard gate of this work — the current file re-implements the _old_ absolute-scroll math inline and would silently keep passing. The new spec dynamically imports the **real** `zoom-controller`/`zoom-math` modules through the Vite dev server and drives a synthetic strip DOM (LTR and RTL, including a fit-to-width-like layout) through wheel/double-tap/pinch scenarios, asserting anchor pinning and reachability (page-1 content reachable while zoomed in RTL). Add a `test:e2e` npm script — the Playwright dependency exists but nothing wires it.
3. **Manual browser verification:** dev server + real volume; wheel zoom (both swap settings), double-tap in/out, page detection correctness while zoomed (page counter), keyboard nav while zoomed, RTL horizontal mode, vertical mode in all three `continuousZoomDefault` modes.

## Out of scope

- Continuous (non-stepped) wheel zoom and zoom ranges beyond 3× (parity with the existing level design).
- Paged-mode behavior (untouched).
- Migaku/extension DOM-mutation interactions beyond existing keying patterns.
