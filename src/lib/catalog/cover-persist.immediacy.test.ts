import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

/**
 * The flush IMMEDIACY of `cover-persist.ts` (`scheduleDrain`/`runDrain`/
 * `flushOneBatch`), against a plain in-memory `db` stub (real Dexie over
 * `fake-indexeddb` hangs under `vi.useFakeTimers()` — see
 * `cover-service.retry.test.ts`'s note; the real-Dexie half of this module's
 * coverage lives in `cover-persist.test.ts`).
 *
 * WHAT THIS FILE REPLACED. It used to be `cover-persist.cadence.test.ts`,
 * which pinned a FIXED 750ms debounce (itself the replacement for a window
 * that WIDENED to 8s under pressure). Both were bandaids for the days when
 * every `cloud_covers` commit re-derived the whole catalog. That coupling is
 * gone — covers are out of `volumesWithPlaceholders`, a commit reaches only
 * the cards holding its paths — so the window had stopped preventing anything
 * and was only delaying paint by up to 750ms per cover. User ruling: "The
 * batch insertions make the ui seem less reactive… The user wants to see
 * asap, and the only remedy for ui jank is to background the downloads, not
 * to pace them."
 *
 * So these tests are the mirror image of the ones they replace: a cover must
 * be committed within a MICROTASK of install — no timer may even be armed —
 * and the only grouping allowed is the kind that costs zero latency
 * (synchronous co-arrival, and arrivals riding out an in-flight flush).
 * Reintroducing a wait of ANY fixed length — 750ms or 1ms — fails every test
 * here: they drain microtasks (or a single 0ms macrotask hop) and never
 * advance a clock far enough for a timer-based window to fire.
 */

vi.mock('$lib/catalog/thumbnail-cache', () => ({
  thumbnailCache: { invalidate: vi.fn() }
}));

const { rowsByUuid, transactionSpy, batchSizes, txGate } = vi.hoisted(() => ({
  rowsByUuid: new Map<string, VolumeMetadata>(),
  transactionSpy: vi.fn(),
  // Every flush reads its whole batch with ONE `bulkGet`, so the key counts
  // handed to this stub ARE the batch sizes.
  batchSizes: [] as number[],
  /**
   * When non-null, every `db.transaction` awaits it before running its body —
   * how the natural-batching test holds a flush "in IndexedDB" while more
   * covers arrive. The spy still fires at transaction OPEN, before the gate,
   * so "a second transaction was opened concurrently" stays observable.
   */
  txGate: { hold: null as Promise<void> | null }
}));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: async (uuid: string) => rowsByUuid.get(uuid),
      bulkGet: async (uuids: string[]) => {
        batchSizes.push(uuids.length);
        return uuids.map((u) => rowsByUuid.get(u));
      },
      put: async (row: VolumeMetadata) => {
        rowsByUuid.set(row.volume_uuid, row);
      },
      update: async (uuid: string, patch: Record<string, unknown>) => {
        const r = rowsByUuid.get(uuid);
        if (r) Object.assign(r, patch);
      }
    },
    transaction: async (_mode: string, _table: unknown, body: () => Promise<unknown>) => {
      transactionSpy();
      if (txGate.hold) await txGate.hold;
      return body();
    }
  }
}));

// `cover-persist.ts`'s flush consults the reading-state store
// (`$lib/settings/volume-data`) to tell a genuine relationship apart from a
// row minted purely by browsing. Hand-rolled (same pattern as
// `cover-persist.test.ts`) so `queueWave` below can mark its rows as
// relationships without touching real localStorage — this file's own concern
// is flush TIMING, not routing, so every row here should land.
const readingHistory = vi.hoisted(() => {
  const value: Record<string, unknown> = {};
  const subs = new Set<(v: Record<string, unknown>) => void>();
  return {
    store: {
      subscribe(fn: (v: Record<string, unknown>) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      }
    },
    // Mutated in place (never re-spread) because these tests queue hundreds
    // of covers and a fresh copy per cover would be quadratic.
    mark(uuid: string) {
      value[uuid] = { progress: 1 };
      subs.forEach((fn) => fn(value));
    },
    clear() {
      for (const k of Object.keys(value)) delete value[k];
      subs.forEach((fn) => fn(value));
    }
  };
});
vi.mock('$lib/settings/volume-data', () => ({
  volumes: readingHistory.store
}));

import {
  _resetCoverPersistForTests,
  COVER_PERSIST_MAX_BATCH,
  flushPendingCoverPersists,
  installCover
} from './cover-persist';
import type { CloudThumbnailResult } from './cloud-thumbnails';

function coverResult(name: string): CloudThumbnailResult {
  return { file: new File(['img'], name, { type: 'image/webp' }), width: 210, height: 297 };
}

