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

### The edit overlay owns its blocks (`.editBlock`, role 'editor')

In OCR edit mode (`EditOverlay.svelte`) every block renders as an
`.editBlock` with `[data-edit-handle]` resize handles. The overlay
`setPointerCapture`s its own presses and lets them **bubble** — it never
stops propagation. The surface's tracker therefore adds an editor press to
its pointer map like any other, but classifies the role first and **never
pans, tap-toggles, or zooms from role 'editor' — for any pointer type**
(unlike `.textBox`, where touch still pans). The release bubbles too, so the
map drains (a swallowed `pointerup` would leave a phantom pointer behind).

The page background keeps its read-mode gestures, so the user can pan and
pinch while editing; with the "draw box" tool armed the overlay marks its
root `[data-edit-draw]`, which classifies as 'editor', and owns the next
background drag instead.

Pinch still wins everywhere, and bubbling is why: a second pointer makes two
in the surface's map, so the surface pinches — and the editor **yields**. A
block/line drag or a draw in flight watches the window for a second
`pointerdown`, cancels itself, releases its capture, and rolls back whatever
it had moved (`EditSession.cancelGesture` — a cancel, not an undo, so the
aborted drag is never left on the redo stack). The press that caused the
yield never starts a drag or a draw of its own.

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

### Wheel granularity decides the zoom's shape (#259)

A wheel stream is classified as **fine** (trackpad, precision wheel,
synthetic pinch) or **notched** by `WheelStreamClassifier` — once per event,
at the top of each surface's `handleWheel`, shared by the intent check and
the zoom so the stateful classifier is never asked twice.

- **Fine streams zoom continuously** at the cursor, through the same
  anchored path a pinch uses. Stepping a ladder on a device that reports
  every millimetre of travel is what #259 reported: nothing, nothing,
  nothing, lurch.
- **Notched streams keep the level ladder** — one notch is one deliberate
  step, and mouse users are untouched.
- **A fine ctrl/meta+wheel is a pinch, so it always zooms**, whatever
  `swapWheelBehavior` says. Chrome and Firefox deliver trackpad pinch as a
  synthetic ctrl+wheel; only Safari has real pinch events. Without this a
  Mac user with the swap on has no working pinch at all. A _notched_
  ctrl+wheel is a genuine keyboard chord and keeps the swap semantics.
- Classification is **sticky per stream** and only ever upgrades to fine:
  trackpad momentum reports large round deltas indistinguishable from
  notches, while a mouse never reports the small ones. Erring toward fine
  costs a precision-wheel owner a smooth zoom, which is what they wanted;
  erring the other way is the bug.

Wheel zoom has no release event, so a fine stream settles on an idle
timeout (`WHEEL_ZOOM_SETTLE_MS`) — that settle is what clamps the paged
camera into bounds and reports reading progress.

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

### Keyboard: one registry, one resolver (#55)

Every shortcut is an entry in the action registry (`src/lib/keys/actions.ts`)
and resolves through `dispatchKey` (`src/lib/keys/dispatch.ts`) against the
active profile's keymap (`Settings.keyBindings`, sparse — `{}` is the
defaults; `src/lib/keys/keymap.ts`). Nothing else compares keys by hand at a
shortcut site (`src/lib/keys/source-lint.test.ts` holds the line).

- **Reader.svelte is the reader's only keyboard listener**, continuous scroll
  included. Its guard prelude (re-read prompt open → layer UI →
  `keyboardShouldIgnore`) runs first; then it dispatches with scopes
  `edit → reader → app` while editing, else `reader → app`, and the layout
  (`paged` / `vertical` / `horizontal`) as the mode. In continuous mode the
  page and scroll actions call the mounted scroll reader's `keyAction(id)`;
  the scroll readers have no key listener of their own. A modal that must
  stop page keys therefore needs no key list: Reader returns early.
