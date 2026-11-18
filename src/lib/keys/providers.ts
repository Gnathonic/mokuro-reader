/**
 * One keyboard listener outside the reader (#55, spec 17.4).
 *
 * Views and hovered cards do not own a window listener: each PROVIDES the
 * handlers of its scope while it is live — a view while it is mounted, a card
 * while the pointer is on it, a dialog while it is the top one — and
 * `+layout.svelte`'s single listener dispatches to them. So the order of
 * trying is decided in one place (the hovered card's scope, the view's scope,
 * `app`) and not by which component happened to attach its listener first.
 *
 * The reader keeps its own listener (`Reader.svelte`): `edit`, `reader` and
 * `app` there are never provided through here.
 *
 * Plain module state, no stores, and nothing imported but the registry's
 * types: a card renders N times and provides only while hovered, and the
 * listener (`outside-reader.ts`) reads the table at event time.
 */
import { SCOPES, type KeyScope, type ScopeActionId } from './actions';
import type { KeyHandler } from './dispatch';

/** The scopes a component provides: everything but the reader's own three. */
export type ProvidedScope = Exclude<KeyScope, 'edit' | 'reader' | 'app'>;

type HandlerMap = Partial<Record<string, KeyHandler>>;

/** scope → its providers, oldest first. The newest one answers. */
const providers = new Map<KeyScope, HandlerMap[]>();

/**
 * Answer `scope`'s actions with `handlers` until the returned disposer runs.
 * The map must hold every hand-registered action of the scope (type-checked).
 * The newest provider of a scope wins; disposing it hands the scope back to
 * the one before it, and a disposer only ever removes its own entry.
 */
export function provideKeyHandlers<S extends ProvidedScope>(
  scope: S,
  handlers: Record<ScopeActionId<S>, KeyHandler>
): () => void {
  const entry = handlers as HandlerMap;
  const stack = providers.get(scope);
  if (stack) stack.push(entry);
  else providers.set(scope, [entry]);
  return () => {
    const live = providers.get(scope);
    const at = live?.lastIndexOf(entry) ?? -1;
    if (!live || at < 0) return;
    live.splice(at, 1);
    if (live.length === 0) providers.delete(scope);
  };
}

export function isProvided(scope: KeyScope): boolean {
  return providers.has(scope);
}

/** The handler the newest provider of `scope` has for `id`. */
export function providedHandler(scope: KeyScope, id: string): KeyHandler | undefined {
  const stack = providers.get(scope);
  return stack?.[stack.length - 1]?.[id];
}

const ALL_SCOPES = Object.keys(SCOPES) as KeyScope[];

/**
 * The scopes the layout tries for one key press, highest precedence first.
 *
 * - Under a dialog: only a PROVIDED dialog scope (the series editor while it
 *   is the top dialog). Never `app`, never the page under the dialog.
 * - Otherwise: a provided scope that shadows the view's (the card under the
 *   pointer), the view's own scope, then `app`.
 */
export function scopesOutsideReader(
  viewScope: KeyScope | undefined,
  dialogOpen: boolean
): KeyScope[] {
  if (dialogOpen) return ALL_SCOPES.filter((s) => SCOPES[s].dialog && isProvided(s));
  const hovered = viewScope
    ? ALL_SCOPES.filter((s) => SCOPES[s].shadows.includes(viewScope) && isProvided(s))
    : [];
  return [...hovered, ...(viewScope ? [viewScope] : []), 'app'];
}
