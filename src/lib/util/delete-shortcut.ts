// Pure decision logic for the "hover a card/row and press Delete" shortcut, the mirror
// of `series-editor-shortcut.ts` for the delete flows. Kept out of the components so it
// can be unit tested without their (heavy) import graphs, and so the volume grid, the
// volume list, and both catalog card layouts all answer the question identically.

import { isTypingTarget } from './series-editor-shortcut';

/**
 * Whether a keydown while hovering a card/row should start its delete flow.
 *
 * True iff: the card is hovered, the key is Delete, the event is not an auto-repeat
 * (holding the key must open ONE dialog, not a stack), no ctrl/meta/alt is held, focus is
 * not on a typing target, and no modal is open yet.
 *
 * Shift is deliberately left to the caller: on a volume it means "the cloud copy only".
 */
export function shouldTriggerDelete(
  e: KeyboardEvent,
  hovered: boolean,
  activeElement: Element | null,
  modalOpen: boolean
): boolean {
  if (!hovered) return false;
  if (e.key !== 'Delete') return false;
  if (e.repeat) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (modalOpen) return false;
  if (isTypingTarget(activeElement)) return false;
  return true;
}

/**
 * Is a modal already up?
 *
 * Every modal in the app (the confirmation popup included) is a flowbite `<dialog>`, so
 * one DOM question covers all of them — no store to import, and no way for a new modal to
 * be missed. A confirm dialog opened by this shortcut is itself a `<dialog open>`, which
 * is what stops a second Delete from stacking another one behind it.
 */
export function anyModalOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('dialog[open]');
}