- **Exact modifiers.** A chord (`Ctrl+Alt+Shift+Meta+<code>`) matches only the
  identical modifier set, so a Shift held for dictionary scanning is inert
  unless the user binds a Shift chord.
- **Position, not character**: `KeyboardEvent.code`, with `e.key` only for an
  empty code and for Numpad keys with NumLock off.
- **Dropped before matching**: bare modifiers, IME composition
  (`isComposing` / keyCode 229), and events already `defaultPrevented` — an
  extension or another handler took the key.
- `preventDefault()` only on a match; a handler returning `false` declines and
  the key falls through (`edit.delete` with nothing selected).
- Toggles, Back and library actions ignore auto-repeat.
- **One Back owner per view**: Reader in the reader, `+layout.svelte`
  elsewhere (never from a field, the settings panel, a popover, or under an
  open dialog). Library hover keys are dispatched by the hovered card.
- Element-level handlers stay outside the keymap: text fields, the OCR line
  editor, the page-number input, modal Escape captures, the layer picker and
  name prompt, the spine shelf's arrows.

### Wheel page turns are edge-gated per stream (#55)

With "Mouse wheel: Turns pages" (`wheelTurnsPages`, paged only), a plain
vertical wheel turns pages in reading order (`src/lib/reader/input/wheel-page.ts`).
Like a swipe (#186), a stream that could still pan in its direction **when it
began** pans for its whole length; a stream ends after the
`WHEEL_STREAM_IDLE_MS` gap, on a direction flip, or — notched — on a turn, so
the next notch gates on the NEW page's edges (a spin onto a page taller than
the viewport pans it rather than skipping it). A notched wheel turns one page
per notch; a fine stream one page per stream (its momentum never re-gates).
Only a wheel RUN's first turn may leave the volume (`WheelRun`: events with no
idle gap, shared across the remount a volume change does); a run that left is
swallowed until idle, so a flick's leftover notches neither overshoot the
book's end nor page the next volume. Ctrl/meta+wheel still zooms (a fine one
is a pinch, #259), shift+wheel and a horizontal wheel still pan, and the gap
chord is untouched. A turn opens with the paged gate's `beforeNav`. "Turns
pages" also beats the swap in the continuous readers (`wheelSwapsZoom`): a
profile with both flags on (an older client toggled the swap) never zooms on a
plain wheel.

## Per-surface policy matrix

| Policy         | PagedViewport                         | Scroll readers                          |
| -------------- | ------------------------------------- | --------------------------------------- |
| Capture        | deferred (at drag threshold)          | immediate (at pan press)                |
| Pan deltas     | incremental → `camera.adjustView`     | totals → absolute scroll from baselines |
| Text-box pan   | suppressed for mouse/pen only         | suppressed for all pointer types        |
| Pinch survivor | keeps panning                         | ignored until fresh press               |
| Tap commit     | immediate                             | deferred (300 ms)                       |
| Swipe-to-flip  | yes (mobile setting, edge-gated)      | no (panning is the scroll)              |
| Wheel          | zoom, gap, camera glide, or page turn | zoom, gap, or (native/strip) scroll     |
| Wheel zoom     | continuous (fine) / ladder (notched)  | continuous (fine) / ladder (notched)    |

Ctrl/meta+shift+wheel is the page-gap adjustment chord on every surface
(paged writes `pagedGap`; scroll readers write `scrollGap` and sync
`pageDividers`), checked before the zoom intent. Binding rule: wheel combos
with a native browser meaning keep that meaning tuned for the reader
(ctrl+wheel zooms, shift+wheel stays a horizontal pan); the gap chord is
deliberately one no browser binds.

## Testing

Unit tests cover the shared machinery (`src/lib/reader/input/*.test.ts`,
`src/lib/reader/page-nav.test.ts`); Playwright e2e covers zoom geometry
(`e2e/zoom.spec.ts`). When changing gesture behavior, test manually with a
Japanese-learning extension (Yomitan/Migaku) enabled and verify the Anki
double-tap flow still captures.