/** Queue `count` covers for fresh, relationship-carrying rows, numbered from `from`. Purely synchronous, like a real arrival burst. */
function queueWave(from: number, count: number): void {
  for (let i = from; i < from + count; i++) {
    const uuid = `v-${i}`;
    rowsByUuid.set(uuid, {
      volume_uuid: uuid,
      series_uuid: 's',
      series_title: 'One Piece',
      volume_title: uuid,
      mokuro_version: '0.4.11',
      page_count: 5,
      character_count: 50,
      page_char_counts: [50],
      metadata_only: true
    } as VolumeMetadata);
    readingHistory.mark(uuid);
    installCover(uuid, coverResult(`${i}.webp`));
  }
}

/** How many of the queued rows actually received their cover. */
function landedCount(): number {
  let n = 0;
  for (const r of rowsByUuid.values()) if (r.thumbnail_width === 210) n += 1;
  return n;
}

/**
 * Yield to the microtask queue `rounds` times — and to nothing else. Every
 * hop in the drain (the arming `queueMicrotask`, each stubbed `db` await) is
 * one round, so a modest count exhausts the whole chain; what this
 * deliberately does NOT do is let any timer fire, which is what makes a
 * reintroduced `setTimeout` window — of any length — a guaranteed failure.
 */
async function drainMicrotasks(rounds = 32): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

beforeEach(() => {
  _resetCoverPersistForTests();
  transactionSpy.mockClear();
  batchSizes.length = 0;
  txGate.hold = null;
  rowsByUuid.clear();
  readingHistory.clear();
});

afterEach(() => {
  _resetCoverPersistForTests();
  txGate.hold = null;
  vi.useRealTimers();
});

describe('a cover is committed immediately — no window, no timer', () => {
  it('lands within a microtask of install, with fake timers that are NEVER advanced', async () => {
    // Fake timers, deliberately never ticked: if any code path between
    // install and commit waits on a timer — the removed 750ms window, or any
    // "small" replacement — the write can never happen in this test.
    vi.useFakeTimers();
    expect(vi.getTimerCount()).toBe(0);

    queueWave(0, 1);
    // Not synchronous — installCover must stay non-blocking (its return is
    // the card painting from memory; persistence is a background microtask).
    expect(transactionSpy).not.toHaveBeenCalled();

    await drainMicrotasks();

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(batchSizes).toEqual([1]);
    expect(landedCount()).toBe(1);
    // The second detector: not only did the write land without the clock
    // moving, nothing ever ARMED a timer to begin with.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a synchronous co-arrival burst shares ONE immediate flush — grouping that costs no latency', async () => {
    queueWave(0, 20);

    await drainMicrotasks();

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(batchSizes).toEqual([20]);
    expect(landedCount()).toBe(20);
  });
});

describe('natural batching: what arrives during a flush rides the next one', () => {
  it('groups mid-flight arrivals into the immediately following transaction, never a concurrent one', async () => {
    let release!: () => void;
    txGate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    // First cover: its flush opens at once and parks inside the (gated)
    // transaction, batch already snapshotted.
    queueWave(0, 1);
    await drainMicrotasks();
    expect(transactionSpy).toHaveBeenCalledTimes(1);

    // Two more arrive while that transaction is "in IndexedDB". No second
    // transaction may open — one flush at a time — and nothing lands yet.
    queueWave(1, 2);
    await drainMicrotasks();
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(landedCount()).toBe(0);

    // The moment the first commit completes, the SAME drain takes both
    // waiters as one batch — no re-arm, no window, no timer.
    release();
    await drainMicrotasks();
    expect(transactionSpy).toHaveBeenCalledTimes(2);
    expect(batchSizes).toEqual([1, 2]);
    expect(landedCount()).toBe(3);
  });

  it('a burst beyond the cap flushes back-to-back in cap-bounded slices, still without waiting', async () => {
    const N = COVER_PERSIST_MAX_BATCH * 2 + 50;
    queueWave(0, N);

    // One 0ms macrotask hop: the event loop exhausts EVERY microtask —
    // however deep the drain chain — before this timer fires, while a
    // reintroduced fixed window would still be waiting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(batchSizes).toEqual([
      COVER_PERSIST_MAX_BATCH,
      COVER_PERSIST_MAX_BATCH,
      N - 2 * COVER_PERSIST_MAX_BATCH
    ]);
    expect(transactionSpy).toHaveBeenCalledTimes(3);
    expect(landedCount()).toBe(N);
  });
});

describe('forced drains still work, and still respect the batch bound', () => {
  it('flushPendingCoverPersists drains everything and returns only once it has all landed', async () => {
    queueWave(0, 1);

    await flushPendingCoverPersists();

    expect(rowsByUuid.get('v-0')?.thumbnail_width).toBe(210);
  });

  it('a forced drain empties a queue several batches deep, in bounded batches', async () => {
    const N = COVER_PERSIST_MAX_BATCH * 3 + 7;
    queueWave(0, N);

    await flushPendingCoverPersists();

    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(COVER_PERSIST_MAX_BATCH);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(N);
    expect(landedCount()).toBe(N);
  });
});
