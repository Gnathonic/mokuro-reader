# Paged-Mode Zoom Quality Rework

**Date:** 2026-06-09
**Depends on:** PR #225 (continuous-mode targeted zoom, issue #195) — reuses its architecture.
**Decisions (user-confirmed):** replace the `panzoom` npm library entirely; match the continuous-mode zoom model (animated discrete levels above the fitted base, continuous pinch, no below-fit zoom).

## Why replace panzoom

Paged mode's zoom is the `panzoom` v9.4.3 library plus years of compensating patches, each fighting the library's model:

- Three separate wheel-normalization attempts (`b8d0921`, `207e084`, `42115c5`) for platform/browser delta differences.
- The "edge-aware blending" hack (`f8c29c5`): cursor-anchored zoom pushed corners off-screen, so the anchor is blended away from the cursor near edges — trading anchor fidelity for reachability.
- Custom `keepInBounds()` re-clamping after every pan/zoom event (library bounds disabled), with a sub-pixel rounding workaround for a 1-px compositor seam (#65).
- False page-turns from pinch/pan interplay (#186), fixed by edge-state snapshots around the library.
- Instant, unanimated wheel steps that users found too aggressive (#200).

The continuous-mode rework (#225) already built the pieces that solve these properly: NaN-safe anchor math, a wheel accumulator that makes one notch = one level on every platform, an exponential `Animator` with settle/interrupt semantics, and measurement-based correction that keeps the anchor exactly under the cursor. Bounds clamping (this design) solves corner reachability without distorting the anchor: you can always pan/zoom the corner back into view because the camera never lets content drift past the viewport edge.

## Model

### Base transform + user zoom

- For each (zoom mode, displayed page(s), viewport) a **base transform** is computed from **page data, not DOM measurement** (`img_width`/`img_height` of the displayed page or pair — Reader already knows them, and MangaPage sizes itself from them): a base scale (`fitToScreen` = min of width/height fits; `fitToWidth`; `original` = 1) and a base alignment (centered for fit-to-screen; centered-x/top for fit-to-width; reading-start corner for original — preserving `panToPageStart` RTL semantics). Data-driven sizing makes the base and clamp bounds immune to the `{#key page}` transition overlap (out- and in-trees coexist for ~300 ms) and replaces the old double-RAF layout wait entirely.
- **User zoom** multiplies the base. Wheel/double-tap step through a per-context level list; pinch is continuous — same gestures, accumulator, and settle rules as continuous mode. Effective scale = `baseScale × userZoom`.
- **Floor — the whole-page escape hatch stays.** The user-zoom floor is `min(1, fitScale / baseScale)`: in `zoomOriginal` (and `fitToWidth` on tall pages) the user can still zoom _down to_ fit-to-screen — today's wheel-out-to-fit behavior, which a flat "no below level 1" rule would have deleted on exactly the volumes that need it (scans larger than the viewport). Never below fit.
- **Ceiling — native resolution stays reachable.** The top level is `max(3, 2 / baseScale)` (at least 2× native pixels), so small fit scales (portrait phones) don't cap below today's usable magnification. The step list is the sorted, deduped `[floor, 1, 1.5, 2, 3, top]`; pinch clamps to `[floor, top]`.
- **Double-tap**: zoomed above level 1 → reset to 1; at level 1 with an overflowing base (`floor < 1`, e.g. zoomOriginal scans) → toggle _down to fit_ (today's double-tap-to-fit, kept); at fit or at a fitting base → zoom in to 2× panning the tap point toward center. Each state has an obvious tap-out.
- **`keepZoom` preserves the effective scale** across page turns: `level′ = clamp(level × oldBase / newBase, floor′, top′)`, over a fit-to-screen base. This reproduces today's absolute-scale behavior on uniform volumes _and_ keeps single↔spread transitions seamless (a level-only rule would jump apparent size ~1.4× at every spread boundary). Entering keepZoom via KeyZ converts the current view: `level = clamp(currentEffectiveScale / newBase, floor, top)` — "keep zoom" actually keeps what's on screen. Re-application on page turns is instant (`snapTo`), never animated. Resize preserves the effective scale the same way. Legacy `keepZoomStart`/`keepZoomTopCorner` strings (persisted in localStorage, cloud `profiles.json`, and profile imports — `migrateProfiles` never normalizes them) keep resolving to keepZoom at the read site, permanently; the `ZoomModes` union and default stay untouched for cross-version profile sync.

### Camera

A `PagedCamera` owns `translate(x, y) scale(s)` (origin `0 0`) on the wrapper element that `Panzoom.svelte` used to control. It provides:

- `adjustView(dx, dy)` — relative correction in screen space (the paged equivalent of `scrollLeft += dx`): `x -= dx; y -= dy`, then clamp.
- **Bounds clamping** (replaces `keepInBounds`): per axis, if the _currently scaled_ content ≤ viewport → lock to the alignment position **recomputed from the current scaled size** (`center → (viewport − scaled)/2`, `end → viewport − scaled`, `start → 0`; the alignment rule, not the level-1 translate, is what the mode defines — locking to the base _position_ mis-places every userZoom > 1 frame where an axis still fits, and in RTL-original pushes content past the right edge unpannably); else clamp translate so content edges never pass viewport edges. **Clamping runs after every camera mutation** — scale-only writes shrink the bounds before any correction arrives, and anchorless paths (reset) never call `adjustView` at all. Honors the existing `bounds`/`mobile` settings exactly as today (both off → free panning, no clamping). `bounds` defaults to true. Note the deliberate divergence from `keepInBounds`, which force-_centered_ fitting axes regardless of mode (silently snapping zoomOriginal's corner alignment to center on the first pan); the new lock respects the mode's alignment.
- Smooth panning via two `Animator`s (arrow keys / wheel-pan get the same eased feel as continuous mode; today's wheel-pan is an instant `moveTo`).
- Settled translates round to device pixels (preserves the #65 seam fix).
- Edge state for swipe-to-flip: `canRevealLeft/Right` (translate at its min/max), replacing `getHorizontalPanEdgeState` with identical semantics (#186 stays fixed).

### Controller: one gesture engine, two surfaces

`ContinuousZoomController` already contains everything gesture-related (wheel accumulation/stepping, pinch with re-baselining and snap-to-1, double-tap toggle, Safari gesture events, anchor capture, NaN guards, settle/`finishNow()`/`reset()` semantics). Its only scroll-specific code is the frame step's write target. Refactor:

```ts
interface ZoomSurface {
  /** False while the surface's elements aren't mounted — the frame step skips. */
  isReady(): boolean;
  /** Apply the zoomed layout for this frame (transform/spacers/alignment). */
  applyZoomLayout(zoom: number): void;
  /** Force layout so measurements see this frame's writes (no-op for transform surfaces). */
  syncLayout(): void;
  /** Relative view correction in screen space: move content left/up by (dx, dy). */
  correctView(dx: number, dy: number): void;
}
```

- **The refactor changes zero PR #225 call sites.** `ZoomControllerConfig` accepts _both_ shapes: the existing `getScrollContainer` + `applyZoomLayout` keys remain as sugar that builds a scroll surface internally (readiness = container non-null, `syncLayout` = `void scrollWidth`, `correctView` = scroll `+=`), and a new `surface` key takes precedence for paged mode. The scroll readers, the unit-test harness, and the e2e spec keep constructing exactly as today — all 18 controller tests stay green with **assertion bodies untouched** (only additive tests land). The e2e suite is not in CI, so it's run manually as a gate.
- The `Number.isFinite` guard stays in the controller (camera translates are plain numbers — no CSSOM NaN coercion behind them). New frame-step guard: an anchor rect with **zero width or height** (a detached element — `getBoundingClientRect` on removed nodes returns all zeros, which is finite) drops the anchor for the gesture instead of applying a garbage correction. This protects both surfaces and gets a controller test.
- Frame step otherwise unchanged: apply layout → sync → measure anchored page rect → `lerp2`/`zoomProgress` desired position → finite-guarded relative correction. Bounds clamping inside the camera degrades the correction gracefully at edges exactly like native scroll clamping does in continuous mode (corrections are recomputed from absolute measurements every frame, so clamp + correction cannot oscillate or accumulate error).

### Pure layout math — `paged-zoom-layout.ts`

Element-free and unit-testable, shared with the e2e suite like `zoom-layout.ts`:

- `baseTransform(mode, contentSize, viewport, rtl)` → `{ scale, x, y }`.
- `clampTranslate(translate, scaledContent, viewport, base)` → clamped translate with per-axis centering locks.
- `panEdgeState(translate, scaledContent, viewport)` → `{ canRevealLeft, canRevealRight }`.

### Pointer arbitration (paged mode never had native scroll to lean on)

A small explicit state machine in `PagedViewport`, preserving today's contracts:

- **All pointers always enter the pointer map** — `.textBox` targets only suppress _pan initiation_ (selection/Yomitan), never pinch participation (today touch pinches work over text; `beforeMouseDown` only ever affected mouse).
- **Single-finger touch pans** (correction, 2026-06-10): panzoom's `onTouch` option only gated `preventDefault` — `handleSingleFingerTouch` ran unconditionally, so production touch DID pan with one finger, coexisting with Reader's swipe-to-flip precisely because propagation wasn't stopped. Touch pan and the edge-gated (#186) swipe handlers coexist the same way here: pointer capture never retargets touch events, so the window-level swipe handlers still see them. Mouse/pen on `.textBox` defers to drag selection; touch pans everywhere (as in production).
- **Pointer capture is deferred until `DRAG_THRESHOLD` is exceeded** — capturing on pointerdown would retarget `mouseup` away from the in-wrapper gutter page-turn buttons (the primary desktop navigation) and break text-selection drags. Below the threshold the press behaves exactly as today.
- Transitions: a second pointer always upgrades pan → pinch (pan ends, pinch baselines); a pinch losing a finger down to one re-baselines as a fresh mouse-pan _only_ for mouse/pen (touch returns to idle); losing all pointers runs `pinchEnd`. Resize/reset mid-pinch clears controller state; the component re-baselines via `pinchStart` on the next move with ≥2 pointers (the established scroll-reader pattern).

### Component & integration

- `src/lib/panzoom/` is deleted along with the `panzoom` dependency (verified: no transitive consumers, no service-worker/build references) — **as the final, isolated commit** of the branch to keep modify/delete rebase conflicts legible while PR #225 is open. `toggleFullScreen` moves to `$lib/util/fullscreen.ts` (consumers: Reader, QuickActions, QuickAccess — _not_ the scroll readers); the write-only `sessionFullscreenState` store is dead and is dropped.
- `Panzoom.svelte` is replaced by `PagedViewport.svelte`: hosts the wrapper element (keeping the `data-mokuro-reader` marker), instantiates `PagedCamera` + the controller with a paged surface, and owns the pointer state machine above. Double-tap keeps the native `dblclick` plumbing but gains the `.textBox` guard (today double-clicking a word to select it also zooms — that quirk dies).
- **Wheel stays a window-level `capture: true, passive: false` listener** filtered by `closest('[data-mokuro-reader]')`, delegating zoom intent to the controller and smooth-panning otherwise — this is what guarantees ctrl+wheel never browser-zooms over reader content while body-injected extension popups (Yomitan/Migaku) keep native scrolling. The existing handler shell in Reader.svelte survives; only its delegate changes.
- A `pagedZoomStore` (or exported API object) replaces `panzoomStore` for consumers: Reader.svelte (`applyBase()` on page/mode/resize — data-driven, no double-RAF; `scrollImage` → smooth pan; edge state for swipes; double-tap), QuickActions (`zoomFitToScreen`). The `zoomDefault()` calls in `settings/volume-data.ts:597` and `ReaderSettings.svelte` are **dropped, not migrated**: Reader's `$effect` already re-applies the base on `zoomDefault`/`singlePageView`/`hasCover` changes, and removing them breaks the pre-existing settings↔panzoom import cycle instead of recreating it. (Both files' imports must be removed in the same commit as the deletion.)
- **Every displayed-content change — page turn, page-mode rotation (KeyP), spread offset (KeyO), single↔dual recomposition, resize, fullscreen — runs the suppressed finish/reset pattern** before the keyed DOM swap, then applies the new base (keepZoom converting level per the effective-scale rule). Anchor capture excludes stale trees via the zero-rect guard; `getPageElements` exposes only the current key block's pages.
- The Anki cropper and context menu are independent of the wrapper transform (cropper works in image-pixel space from OCR boxes; menu positions by `clientX/Y`) — re-verified in the real-app pass anyway.

## What intentionally changes for users

- Wheel zoom steps are **animated** and **level-quantized**, one notch = one step on all platforms (today: free-range with instant, platform-dependent steps).
- The zoom range becomes `[fit … max(3× base, 2× native)]` instead of absolute `0.1–10×`: no zooming out below fit-to-screen (the 0.1× void disappears), and the ceiling is "2× native pixels" rather than a number most of which was unusable blur.
- Double-tap cycles contextually (in ↔ out, fit when the base overflows) instead of `scale<1 → 1.5×`; double-clicking text to select it no longer zooms.
- The cursor anchor stays exactly under the cursor; near edges the bounds clamp (not anchor distortion) keeps corners reachable.
- Wheel/keyboard panning is eased instead of instant.
- Fitting axes lock to the mode's alignment instead of `keepInBounds`' force-center (zoomOriginal's corner alignment no longer snaps to center on the first pan).
- `keepZoom` preserves the effective on-screen scale across pages, spreads, resizes, and KeyZ entry (today: raw transform persistence that happened to work only within a mode).

Everything else preserves semantics: zoom modes and KeyZ rotation, `bounds`/`mobile` settings (off → free pan), single-finger swipe-to-flip with #186 edge gating, gutter-button page turns, text selection on text boxes, RTL reading-start alignment, fullscreen.

## Testing

1. **Unit:** `paged-zoom-layout` math (base transforms per mode incl. RTL, clamping, edge state); `PagedCamera` correction/clamp/animation with stubbed elements; the `ZoomSurface` refactor keeps all existing controller tests green, plus paged-surface controller tests reusing the FakeWorld pattern (anchor pinning under transform, bounds-clamped corrections, keepZoom level persistence across simulated page swaps).
2. **E2E:** extend `e2e/zoom.spec.ts` with a paged world importing the real `paged-zoom-layout` + controller + camera through Vite: wheel pin at cursor, double-tap round trip, pinch, clamping at edges (corner reachability — the thing the old blending hack faked), base re-application on simulated page swap with keepZoom.
3. **Real-app verification:** Playwright script against the actual Reader in paged mode — wheel zoom both swap settings, double-tap, CDP pinch, page flip while zoomed (keepZoom on and off), arrow-key panning, swipe edge gating unchanged, Anki cropper opens correctly on a zoomed page.

## Out of scope

- Rubber-band overscroll physics (clamping is instant, like native scroll edges).
- Inertial fling for drag panning (not present today either).
- Continuous-mode readers (untouched beyond the controller refactor, which their tests pin).
