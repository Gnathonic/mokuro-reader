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
 * THREE UNITS, AND WHY EACH CONTRACT PICKS THE ONE IT DOES. `countIdbOps`
 * reports round trips (`"<store>.<op>"`), index reads (`"<store>.idx.<op>"`)
 * and transactions (`"tx.<stores>.<mode>"`). They are not interchangeable:
 *
 * 1. WRITE TRANSACTIONS are the catalog's real currency — Dexie broadcasts
 *    `storagemutated` once per readwrite commit, so on `volumes` a write
 *    transaction is a change signal is a full re-derive. Round-trip counts
 *    are blind to it: N rows written in ONE transaction and N rows written in
 *    N transactions issue exactly the same N `put`s. CONTRACT 4 is built on
 *    this, and the MODE qualifier is load-bearing — the per-volume keyed
 *    reads would otherwise swamp the bound.
 * 2. ROUND TRIPS are the right unit when the regression is "read the whole
 *    table instead of the one row" (CONTRACT 2) or "write when you should not
 *    have written at all" (CONTRACT 3).
 * 3. NEITHER can see work Dexie serves from its own cache. Dexie 4 answers a
 *    re-running liveQuery querier out of an in-memory cache: measured here,
 *    22 querier executions produced only ~4 IndexedDB `getAll` round trips. A
 *    cached answer still costs the full row set — thumbnail blobs included —
 *    being handed to whatever consumes it, so where the expensive thing is
 *    the CALL rather than the round trip, count the call (CONTRACT 1 spies on
 *    `db.volumes.toArray` for exactly that reason).
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
  readingHistory,
  scheduleSeriesFileWriteMock
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
    readingHistory: createStore({} as Record<string, unknown>),
    scheduleSeriesFileWriteMock: vi.fn()
  };
});

