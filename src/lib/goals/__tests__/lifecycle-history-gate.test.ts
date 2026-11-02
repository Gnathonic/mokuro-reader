import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
const { catalog, readyGate, backfill } = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return {
    catalog: { value: undefined as unknown, subs: [] as Array<(v: unknown) => void> },
    readyGate: { promise, resolve },
    backfill: vi.fn()
  };
});
vi.mock('$lib/catalog', () => ({
  volumesWithPlaceholders: {
    subscribe(fn: (v: unknown) => void) {
      catalog.subs.push(fn);
      fn(catalog.value);
      return () => {};
    }
  }
}));
vi.mock('$lib/reading-history/turns-store', async () => {
  const { readable } = await import('svelte/store');
  return {
    historyTurnsReady: () => readyGate.promise,
    historyTurns: readable(new Map()),
    getHistoryTurns: () => undefined
  };
});
vi.mock('../completed-at-backfill', () => ({ backfillCompletedAt: backfill }));
vi.mock('../snapshots', () => ({ finalizeGoalSnapshot: vi.fn() }));

import { initGoalsLifecycle } from '../lifecycle';

afterEach(() => vi.useRealTimers());

describe('goal maintenance waits for reading history', () => {
  it('does not back-date completions from a half-loaded projection', async () => {
    catalog.value = {};
    const stop = initGoalsLifecycle();
    await Promise.resolve();
    expect(backfill).not.toHaveBeenCalled();
    readyGate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(backfill).toHaveBeenCalled();
    stop();
  });
});
