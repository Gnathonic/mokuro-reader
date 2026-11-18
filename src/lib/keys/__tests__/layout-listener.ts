/**
 * Test helper: the app's ONE keyboard listener outside the reader, installed
 * on `window` the way `+layout.svelte` installs it (#55).
 *
 * Cards and views no longer listen for their own shortcuts — they provide
 * handlers (`providers.ts`) and the layout dispatches — so a component test
 * that presses a key needs the listener too. This is the layout's own
 * function (`handleKeydownOutsideReader`), with no `app` handlers and no
 * generated setting actions: a component test is about the component's keys.
 */
import type { KeyScope } from '../actions';
import { compileKeymap, type KeyBindings, type Keymap } from '../keymap';
import { handleKeydownOutsideReader } from '../outside-reader';
import { allActions } from '../registry';

/** A keymap with `bindings` over the defaults, for a test that presses a key nothing has by default. */
export function keymapWith(bindings: KeyBindings): Keymap {
  return compileKeymap(bindings, allActions());
}

/**
 * Listen as the layout does on a view of `viewScope`. Returns the remover.
 * `keymap`: the bindings to resolve against; the live profile's when omitted.
 */
export function installLayoutKeyListener(
  viewScope: KeyScope | undefined,
  keymap?: Keymap
): () => void {
  const listener = (event: KeyboardEvent) => {
    handleKeydownOutsideReader(event, { viewScope, app: {}, setting: () => false }, keymap);
  };
  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}
