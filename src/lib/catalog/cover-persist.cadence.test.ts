import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

/**
 * The flush CADENCE (`cover-persist.ts`'s `armTimer`/`runDrain`/
 * `flushOneBatch`), under fake timers — split out from
 * `cover-persist.test.ts` because real Dexie (`fake-indexeddb`) hangs under
 * `vi.useFakeTimers()` (see `cover-service.retry.test.ts`'s note, the same
 * issue). `db` here is a plain in-memory stub, same pattern.
 *
 * WHAT THIS FILE REPLACED. It used to guard an ADAPTIVE cadence: the flush
 * delay DOUBLED from 750ms up to 8,000ms whenever a batch started collecting
 * within 750ms of the last flush, on the theory that fewer flushes meant
 * fewer catalog re-derives. Measured on a 12,520-file / 1,027-series library
 * that made batches GROW as the burst intensified — roughly 270 / 535 /
 * 1,070 / 2,140 covers, the last of them ~66MB of `File` objects in a single
 * IndexedDB transaction. The cadence is now FIXED and the BATCH is capped
 * (`COVER_PERSIST_MAX_BATCH`), so pressure produces MORE, SMALLER
 * transactions instead of fewer, enormous ones.
 *
 * The tests below are therefore the mirror image of the ones they replace:
 * the window must never widen, and no batch may exceed the cap however hard
 * the queue is pushed.
 */

vi.mock('$lib/catalog/thumbnail-cache', () => ({
  thumbnailCache: { invalidate: vi.fn() }
}));

const { rowsByUuid, transactionSpy, batchSizes } = vi.hoisted(() => ({
  rowsByUuid: new Map<string, VolumeMetadata>(),
  transactionSpy: vi.fn(),
  // Every flush reads its whole batch with ONE `bulkGet`, so the key counts
  // handed to this stub ARE the batch sizes.
  batchSizes: [] as number[]
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
    transaction: (_mode: string, _table: unknown, body: () => Promise<unknown>) => {
      transactionSpy();
      return body();
    }
  }
}));

// `cover-persist.ts`'s flush consults the reading-state store
// (`$lib/settings/volume-data`) to tell a genuine relationship apart from a
// row minted purely by browsing. Hand-rolled (same pattern as
// `cover-persist.test.ts`) so `row()` below can mark itself as a
// relationship without touching real localStorage — this file's own concern
// is the flush CADENCE, not routing, so every row here should land.
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
    // Mutated in place (never re-spread) because these tests queue thousands
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
  COVER_PERSIST_BASE_DELAY_MS,
  COVER_PERSIST_MAX_BATCH,
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

beforeEach(() => {
  _resetCoverPersistForTests();
  transactionSpy.mockClear();
  batchSizes.length = 0;
  rowsByUuid.clear();
  readingHistory.clear();
});

afterEach(() => {
  _resetCoverPersistForTests();
  vi.useRealTimers();
});

describe('the interactive case stays snappy', () => {
  it('a single wave — everything queued together, nothing following — costs exactly one flush at the fixed delay', async () => {
    vi.useFakeTimers();
    queueWave(0, 20);

    // Just short of the delay: nothing has flushed yet.
    await vi.advanceTimersByTimeAsync(COVER_PERSIST_BASE_DELAY_MS - 1);
    expect(transactionSpy).not.toHaveBeenCalled();

    // Exactly at the delay: the one and only flush for this wave.
    await vi.advanceTimersByTimeAsync(1);
    expect(transactionSpy).toHaveBeenCalledTimes(1);

    // Nothing follows — no further flush ever fires, however long we wait.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(batchSizes).toEqual([20]);
    expect(landedCount()).toBe(20);
  });
});

