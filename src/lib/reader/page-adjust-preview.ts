/**
 * Live preview while adjusting the page image (#363).
 *
 * The page image sliders sit in the settings drawer, a modal `<dialog>` whose
 * backdrop dims the page behind it — exactly the page the user is trying to
 * judge. While a slider is held (pointer down → up/cancel) or being stepped
 * from the keyboard (an adjusting key → blur), `pageAdjustPreviewing` is true
 * and the drawer drops its backdrop's tint (`Settings.svelte`). Nothing moves
 * or resizes: only the backdrop's colour changes.
 */
import { writable, type Readable } from 'svelte/store';

/** Keys a focused range input steps its value with. */
const ADJUST_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End'
]);

const active = new Set<HTMLElement>();
const previewing = writable(false);

/** True while any page image slider is being adjusted. */
export const pageAdjustPreviewing: Readable<boolean> = { subscribe: previewing.subscribe };

function mark(node: HTMLElement, on: boolean): void {
  if (on) active.add(node);
  else active.delete(node);
  previewing.set(active.size > 0);
}

/**
 * Attachment for a slider (`{@attach previewWhileAdjusting}`): reports it as
 * adjusting from pointer down until the pointer is released anywhere, and from
 * an adjusting key until it loses focus.
 */
export function previewWhileAdjusting(node: HTMLElement): () => void {
  let pointer = false;
  let keyboard = false;
  const sync = () => mark(node, pointer || keyboard);

  const endPointer = () => {
    window.removeEventListener('pointerup', endPointer, true);
    window.removeEventListener('pointercancel', endPointer, true);
    pointer = false;
    sync();
  };
  const onPointerDown = (e: PointerEvent) => {
    // A secondary mouse button opens a context menu, it does not drag.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!pointer) {
      window.addEventListener('pointerup', endPointer, true);
      window.addEventListener('pointercancel', endPointer, true);
    }
    pointer = true;
    sync();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!ADJUST_KEYS.has(e.key)) return;
    keyboard = true;
    sync();
  };
  const onBlur = () => {
    keyboard = false;
    sync();
  };

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('keydown', onKeyDown);
  node.addEventListener('blur', onBlur);
  return () => {
    node.removeEventListener('pointerdown', onPointerDown);
    node.removeEventListener('keydown', onKeyDown);
    node.removeEventListener('blur', onBlur);
    window.removeEventListener('pointerup', endPointer, true);
    window.removeEventListener('pointercancel', endPointer, true);
    // The drawer closing mid-drag must not leave the backdrop clear forever.
    mark(node, false);
  };
}
