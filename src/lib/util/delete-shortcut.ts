// The guards around the library's hover shortcuts (#55). The keys themselves
// resolve through the keymap ($lib/keys): `library.series-*` on catalog cards,
// `library.volume-*` on volumes. Kept out of the components so it can be unit
// tested without their (heavy) import graphs, and so the volume grid, the
// volume list, and both catalog card layouts all answer the question identically.

import { keyboardShouldIgnore } from '$lib/reader/input/gesture-target';
import { isTypingTarget } from './series-editor-shortcut';

/**
 * Whether a hover shortcut may fire for this keydown: the card is hovered,
 * focus is not on a typing target (nor in the settings panel or a popover),
 * and no modal is open — a confirm dialog opened by the shortcut is itself a
 * `<dialog open>`, which is what stops a second press stacking another one
 * behind it. Auto-repeat and modifiers are the keymap's rules (exact chords;
 * library actions never repeat).
 */
export function libraryShortcutAllowed(
  e: Pick<KeyboardEvent, 'target'>,
  hovered: boolean,
  activeElement: Element | null,
  modalOpen: boolean
): boolean {
  if (!hovered) return false;
  if (modalOpen) return false;
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
