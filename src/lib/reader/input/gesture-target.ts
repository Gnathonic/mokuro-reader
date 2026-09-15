/**
 * Gesture target classification — THE statement of the reader's
 * element-routing contracts. Every input handler classifies its event target
 * through here instead of scattering `closest('.textBox')` calls.
 *
 * # The contracts
 *
 * **`.textBox` (role 'textbox') is an input-routing protocol, not styling.**
 * OCR text boxes own their gestures: double-tap is the AnkiConnect
 * card-capture gesture (TextBoxes.svelte's own dblclick handler — which also
 * stopPropagation()s as defense in depth), mouse/pen drags are text
 * selection (Yomitan/Migaku scanning), and the custom context menu lives
 * there. Reader surfaces must never start a pan from a mouse/pen press on a
 * text box, never treat clicks on one as overlay toggles, and never zoom on
 * its double-taps. Single-finger TOUCH is the exception: touch has no
 * drag-selection gesture, so touch pans across text boxes (as the old
 * panzoom touch path always did).
 *
 * **`.editBlock` (role 'editor')** is the OCR edit overlay
 * (`EditOverlay.svelte`): the overlay captures its own pointers and stops
 * propagation; surfaces must never pan, tap-toggle, or zoom from a press on
 * one, for ANY pointer type (unlike text boxes, where touch still pans).
 *
 * **'interactive'** is reader chrome (buttons, links): taps belong to the
 * control, not to overlay toggling or zoom.
 *
 * **'page'** is everything else — pannable, zoomable, tappable surface.
 *
 * The classification walks ancestors (`closest`), so extension-injected
 * wrappers inside a text box (Yomitan spans, Migaku rubies) classify as the
 * text box they live in.
 */

export type GestureTargetRole = 'editor' | 'textbox' | 'interactive' | 'page';

export function gestureTargetRole(target: EventTarget | null): GestureTargetRole {
  if (!(target instanceof Element)) return 'page';
  // The OCR edit overlay owns every press on its blocks and handles (move,
  // resize, text editing) — checked first so an editor never pans, taps, or
  // triggers the Anki double-tap. See docs/INPUT-CONTRACTS.md "Edit overlay".
  if (target.closest('.editBlock, [data-edit-handle]')) return 'editor';
  // textbox wins over interactive: controls inside a box belong to the box's
  // domain (Anki capture UI), not to reader chrome.
  if (target.closest('.textBox')) return 'textbox';
  if (target.closest('button, [role="button"], a')) return 'interactive';
  return 'page';
}

/**
 * Whether a keyboard event's target means reader shortcuts must not fire —
 * the union of the guards that previously drifted apart between Reader.svelte
 * (.textBox / #settings / [data-popover] / inputs) and the scroll readers
 * (INPUT / TEXTAREA / SELECT / contentEditable only).
 */
export function keyboardShouldIgnore(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return !!(
    target.closest('.textBox') ||
    target.closest('#settings') ||
    target.closest('[data-popover]')
  );
}
