import type { Readable } from 'svelte/store';

export interface WaitForOptions {
  /** Reject with `Error(timeoutMessage)` after this many ms (and stop listening). */
  timeoutMs?: number;
  timeoutMessage?: string;
}

/**
 * Resolves with the first value of `store` that satisfies `pred`, its current
 * one included, and stops listening.
 *
 * A store calls back from INSIDE `subscribe()` with its current value, before
 * the unsubscriber is returned: a value that already matches is unsubscribed
 * right after `subscribe()` returns. A later match unsubscribes in a
 * microtask, outside the store's own notification loop.
 */
export function waitFor<T>(
  store: Readable<T>,
  pred: (value: T) => boolean,
  options: WaitForOptions = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      done = true;
      if (timer) clearTimeout(timer);
      if (unsubscribe) {
        const off = unsubscribe;
        queueMicrotask(() => off());
      }
    };
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (done) return;
        finish();
        reject(new Error(options.timeoutMessage ?? 'Timed out'));
      }, options.timeoutMs);
    }
    unsubscribe = store.subscribe((value) => {
      if (done || !pred(value)) return;
      finish();
      resolve(value);
    });
    if (done) unsubscribe();
  });
}
