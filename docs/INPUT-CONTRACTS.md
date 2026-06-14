# Reader Input Contracts

How user input flows through the reader, and the contracts every input
handler must respect. The modules in `src/lib/reader/input/` are the
load-bearing implementation of this document — their doc comments carry the
details; this file is the map.

## Architecture

```
                        ┌─────────────────────────────┐
                        │   Reader.svelte             │
                        │   keyboard shortcuts,       │
                        │   page-flip + overlay       │
                        │   intents, volume nav       │
                        └─────────┬───────────────────┘
              props (callbacks)   │   keyboard / $pagedZoom
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
┌───────────────┐        ┌───────────────┐        ┌───────────────────┐
│ PagedViewport │        │ VerticalScroll │       │ HorizontalScroll  │
│               │        │ Reader         │       │ Reader            │
└───────┬───────┘        └───────┬───────┘        └─────────┬─────────┘
        │     each surface owns ALL of its pointer input    │
        ▼                        ▼                          ▼
   PointerGestureTracker · TapDiscriminator · classifySwipe · MotionGate
                  (src/lib/reader/input/ — shared machinery)
```

Each reading surface owns every gesture that starts on it. Reader owns
keyboard shortcuts and supplies intent callbacks (`onPageFlip`,
`onOverlayToggle`); it never touches pointer events.

## The shared machinery

| Module               | Owns                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pointer-tracker.ts` | THE pointer state machine: pan threshold, pinch upgrade/downgrade/re-baseline, capture policy, leak-proof window-level release, `wasDrag`/`wasPinch` |
| `gesture-target.ts`  | Element-role classification (`textbox` / `interactive` / `page`) and the keyboard-ignore guard                                                       |
| `tap.ts`             | Tap vs double-tap timing (300 ms), deferred vs immediate commit, text-box dismissal swallowing                                                       |
| `swipe.ts`           | Pure swipe-to-flip classification (edge gating #186, pinch suppression, thresholds)                                                                  |
| `motion-gate.ts`     | The interrupt contract: what must stop before new motion starts (`beforeZoom` / `beforeManualPan` / `beforeAnimatedScroll` / `beforeNav`)            |

Surfaces hold only **policy** (config objects) and **actuation** (scroll
writes, camera moves); classification and lifecycle live in the shared
modules.

## Contracts that must not break

### `.textBox` is an input-routing protocol, not styling

OCR text boxes own their gestures (see `gesture-target.ts`):

- **Double-tap on a text box is the AnkiConnect card-capture gesture.**
  TextBoxes.svelte handles it and `stopPropagation()`s; surfaces must also
  filter taps by role so pointer-based detection never zooms from a text
  box. Breaking this breaks users' Anki mining flow.
- Mouse/pen drags on a text box are **text selection** (Yomitan/Migaku
  scanning) — never a pan. Single-finger **touch** is the exception: it
  pans everywhere, because touch has no drag-selection gesture.
- After interacting with a text box, the next tap outside is a
  **dismissal** — it must not toggle the overlay
  (`TapDiscriminator.noteTextBoxInteraction`).

### Pinch always wins

Two pointers upgrade to pinch no matter where they pressed (text box
included). Pointer-set changes re-baseline; dropping to one pointer
ends the pinch. The survivor continues as a pan only on surfaces with
incremental deltas (`pinchSurvivorPans` — paged); absolute-baseline
surfaces (scroll readers) require a fresh press.

### Releases are window-level

`pointerup`/`pointercancel` listen on the window, always. A release landing
on an overlay or outside the browser must still clean the pointer map —
phantom entries get misread as pinches (this was a live production bug).

### One gesture at a time (MotionGate)

Every handler that starts motion opens with the gate call matching its
intent. Never call `finishNow`/`stop`/`stopPan` combinations inline — add
to the gate if a new intent appears.

### Swipe-to-flip is edge-gated (#186)

A touch swipe flips the page only if no pannable content was hidden in the
swipe's direction **when the gesture began**. Gestures that pinched never
flip (`tracker.wasPinch`).

### Tap timing differs by surface family — deliberately

- Scroll readers: **deferred** — overlay toggles 300 ms late so a
  double-tap (zoom) never flashes it.
- Paged: **immediate** — overlay toggles instantly on every tap; a
  double-tap toggles twice (net zero) and zooms, reproducing the native
  click/click/dblclick sequence paged mode has always had.

### Settle reasons gate progress reporting

Zoom settles carry a `SettleReason` (`zoom-controller.ts`): only
`'gesture'`/`'interrupt'` settles report reading progress; `'nav'` and
`'reset'` settles are superseded by whatever caused them.

## Per-surface policy matrix

| Policy         | PagedViewport                     | Scroll readers                          |
| -------------- | --------------------------------- | --------------------------------------- |
| Capture        | deferred (at drag threshold)      | immediate (at pan press)                |
| Pan deltas     | incremental → `camera.adjustView` | totals → absolute scroll from baselines |
| Text-box pan   | suppressed for mouse/pen only     | suppressed for all pointer types        |
| Pinch survivor | keeps panning                     | ignored until fresh press               |
| Tap commit     | immediate                         | deferred (300 ms)                       |
| Swipe-to-flip  | yes (mobile setting, edge-gated)  | no (panning is the scroll)              |
| Wheel          | zoom or camera glide              | zoom or (native/strip) scroll           |

## Testing

Unit tests cover the shared machinery (`src/lib/reader/input/*.test.ts`,
`src/lib/reader/page-nav.test.ts`); Playwright e2e covers zoom geometry
(`e2e/zoom.spec.ts`). When changing gesture behavior, test manually with a
Japanese-learning extension (Yomitan/Migaku) enabled and verify the Anki
double-tap flow still captures.
