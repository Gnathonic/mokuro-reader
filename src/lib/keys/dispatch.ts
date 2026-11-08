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

import { ACTIONS_BY_ID, type ActionId, type KeyScope, type ReaderMode } from './actions';
import { chordFromEvent } from './chord';
import { lookup, type Keymap } from './keymap';
import { currentKeymap } from './live';

/**
 * Run the action. Return `false` to decline — the key then falls through to
 * the next candidate (e.g. `edit.delete` with nothing selected) and, if
 * nothing takes it, keeps its browser default.
 */
export type KeyHandler = (e: KeyboardEvent) => boolean | void;

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
 * Returns the action that took the key, or null.
 */
export function dispatchKey(
  e: KeyEventLike,
  ctx: DispatchContext,
  handlers: Partial<Record<ActionId, KeyHandler>>,
  keymap: Keymap = currentKeymap()
): ActionId | null {
  if (e.defaultPrevented) return null;
  const chord = chordFromEvent(e);
  if (!chord) return null;
  for (const scope of ctx.scopes) {
    for (const id of lookup(keymap, scope, chord, ctx.mode)) {
      const handler = handlers[id];
      if (!handler) continue;
      if (e.repeat && !ACTIONS_BY_ID.get(id)!.repeat) {
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
