import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_MUTATION_COALESCE_MS, CoalescedCacheStore } from './coalesced-cache-store';

/**
 * The state/emission split, pinned at the primitive. Every test here is
 * paired with the mutation that would fake it:
 *
 * - "one emission per burst" fails if `update()` publishes per mutation
 *   (the pre-fix behavior) — the burst then emits N times, not once;
 * - "read() is immediate" fails if `read()` returns the published side —
 *   the entry is then invisible until the flush;
 * - "final map, not a snapshot" fails if the flush captures the map when the
 *   timer is ARMED instead of when it fires;
 * - the supersede/cancel tests fail if `set()` stops cancelling the timer —
 *   the stale flush then lands as an extra emission.
 */
describe('CoalescedCacheStore', () => {
  let store: CoalescedCacheStore<string[]>;
  /** Every emission a subscriber saw AFTER the initial replay. */
  let seen: Map<string, string[]>[];
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new CoalescedCacheStore<string[]>();
    seen = [];
    unsubscribe = store.subscribe((map) => {
      seen.push(map);
    });
    // Drop the subscribe-time replay of the initial value; only real
    // emissions count.
    seen.length = 0;
  });

  afterEach(() => {
    unsubscribe();
    vi.useRealTimers();
  });

  const addEntry = (key: string) =>
    store.update((map) => new Map(map).set(key, [`${key}/file.cbz`]));

  it('publishes a burst of updates ONCE, carrying the final map — not per mutation, not an arm-time snapshot', () => {
    for (let i = 0; i < 10; i++) addEntry(`series-${i}`);

    // Nothing on the leading edge: subscribers re-derive at most once per
    // window, never once per file.
    expect(seen).toHaveLength(0);

    vi.advanceTimersByTime(CACHE_MUTATION_COALESCE_MS);

    expect(seen).toHaveLength(1);
    // All ten mutations rode the one emission. A flush that snapshotted the
    // map when the FIRST update armed the timer would publish size 1 here.
    expect(seen[0].size).toBe(10);
    expect(seen[0].get('series-9')).toEqual(['series-9/file.cbz']);

    // ...and the window really closed: quiet afterwards.
    vi.advanceTimersByTime(10 * CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
  });

  it('makes an update() visible to read() IMMEDIATELY while the emission is still pending', () => {
    addEntry('series-a');

    // The synchronous side sees it before any timer fires.
    expect(store.read().get('series-a')).toEqual(['series-a/file.cbz']);

    // And it genuinely is still pending — without these two lines the
    // assertion above would also hold for publish-per-add and prove nothing.
    expect(seen).toHaveLength(0);
    expect(store.hasPendingPublish()).toBe(true);

    vi.advanceTimersByTime(CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0].get('series-a')).toEqual(['series-a/file.cbz']);
  });

  it('set() supersedes a pending emission: the fresh map publishes now, the stale flush never fires', () => {
    addEntry('pre-fetch-entry');
    expect(store.hasPendingPublish()).toBe(true);

    const listing = new Map<string, string[]>([['listed-series', ['listed-series/vol.cbz']]]);
    store.set(listing);

    // The install published immediately — consumers wait on full listings.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(listing);
    expect(store.read()).toBe(listing);
    expect(store.hasPendingPublish()).toBe(false);

    // The pre-set timer is dead: nothing later clobbers the install with the
    // pre-fetch map.
    vi.advanceTimersByTime(10 * CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(listing);
  });

  it('set() with nothing pending publishes immediately and arms no timer', () => {
    const listing = new Map<string, string[]>([['s', ['s/v.cbz']]]);
    store.set(listing);

    expect(seen).toHaveLength(1);
    expect(store.hasPendingPublish()).toBe(false);

    vi.advanceTimersByTime(10 * CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
  });

  it('flush() publishes a pending mutation NOW, and is an identity-preserving no-op when idle', () => {
    addEntry('series-a');
    store.flush();

    expect(seen).toHaveLength(1);
    expect(seen[0].get('series-a')).toEqual(['series-a/file.cbz']);
    expect(store.hasPendingPublish()).toBe(false);

    // Idle flush spends nothing: no emission, no identity churn. This is the
    // arm the sameCacheMap skip leans on when no mutations are pending.
    store.flush();
    expect(seen).toHaveLength(1);

    vi.advanceTimersByTime(10 * CACHE_MUTATION_COALESCE_MS);
    expect(seen).toHaveLength(1);
  });

  it('a clear-shaped set() cancels the pending emission: the dead map never reaches subscribers', () => {
    addEntry('dead-account-series');
    expect(store.hasPendingPublish()).toBe(true);

    // What clearCache()/logout/account switch do.
    store.set(new Map());

    expect(store.hasPendingPublish()).toBe(false);
    vi.advanceTimersByTime(10 * CACHE_MUTATION_COALESCE_MS);

    // Exactly the clear's own (empty) publish, and no emission — before or
    // after it — ever carried the dead account's entry.
    expect(seen).toHaveLength(1);
    expect(seen[0].size).toBe(0);
    expect(seen.some((map) => map.has('dead-account-series'))).toBe(false);
  });
});
