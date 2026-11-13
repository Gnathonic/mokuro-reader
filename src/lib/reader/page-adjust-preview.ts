/**
 * Live preview while adjusting the page image (#363).
 *
 * The page image sliders sit in the settings drawer, a modal `<dialog>` whose
 * backdrop dims the page behind it — exactly the page the user is trying to
 * judge. While a slider is held (pointer down → up/cancel) or being stepped
 * from the keyboard (an adjusting key → blur), and for a moment after the
 * on/off switch is flipped, `pageAdjustPreviewing` is true and the drawer drops
 * its backdrop's tint (`Settings.svelte`). Nothing moves
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
 * adjusting from pointer down until THAT pointer is released anywhere (another
 * finger or the mouse lifting elsewhere does not end the drag), and from an
 * adjusting key until it loses focus.
 */
export function previewWhileAdjusting(node: HTMLElement): () => void {
  const pointers = new Set<number>();
  let keyboard = false;
  const sync = () => mark(node, pointers.size > 0 || keyboard);

  const listen = (on: boolean) => {
    if (on) {
      window.addEventListener('pointerup', endPointer, true);
      window.addEventListener('pointercancel', endPointer, true);
    } else {
      window.removeEventListener('pointerup', endPointer, true);
      window.removeEventListener('pointercancel', endPointer, true);
    }
  };
  function endPointer(e: PointerEvent) {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0) listen(false);
    sync();
  }
  const onPointerDown = (e: PointerEvent) => {
    // A secondary mouse button opens a context menu, it does not drag.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pointers.size === 0) listen(true);
    pointers.add(e.pointerId);
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
    listen(false);
    pointers.clear();
    // The drawer closing mid-drag must not leave the backdrop clear forever.
    mark(node, false);
  };
}

/** How long the page stays undimmed after the on/off switch is flipped. */
export const PREVIEW_AFTER_CHANGE_MS = 1500;

/**
 * Attachment for the brightness/contrast on/off switch: a flip changes the
 * page at once, so the backdrop stops dimming it for a moment after each
 * change — long enough to compare, restarted by every flip, so flipping back
 * and forth stays undimmed throughout.
 */
export function previewAfterChange(node: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onChange = () => {
    clearTimeout(timer);
    mark(node, true);
    timer = setTimeout(() => mark(node, false), PREVIEW_AFTER_CHANGE_MS);
  };
  node.addEventListener('change', onChange);
  return () => {
    node.removeEventListener('change', onChange);
    clearTimeout(timer);
    mark(node, false);
  };
}
