import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { VolumeMetadata } from '$lib/types';
import type { CloudThumbnailResult } from '$lib/catalog/cloud-thumbnails';

/**
 * OPERATION-COUNT CONTRACTS.
 *
 * Everything asserted in this file is a "how many times" property, never a
 * "what result" one: the catalog returned exactly the right rows before the
 * scan-storm fixes and returns exactly the right rows after them — it just
 * took 145 full `volumes` scans in a 20-second window to do it, with
 * individual scans queueing behind each other until the worst one reported
 * 16,560ms. No ordinary correctness test can see that regress, and the
 * browser benchmarks that measured it need a 12,520-file cloud account, so
 * they cannot run in CI.
 *
 * This suite is the CI-runnable net: a real Dexie over `fake-indexeddb`, with
 * the `IDBObjectStore`/`IDBIndex` prototypes counted for the duration of one
 * callback (`countIdbOps`), asserting BOUNDS on the resulting counts. The
 * bounds are deliberately loose — they are here to catch the order-of-
 * magnitude failure mode (1 → 145), not a fix that legitimately shifts a
 * count by one.
 *
 * TWO THINGS THIS TECHNIQUE CANNOT SEE, both worth knowing before adding a
 * contract here:
 *
 * 1. TRANSACTIONS. `countIdbOps` counts object-store and index operations, so
 *    it measures round trips. "One burst, one transaction" — the property
 *    behind the batched case-3 row writes, and the reason the catalog gets
 *    ONE `storagemutated` signal for a whole batch — is invisible to it, and
 *    is pinned instead by the call-count spies in `cover-service.test.ts` and
 *    the liveQuery-emission counts in `cover-persist.test.ts`.
 * 2. WORK DEXIE SERVES FROM ITS OWN CACHE. Dexie 4 answers a re-running
 *    liveQuery querier out of an in-memory cache: measured here, 22 querier
 *    executions produced only ~4 IndexedDB `getAll` round trips. A cached
 *    answer still costs the full row set — thumbnail blobs included — being
 *    handed to whatever consumes it, so where the expensive thing is the CALL
 *    rather than the round trip, count the call (see CONTRACT 1).
 */

// A real Dexie under its own database name — `countIdbOps` can only count
// operations that actually reach IndexedDB, so the `db` module is the one
// thing in this file that must NOT be a stub.
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_perf_contracts_test') };
});

const {
  cloudFiles,
  seriesMetadataMap,
  seriesIndexMap,
  cloudCoverMap,
  routeParams,
  readingHistory
} = vi.hoisted(() => {
  // vi.mock factories are hoisted above imports, so the stores they close
  // over are hand-rolled here rather than built with svelte/store's
  // `writable` — same constraint, and the same helper, as
  // `catalog-store.test.ts`.
  function createStore<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      },
      set(v: T) {
        value = v;
        subs.forEach((fn) => fn(value));
      }
    };
  }

  return {
    cloudFiles: createStore(new Map<string, unknown>()),
    seriesMetadataMap: createStore(new Map<string, unknown>()),
    seriesIndexMap: createStore(new Map<string, unknown>()),
    cloudCoverMap: createStore(new Map<string, unknown>()),
    routeParams: createStore({} as Record<string, string>),
    readingHistory: createStore({} as Record<string, unknown>)
  };
});

// One authenticated account, so a row-less cover has a scope to be attributed
// to in `cloud_covers` (`cover-persist.ts`'s ROUTING rule drops an unscoped
// one). `cloudFiles` is the same listing store `$lib/catalog/index.ts` joins.
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    cloudFiles,
    getActiveProvider: () => ({
      getStatus: () => ({ isAuthenticated: true, accountScope: 'webdav:perf-contracts' })
    })
  }
}));
vi.mock('$lib/util/hash-router', () => ({ routeParams }));
vi.mock('$lib/metadata/store', () => ({ seriesMetadataMap }));
vi.mock('$lib/metadata/series-index', () => ({ seriesIndexMap }));
vi.mock('$lib/catalog/cloud-covers-store', () => ({ cloudCoverMap }));
vi.mock('$lib/util/download-volume-repair', () => ({
  getLegacyImageOnlyVolumeUuid: () => undefined
}));
// The Worker-backed decode cache is orthogonal to every count here.
vi.mock('$lib/catalog/thumbnail-cache', () => ({
  thumbnailCache: { invalidate: vi.fn() }
}));
// The relationship gate reads this store; hand-rolled (same pattern as
// `cover-persist.test.ts`) so a test can say exactly which volumes the device
// has actually read, without touching localStorage.
vi.mock('$lib/settings/volume-data', () => ({ volumes: readingHistory }));

import { db } from '$lib/catalog/db';
import { volumes, VOLUMES_EMISSION_COALESCE_MS } from '$lib/catalog';
import {
  _resetCoverPersistForTests,
  flushPendingCoverPersists,
  installCover
} from '$lib/catalog/cover-persist';
import { countIdbOps } from './idb-op-counter';

