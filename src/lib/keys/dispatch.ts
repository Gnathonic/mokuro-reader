/**
 * The one resolver every keyboard shortcut goes through (#55).
 *
 * Listener sites stay where their state lives (Reader.svelte for the
 * reader, the hovered card for the library, +layout.svelte for Back
 * elsewhere); each one calls `dispatchKey` with the scopes it serves and a
 * handler per action. Element-level handlers (text fields, the OCR line
 * editor, modal Escape captures) stay outside — see docs/INPUT-CONTRACTS.md
 * "Keyboard".
 */

import type { ActionId, KeyActionDef, KeyScope, ReaderMode } from './actions';
import { chordFromEvent } from './chord';
import { lookup, type Keymap } from './keymap';
import { currentKeymap } from './live';

/**
 * Run the action. Return `false` to decline — the key then falls through to
 * the next candidate (e.g. `edit.delete` with nothing selected) and, if
 * nothing takes it, keeps its browser default.
 */
export type KeyHandler = (e: KeyboardEvent) => boolean | void;

/**
 * A site's handlers as a function: the handler for an action, or undefined
 * when the site does not serve it. Lets a site answer its typed map first
 * and the generated setting actions after it (`setting-actions.ts`), which
 * have no per-action entry anywhere.
 */
export type KeyResolver = (id: ActionId, action: KeyActionDef) => KeyHandler | undefined;

export interface DispatchContext {
  /** Scopes to try, highest precedence first. */
  scopes: readonly KeyScope[];
  /** The reader layout, for reader/edit scopes. */
  mode?: ReaderMode;
}

export type KeyEventLike = Pick<
  KeyboardEvent,
  | 'code'
  | 'key'
  | 'ctrlKey'
  | 'altKey'
  | 'shiftKey'
  | 'metaKey'
  | 'isComposing'
  | 'keyCode'
  | 'repeat'
  | 'defaultPrevented'
  | 'preventDefault'
>;

/**
 * Resolve `e` and run the first handler that accepts it.
 *
 * Drops: an event already `defaultPrevented` (an extension or another
 * handler took it), bare modifiers and IME composition (`chordFromEvent`).
 * Matching is the exact chord: modifiers held must equal the binding's.
 * An auto-repeat of an action that does not repeat is swallowed (holding F
 * must not flicker fullscreen, holding Escape must leave one level).
 * `preventDefault()` happens only on a match.
 *
 * `handlers` is a map, or a resolver (`KeyResolver`). The action list is
 * the keymap's own (`Keymap.actions`).
 *
 * Returns the action that took the key, or null.
 */
export function dispatchKey(
  e: KeyEventLike,
  ctx: DispatchContext,
  handlers: Partial<Record<ActionId, KeyHandler>> | KeyResolver,
  keymap: Keymap = currentKeymap()
): ActionId | null {
  if (e.defaultPrevented) return null;
  const chord = chordFromEvent(e);
  if (!chord) return null;
  const resolve: KeyResolver =
    typeof handlers === 'function' ? handlers : (id) => handlers[id] ?? undefined;
  for (const scope of ctx.scopes) {
    for (const id of lookup(keymap, scope, chord, ctx.mode)) {
      const action = keymap.actions.get(id)!;
      const handler = resolve(id, action);
      if (!handler) continue;
      if (e.repeat && !action.repeat) {
        e.preventDefault();
        return id;
      }
      if (handler(e as KeyboardEvent) === false) continue;
      e.preventDefault();
      return id;
    }
  }
  return null;
}
