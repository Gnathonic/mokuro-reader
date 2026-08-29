import { describe, expect, it } from 'vitest';

import { providerManager } from './provider-manager';

/**
 * `updateStatus()` ends in `statusStore.set`, which runs every subscriber
 * SYNCHRONOUSLY. A subscriber that reacts by touching provider state calls
 * straight back in from inside that `set`, and without a guard the nested call
 * publishes, runs the same subscribers again, and recurses — a silent hang or
 * a stack overflow with nothing in the UI to say why.
 *
 * No subscriber does that today. The store is public, and the guard is two
 * booleans.
 */
describe('providerManager.updateStatus re-entrancy', () => {
  it('bounds the publishes when a subscriber calls back into it', () => {
    let publishes = 0;
    // High enough that an unguarded implementation is unmistakable, low
    // enough that it terminates rather than blowing the stack.
    const RUNAWAY_CEILING = 200;

    const unsubscribe = providerManager.status.subscribe(() => {
      publishes += 1;
      if (publishes < RUNAWAY_CEILING) providerManager.updateStatus();
    });

    try {
      expect(() => providerManager.updateStatus()).not.toThrow();
    } finally {
      unsubscribe();
    }

    // The subscriber really did re-enter (a guard that never fired would
    // prove nothing)...
    expect(publishes).toBeGreaterThan(1);
    // ...and the re-entry did not run away. `subscribe` publishes once on
    // attach, then at most MAX_RESTATE_PASSES recomputes per outer call.
    expect(publishes).toBeLessThan(20);
  });

  it('still publishes normally with no re-entrant subscriber', () => {
    let publishes = 0;
    const unsubscribe = providerManager.status.subscribe(() => {
      publishes += 1;
    });

    providerManager.updateStatus();
    providerManager.updateStatus();
    unsubscribe();

    // One on attach plus one per call: the guard must not swallow ordinary
    // sequential updates.
    expect(publishes).toBe(3);
  });
});
