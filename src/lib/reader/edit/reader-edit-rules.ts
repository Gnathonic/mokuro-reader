/**
 * Reader-level rules of the OCR editor, kept out of `Reader.svelte` so they
 * can be tested without mounting the reader: the flush on tab hide, and who
 * owns the keyboard while the layer UI is open. `Reader.svelte` feeds these
 * its own state; the one thing held here is the reader's registration for
 * `beforeLayerMutation`.
 */
import type { LayerAction } from '$lib/components/Reader/Layers/layer-actions';

/**
 * Save pending edits when the page is about to stop running: the tab is
 * hidden (mobile browsers may kill a hidden tab without another event) or the
 * page is being unloaded. The debounced save would otherwise lose the last
 * half second of edits. Returns the detach function.
 */
export function flushOnPageHide(flush: () => void): () => void {
  const onVisibilityChange = () => {
    if (document.hidden) flush();
  };
  const onPageHide = () => flush();
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
  };
}

export type LayerUiKeyAction = 'pass' | 'swallow' | 'close-picker';

/**
 * What the reader's window keydown handler does with a key while the layer UI
 * is open. `keyboardShouldIgnore` only sees the event TARGET, and the picker
 * opens without taking focus from its toggle button — so the reader's own
 * state has to say the picker is up, or Escape navigates back out of the
 * reader and the arrows page it underneath. The name prompt is a native
 * dialog that handles its own Escape; the reader just stays out of the way.
 */
export function layerUiKeyAction(
  code: string,
  ui: { pickerOpen: boolean; namePromptOpen: boolean }
): LayerUiKeyAction {
  if (ui.namePromptOpen) return 'swallow';
  if (ui.pickerOpen) return code === 'Escape' ? 'close-picker' : 'swallow';
  return 'pass';
}

type BeforeLayerMutation = (action: LayerAction) => Promise<void>;
let readerBeforeLayerMutation: BeforeLayerMutation | null = null;

/**
 * The reader registers how it settles its open edit session before a layer
 * action touches the DB, so a surface that is not its child (the settings
 * panel's layer buttons) can pass the same thing as its
 * `LayerActionContext.onBeforeMutate`. Returns the unregister function, which
 * only removes its OWN registration — a reader being torn down must not
 * unhook the one that replaced it.
 */
export function registerBeforeLayerMutation(fn: BeforeLayerMutation): () => void {
  readerBeforeLayerMutation = fn;
  return () => {
    if (readerBeforeLayerMutation === fn) readerBeforeLayerMutation = null;
  };
}

/** Settle the reader's unsaved edits ahead of `action`. No reader, nothing unsaved. */
export function beforeLayerMutation(action: LayerAction): Promise<void> {
  return readerBeforeLayerMutation?.(action) ?? Promise.resolve();
}