/**
 * Cleanup is registered rather than written at the end of each test body, for
 * the reason `catalog-store.test.ts` documents: a test that throws mid-body
 * would otherwise skip its own teardown and leave a LIVE subscription behind,
 * which stops the next `subscribe()` from triggering a fresh `start()` at all
 * — turning one real failure into a cascade of misleading ones.
 */
const pendingCleanups: Array<() => void> = [];
const trackSubscription = (unsubscribe: () => void) => {
  pendingCleanups.push(unsubscribe);
  return unsubscribe;
};

/** Subscribe the real catalog readable, tracked for unconditional teardown. */
function subscribeToVolumes(): () => void {
  return trackSubscription(volumes.subscribe(() => {}));
}

/**
 * Let the trailing-edge coalesce window elapse and its (genuinely async) read
 * settle. Real timers on purpose: `fake-indexeddb` drives its requests off the
 * real task queue, so faking timers here would stall the very reads being
 * counted — the opposite trade-off from `catalog-store.test.ts`, whose `db` is
 * a plain promise-returning stub and can therefore be advanced synthetically.
 */
function settle(ms = VOLUMES_EMISSION_COALESCE_MS * 3): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRow(uuid: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 's1',
    series_title: 'One Piece',
    volume_title: uuid,
    mokuro_version: '0.4.11',
    page_count: 10,
    character_count: 100,
    page_char_counts: [100],
    metadata_only: true,
    ...overrides
  } as VolumeMetadata;
}

function makeCover(): CloudThumbnailResult {
  return {
    file: new File([new Uint8Array([1])], 'c.webp', { type: 'image/webp' }),
    width: 250,
    height: 350
  };
}

beforeEach(() => {
  _resetCoverPersistForTests();
  readingHistory.set({});
});

afterEach(async () => {
  while (pendingCleanups.length) pendingCleanups.pop()?.();
  vi.restoreAllMocks(); // CONTRACT 1 spies on db.volumes.toArray
  _resetCoverPersistForTests(); // cancel a pending timer before it can fire against a cleared table
  await db.volumes.clear();
  await db.cloud_covers.clear();
  readingHistory.set({});
});

/**
 * A counter that silently counted nothing would make every contract below
 * pass vacuously, so the helper's own floor is asserted before anything is
 * built on it — and so is its restore path, since a leaked prototype patch
 * would corrupt every later test in the process.
 */