// One authenticated account, so a row-less cover has a scope to be attributed
// to in `cloud_covers` (`cover-persist.ts`'s ROUTING rule drops an unscoped
// one). `cloudFiles` is the same listing store `$lib/catalog/index.ts` joins;
// the folder/listing lookups are what `cover-service.ts`'s case-3 resolution
// reads. An EMPTY `getCloudVolumesBySeries` selects the image-only branch of
// that resolution — no `.mokuro` sidecar to pull, no cover sidecar to fetch —
// so CONTRACT 4 exercises the batch queue itself with no network in the way.
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    cloudFiles,
    getActiveProvider: () => ({
      type: 'webdav',
      getStatus: () => ({ isAuthenticated: true, accountScope: 'webdav:perf-contracts' })
    }),
    resolveCloudFolderTitle: (title: string) => title,
    getCloudVolumesBySeries: () => [] as unknown[]
  }
}));
// Never reached on CONTRACT 4's image-only path; stubbed so the real module's
// download plumbing stays out of this file's graph.
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: vi.fn(async () => null),
  getCachedCloudThumbnail: vi.fn(() => undefined)
}));
// Doubles as CONTRACT 4's "the batch has landed" signal: `materializeBatch`
// calls this once per cloud folder, after its materialize has committed. It
// touches no IndexedDB, which is what lets CONTRACT 4 wait for the real
// 750ms batch window from INSIDE its counted block without polluting the
// transaction counts it is asserting on.
vi.mock('$lib/metadata/series-file-sync', () => ({
  scheduleSeriesFileWrite: (...a: unknown[]) => scheduleSeriesFileWriteMock(...a)
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
import {
  _resetCoverServiceForTests,
  MATERIALIZE_BATCH_MAX_ENTRIES,
  requestCover
} from '$lib/catalog/cover-service';
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

/**
 * A BARE cloud placeholder — no row, no series-index entry, `'unknown'`
 * version and zero counts — which is what sends `cover-service.ts` down its
 * case-3/4 resolution path. `cloudPath` tracks the volume title the way a
 * real placeholder's does.
 */
function barePlaceholder(index: number): VolumeMetadata {
  const volumeTitle = `Volume ${index}`;
  return {
    volume_uuid: `ph-${index}`,
    series_uuid: 's1',
    series_title: 'Dr Stone',
    volume_title: volumeTitle,
    mokuro_version: 'unknown',
    page_count: 0,
    character_count: 0,
    page_char_counts: [],
    isPlaceholder: true,
    cloudProvider: 'webdav',
    cloudFileId: `archive-${index}`,
    cloudPath: `Dr Stone/${volumeTitle}.cbz`,
    cloudSize: 12345,
    cloudModifiedTime: '2026-01-01T00:00:00.000Z'
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
  _resetCoverServiceForTests();
  scheduleSeriesFileWriteMock.mockClear();
  readingHistory.set({});
});

afterEach(async () => {
  while (pendingCleanups.length) pendingCleanups.pop()?.();
  vi.restoreAllMocks(); // CONTRACT 1 spies on db.volumes.toArray
  _resetCoverPersistForTests(); // cancel a pending timer before it can fire against a cleared table
  _resetCoverServiceForTests();
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
    // Open the database FIRST: opening it is itself several transactions
    // (Dexie's schema check spans every store), and counting those would make
    // the exact transaction assertions below depend on test order.
    await db.volumes.count();

    const counts = await countIdbOps(async () => {
      await db.volumes.toArray();
      await db.volumes.get('nope');
    });

    expect(counts['volumes.getAll']).toBe(1);
    expect(counts['volumes.get']).toBe(1);
    // Transactions are counted too — the number CONTRACT 4 leans on. Dexie
    // wraps each of the two reads above in its own auto-transaction.
    expect(counts['transactions']).toBe(2);
    expect(counts['tx.volumes.readonly']).toBe(2);
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

    // The transaction wrapper is permanent by design (Dexie binds
    // `idbdb.transaction` at open time — see the helper), so identity is the
    // wrong thing to assert for it. What has to hold instead is that it
    // stopped ATTRIBUTING: work done between counted blocks must not leak
    // into the next block's counts.
    await db.volumes.toArray();
    const after = await countIdbOps(async () => {
      await db.volumes.get('nope');
    });
    expect(after['transactions']).toBe(1);
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
// same one `put` per row, so it is invisible to a round-trip count. The
// one-transaction-per-burst property is CONTRACT 4's job below.
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

// CONTRACT 4 — a burst of case-3 resolutions commits as ONE write
// transaction, not one per volume.
//
// THE number this whole plan is really about. Dexie broadcasts
// `storagemutated` once per readwrite COMMIT, so on the `volumes` table a
// write transaction is a change signal is a full catalog re-derive — a
// placeholder scan, display-title resolution, a re-sort and the on-screen
// canvas redraws behind it. Before Task 3, `cover-service.ts` called
// `materializeSeriesVolumes` once per resolved volume, so a browsed screenful
// of cloud-only cards paid one of those per CARD; on the 12,520-file library
// that is what grew `volumes` from 434 to 11,354 rows while the main thread
// stayed busy back to back. Resolution is still inherently per volume (each
// pulls its own sidecar through the backfill semaphore) — the WRITE is not:
// `queueMaterialization` collects a burst and issues one materialize per
// series.
//
// This is the property the other three contracts structurally cannot see.
// Round-trip counts are blind to it: N rows written in one transaction and N
// rows written in N transactions issue exactly the same N `put`s. Only the
// transaction count separates them, and only when it is qualified by MODE —
// the reads (one keyed `db.volumes.get` per volume, in `resolveAndDeliver`)
// are per volume by design and would otherwise swamp the bound.
describe('CONTRACT 4: case-3 row writes batch into one transaction', () => {
  it('commits a burst of resolutions in a bounded number of write transactions', async () => {
    const N = 20;
    // Deliberately UNDER the queue's size threshold, so the quiet-period
    // window is what closes this batch. A burst above the threshold would
    // legitimately split into more than one, and this bound would be wrong.
    expect(N).toBeLessThan(MATERIALIZE_BATCH_MAX_ENTRIES);

    const counts = await countIdbOps(async () => {
      for (let i = 0; i < N; i++) requestCover(barePlaceholder(i));

      // Wait out the REAL batch window rather than draining it by hand, so
      // the cadence itself is under test. `scheduleSeriesFileWrite` is fired
      // once per cloud folder at the END of a batch and touches no
      // IndexedDB, which is what makes it safe to poll from inside the
      // counted block.
      await vi.waitFor(() => expect(scheduleSeriesFileWriteMock).toHaveBeenCalled(), {
        timeout: 8000
      });
    });

    expect(counts['tx.volumes.readwrite'] ?? 0).toBeLessThanOrEqual(3);
    // Anchor: the bound is only meaningful if a write happened at all...
    expect(counts['tx.volumes.readwrite'] ?? 0).toBeGreaterThanOrEqual(1);
    // ...and if that one transaction really did mint every row in the burst.
    expect(await db.volumes.count()).toBe(N);
  }, 15000);
});