describe('the cadence is FIXED — pressure never widens the window', () => {
  it('a wave arriving immediately after a flush still flushes at the base delay, not a doubled one', async () => {
    vi.useFakeTimers();

    // Ten back-to-back cycles, each starting the instant the previous flush
    // finished — precisely the pattern the deleted backoff treated as
    // evidence to double the delay (750 → 1500 → 3000 → 6000 → 8000…).
    for (let cycle = 0; cycle < 10; cycle++) {
      queueWave(cycle * 5, 5);

      // One tick short of the FIXED delay: still nothing. This half keeps the
      // assertion honest — a window that HAD grown would also satisfy
      // "nothing yet", but could not then satisfy the line after it.
      await vi.advanceTimersByTimeAsync(COVER_PERSIST_BASE_DELAY_MS - 1);
      expect(transactionSpy).toHaveBeenCalledTimes(cycle);

      // Exactly at the fixed delay, every cycle. A widened window (the old
      // behaviour: 1,500ms on cycle 1, 3,000ms on cycle 2, …) would still be
      // waiting here.
      await vi.advanceTimersByTimeAsync(1);
      expect(transactionSpy).toHaveBeenCalledTimes(cycle + 1);
    }

    await vi.advanceTimersByTimeAsync(1);
    expect(landedCount()).toBe(50);
  });
});

describe('batches shrink under pressure instead of growing', () => {
  it('a burst at the cap flushes on the spot, without waiting out the debounce at all', async () => {
    vi.useFakeTimers();

    queueWave(0, COVER_PERSIST_MAX_BATCH);

    // NOT ONE MILLISECOND advanced: reaching the cap opens the write
    // transaction from inside `installCover` itself. A cadence that only ever
    // flushed on its timer would be at zero here.
    expect(transactionSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(COVER_PERSIST_BASE_DELAY_MS + 1);
    expect(batchSizes).toEqual([COVER_PERSIST_MAX_BATCH]);
    expect(landedCount()).toBe(COVER_PERSIST_MAX_BATCH);
  });

  it('sustained arrival far above the cap produces many bounded batches, never one enormous one', async () => {
    vi.useFakeTimers();

    // 250 covers every 200ms — each individual wave overshoots the cap by
    // more than a whole batch, so the queue really does keep refilling while
    // a bounded transaction is in flight. This is the shape that produced the
    // old 270 / 535 / 1,070 / 2,140 growth curve.
    const WAVE_INTERVAL_MS = 200;
    const PER_WAVE = 250;
    const TOTAL_WAVES = 12;
    const TOTAL = PER_WAVE * TOTAL_WAVES;

    for (let w = 0; w < TOTAL_WAVES; w++) {
      queueWave(w * PER_WAVE, PER_WAVE);
      await vi.advanceTimersByTimeAsync(WAVE_INTERVAL_MS);
    }
    await vi.advanceTimersByTimeAsync(COVER_PERSIST_BASE_DELAY_MS * 4);

    // THE contract: no batch, ever, is bigger than the cap.
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(COVER_PERSIST_MAX_BATCH);
    // Anchor: the burst really did split into many batches.
    expect(batchSizes.length).toBeGreaterThanOrEqual(Math.ceil(TOTAL / COVER_PERSIST_MAX_BATCH));
    // And they do not TREND upward — the last batches are no bigger than the
    // first, which is what "smaller under pressure, not larger" means.
    expect(Math.max(...batchSizes.slice(-3))).toBeLessThanOrEqual(
      Math.max(...batchSizes.slice(0, 3))
    );

    // Nothing lost: every wave's cover landed. (This burst stays under
    // `COVER_PERSIST_MAX_PENDING`, so the overflow policy never engages —
    // that one is covered in `cover-persist.test.ts`.)
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(TOTAL);
    expect(landedCount()).toBe(TOTAL);
  }, 20000);
});

describe('the debounce only ever defers WHEN a flush happens, never whether', () => {
  it('a direct flushPendingCoverPersists() call still drains everything immediately, bypassing the cadence entirely', async () => {
    const { flushPendingCoverPersists } = await import('./cover-persist');
    queueWave(0, 1);

    await flushPendingCoverPersists();

    expect(rowsByUuid.get('v-0')?.thumbnail_width).toBe(210);
  });

  it('a forced drain empties a queue several batches deep, in bounded batches', async () => {
    const { flushPendingCoverPersists } = await import('./cover-persist');
    const N = COVER_PERSIST_MAX_BATCH * 3 + 7;
    queueWave(0, N);

    await flushPendingCoverPersists();

    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(COVER_PERSIST_MAX_BATCH);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(N);
    expect(landedCount()).toBe(N);
  });
});