describe('countIdbOps', () => {
  it('counts the operations it wraps', async () => {
    const counts = await countIdbOps(async () => {
      await db.volumes.toArray();
      await db.volumes.get('nope');
    });
    expect(counts['volumes.getAll']).toBe(1);
    expect(counts['volumes.get']).toBe(1);
  });

  it('restores the patched prototypes even when the callback throws', async () => {
    const originalGetAll = IDBObjectStore.prototype.getAll;
    const originalIndexGetAll = IDBIndex.prototype.getAll;

    await expect(
      countIdbOps(async () => {
        await db.volumes.toArray();
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(IDBObjectStore.prototype.getAll).toBe(originalGetAll);
    expect(IDBIndex.prototype.getAll).toBe(originalIndexGetAll);
  });
});

// CONTRACT 1 — a burst of writes costs ONE full scan, not one per write.
//
// Regression guarded: the catalog readable used to run `db.volumes.toArray()`
// INSIDE its `liveQuery`, and Dexie re-executes a liveQuery querier on every
// mutation — so the expensive scan had already happened by the time the
// downstream debounce ran; only the recompute it fed was collapsed. Measured
// against a real 12,520-file library: 145 full scans in a 20-second window,
// queueing behind each other until the worst reported 16,560ms. The fix
// inverts it — `liveQuery` wraps a cheap `count()` used purely as a change
// SIGNAL, and the scan runs at most once per quiet period
// (`VOLUMES_EMISSION_COALESCE_MS`). Two scans are expected here: one for the
// subscribe itself, one for the whole burst.
//
// COUNTED TWO WAYS, ON PURPOSE. The IDB round-trip bound alone would be a
// weak detector: Dexie 4 serves a re-running liveQuery querier from its own
// in-memory cache, so putting the scan back inside the liveQuery is measured
// here as 22 `toArray()` CALLS but only ~4 `getAll` round trips. The cost
// this contract exists to bound is the call — every one of them hands the
// whole row set, thumbnail blobs included, to a full catalog re-derive,
// whether or not IndexedDB was touched to produce it. The round-trip bound is
// kept as the second assertion because it is the one that would catch a
// regression on the read side of that cache.
//
// Complements `catalog-store.test.ts`'s own `toArrayCalls` test rather than
// repeating it: that file drives a hand-rolled `dexie` mock, so it pins the
// readable's internal logic; this one runs against the REAL Dexie liveQuery
// over a real (fake-indexeddb) database, so it also pins the wiring between
// them — a `count()` signal that stopped firing, or started firing per row,
// is invisible to a mocked liveQuery.
describe('CONTRACT 1: catalog scan coalescing', () => {
  it('coalesces a burst of writes into a single full scan', async () => {
    const scan = vi.spyOn(db.volumes, 'toArray');

    const counts = await countIdbOps(async () => {
      const stop = subscribeToVolumes();
      await settle();
      // 20 writes inside one quiet period, spaced far enough apart that each
      // one commits its own transaction and fires its own change signal —
      // the shape of a real convergence burst, and the shape that made the
      // pre-fix code scan per write.
      for (let i = 0; i < 20; i++) {
        await db.volumes.put(makeRow(`v${i}`));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await settle();
      stop();
    });

    expect(scan.mock.calls.length).toBeLessThanOrEqual(3);
    // Anchor: the bound is only meaningful if the scans happened at all.
    expect(scan.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(counts['volumes.getAll'] ?? 0).toBeLessThanOrEqual(3);
    expect(await db.volumes.count()).toBe(20);
  });
});

// CONTRACT 2 — persisting a batch of covers reads each row by key, never by
// scanning the table.
//
// The row blobs are what make a `volumes` scan expensive in the first place
// (thumbnails deserialize with every row), so the one thing the cover queue
// must never do is read the whole table to find the rows it is about to
// write. `flushPendingCoverPersists` re-reads each row INSIDE its write
// transaction — deliberately, so a download that finished mid-fetch cannot
// have its page-measured thumbnail clobbered — and that re-read has to stay a
// keyed `get` per entry.
//
// NOTE on what this does NOT measure: the whole burst is already ONE Dexie
// transaction, and Dexie broadcasts `storagemutated` once at commit, so the
// signal/scan win came from batching the burst, not from the write SHAPE
// inside it. `bulkPut` (materialize.ts) saves IDB round trips but issues the
// same one `put` per row, so it is invisible to these counts; the
// one-transaction-per-burst property is pinned by emission counts in
// `cover-persist.test.ts` instead.
describe('CONTRACT 2: cover persistence', () => {
  it('persists a batch of covers without a per-cover full scan', async () => {
    const N = 30;
    const history: Record<string, unknown> = {};
    for (let i = 0; i < N; i++) {
      await db.volumes.put(makeRow(`rel-${i}`));
      history[`rel-${i}`] = { progress: 1 }; // a real relationship: the cover belongs on the row
    }
    readingHistory.set(history);

    const counts = await countIdbOps(async () => {
      for (let i = 0; i < N; i++) {
        installCover({ volume_uuid: `rel-${i}`, cloudPath: `One Piece/v${i}.cbz` }, makeCover());
      }
      await flushPendingCoverPersists();
    });

    expect(counts['volumes.getAll'] ?? 0).toBe(0);
    expect(counts['volumes.get'] ?? 0).toBeLessThanOrEqual(2 * N);
    // Anchor: the counts above describe the row-write path actually running,
    // not a burst that quietly routed everything elsewhere.
    expect((await db.volumes.get('rel-0'))?.thumbnail).toBeInstanceOf(File);
  });
});

// CONTRACT 3 — browsing cloud-only series never writes a cover blob onto a
// `volumes` row.
//
// Regression guarded: render-demand materialization grew the table from 434
// to 11,354 rows carrying 417MB of blobs, which is what made every full scan
// above so expensive. A row minted purely by browsing (case-3 placeholder
// resolution: nothing installed, nothing read) is catalog knowledge, not a
// relationship, so its cover belongs in `cloud_covers` — keyed by account
// scope and path — and the row itself must not be touched at all.
describe('CONTRACT 3: cloud covers stay off relationship-less rows', () => {
  it('writes no volumes rows when only cloud covers are cached', async () => {
    const N = 10;
    // Rows exist (a series open materialized them) but carry no reading
    // history and nothing installed — exactly the "minted by browsing" case.
    for (let i = 0; i < N; i++) await db.volumes.put(makeRow(`browsed-${i}`));
    readingHistory.set({});
    const before = await db.volumes.count();

    const counts = await countIdbOps(async () => {
      for (let i = 0; i < N; i++) {
        installCover(
          { volume_uuid: `browsed-${i}`, cloudPath: `Dr Stone/Volume ${i}.cbz` },
          makeCover()
        );
      }
      await flushPendingCoverPersists();
    });

    // Not one write reached the `volumes` table.
    expect(counts['volumes.put'] ?? 0).toBe(0);
    expect(await db.volumes.count()).toBe(before);
    expect((await db.volumes.get('browsed-0'))?.thumbnail).toBeUndefined();

    // The blobs went to the cache table instead — nothing was dropped.
    expect(await db.cloud_covers.count()).toBe(N);
  });
});
