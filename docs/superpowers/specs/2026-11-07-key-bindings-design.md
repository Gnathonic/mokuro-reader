# Key bindings: rebind or unbind every shortcut (#55)

Status: proposed design, 2026-11-07. Read against `origin/develop` b905a92a.
Sections 1-15 are built (draft PR #370). Section 17, added 2026-11-09, extends
the work to every control, with icons and a registry-driven quick menu.
Mockup: `2026-11-07-key-bindings-mockup.html` (same folder).
Target list for section 17: `2026-11-08-binding-targets.html` (same folder).

## 1. Problem

Every shortcut is hard-coded. Issue #55: a user on a 60% keyboard (no arrow
keys) wants A/D page turns, and wants the mouse wheel to turn pages the way
YACReader does. Another user maps a/d to Left/Right with AutoHotkey. The owner
wants designs for rebinding or unbinding EVERY key we map ("programmable
shortcuts for everything"). Closed #202 asked for a key to show/hide the
reading timer; pause stays out (the timer is becoming automatic).

Constraints:

- Dictionary extensions (Yomitan, Migaku, 10ten, Jiten) scan with Shift or
  Alt held and mutate the DOM.
- Many readers have no keyboard (phones, tablets). Some have no arrows.
- Settings live in per-user profiles that sync through `profiles.json`.
- Everything must work on defaults. A user who never opens the new screen
  sees no change beyond the small fixes in section 9.

## 2. Goals and non-goals

Goals:

- Every action that has a key today can be rebound, given extra keys, or
  unbound. Unbound is a stored state, distinct from "default".
- New actions can ship unbound (#202 timer).
- One action registry and one resolver replace the hand-written key
  switches. UI key hints come from the same table, so they never go stale.
- #55 is solved in two key presses (add A, add D), plus an optional wheel
  setting (section 8).

Non-goals (v1):

- Key sequences (`g g`), gamepads, mouse buttons as triggers.
- Rebinding pointer gestures: tap, double-tap (Anki capture), drag, pinch,
  swipe, edge zones, ctrl+wheel zoom, the ctrl+shift+wheel gap chord, the
  catalog's Shift/Alt+wheel and Shift+right-click spine gestures.
- Keys owned by a focused widget: Enter/Escape/Backspace in the OCR line
  editor and text fields, Escape that closes a modal, the spine shelf's
  arrows, IME composition. These are listed read-only.

## 3. What the code does today (verified)

- `Reader.svelte` `handleShortcuts` (~290-485) is one `switch` on
  `event.code`. Guard order: re-read prompt open → layer UI
  (`layerUiKeyAction`) → `keyboardShouldIgnore(target)` → edit-session keys
  → modifier filter → `preventDefault` for scroll keys → continuous-mode
  early return → switch.
- The modifier filter covers letters, arrows, Home and End only. Space,
  PageUp, PageDown and Escape fire with any modifier: Shift+Space turns
  FORWARD (browsers use it to scroll up), and a reader holding Shift to scan
  who presses Space turns the page.
- `VerticalScrollReader` and `HorizontalScrollReader` each add a window
  `keydown` on `e.key` with NO modifier filter. Reader returns early for
  nav keys in continuous mode so they own them. Both listeners see every
  event.
- `RereadPromptModal` blocks nav keys for the scroll readers with a
  capture-phase `BLOCKED_NAV_KEYS` set, matched on `e.key`. Once a key is
  rebindable this list is wrong: a rebound A would page under the modal in
  continuous mode.
- Catalog shortcuts match `e.key` (`'e'`, `'Delete'`); the reader matches
  `event.code`. `VolumeItem`'s `e`/`c` switch has no modifier check, so
  Ctrl+C on a hovered volume opens the cover picker and blocks copy.
  `VolumeItem` `E` opens the VOLUME editor (`promptVolumeEditor`), not the
  OCR editor.
- One Escape press reaches two `navigateBack()` callers: `Reader.svelte`
  and `+layout.svelte` in the reader, `+layout.svelte` and
  `SeriesView.svelte` on a series page. `navigateBack()` reads
  `currentView`, and `navigate()` sets it synchronously. Whether the second
  caller climbs a second level depends on listener order and Svelte's
  teardown timing. Reasoned from code, not observed. SeriesView's listener
  has no field guard at all.
- `settings.showTimer` exists (Desktop default on, Mobile off). #202 is a
  toggle of it, like `T` toggles `alwaysShowOCR`.
- The settings drawer is a Flowbite `Drawer` with `id="settings"` holding an
  `Accordion`. `keyboardShouldIgnore` already ignores keys inside it.
- Profiles merge whole-profile, newest `lastUpdated` wins
  (`unified-sync-service.ts` `mergeProfiles`). `migrateProfiles` and
  `updateSetting` spread the stored profile, so unknown fields survive an
  older client's write-back.
- Hard-coded key hints: `ReaderSettings` (V, P, M, C, L, O), `ReaderToggles`
  (T, E), `ReaderSelects` (Z), `ScheduledFilterCard` (N, I, G), `QuickAccess`
  (F, Esc), `EditToolbar` ("Next OCR layer (L)"), a Reader snackbar ("press E
  to edit your own copy"), a VolumeItem snackbar ("shift+Delete deletes the
  cloud copy").

## 4. Behaviour

- Settings gets a new accordion item, **Keyboard shortcuts**, after Reader.
  It lists every action, grouped, with its keys as chips.
- `+ Add` turns into "Press a key… (Esc cancels)". The next non-modifier key
  is recorded with the modifiers held. Click a chip's `×` to remove it.
  Removing every chip leaves the action **Not set**.
- A row that differs from its default shows **Reset**. The section ends with
  **Reset all shortcuts** (confirm dialog).
- Escape is locked on Back and on the edit-mode step back (lock icon, no
  `×`). Extra keys may be added to Back.
- Bindings follow the profile. A line at the top names it, with **Copy to
  all profiles**.
- Every key hint in the app reads the live binding. An unbound action shows
  no hint.
- #55: add A to "Page left", D to "Page right". Arrows keep working.

## 5. Actions and today's defaults

Ids are permanent (they are stored). "Live in" decides when an action can
fire and which bindings can conflict. Reader modes: Paged, Vertical,
Horizontal (continuous `auto` resolves to one of the two, as
`effectiveScrollMode` does today). Repeat = fires on key auto-repeat.

| Group     | Id                            | Label                       | Live in              | Default                                    | Repeat |
| --------- | ----------------------------- | --------------------------- | -------------------- | ------------------------------------------ | ------ |
| Pages     | `reader.page-left`            | Page left                   | Paged, Horizontal    | ←                                          | yes    |
| Pages     | `reader.page-right`           | Page right                  | Paged, Horizontal    | →                                          | yes    |
| Pages     | `reader.page-prev`            | Previous page               | all modes            | PageUp                                     | yes    |
| Pages     | `reader.page-next`            | Next page                   | all modes            | PageDown, Space                            | yes    |
| Pages     | `reader.page-first`           | First page                  | all modes            | Home                                       | no     |
| Pages     | `reader.page-last`            | Last page                   | all modes            | End                                        | no     |
| Pages     | `reader.volume-prev`          | Previous volume             | all modes            | — (new)                                    | no     |
| Pages     | `reader.volume-next`          | Next volume                 | all modes            | — (new)                                    | no     |
| Scrolling | `reader.scroll-up`            | Scroll up                   | all modes            | ↑                                          | yes    |
| Scrolling | `reader.scroll-down`          | Scroll down                 | all modes            | ↓                                          | yes    |
| Scrolling | `reader.scroll-left`          | Scroll left                 | Vertical             | ←                                          | yes    |
| Scrolling | `reader.scroll-right`         | Scroll right                | Vertical             | →                                          | yes    |
| View      | `reader.fullscreen`           | Fullscreen                  | all modes            | F                                          | no     |
| View      | `reader.zoom-mode`            | Cycle zoom mode             | all modes            | Z                                          | no     |
| View      | `reader.zoom-fit`             | Zoom to fit                 | Paged                | — (new; QuickActions has it)               | no     |
| View      | `reader.page-mode`            | Cycle page mode/scroll mode | all modes            | P                                          | no     |
| View      | `reader.continuous`           | Continuous scroll           | all modes            | V                                          | no     |
| View      | `reader.offset-spreads`       | Offset spreads              | all modes            | O                                          | no     |
| View      | `reader.cover`                | First page is cover         | all modes            | C                                          | no     |
| View      | `reader.dividers`             | Page dividers               | Vertical, Horizontal | M                                          | no     |
| View      | `reader.controls`             | Show/hide reader controls   | all modes            | — (new; what a tap does)                   | no     |
| View      | `reader.timer`                | Show/hide reading timer     | all modes            | — (new, #202; toggles `showTimer`)         | no     |
| OCR       | `reader.ocr-always`           | Always show OCR             | all modes            | T                                          | no     |
| OCR       | `reader.ocr-layer`            | Next OCR layer              | all modes            | L                                          | no     |
| OCR       | `reader.edit-mode`            | Edit OCR text               | all modes            | E                                          | no     |
| Filters   | `reader.invert`               | Invert colors               | all modes            | I                                          | no     |
| Filters   | `reader.night`                | Night mode                  | all modes            | N                                          | no     |
| Filters   | `reader.grayscale`            | Black & white               | all modes            | G                                          | no     |
| Edit mode | `edit.undo`                   | Undo                        | editing              | Ctrl+Z, Meta+Z                             | yes    |
| Edit mode | `edit.redo`                   | Redo                        | editing              | Ctrl+Shift+Z, Meta+Shift+Z, Ctrl+Y, Meta+Y | yes    |
| Edit mode | `edit.delete`                 | Delete selected boxes       | editing              | Delete, Backspace                          | yes    |
| Edit mode | `edit.back`                   | Step back                   | editing              | Esc (locked)                               | no     |
| Library   | `library.series-edit`         | Edit series                 | series card hovered  | E                                          | no     |
| Library   | `library.series-remove`       | Remove series               | series card hovered  | Delete                                     | no     |
| Library   | `library.volume-edit`         | Edit volume                 | volume hovered       | E                                          | no     |
| Library   | `library.volume-cover`        | Change cover                | volume hovered       | C                                          | no     |
| Library   | `library.volume-remove`       | Remove from device          | volume hovered       | Delete                                     | no     |
| Library   | `library.volume-delete-cloud` | Delete cloud copy           | volume hovered       | Shift+Delete                               | no     |
| General   | `app.back`                    | Back                        | everywhere           | Esc (locked) + extras                      | no     |

Notes:

- Page left/right follow the page direction: in a right-to-left book, left
  is the next page. Previous/next follow reading order. Both pairs exist
  today (arrows vs PageUp/PageDown); the row text says which is which.
- Arrows mean different things per mode today. Live-in sets keep that
  exactly: in Vertical, ← is `scroll-left` because `page-left` is not live
  there. A key bound to Page left does nothing in Vertical.
- Scroll up/down keep each mode's behaviour: Paged pans a zoomed page 75% of
  the screen; Vertical scrolls half a screen, or turns the page at
  fit-to-screen; Horizontal scrolls half a screen. Horizontal's
  Previous/Next step a spread (2) except at the cover, as today.
- `edit.delete` runs only with a selection. Otherwise the key falls through
  to lower scopes, as today.
- 39 actions; 5 new, all unbound. "Open settings" and zoom in/out steps need
  new plumbing and are left for later.

## 6. Chords

A chord is one string: modifiers in a fixed order, then the key.
`Ctrl+Alt+Shift+Meta+<code>`. Examples: `KeyA`, `Shift+Space`,
`Ctrl+Shift+KeyZ`, `ArrowLeft`.

- **Position, not character.** The key is `KeyboardEvent.code`, as the
  reader does today. A Russian or kana layout still triggers letter
  shortcuts; WASD stays where the fingers are on AZERTY. Fallbacks: empty
  `code` uses `e.key`; a Numpad key with NumLock off (`Numpad4` +
  `key: 'ArrowLeft'`) counts as the nav key it sends, which keeps the scroll
  readers' current `e.key` behaviour.
- **Exact modifiers.** A chord fires only with exactly its modifiers. `KeyA`
  does not fire on Shift+A. This replaces the partial filter, and makes a
  Shift held for scanning inert unless the user binds a Shift chord.
- **Labels are per device, never stored.** `navigator.keyboard.getLayoutMap()`
  (Chromium) gives the user's glyph. Else a label learned at capture time
  (`e.key`, kept in localStorage `keyLabels`). Else the US name. Arrows show
  as ← → ↑ ↓; Meta shows as Cmd on Apple platforms.
- **Dropped before matching:** bare modifier keys, `isComposing` or
  `keyCode === 229`, and events already `defaultPrevented` (an extension or
  another handler took the key).

## 7. Storage and sync

```ts
// Settings (settings.ts), default {}
keyBindings: Record<string /* action id */, string[] /* chords */>;
```

- Absent id = registry defaults. `[]` = unbound. Non-empty = replaces the
  defaults for that action. Locked chords (Esc) are implicit, never stored;
  the stored list holds the extras.
- Defaults live in code, so a changed default reaches every user who has not
  customised that action.
- Profile field, synced in `profiles.json` like every setting. One edit is
  one `updateSetting('keyBindings', next)`, which touches `lastUpdated`.
  Same whole-profile newest-wins merge as everything else.
- No per-device override. `currentProfile` is already per device, so "other
  keys on this device" is "another profile on this device". Added keys are
  harmless on a keyboard that has arrows, and inert on a touch device.
- **Copy to all profiles** writes the current map into every live profile.
- `migrateProfiles` checks shape only: a non-object becomes `{}`, a non-array
  entry is dropped, a list is capped at 8 strings of ≤ 40 chars. Unknown ids
  and unparseable chords are KEPT, so an older client's write-back cannot
  erase a newer client's bindings. `compileKeymap` ignores what it cannot
  parse or does not know.
- Built-in Desktop and Mobile profiles start with `{}`. No migration. No
  Dexie or file version change.

## 8. Wheel turns pages (phase 3)

The #55 user's first ask. It is a wheel mode, not a key binding.

- The "Swap mouse wheel scroll/zoom" toggle becomes a select, **Mouse wheel
  (paged)**: Pans the page (Ctrl+wheel zooms) · Zooms (Ctrl+wheel pans) ·
  Turns pages (Ctrl+wheel zooms).
- Stored as today's `swapWheelBehavior` plus a new `wheelTurnsPages: boolean`
  (default false). Older clients ignore the new field and pan.
  `wheelTurnsPages` wins if both are on.
- Plain vertical wheel in paged mode: down = next page, up = previous page
  (reading order). Horizontal wheel still pans. The gap chord and pinch are
  unchanged; a fine ctrl+wheel always zooms (#259).
- Edge-gated per stream, like swipe (#186): if the zoomed page could still
  pan in the wheel's direction when the stream began, the whole stream pans.
  A stream ends after the existing `WheelAccumulator` idle gap (250 ms).
- Rate from `WheelStreamClassifier`: notched wheel = one page per notch; a
  trackpad stream = one page per stream.
- Continuous modes are untouched: the wheel already moves through pages.

## 9. Behaviour changes at defaults

Each is a bug-class fix. Each gets a test.

1. Space, PageUp, PageDown and Escape no longer fire with extra modifiers.
   Shift+Space stops turning forward.
2. The continuous readers apply the same rule. Shift/Ctrl/Alt+arrows stop
   scrolling there; Alt+← reaches the browser again.
3. Edit mode: Ctrl+Alt+Z, Shift+Delete and similar no longer undo or delete.
4. Ctrl/Meta/Alt+E and +C no longer open the volume editor or cover picker
   on a hovered volume. Ctrl+C copies again.
5. Library keys match position like the reader (CapsLock+E now works; on
   Dvorak the key moves to the E position).
6. Toggles, Back and library actions ignore auto-repeat. Holding F no longer
   flickers fullscreen; holding Esc leaves one level, not two.
7. Back has one owner per view. SeriesView's listener goes; Escape in a
   field, the settings panel or a popover no longer leaves the page.
8. Library actions never fire while a dialog is open (today only Delete
   checks).
9. Keys an extension already handled (`defaultPrevented`) are left alone.

## 10. Conflicts and refusals

Two actions conflict when they share a chord, share a scope (reader, edit,
library-series, library-volume) and, in the reader, share a live mode. The
same key in different scopes is fine (E is Edit OCR text in the reader and
Edit series in the library).

- At capture, a conflict shows inline: "↓ is already Scroll down.
  [Replace] [Cancel]". Replace removes it from the other action, which may
  become Not set. No "keep both": two actions on one chord is ambiguous.
- Cross-scope overlap is a note, not a prompt: "In edit mode, Backspace
  deletes the selection first."
- A synced or hand-edited map can still hold a conflict. It stays as stored;
  the first action in registry order runs; both rows show an amber icon.
- Defaults never conflict (lint test).
- Refused at capture: bare modifiers, CapsLock/NumLock/ScrollLock,
  ContextMenu, Tab and Shift+Tab (focus), Escape (cancels capture), and
  chords browsers keep for themselves (Ctrl/Meta + W, T, N, Q, Tab,
  PageUp, PageDown; F11; Alt+F4). The list lives in `reserved.ts` and is
  tuned by testing what Chrome, Firefox and Safari deliver.
- Warned, allowed (amber line): chords with Shift or Alt ("Dictionary
  pop-ups often scan while Shift or Alt is held"), and chords that take over
  a browser action (Ctrl/Meta + C, V, X, A, F, P, S, R, L; F5; Alt+← →).
- Max 4 chords per action in the UI.

## 11. Settings UI

See the mockup. Layout A is recommended; B is the alternative.

**A. Section in the settings drawer.** A new `AccordionItem`, "Keyboard
shortcuts". Rows stack: label and Reset on one line, a short description
with live-in tags, then chips. Works at the drawer's narrowest width
(full width on phones, a quarter on desktop). Inherits the `#settings` key
guard, so capture and filtering never trigger reader keys.

**B. Modal opened from the drawer.** One line per row (label, keys, reset)
with room for descriptions. Needs its own key guard (`data-popover`), the
modal `relative z-10` button rule, and one more click to reach.

Both:

- Top: "Saved in profile Desktop · Copy to all profiles", and a filter box
  (by action name).
- On a coarse pointer, one line: "Shortcuts need a hardware keyboard."
- Groups in table order. New unbound actions sit in their group with a muted
  "Not set" chip, so #202's timer is found under View.
- A modified row gets an accent bar and Reset.
- Capture: a window capture-phase listener installed only while capturing.
  It `stopImmediatePropagation()`s and `preventDefault()`s every key, waits
  for a non-modifier key, cancels on Escape, blur or a click elsewhere, and
  lets Tab move focus (which ends capture). `aria-live` announces "Press a
  key. Escape cancels." and then the result.
- A collapsed "Not changeable" group lists the fixed keys and gestures from
  section 2, so "every key" can be checked.
- No help sheet: the section is the sheet, and every hint in the app reads
  the live map.

## 12. Architecture

One registry, one resolver. Listener sites stay where their state lives,
except that the reader gets ONE keyboard owner.

New, `src/lib/keys/`:

- `actions.ts` — the registry as data: id, label, description, group,
  scope, live modes, default chords, repeat, locked. Exports id unions per
  scope (`ReaderActionId`, …).
- `chord.ts` — `chordFromEvent`, `parseChord`, `formatChord` (labels),
  canonical order, Numpad and empty-code fallbacks.
- `keymap.ts` — `compileKeymap(keyBindings)` →
  `Map<scope, Map<chord, ActionId[]>>` plus `chordsFor(id)`. Compiled at
  module level from one `settings` subscription, recompiled only when the
  `keyBindings` reference changes. No per-component derived store: cards
  render N times (CLAUDE.md, Svelte 5 performance). `keyHint(id)` for the UI.
- `dispatch.ts` — `dispatchKey(e, { scopes, mode }, handlers)`: drop rules
  (section 6) → resolve candidates in scope order → repeat rule → run the
  first handler that does not return `false` → `preventDefault()` only on a
  match.
- `reserved.ts`, `capture.ts` (pure: validate a captured chord → ok / refused
  / warning / conflict), `key-labels.ts` (layout map + learned labels).

Changed:

- `Reader.svelte` — `handleShortcuts` keeps its guard prelude (re-read
  prompt, layer UI, `keyboardShouldIgnore`), then calls `dispatchKey` with
  scopes `['edit', 'reader', 'app']` while editing, else
  `['reader', 'app']`, and mode from `continuousScroll` +
  `effectiveScrollMode`. The handler map is
  `satisfies Record<ReaderActionId | EditActionId | 'app.back', Handler>`,
  so a registry entry without a handler fails type-check. In continuous
  mode, page and scroll handlers call the mounted scroll reader's exported
  `keyAction(id)` (via `bind:this`).
- `VerticalScrollReader.svelte`, `HorizontalScrollReader.svelte` — the
  window `keydown` listeners go. Their switch bodies become
  `export function keyAction(id): boolean`, behaviour unchanged.
- `RereadPromptModal.svelte` — `BLOCKED_NAV_KEYS` goes: Reader returns early
  while the prompt is open, and it is now the only reader listener. Its
  Escape capture stays.
- `CatalogItem.svelte`, `CatalogListItem.svelte`, `VolumeItem.svelte` — the
  hover `$effect` stays; the handler becomes `dispatchKey` with scope
  `library.series` or `library.volume`, guarded by `keyboardShouldIgnore`
  and `anyModalOpen()`. `series-editor-shortcut.ts` and `delete-shortcut.ts`
  shrink to those guards. Shift/Alt `modifierState` tracking for the wheel
  hints is not a shortcut and stays.
- `+layout.svelte` — Escape becomes `app.back` through `dispatchKey`, with
  `keyboardShouldIgnore`, skipped when the view is the reader (Reader owns
  it). On the catalog the handler returns `false`, so no `preventDefault`,
  as today.
- `SeriesView.svelte` — its Escape listener is deleted (the layout covers
  the series view).
- `settings.ts` — `keyBindings` (default `{}`), `wheelTurnsPages` (phase 3),
  shape check in `migrateProfiles`, `copyKeyBindingsToAllProfiles()`.
- Hint sites from section 3 read `keyHint(id)`.
- New `src/lib/components/Settings/Keys/`: `KeyboardShortcuts.svelte`
  (accordion item), `KeyActionRow.svelte`, `KeyChip.svelte`,
  `KeyCapture.svelte`.
- Phase 3: `PagedViewport.svelte` wheel path; a pure
  `src/lib/reader/input/wheel-page.ts` (stream state, edge gate, steps); a
  vertical counterpart of `panEdgeState`; `ReaderToggles.svelte` select.
- `docs/INPUT-CONTRACTS.md` — a Keyboard section: every shortcut resolves
  through the keymap; Reader is the reader's only keyboard listener; exact
  modifiers; `defaultPrevented` is respected; element-level editor handlers
  stay outside. Wheel page turns are edge-gated per stream.
- `CLAUDE.md` — "Catalog card shortcuts" points at the registry.

Untouched: element-level handlers (line editor, page-number input, rename
and title fields, goals, deadline, link field, image-only review), modal
Escape captures, the layer picker and name prompt guards, the spine shelf
arrows, `user-gesture.ts`.

## 13. Phases

1. **Registry, resolver, one owner. No UI.** Defaults identical except
   section 9. Golden test + e2e pins first, then the refactor.
2. **Settings section and new actions.** List, capture, conflicts, reset,
   copy to all profiles, labels, live hints. Wire the five new unbound
   actions (#202 timer first).
3. **Wheel turns pages.** The select and the paged wheel path.

Each phase ships alone; no flag, since `{}` means today's keys.

## 14. Tests

Unit (vitest):

- `chord.test.ts` — canonical order; code vs empty-code fallback; Numpad
  with NumLock off; bare modifiers, `isComposing`, 229 and
  `defaultPrevented` drop; labels from a fake layout map, learned labels,
  US fallback.
- `keymap.test.ts` — absent = default, `[]` = unbound, list replaces;
  locked Esc always present; unknown ids and bad chords kept in storage,
  ignored when compiling; scope + mode conflict detection; registry-order
  tie-break.
- `actions.test.ts` — unique ids, labels, groups; no default conflicts;
  every default chord parses and is not reserved.
- `defaults-golden.test.ts` — one row per inventory entry (paged, vertical,
  horizontal, edit, library, app): event → action under `{}`. A second table
  lists every section 9 change and asserts its new result.
- `capture.test.ts` — refused, warned, conflict, cross-scope note, max 4.
- `dispatch.test.ts` — scope order and fall-through (`edit.delete` with no
  selection), repeat rule, `preventDefault` only on match.
- `migrateProfiles` — shape check; an older-client round trip keeps unknown
  ids; copy to all profiles touches every `lastUpdated`.
- Source lint — no `e.key ===`, `event.code ===` or `switch (e.key|code)`
  in the migrated files outside an allowlist of element-level handlers.
  This is what keeps "every key" true.
- `wheel-page.test.ts` (phase 3) — notched stream = one page per notch;
  trackpad stream with inertia = one page; edge gate at stream start;
  direction flip starts a stream.

Component (testing-library): the settings section renders from the registry;
add, remove, reset row, reset all; capture swallows the key, Esc cancels,
Tab passes; conflict Replace/Cancel; Not set display; touch note.

E2E (Playwright via `/verify`, synthetic volume, dedicated `E2E_PORT`):

- Pins before phase 1: Esc from the reader lands on the series page in one
  press; Esc in edit mode clears the selection and stays; arrows, Space,
  PageUp/Down, Home/End per mode, RTL and LTR.
- After: bind A to Page right, press A, the page turns; reload, still bound;
  switch profile, gone. Unbind F; F does nothing. Shift+Space does nothing.
  Continuous vertical: PageDown pages, ← scrolls. Re-read prompt open + a
  rebound key does not page in continuous mode. Ctrl+C on a hovered volume
  is not swallowed.
- Phase 3: one wheel notch = one page; a zoomed page pans to its edge
  before a new stream turns it.

Manual: Yomitan and 10ten with a bound letter (does the extension mark the
event handled?); Dvorak and AZERTY labels in Chrome and Firefox; an iPad
with a hardware keyboard.

## 15. Alternatives considered

- **Device-local keymap override** (drafts 1, 3). Rejected: the profile
  choice is already per device; a second store, a toggle and a precedence
  rule for little gain.
- **User-level synced keymap outside profiles** (like the timer's
  `tracking` section). Rejected: a second settings home that Reset and
  profile copy would not cover. "Copy to all profiles" covers multi-profile
  users.
- **Wheel and mouse buttons as keymap triggers** (draft 2). Rejected: the
  wheel needs accumulation, edge gating and fine/coarse handling that a
  chord cannot express. One three-way select covers #55. Back/forward mouse
  buttons navigate history in most browsers.
- **Presets** (WASD, YACReader-like, pedal) (drafts 2, 3). Not in v1: #55 is
  two key presses, and A/D are free in every scope. Owner decision 6.
- **Key sequences, gamepad, import/export** (draft 2). No demand; profiles
  already sync and copy.
- **Match by character (`e.key`)**. Rejected: letter shortcuts die on
  Cyrillic or kana layouts, and the reader is positional today.
- **One global dispatcher in `+layout`** (draft 3). Rejected: the reader's
  guards depend on Reader state (re-read prompt, layer UI, edit session),
  and library scope depends on per-card hover. One resolver, sites keep
  their state.
- **"Keep both" on a same-scope conflict** (drafts 1, 2). Rejected: which
  one runs would be a hidden rule.
- **Dropping synced conflicts at load** (draft 3). Rejected: it silently
  rewrites synced data. Deterministic order plus a visible flag instead.
- **Skip Space/Enter when a button has focus** (draft 3). Rejected: today
  you click a reader button, then press Space and the page turns.
- **A `Mod` token for Ctrl-or-Cmd** (draft 3). Rejected: defaults list both;
  captured chords are what the user pressed.
- **On-screen key picker for touch** (draft 2). Rejected: with no keyboard
  there is nothing to fire a binding. A Bluetooth keyboard or pedal is
  captured by pressing it.
- **`?` help sheet bound by default** (draft 3). Rejected: a new bare
  default, and `?` sits on different keys per layout. Live hints plus the
  settings section cover it.
- **Focus path for library shortcuts** (drafts 2, 3). Worth doing, but it is
  keyboard-navigation work for the cards, not rebinding. Follow-up.
- **New bare-letter defaults (A/D out of the box)**. Rejected: popup
  dictionaries use bare letters while their popup is open (Rikaikun-style
  A and D); new defaults widen that overlap for everyone.

## 16. Decisions for the owner

All eight are answered. Each took option (a), and that is what draft PR #370
built; section 17 widens number 5.

1. **Section 9 changes at defaults:** (a) accept all, recommended;
   (b) keep Shift+Space as Next page (add it to the defaults);
   (c) make Shift+Space Previous page, the browser convention.
   **Answered: (a).** Built; pinned by the second table in
   `defaults-golden.test.ts`.
2. **Settings layout:** (a) section in the drawer, recommended;
   (b) modal opened from the drawer.
   **Answered: (a).** Built as the "Keyboard shortcuts" accordion item.
3. **Wheel turns pages (#55):** (a) phase 3 of this work, recommended;
   (b) its own issue later.
   **Answered: (a).** Built (`wheelTurnsPages`, the "Mouse wheel" select).
4. **Scope:** (a) per profile with "Copy to all profiles", recommended;
   (b) per profile only; (c) one user-level map outside profiles.
   **Answered: (a).** Built. Section 17 stores the quick-menu selection the
   same way.
5. **New unbound actions in v1:** (a) timer, reader controls, zoom to fit,
   previous/next volume, recommended; (b) timer only.
   **Answered: (a), then widened.** The five are built. Section 17 makes
   every control on the target list an action.
6. **Presets:** (a) none in v1, recommended; (b) one "No arrow keys"
   preset (A/D page left/right, W/S scroll).
   **Answered: (a).** No presets.
7. **Library keys by position:** (a) yes, like the reader, recommended;
   (b) keep `e.key` for the library only.
   **Answered: (a).** Built.
8. **Fixed gestures** (catalog Shift/Alt+wheel, the gap chord, taps):
   (a) stay fixed, listed read-only, recommended; (b) rebindable in a later
   round.
   **Answered: (a).** Built (`FIXED_INPUTS`), and restated on the target
   list: the spine-offset gestures stay fixed.

## 17. Extension: every control, icons, quick menu

Added 2026-11-09. Read against this branch at 4c302b67. The target list is
`2026-11-08-binding-targets.html`: 119 rows, 98 marked Y. Only Y rows get
actions.

### 17.1 Owner decisions

From the target list's Decisions section and the owner's answers:

1. **C and O.** ONE action, "Spreads offset", default O. C is freed: no
   default, nothing answers it in the reader. The cover toggle only shifted
   the pairing as a side effect, and it is the less useful of the two. The
   owner would rather need neither key: pairing that is right without help is
   a follow-up, not this work.
2. **P and Z.** Unchanged. V picks the layout type (paged or continuous). P
   changes how the current type lays out, and Z changes its zoom. Each stays
   ONE mode-aware cycle action. Folding P into V as a six-way rotation was
   considered and not taken. The per-setting Next, Previous and Set-to actions
   exist too, unbound.
3. **Night, invert, black & white while scheduled.** The key shows today's
   schedule message, and the message carries a "Set to manual" button.
4. **Quick menu outside the reader.** Stays reader-only. Library and series
   actions are bindable with no quick-menu option. A library quick menu is
   acceptable later, not in v1.
5. **Text-box actions under the pointer.** Deferred past v1. "Copy whole page
   text" is in.
6. **Open settings.** Yes, with one shared open-state store.
7. Every row left on "maybe" is bindable, unbound by default.

Rules that hold throughout:

- This is rebinding. Every action can be unbound or given other keys. A new
  action ships unbound unless its row has a key today.
- Auto stays the default. `keyBindings: {}` and `quickMenu: {}` are today's
  keys and today's quick menu. Nothing asks the user to configure anything.
- A destructive command is bindable. Its key calls the button's own handler,
  so the confirmation dialog still opens.
- Feedback for a key press goes through the reader's in-overlay notification.
  Outside the reader it uses the snackbar.

### 17.2 Three kinds of target

| Kind    | Source                      | Actions                                             |
| ------- | --------------------------- | --------------------------------------------------- |
| Setting | a setting definition (data) | generated: see the table below                      |
| Command | one registry entry, by hand | one action, handler at the site that owns its state |
| Cycle   | by hand (P, Z, L)           | one mode-aware action, behaviour unchanged          |

Generated actions per setting kind:

| Setting kind | Actions                                     | Repeat          |
| ------------ | ------------------------------------------- | --------------- |
| toggle       | Toggle                                      | no              |
| list         | Next, Previous, one "Set to X" per option   | no              |
| slider       | Step up, Step down, Reset (by its own step) | up and down yes |

**Setting definitions.** Option lists exist in six Svelte components today
(`ReaderSelects`, `ReaderSettings`, `ReaderToggles`, `PageAdjustCard`,
`CatalogSettings`, `ProgressTrackerView`) and nowhere as data. A new module,
`src/lib/settings/setting-defs.ts`, holds one definition per bindable setting.
The components import their option lists from it, so each list exists once
and the generator never copies one.

```ts
type SettingDef = {
  id: string; // stable token used in action ids, never renamed
  label: string; // "Paged zoom"
  group: ActionGroup;
  scope: KeyScope;
  modes?: readonly ReaderMode[];
  icon: IconName;
  menu: 'off' | 'never'; // may it be put on the quick menu?
  read(ctx: SettingCtx): unknown;
  write(ctx: SettingCtx, value: unknown): void;
} & (
  | { kind: 'toggle'; actionId?: string; schedule?: ScheduleSettingKey }
  | { kind: 'list'; options: Options | ((ctx: SettingCtx) => Options); wrap?: boolean }
  | {
      kind: 'slider';
      min: number;
      max: number;
      step: number;
      reset: number;
      format(v: number): string;
    }
);
```

- `read`/`write` come from one helper per settings home: profile
  (`updateSetting`), Anki (`updateAnkiSetting`), catalog
  (`updateCatalogSetting`), device (`updateMiscSetting`), open volume
  (`updateVolumeSetting`, with `ctx.volumeId`). A definition overrides them
  when the control does more than store a value:
  - Mouse wheel: three options over two booleans (`wheelTurnsPages`,
    `swapWheelBehavior`).
  - Anki double-tap: a toggle over `triggerMethod` (`doubleTap`/`both` = on).
  - Stacking preset: `applyPreset`, which writes eight catalog settings. It
    moves out of `CatalogSettings.svelte` into the definition's module.
  - Hide completed volumes: also switches the preset to Custom, as the
    control does.
  - Theme: "Set to Custom" only selects Custom. It does not re-seed the
    custom colours the way a click on the swatch does, because a key must
    not overwrite a palette.
- Slider steps and limits are the existing constants (`PAGE_ADJUST_*`,
  `INK_STRENGTH_*`, `PAPER_*`, `MAX_PAGE_GAP`). The gap step is one wheel
  notch, `100 / GAP_WHEEL_STEP_SIZE` = 5 px, not a second number.
- A list wraps round by default. Font size does not (`wrap: false`): Next
  stops at 60, Previous stops at auto.
- Series sort and series view are component state in `SeriesView.svelte`
  with their own localStorage keys. They move into a small store
  (`src/lib/settings/series-view-prefs.ts`, same keys) so a definition can
  read and write them.
- Settings controls that copy a value into local state at mount
  (`AnkiConnectSettings`: `cardMode`, `doubleTapEnabled`) must follow the
  store instead, or the drawer shows a stale value after a key press.
- The cycle buttons on the catalog, the series page and the progress tracker
  call the definition's Next, so a button and a key walk the same order.

**Generation.** `src/lib/keys/generate.ts` turns the definitions into
`KeyActionDef`s. `src/lib/keys/setting-actions.ts` is the ONE handler for all
of them: it reads the definition, computes the next value, writes it and
announces it ("Brightness: 110%", "Paged zoom: Fit to width", "Bold font:
On"). No listener site has a per-setting handler.

Profiles are the one dynamic list: its "Set to" actions are rebuilt when the
set of profile names changes (a primitive key derived from the `profiles`
store, so other profile writes rebuild nothing).

### 17.3 Ids

Ids are stored in synced profiles, so they are permanent.

| Kind           | Id                                                  |
| -------------- | --------------------------------------------------- |
| Command, cycle | `<area>.<name>`, as today (`reader.goto-page`)      |
| Toggle         | `set.<def>.toggle`                                  |
| List           | `set.<def>.next`, `set.<def>.prev`                  |
| List option    | `set.<def>.to.<option>`                             |
| Slider         | `set.<def>.up`, `set.<def>.down`, `set.<def>.reset` |
| Profile option | `set.profile.to.<profile name>`                     |

- `<def>` is the definition's `id`: kebab-case, no dots, chosen by hand and
  never derived from a label or a storage key.
- `<option>` is the stored value itself (`zoomFitToScreen`, `SMART`, `9`).
  Stored values are already permanent. Everything after `.to.` is the option,
  so a profile name with dots or spaces parses.
- **Pinned ids.** Seven actions that exist today ARE a setting's toggle.
  Their definitions carry `actionId`, so they keep their id, key and stored
  bindings: `reader.continuous`, `reader.dividers`, `reader.timer`,
  `reader.ocr-always`, `reader.night`, `reader.invert`, `reader.grayscale`.
- Removing an option or a definition retires its ids. A retired or unknown id
  stays in storage and is ignored, as section 7 says.
- A profile that is renamed or deleted leaves its "Set to" binding behind,
  inert. After a profile switch the keymap is the new profile's own.
- `generated-ids-golden.test.ts` holds the full generated id list. An id that
  changes or disappears fails it.

**Migration of the old C and O ids.** `reader.offset-spreads` stays, with its
default O; only its label changes to "Spreads offset". `reader.cover` is
retired. No released build ever stored it; the fold below covers profiles
written by builds of this branch, and is the pattern for any later
retirement.

- `RETIRED_ACTIONS = { 'reader.cover': { into: 'reader.offset-spreads', dropped: ['KeyC'] } }`
  in `keymap.ts`, applied by `sanitizeKeyBindings` (so on load and on every
  merged profile).
- No stored entry: nothing to do. C simply has no action.
- Stored `[]`: the entry is deleted.
- Stored chords: `KeyC` is dropped (C is freed for everyone). Any other
  chord is added to `reader.offset-spreads` (its stored list, else its
  default O), up to the stored-chord cap. Then the entry is deleted.
- The fold is deterministic and does not touch `lastUpdated`, like the other
  shape migrations, so two devices converge without a write.

### 17.4 Scopes and context

| Scope            | Live in                        | Shadows     | Listener         |
| ---------------- | ------------------------------ | ----------- | ---------------- |
| `edit`           | reader, while editing          | reader, app | `Reader.svelte`  |
| `reader`         | reader (per mode)              |             | `Reader.svelte`  |
| `library.series` | catalog, card under pointer    | library     | `+layout.svelte` |
| `library`        | catalog                        |             | `+layout.svelte` |
| `library.volume` | series page, row under pointer | series      | `+layout.svelte` |
| `series`         | series page                    |             | `+layout.svelte` |
| `tracker`        | progress tracker               |             | `+layout.svelte` |
| `text`           | volume and series text views   |             | `+layout.svelte` |
| `series-editor`  | the series editor dialog       |             | `+layout.svelte` |
| `app`            | everywhere but under a dialog  |             | both             |

Order of trying: `edit`, `reader`, `app` in the reader; the hovered card's
scope, the view's scope, `app` elsewhere.

- **Relations.** Two actions on one chord: same scope with a shared mode is
  a conflict. So is `app` against any scope it is live with, except `edit`
  (as today). A scope against one it shadows is a note at capture, not a
  prompt: "While a volume is under the pointer, E edits the volume first."
  Scopes that are never live together (reader and library, catalog and
  series page, the dialog and anything) do not relate. The table above is
  data in `actions.ts`; `chordRelation` reads it.
- **Modes.** A generated action takes its definition's `modes`. Page view
  mode, paged zoom, page transition, paged gap, Bounds and Mobile are live in
  Paged only. Scroll mode, continuous zoom, dividers and the scroll gap are
  live in the continuous modes only. So "Set paged zoom to Fit" and "Set
  continuous zoom to Fit" can share a key.
- **P and Z** stay `reader.page-mode` and `reader.zoom-mode`, live in all
  modes, each cycling the current mode's setting.
- **One listener outside the reader.** Views and hovered cards stop owning
  window listeners. `src/lib/keys/providers.ts` keeps one handler map per
  scope: `provideKeyHandlers(scope, handlers)` returns its own disposer, and
  the newest provider of a scope wins. `+layout.svelte` dispatches
  `[hover scope if provided, view scope, 'app']`. A card provides its scope
  while hovered; a view provides its scope while mounted. The guards run once
  in the layout: not from a typing target, the settings panel or a popover.
- **Dialogs.** While any dialog is open the layout dispatches only a provided
  dialog scope (`series-editor`), never `app`. `SeriesEditorModal` provides
  its handlers only while it is the top dialog (not while its link modal or a
  confirmation is over it), the same test its Escape capture uses.
- **The reader** keeps its own listener and guard prelude. Handlers resolve
  in this order: the reader's typed map, the shared app map
  (`src/lib/keys/app-actions.ts`), the generated-setting handler. New in
  step B: the reader's listener also returns while any dialog is open, as the
  library's already does. With confirm-dialog commands bindable, a second
  press must not stack a dialog or act under one.
- **Types.** Hand-registered ids stay a literal union, and every site's map is
  `satisfies Record<…>`, so an entry without a handler fails type-check.
  Generated ids are `` `set.${string}` `` plus the pinned literals; a unit test
  checks each resolves.

### 17.5 Feedback and the scheduled filters

- `src/lib/keys/announce.ts`: `announce(message, key, action?)`. The reader
  registers its notification while mounted; otherwise the snackbar shows the
  message.
- The seven pinned toggles have a toast today. They keep one, in the
  generated wording: "Page dividers: On" where it said "Dividers On".
  Cosmetic.
- An action that cannot run says why ("AnkiConnect is off", "Not available
  for the primary layer", "Select two boxes to merge") instead of doing
  nothing.
- **Scheduled filter.** `reader.night`, `reader.invert` and
  `reader.grayscale` carry `schedule` on their definition. With the schedule
  on, the key changes nothing and announces today's message ("Night Mode is
  on automatic schedule"; the definition keeps today's three names for it),
  with one button: **Set to manual**.
  - The button turns the schedule off and keeps what is on screen: the manual
    value takes the schedule's current state. The next press of the key then
    toggles it. The settings card's radio is unchanged.
  - `showNotification(message, key, action?)`. A notification with a button
    stays 5 s instead of 2 and while the pointer or focus is on it (the hold
    ends with the notice it was on). It is as wide as its content up to the
    screen less a margin; on a phone the message wraps and the button does
    not. It never takes focus. The button is a real `<button>`, which the gesture layer
    already treats as interactive, so a tap on it neither turns the page nor
    toggles the controls.
  - It shows the same way when the action is run from the quick menu, which
    is how a touch device reaches it.

### 17.6 Storage: the quick-menu selection

```ts
// Settings (settings.ts), default {}
quickMenu: Record<string /* action id */, boolean>;
```

- Sparse, like `keyBindings`. Absent id = the default (on for the eight
  default ids, off for the rest). `true` = shown, `false` = hidden. A write
  that equals the default deletes the entry, so a changed default reaches
  everyone who has not chosen.
- Profile field. Same whole-profile newest-wins merge, same
  `updateSetting` touch.
- `sanitizeQuickMenu` in `migrateProfiles`: a non-object becomes `{}`, a
  non-boolean entry is dropped. Unknown ids are KEPT. An id whose action can
  never be on the menu is ignored when the menu is built.
- "Copy to all profiles" copies both maps. "Reset all shortcuts" and "Reset
  quick menu" are separate.
- No Dexie or file version change.

### 17.7 The quick menu

The reader's quick-actions menu renders from the registry.

- **Eligible:** scope `reader`, `edit` or `app`, and not marked never. Never:
  Open quick menu, Show quick actions button, the Mouse wheel list, the five
  "Open …" navigation actions, and every library, series, volume-row,
  series-editor, tracker and text-view action.
- **Default set and order** is one list in `src/lib/keys/quick-menu.ts`,
  top to bottom as today: OCR layers, Edit OCR text, Add image to Anki, Add
  image 2 to Anki, Fullscreen, Zoom to fit, Next page, Previous page. A
  user's additions follow in registry order. No reordering in v1.
- **Next page and Previous page, as the target list has them.** Both are
  live in every layout, so the default menu is the same in paged, vertical
  and horizontal: vertical scroll keeps its two page buttons. Page left and
  Page right (the physical pair) are available, off.
- **The two arrows point where the page goes.** The buttons this replaces
  called `left()` and `right()`: they were physical, and in a right-to-left
  book (the default) → turned back. So that nobody taps → and moves left,
  the menu draws Next page and Previous page by the direction they turn in
  the layout and the book on screen (`QuickMenuState.forward`): → and ← left
  to right, ← and → right to left, ↓ and ↑ in vertical scroll. Only the
  glyph follows; the action, its name and its settings row do not. Not on
  the target list, which gives the left-to-right pair.
- **State.** `Reader.svelte` answers, for the ids on the menu only: hidden
  (not live in this mode; Anki off; no second page; no layers and not
  editing), disabled with a reason (Edit in continuous scroll or on the
  read-only original), on/off for a toggle, and a badge. One `$derived` in
  the reader, which is a single instance.
- **Badges** tell apart actions that share an icon: `+`, `−`, `0` for a
  slider's three, `›` and `‹` for Next and Previous, up to three letters of
  the option for a Set-to, `1` and `2` for the Anki pair as today.
- A tap runs the same handler the key runs.
- "Open quick menu" (`reader.quick-menu`) opens it by key even when the
  button is hidden. The OCR layer picker is opened by `reader.ocr-layers` and
  renders whenever it is open, not only while the menu button shows.
- More entries than fit one column wrap into further columns toward the
  centre of the screen.
- Open settings on the menu is the same action as the key.

### 17.8 The settings-open store

- `src/lib/settings/settings-open.ts`: `settingsOpen`, a writable boolean.
  `uploadModalOpen` sits beside it for the "Open upload" action.
- The drawer is mounted twice today, by `NavBar` (always mounted, hidden in
  the reader) and by the reader's `SettingsButton`, each with its own flag.
  Both mounts stay, because `Settings.svelte` reads `isReader()`
  non-reactively to choose reader or library content. Each binds to the
  store through a function binding
  and shows only in its own context: NavBar's outside the reader, the
  reader's inside it. One flag, never two drawers.
- The NavBar button, the reader's settings button, the key (`app.settings`)
  and the quick menu all set the store. The drawer's own close paths clear
  it.

### 17.9 The settings section at 250 actions

254 actions with two profiles: 170 generated, 84 by hand. The section lists
TARGETS, about 130, not actions.

- **Title:** "Shortcuts and quick menu".
- **Groups** follow the target list's areas: Reader: navigation, view, image,
  text, this volume, edit mode, OCR layers; App; Library; Series page; Volume
  row; Series editor; Other views. Each is a collapsed disclosure showing its
  count and how many rows are changed. Collapsed groups mount no rows.
- **Rows.** A command or a toggle is one row: icon, label, keys, quick-menu
  switch. A list or a slider is one row for the setting; it opens to its
  actions (Next, Previous, each Set-to; or Step up, Step down, Reset). A
  closed setting row says what is inside: "2 keys · 1 on the quick menu".
  Nothing bound is ever invisible.
- **Search** matches the label, the setting, an option name, the area and a
  bound key's label. A search opens every group and setting with a match and
  hides the rest. It is applied 150 ms after the last keystroke.
- **Filters:** Has a key · Changed · On the quick menu.
- **A search or a filter mounts at most 60 action rows** (`MATCH_LIMIT`),
  with "Showing the first 60 of N matching actions. Show all" under them:
  one letter matches most of the registry. While one is up, the group and
  setting headers are disabled (they cannot fold what it holds open), and a
  row whose keys or menu choice the user changes stays listed until the
  search or the filters change, whatever the change did to it.
- **Quick-menu switch** per row, absent where the action can never be on the
  menu. Above the list: "Quick menu: 8 actions", with Reset.
- **Touch.** The one-line note becomes "Keys need a hardware keyboard. The
  quick menu works by touch." The quick-menu switches work without one.
- A conflict's amber icon also shows on a closed group or setting that holds
  it.
- Rows keep `$derived` to their own chords. The keymap, the conflict map and
  the menu selection are each derived once in the section.

### 17.10 Every Y row

"On branch" says whether the control exists here. Handler sites: R =
`Reader.svelte`; G = the generated-setting handler; A = `app-actions.ts`;
others are named. Rows marked SKIP or DEFER are in 17.11.

**Reader: navigation**

| Row                    | Actions                                                      | Site | On branch                                          |
| ---------------------- | ------------------------------------------------------------ | ---- | -------------------------------------------------- |
| Next page              | `reader.page-next` (exists)                                  | R    | yes; menu default, see 17.7                        |
| Previous page          | `reader.page-prev` (exists)                                  | R    | yes; menu default                                  |
| Page left / Page right | `reader.page-left`, `reader.page-right`                      | R    | yes; off the menu by default                       |
| First page, Last page  | `reader.page-first`, `reader.page-last`                      | R    | yes                                                |
| Scroll image up / down | `reader.scroll-up`, `-down`, `-left`, `-right`               | R    | yes                                                |
| Next / Previous volume | `reader.volume-next`, `reader.volume-prev`                   | R    | yes                                                |
| Back / close reader    | `app.back` (Esc locked)                                      | R    | yes                                                |
| Go to page…            | `reader.goto-page` (new)                                     | R    | popover yes; opens it and focuses the number field |
| Wheel turns pages      | `set.wheel.next`, `.prev`, `.to.pan`, `.to.zoom`, `.to.turn` | G    | select yes; menu never                             |

**Reader: view**

| Row                        | Actions                                        | Site | On branch                                                          |
| -------------------------- | ---------------------------------------------- | ---- | ------------------------------------------------------------------ |
| Fullscreen                 | `reader.fullscreen` (exists)                   | R    | yes                                                                |
| Zoom to fit (now)          | `reader.zoom-fit` (exists; now all modes)      | R    | yes; continuous sets the zoom mode to fit, as the menu button does |
| Zoom in / Zoom out         | `reader.zoom-in`, `reader.zoom-out` (new)      | R    | no control; one ladder step at the screen centre, see 17.11        |
| Show/hide reader controls  | `reader.controls` (exists)                     | R    | yes                                                                |
| Open settings              | `app.settings` (new)                           | A    | button yes; store in 17.8                                          |
| Open quick menu            | `reader.quick-menu` (new)                      | R    | button yes; menu never                                             |
| Page view mode             | `set.page-view.*` (3 options)                  | G    | yes                                                                |
| Continuous scroll          | `reader.continuous` (pinned)                   | G    | yes                                                                |
| Scroll mode                | `set.scroll-mode.*` (3)                        | G    | yes                                                                |
| On page zoom (paged)       | `set.zoom-paged.*` (5)                         | G    | yes                                                                |
| Continuous zoom            | `set.zoom-continuous.*` (3)                    | G    | yes                                                                |
| P, Z                       | `reader.page-mode`, `reader.zoom-mode` (exist) | R    | yes                                                                |
| Page dividers              | `reader.dividers` (pinned)                     | G    | yes                                                                |
| Page transition            | `set.page-transition.*` (4)                    | G    | yes                                                                |
| Bounds                     | `set.bounds.toggle`                            | G    | yes                                                                |
| Show page number           | `set.page-number.toggle`                       | G    | yes                                                                |
| Show character count       | `set.char-count.toggle`                        | G    | yes                                                                |
| Show timer                 | `reader.timer` (pinned)                        | G    | yes                                                                |
| Show quick actions button  | `set.quick-actions.toggle`                     | G    | yes; menu never                                                    |
| Disable animations         | `set.no-animations.toggle`                     | G    | yes                                                                |
| Mobile mode                | `set.mobile.toggle`                            | G    | yes                                                                |
| Paged gap                  | `set.paged-gap.up`, `.down`, `.reset`          | G    | yes; 5 px                                                          |
| Scroll gap                 | `set.scroll-gap.up`, `.down`, `.reset`         | G    | yes; 5 px                                                          |
| Tap page edges (#54)       | SKIP                                           |      | no                                                                 |
| Page Up/Down scroll (#283) | SKIP                                           |      | no                                                                 |

**Reader: image**

| Row                     | Actions                                                     | Site | On branch                                          |
| ----------------------- | ----------------------------------------------------------- | ---- | -------------------------------------------------- |
| Night mode              | `reader.night` (pinned, schedule)                           | G    | yes                                                |
| Invert colors           | `reader.invert` (pinned, schedule)                          | G    | yes                                                |
| Black & white           | `reader.grayscale` (pinned, schedule)                       | G    | yes                                                |
| Image adjustment (#362) | SKIP                                                        |      | no                                                 |
| Brightness              | `set.brightness.up`, `.down`, `.reset`                      | G    | yes                                                |
| Contrast                | `set.contrast.up`, `.down`, `.reset`                        | G    | yes                                                |
| Magazine print effect   | `set.ink-color.*` (9)                                       | G    | yes                                                |
| Ink strength, tint, age | `set.ink-strength.*`, `set.paper-tint.*`, `set.paper-age.*` | G    | yes; announces "(print effect off)" when it is off |

**Reader: text**

| Row                         | Actions                                          | Site | On branch                                                          |
| --------------------------- | ------------------------------------------------ | ---- | ------------------------------------------------------------------ |
| OCR enabled                 | `set.ocr.toggle`                                 | G    | yes                                                                |
| Always show OCR             | `reader.ocr-always` (pinned)                     | G    | yes                                                                |
| Text box borders            | `set.text-borders.toggle`                        | G    | yes                                                                |
| Bold font                   | `set.bold.toggle`                                | G    | yes                                                                |
| Font size                   | `set.font-size.*` (15, no wrap)                  | G    | yes                                                                |
| Custom text box menu        | `set.text-menu.toggle`                           | G    | yes                                                                |
| Copy whole page text        | `reader.copy-page-text` (new)                    | R    | no control; the displayed layer's page or spread, in reading order |
| Add image to Anki / image 2 | `reader.anki-image`, `reader.anki-image-2` (new) | R    | yes (menu buttons)                                                 |

**Reader: this volume**

| Row                       | Actions                                                                                                    | Site | On branch                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------- |
| Right to left             | `set.rtl.toggle`                                                                                           | G    | yes                                 |
| First page is cover       | `reader.offset-spreads` "Spreads offset", O                                                                | R    | yes; `reader.cover` retired         |
| OCR layer                 | `reader.ocr-layer` (exists, L), `reader.ocr-layer-prev` (new), `reader.ocr-layers` (new, opens the picker) | R    | yes; the picker is the menu default |
| Set OCR layer to primary  | `reader.ocr-layer-primary` (new)                                                                           | R    | yes (picker row)                    |
| Mark volume read / unread | `reader.volume-read` (new)                                                                                 | R    | the volume row's button, see 17.11  |
| Timer pause / resume      | `reader.timer-pause` (new)                                                                                 | R    | yes (click on the timer)            |

**Reader: edit**

| Row                                | Actions                                                                                                   | Site | On branch                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------ |
| Edit mode                          | `reader.edit-mode` (exists)                                                                               | R    | yes                                                          |
| Undo / Redo                        | `edit.undo`, `edit.redo` (exist)                                                                          | R    | yes                                                          |
| Delete selected                    | `edit.delete` (exists)                                                                                    | R    | yes                                                          |
| Step back                          | `edit.back` (exists, Esc locked)                                                                          | R    | yes                                                          |
| Draw new box                       | `edit.draw-tool` (new)                                                                                    | R    | yes                                                          |
| Merge / Split / Place lines / Flip | `edit.merge`, `edit.split`, `edit.place-lines`, `edit.flip` (new)                                         | R    | yes; same enablement as the toolbar                          |
| Revert page                        | `edit.revert-page` (new)                                                                                  | R    | yes; already one undoable commit                             |
| Move edit toolbar                  | `set.toolbar-dock.*` (2)                                                                                  | G    | yes                                                          |
| Layer commands                     | `layer.new`, `.rename`, `.promote`, `.publish`, `.unpublish`, `.copy-to-edit`, `.export`, `.delete` (new) | R    | yes; act on the displayed layer under the picker's own rules |

**App**

| Row               | Actions                                                                                                              | Site | On branch       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | ---- | --------------- |
| Profile           | `set.profile.next`, `.prev`, `.to.<name>`                                                                            | G    | yes             |
| Theme             | `set.theme.*` (9 presets and Custom)                                                                                 | G    | yes             |
| Sync progress now | `app.sync` (new)                                                                                                     | A    | yes             |
| Open: five places | `app.open-catalog`, `app.open-reading-speed`, `app.open-progress-tracker`, `app.open-upload`, `app.open-cloud` (new) | A    | yes; menu never |
| Anki: double-tap  | `set.anki-double-tap.toggle` (reader scope)                                                                          | G    | yes             |
| Anki: card mode   | `set.anki-card-mode.*` (2, reader scope)                                                                             | G    | yes             |

**Library** (catalog page; menu never)

| Row                      | Actions                                  | Site                    | On branch |
| ------------------------ | ---------------------------------------- | ----------------------- | --------- |
| Focus search             | `library.focus-search` (new)             | `Catalog.svelte`        | yes       |
| Gallery layout           | `set.gallery-layout.*` (2)               | G                       | yes       |
| Gallery sort             | `set.gallery-sort.*` (3)                 | G                       | yes       |
| Hide completed volumes   | `set.hide-completed.toggle`              | G                       | yes       |
| Stacking preset          | `set.stacking.*` (4)                     | G                       | yes       |
| Preferred title language | `set.title-language.*` (3)               | G                       | yes       |
| Card: open series        | `library.series-open` (new)              | the two card components | yes       |
| Card: series editor      | `library.series-edit` (exists, E)        | the two card components | yes       |
| Card: remove series      | `library.series-remove` (exists, Delete) | the two card components | yes       |

**Series page and volume row** (menu never)

| Row                                                | Actions                                                                                           | Site                | On branch                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| Edit series                                        | `series.edit` (new)                                                                               | `SeriesView.svelte` | yes                                                            |
| Series sort                                        | `set.series-sort.*` (3)                                                                           | G                   | yes                                                            |
| Series view                                        | `set.series-view.*` (2)                                                                           | G                   | yes                                                            |
| Download all / Backup remaining                    | `series.download-all`, `series.backup` (new)                                                      | `SeriesView.svelte` | yes                                                            |
| Remove / Delete from provider / Clean duplicates   | `series.remove`, `series.delete-cloud`, `series.clean-duplicates` (new)                           | `SeriesView.svelte` | yes; each confirms                                             |
| Extract… / View series text                        | `series.extract`, `series.text` (new)                                                             | `SeriesView.svelte` | yes                                                            |
| Back                                               | `app.back`                                                                                        | `+layout.svelte`    | yes                                                            |
| Row: open in reader                                | `library.volume-open` (new)                                                                       | `VolumeItem.svelte` | yes                                                            |
| Row: volume editor                                 | `library.volume-edit` (exists, E)                                                                 | `VolumeItem.svelte` | yes                                                            |
| Row: change cover                                  | `library.volume-cover` (exists, C)                                                                | `VolumeItem.svelte` | yes                                                            |
| Row: delete / cloud copy                           | `library.volume-remove`, `library.volume-delete-cloud` (exist)                                    | `VolumeItem.svelte` | yes                                                            |
| Row: mark read / unread                            | `library.volume-read` (new)                                                                       | `VolumeItem.svelte` | yes; the button's own handler, so #224's sheet arrives with it |
| Row: download / backup / retry / delete from cloud | `library.volume-download`, `library.volume-backup` (new); delete is `library.volume-delete-cloud` | `VolumeItem.svelte` | yes; see 17.11                                                 |
| Row: view text / extract                           | `library.volume-text`, `library.volume-extract` (new)                                             | `VolumeItem.svelte` | yes                                                            |

**Series editor and other views** (menu never)

| Row                            | Actions                                                                             | Site                         | On branch |
| ------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------- | --------- |
| Next unlinked / without titles | `series-editor.next-unlinked`, `series-editor.next-untitled` (new)                  | `SeriesEditorModal.svelte`   | yes       |
| Tracker: three lists           | `set.tracker-target.*` (2), `set.tracker-sort.*` (5), `set.tracker-completed.*` (2) | G                            | yes       |
| Tracker: current period        | `tracker.current-period` (new)                                                      | `ProgressTrackerView.svelte` | yes       |
| Text views: copy               | `text.copy` (new)                                                                   | the two text views           | yes       |
| Text views: back               | `app.back`                                                                          | `+layout.svelte`             | yes       |

**Icons.** Every action has one; the registry stores the
flowbite-svelte-icons NAME, and `src/lib/keys/icons.ts` maps names to
components (`satisfies Record<IconName, Component>`, so a missing import
fails type-check). All names on the target list exist in the installed
package. A row's icon serves all its actions, except:

- Next / Previous page take `ArrowRightOutline` / `ArrowLeftOutline` (the
  list's; the quick menu mirrors them by reading direction, 17.7); Page left
  / Page right take `ChevronLeftOutline` / `ChevronRightOutline`.
- Scroll: `ArrowUpOutline`, `ArrowDownOutline`, `AngleLeftOutline`,
  `AngleRightOutline`.
- Undo `UndoOutline`, Redo `RedoOutline`. Zoom in `ZoomInOutline`, zoom out
  `ZoomOutOutline`.
- Merge `MergeCellsOutline`, Split `SplitCellsOutline`, Place lines
  `AlignJustifyOutline`, Flip `SortHorizontalOutline`.
- Layer commands take the picker's own: new `CirclePlusOutline`, rename
  `EditOutline`, promote `ArrowUpOutline`, publish `UploadOutline`, unpublish
  `CloseCircleOutline`, copy `FileCopyOutline`, export `DownloadOutline`,
  delete `TrashBinOutline`.
- Open: `HomeOutline`, `ChartLineUpOutline`, `CalendarMonthOutline`,
  `UploadOutline`, `CloudArrowUpOutline` (the NavBar's own).
- Mouse wheel has no icon on the list: `SortOutline`.

### 17.11 Skipped, deferred, flagged

**Skipped: the setting is not on this branch.** Add after the PR merges; each
is one definition.

- Tap page edges to turn (#54): toggle.
- Page Up/Down scroll first (#283): toggle.
- Image adjustment on/off (#362): toggle, and a ninth default quick-menu
  entry.

**To rewire when #224 merges.**

- Reader: Mark volume read / unread is `reader.volume-read`, unbound and off
  the menu. The row says it goes through #224's sheet, which is on its own
  branch. Until then it does what the volume row's button does today, on the
  same test (`reader/volume-read.ts`): one press moves the OPEN volume to its
  last page and marks it finished, or — when it is finished, which is the last
  page or the one before — back to zero, clearing the completion date. No
  confirmation, as on the row. The page on screen follows. When #224 merges,
  route that one function through the sheet, as the row's handler is.

**Flagged: built, with a decision the list did not make.**

- The quick menu draws Next page and Previous page as the direction they
  turn (17.7).
- OCR layer is three actions. The menu default is the picker, because that
  is today's button.
- Volume row "Backup / Retry upload / Delete from cloud" is one menu item
  today whose meaning follows the volume's state. The Backup key only ever
  backs up or retries: on a backed-up volume it says so. Deleting stays on
  `library.volume-delete-cloud`, which confirms.
- A command's key applies the same test its button's `{#if}` or `disabled`
  applies, then calls the button's handler. `onDeleteFromCloud` on the series
  page, for one, trusts its template for the read-only check.
- Zoom in and Zoom out need a `zoomStep(direction)` on the paged zoom API
  and on both scroll readers: the notched-wheel ladder step, anchored at the
  screen centre, behind the surface's motion gate.
- Revert page needs no new undo: it is a history commit already.
- "Set theme to Custom" does not re-seed the custom colours.
- The gap step is 5 px (one wheel notch); the list suggested 4.
- Mouse wheel gets list actions; its row has no icon and it is never on the
  menu.
- "Open upload" opens the upload dialog, as the NavBar button does.
- A binding to "Set profile to X" outlives a rename of X, inert.
- The section in step A is long (one row per action) until step C groups it.
- As built in step A: the scroll gap's key also turns the page dividers on
  above 0 and off at 0, as the Ctrl+Shift+wheel chord does. The definitions
  carry three fields beyond the shape in 17.2: `description` (the action's
  line in the section), `available(ctx)` (a volume setting with no volume)
  and `note(ctx)` ("print effect off"). Generated labels are
  "<Setting>: Next", "<Setting>: Previous", "<Setting>: Set to <Option>",
  "<Setting>: Step up", "<Setting>: Step down", "<Setting>: Reset". The full
  list lives in `src/lib/keys/registry.ts` (`allActions()`); `actions.ts`
  cannot import the definitions, because the settings store imports it.
- The series page still reads its two localStorage keys when it mounts
  (`refreshSeriesViewPrefs`), so a choice made in another tab applies as it
  did before the store.
- As built in step B:
  - The provider registry (`providers.ts`) holds no dispatch code, so a card
    that renders N times imports only the registry's types. The listener body
    is `handleKeydownOutsideReader` in `outside-reader.ts`; component tests
    install that same function (`keys/__tests__/layout-listener.ts`).
  - `libraryShortcutAllowed` became `shortcutAllowed` (no `hovered`, no
    `modalOpen`: a card provides only while hovered, and the dialog rule is
    the dispatcher's).
  - Row icons are the list's, one per row, also where one action of a row
    reads oddly under it: Back up series carries `DownloadOutline`, Download
    volume `CloudArrowUpOutline`, View series text `FileExportOutline`,
    Extract volume `FileLinesOutline`. These actions are never on the quick
    menu, so the icon shows in the settings section only. Changing one is one
    word in `actions.ts`.
  - "Clean duplicates" by key works in both series views. Its button is drawn
    in the list view only, which is where the banner sits, not a rule.
  - The series page's keys decline (the press falls through) while no series
    is drawn: loading, or not found.
  - A hidden-controls press of "Open quick menu" shows the menu AND its
    button, so a touch can close it. Hiding the controls closes the menu and
    the picker (before, a menu left open came back open with the controls).
  - `L` with no layers announces through the reader's notification, like the
    other hotkeys; it used the snackbar.
  - "Go to page…" opened by key closes the popover on Enter. Opened by a
    click it stays open, as before.
  - "Open settings" opens; it does not toggle. Under the open drawer every
    key stands down.
  - "Sync progress now" announces "Syncing progress…" when it starts; the
    result is the sync's own report.
  - Edit commands that run (merge, split, place lines, flip, revert) are not
    announced: the page shows them. The draw tool is ("Draw new box: On").
  - "Tracker: current period" applies the button's test (the period on screen
    has ended); otherwise it says the period is still open.
  - `app.open-upload` also works in the reader, where the dialog opens over
    the page.
- As built in step C:
  - The groups are `ActionGroup` itself (`actions.ts`, `GROUP_ORDER`,
    `GROUP_LABELS`): every action and definition names its area, so there is
    no second mapping. Two places differ from the list's own headings. The
    layer commands have a group of their own (17.9), and the layer cycle,
    picker and "Set to primary" stay under This volume, where the list has
    them. An `app` action has ONE row, under App: Back and Open settings are
    not repeated under the reader and the series page.
  - The rows are `targets.ts`: 132 targets for 254 actions. A search matches
    every word against the action's label, its setting, its option, its area
    and the labels of its keys (locked keys included). Under a search or a
    filter the group headers do not fold; the header's count is the group's
    whole size.
  - A setting row's line always says how many actions it holds: "7 actions",
    "7 actions · 2 keys · 1 on the quick menu".
  - "Changed" (the filter, a group's count, a row's mark) is a changed key OR
    a changed quick-menu choice.
  - "Quick menu: N actions" counts the profile's menu across layouts. A given
    layout can show fewer.
  - The menu shows only what is live in the layout. Every default is live in
    all three. Page left and Page right, when a user adds them, are absent in
    vertical scroll (their keys scroll sideways there).
  - In horizontal scroll Next page and Previous page step the strip, as
    their keys do; before, the two buttons called the paged turn.
  - The Edit entry is named "Edit OCR text" and shows as pressed while
    editing; it said "Exit edit mode" there. While a layer is loading its
    reason is "The layer is still loading".
  - A step keeps the menu open for the next tap: a slider's Step up and Step
    down, Zoom in, Zoom out. Everything else closes it, as before.
  - Badges beyond the list's: `›` `‹` on Next and Previous OCR layer, `P` on
    Set OCR layer to primary, `+` `−` on Zoom in and Zoom out.
  - An edit command on the menu is greyed outside edit mode ("Only in edit
    mode") and absent in continuous scroll.
  - A scheduled filter's entry shows what the schedule has on screen.
  - `KeyActionDef.option` carries a "Set to" action's option name, for the
    search and the badge.
  - To add after their PRs merge: the three toggles of 17.11's Skipped list,
    and the #362 toggle in `QUICK_MENU_DEFAULT` (`quick-menu.ts`).

Nothing on the list was judged impossible to bind.

### 17.12 Build order

Three steps. Each leaves `npm run check`, `npm run lint` and `npm test`
green.

**A. Generation, icons, storage.**

- `setting-defs.ts` and the components reading their lists from it; the
  series view-prefs store; Anki controls following the store.
- `generate.ts`, `setting-actions.ts`, `announce.ts`; `icon` and menu
  eligibility on every action; `icons.ts`.
- Scopes as data, `chordRelation` from the table, the keymap carrying its own
  action list, profile actions rebuilt on a name change.
- `Reader.svelte` and `+layout.svelte` resolve generated actions. The seven
  pinned toggles leave the reader's hand-written map.
- C and O: `reader.cover` retired, the fold, the label, the hint on the cover
  toggle removed.
- The notification's button and the three schedule guards.
- `settings-open.ts` and both drawer mounts on it.
- `quickMenu` in `Settings`, its shape check, the copy to all profiles.
- Until step B, a page-scope key that a hovered card also uses resolves
  page-first; step B makes it hover-first.

**B. Commands.**

- `providers.ts`; the layout as the one listener outside the reader; the
  three card components provide instead of listening.
- The 53 new commands in 17.10, each with its handler at the named site and
  the shared enablement test extracted beside its button:
  `layerActionAvailable` (next to `layerRowActions`), `editCommandState`
  (toolbar and keys), the series page's and volume row's `can…` tests.
- `app-actions.ts`; `zoomStep`; the page popover and the quick menu openable
  by key; the picker rendering whenever it is open.
- The reader's listener stands down while a dialog is open.

**C. Quick menu and the section.**

- `quick-menu.ts`; `QuickActions.svelte` rendering from the registry with
  state, badges and wrapping.
- The per-profile quick-menu switch; the section regrouped, searchable and
  folded as in 17.9.

### 17.13 Tests

Step A, unit:

- `setting-defs.test.ts`: unique ids and options; each default is one of its
  options; slider reset inside its range.
- `generate.test.ts` and `generated-ids-golden.test.ts`: the id scheme; the
  pinned ids; every generated id resolves to a definition and an operation.
- `setting-actions.test.ts`: toggle; Next and Previous with and without wrap;
  Set-to; step up and down clamped at the ends; reset; the announcement text;
  a volume setting with no volume declines; the schedule guard changes nothing
  and returns the button; the button keeps the on-screen state.
- `actions.test.ts`: every action has an icon in the map; nothing outside
  `reader`, `edit` and `app` is menu-eligible; every action that is not in
  the pre-extension golden table has no default chord.
- `keymap.test.ts`: the `reader.cover` fold (absent, `[]`, `[C]`, `[C, X]`,
  `[X]` with a customised O); relations across the new scopes; profile
  actions appear and disappear with the profile list.
- `defaults-golden.test.ts`: iterates the full list; C in the reader is a
  listed change; O still offsets.
- `migrateProfiles`: `quickMenu` shape; unknown ids kept; copy to all
  profiles copies both maps.
- Source lint: the six components hold no `{ value, name }` option literals
  for a defined setting.
- Component: the notification button renders, acts and does not take focus;
  in each context exactly one drawer opens from the store.

Step B, unit:

- `providers.test.ts`: provide and dispose; newest wins; hover before page
  before app on a shared chord; a dialog scope alone while a dialog is open.
- The extracted tests: layer availability per layer kind; edit command state
  per selection; the Backup key never deletes; page text order for single,
  spread, right-to-left and left-to-right.
- `source-lint.test.ts` gains the new sites.
- Type-level: each site's map `satisfies` its scope's ids.

Step C:

- `quick-menu.test.ts`: `{}` gives today's eight in today's order, the same
  in every layout; sparse edits; a never id is ignored; the mode filter; the
  page arrows by reading direction.
- `targets.test.ts`: a kept row survives each filter; the 60-row cut.
- Component: the menu renders its items, badges and disabled reasons and
  runs the action; the section's groups, search, filters, folded setting
  rows with their "inside" summary, the switch hidden where never, the touch
  note.

E2E (Playwright via `/verify`, dedicated `E2E_PORT`): bind a generated action
and press it; add an action to the quick menu, reload, switch profile; N with
the schedule on shows the button and the button sets manual; C does nothing
and O offsets; a hovered volume's E still opens the volume editor with a
series-page action on E as well.

### 17.14 Changes at defaults

1. C no longer toggles the first-page-is-cover setting. O does, as "Spreads
   offset".
2. Seven toggle toasts take the common wording ("Page dividers: On").
3. In the reader, keys stand down while a dialog is open.
4. The quick menu's Fullscreen, Zoom to fit and Edit buttons take the target
   list's icons (`ExpandOutline`, `MinimizeOutline`, `PenOutline`), and every
   entry is named by its action ("Fullscreen", "Edit OCR text"; Edit shows as
   pressed while editing).
5. The quick menu's two page buttons are Next page and Previous page, in
   every layout. In a right-to-left book the upper one is ← (next) and the
   lower → (previous): each arrow still turns the way it points, in the
   other order. In horizontal scroll they step the strip; in vertical scroll
   they are ↓ and ↑ (17.7).

Everything else is new and unbound.
