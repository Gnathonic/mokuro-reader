/**
 * The active profile's keymap, compiled ONCE at module level from one
 * `settings` subscription and recompiled only when the `keyBindings`
 * reference changes. Nothing here is per component: library cards render
 * N times (CLAUDE.md, "Svelte 5 Reactive Performance"), so they read
 * `currentKeymap()` inside their key handler instead of deriving a store.
 */

import { derived, writable, type Readable } from 'svelte/store';
import { settings } from '$lib/settings/settings';
import type { ActionId } from './actions';
import { formatChord } from './chord';
import { compileKeymap, type Keymap } from './keymap';
import { initKeyLabels, isApplePlatform, keyLabelsVersion, labelForCode } from './key-labels';

let current: Keymap = compileKeymap(undefined);
let compiledFrom: unknown = undefined;
const store = writable<Keymap>(current);

settings.subscribe((s) => {
  const bindings = s?.keyBindings;
  if (bindings === compiledFrom) return;
  compiledFrom = bindings;
  current = compileKeymap(bindings);
  store.set(current);
});

initKeyLabels();

/** The live keymap as a store (settings UI). */
export const keymap: Readable<Keymap> = { subscribe: store.subscribe };

/** The live keymap, read at event time. */
export function currentKeymap(): Keymap {
  return current;
}

/** A device label for a chord (`Ctrl+Z`, `←`, `Cmd+Y`). */
export function chordLabel(chord: string): string {
  return formatChord(chord, { apple: isApplePlatform(), labelFor: labelForCode });
}

function hintFrom(map: Keymap, id: ActionId): string {
  const first = map.chords.get(id)?.[0];
  return first ? chordLabel(first) : '';
}

/**
 * The key hint for an action right now — the first chord's label, or ''
 * when the action is unbound (the caller then shows no hint).
 */
export function keyHint(id: ActionId): string {
  return hintFrom(current, id);
}

/**
 * Reactive hints for UI text: `$keyHints('reader.fullscreen')`. One store
 * for the whole app; a component subscribes once, however many hints it
 * shows.
 */
export const keyHints: Readable<(id: ActionId) => string> = derived(
  [store, keyLabelsVersion],
  ([$map]) =>
    (id: ActionId) =>
      hintFrom($map, id)
);
