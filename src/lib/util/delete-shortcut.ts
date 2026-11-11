// The guards around the shortcuts outside the reader (#55). The keys themselves
// resolve through the keymap ($lib/keys) and are dispatched by ONE listener
// (`+layout.svelte`): `library.series-*` while a catalog card is under the
// pointer, `library.volume-*` while a volume is, the view's own actions, then
// `app`. Kept out of the components so it can be unit tested without their
// (heavy) import graphs.

import { keyboardShouldIgnore } from '$lib/reader/input/gesture-target';
import { isTypingTarget } from './series-editor-shortcut';

/**
 * Whether a shortcut may fire for this keydown at all: focus is not on a
 * typing target, and the key was not pressed in the settings panel or a
 * popover. Whether a card is hovered and whether a dialog is up are the
 * dispatcher's rules (`keys/providers.ts`: a card provides its handlers only
 * while hovered; under a dialog only the dialog's own scope is tried, which
 * is what stops a second press stacking another confirmation behind the
 * first). Auto-repeat and modifiers are the keymap's (exact chords; library
 * actions never repeat).
 */
export function shortcutAllowed(
  e: Pick<KeyboardEvent, 'target'>,
  activeElement: Element | null
): boolean {
  if (isTypingTarget(activeElement)) return false;
  if (keyboardShouldIgnore(e.target)) return false;
  return true;
}

/**
 * Is a modal already up?
 *
 * Every modal in the app (the confirmation popup included) is a flowbite `<dialog>`, so
 * one DOM question covers all of them — no store to import, and no way for a new modal to
 * be missed.
 */
export function anyModalOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('dialog[open]');
}
