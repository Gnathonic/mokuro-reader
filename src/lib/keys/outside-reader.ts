/**
 * The ONE keyboard listener outside the reader, as a function (#55, spec
 * 17.4): `+layout.svelte` calls it for every keydown that is not the
 * reader's. Kept out of the layout so the order of trying and the guards can
 * be tested — and so a component test can drive a card's shortcuts through
 * the same code the app runs.
 *
 * The handlers come from `providers.ts` (a view while mounted, a card while
 * hovered, a dialog while it is the top one); `app` and the generated setting
 * actions are passed in by the caller.
 */
import { anyModalOpen, shortcutAllowed } from '$lib/util/delete-shortcut';
import type { ActionId, KeyActionDef, KeyScope } from './actions';
import { dispatchKey, type KeyEventLike, type KeyHandler } from './dispatch';
import type { Keymap } from './keymap';
import { providedHandler, scopesOutsideReader } from './providers';

export interface OutsideReaderHandlers {
  /** The key scope of the view on screen, if it has one. */
  viewScope: KeyScope | undefined;
  /** The `app` scope's handlers: the shared map plus this site's Back. */
  app: Partial<Record<string, KeyHandler>>;
  /** The one handler of every action generated from a setting definition. */
  setting: (action: KeyActionDef) => boolean;
}

export interface OutsideReaderContext extends OutsideReaderHandlers {
  /** A `<dialog>` is open. */
  dialogOpen: boolean;
}

/**
 * Resolve one key press: the scopes `scopesOutsideReader` allows, in its
 * order, each answered by its provider. Returns the action that took the key.
 */
export function dispatchOutsideReader(
  e: KeyEventLike,
  ctx: OutsideReaderContext,
  keymap?: Keymap
): ActionId | null {
  const scopes = scopesOutsideReader(ctx.viewScope, ctx.dialogOpen);
  if (scopes.length === 0) return null;
  return dispatchKey(
    e,
    { scopes },
    (id, action) => {
      if (action.setting) return () => ctx.setting(action);
      if (action.scope === 'app') return ctx.app[id];
      return providedHandler(action.scope, id);
    },
    keymap
  );
}

/**
 * The listener body. The guards run once, here: not from a field, the
 * settings panel or a popover (`shortcutAllowed`); and while a dialog is up
 * only a dialog's own provided scope is tried — Escape there closes the
 * dialog and only the dialog, and a second press of a command that asks for
 * confirmation cannot stack another one behind the first.
 */
export function handleKeydownOutsideReader(
  event: KeyboardEvent,
  handlers: OutsideReaderHandlers,
  keymap?: Keymap
): ActionId | null {
  if (!shortcutAllowed(event, document.activeElement)) return null;
  return dispatchOutsideReader(event, { ...handlers, dialogOpen: anyModalOpen() }, keymap);
}
