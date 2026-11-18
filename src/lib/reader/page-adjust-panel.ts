/**
 * The page image panel (#363): brightness and contrast adjusted OVER the page,
 * not from inside the settings drawer.
 *
 * The drawer is a modal `<dialog>`: its backdrop dims the page being judged,
 * it covers a quarter of a desktop screen, half a tablet's and ALL of a
 * phone's, and while it is open no page can be turned to compare. Clearing the
 * backdrop while a slider moved (the first try at #363) flashed the whole
 * screen between dim and clear on every press and release — on the very
 * quantity being judged — and still showed nothing on a phone. So the sliders
 * live in a small non-modal panel in the reader itself
 * (`components/Reader/PageAdjustPanel.svelte`): no backdrop, nothing else on
 * screen changes while it is used, and the pages still turn underneath it.
 *
 * Opened from the drawer's Page image card, the quick actions menu or the
 * `A` key; Escape, `A` again or its close button close it. Opening it closes
 * the drawer (`Settings.svelte`). A module store, because those three openers
 * live in three unrelated component trees.
 */
import { writable, type Readable } from 'svelte/store';

const open = writable(false);

/** Whether the page image panel is on screen. */
export const pageAdjustPanelOpen: Readable<boolean> = { subscribe: open.subscribe };

export function openPageAdjustPanel(): void {
  open.set(true);
}

export function closePageAdjustPanel(): void {
  open.set(false);
}

export function togglePageAdjustPanel(): void {
  open.update((v) => !v);
}

/** The reader key that opens and closes the panel (`KeyboardEvent.code`). */
export const PAGE_ADJUST_PANEL_KEY = 'KeyA';
