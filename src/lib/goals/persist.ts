import { browser } from '$app/environment';
import type { Readable } from 'svelte/store';

/**
 * Persist a goals store to localStorage, skipping the write Svelte's own
 * subscribe contract would otherwise force at boot.
 *
 * `writable.subscribe(fn)` calls `fn` synchronously with the current value, so
 * a plain persisting subscriber writes the just-loaded value straight back —
 * a `JSON.stringify` plus a synchronous `localStorage.setItem` per store, on
 * the boot path, for every user in the world, including everyone who never
 * opens the tracker. Three stores evaluate at boot (`+layout.svelte` imports
 * the goals barrel for `initGoalsLifecycle`), so that was three of each.
 *
 * The first emission is dropped; every later one is a real change and is
 * written. A subsequent write that happens to serialize identically is also
 * skipped, which keeps a store that emits a new object with the same contents
 * (the merge write-back does exactly that) from churning the key.
 */
export function persistToLocalStorage<T>(
  store: Readable<T>,
  key: string,
  serialize: (value: T) => string
): void {
  if (!browser) return;

  let initial = true;
  let lastWritten: string | null = null;

  store.subscribe((value) => {
    if (initial) {
      initial = false;
      return;
    }

    const json = serialize(value);
    if (json === lastWritten) return;

    lastWritten = json;
    window.localStorage.setItem(key, json);
  });
}
