import { afterEach, describe, expect, it, vi } from 'vitest';
import { writable, type Readable } from 'svelte/store';
import { waitFor } from './store-wait';

/** A writable that counts its live subscribers. */
function counted<T>(initial: T) {
  const store = writable(initial);
  let live = 0;
  const readable: Readable<T> = {
    subscribe(run) {
      live++;
      const off = store.subscribe(run);
      return () => {
        live--;
        off();
      };
    }
  };
  return { store, readable, live: () => live };
}

describe('waitFor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves at once with a current value that matches, and stops listening', async () => {
    const s = counted(3);
    await expect(waitFor(s.readable, (v) => v > 2)).resolves.toBe(3);
    expect(s.live()).toBe(0);
  });

  it('waits for a later matching value, and stops listening', async () => {
    const s = counted(0);
    const waiting = waitFor(s.readable, (v) => v === 2);
    s.store.set(1);
    expect(s.live()).toBe(1);
    s.store.set(2);
    s.store.set(3);
    await expect(waiting).resolves.toBe(2);
    expect(s.live()).toBe(0);
  });

  it('rejects after its timeout, and stops listening', async () => {
    vi.useFakeTimers();
    const s = counted('');
    const waiting = waitFor(s.readable, (v) => v !== '', {
      timeoutMs: 1_000,
      timeoutMessage: 'Login timeout'
    });
    const outcome = expect(waiting).rejects.toThrow('Login timeout');
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    expect(s.live()).toBe(0);
  });

  it('a match before the timeout clears it', async () => {
    vi.useFakeTimers();
    const s = counted('');
    const waiting = waitFor(s.readable, (v) => v !== '', { timeoutMs: 1_000 });
    s.store.set('token');
    await expect(waiting).resolves.toBe('token');
    expect(vi.getTimerCount()).toBe(0);
  });
});
