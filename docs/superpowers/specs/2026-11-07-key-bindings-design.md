# Key bindings: rebind or unbind every shortcut (#55)

Status: proposed design, 2026-11-07. Read against `origin/develop` b905a92a.
Mockup: `2026-11-07-key-bindings-mockup.html` (same folder).

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

1. **Section 9 changes at defaults:** (a) accept all, recommended;
   (b) keep Shift+Space as Next page (add it to the defaults);
   (c) make Shift+Space Previous page, the browser convention.
2. **Settings layout:** (a) section in the drawer, recommended;
   (b) modal opened from the drawer.
3. **Wheel turns pages (#55):** (a) phase 3 of this work, recommended;
   (b) its own issue later.
4. **Scope:** (a) per profile with "Copy to all profiles", recommended;
   (b) per profile only; (c) one user-level map outside profiles.
5. **New unbound actions in v1:** (a) timer, reader controls, zoom to fit,
   previous/next volume, recommended; (b) timer only.
6. **Presets:** (a) none in v1, recommended; (b) one "No arrow keys"
   preset (A/D page left/right, W/S scroll).
7. **Library keys by position:** (a) yes, like the reader, recommended;
   (b) keep `e.key` for the library only.
8. **Fixed gestures** (catalog Shift/Alt+wheel, the gap chord, taps):
   (a) stay fixed, listed read-only, recommended; (b) rebindable in a later
   round.
