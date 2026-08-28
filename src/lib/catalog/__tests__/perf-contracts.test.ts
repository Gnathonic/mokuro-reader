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
  cloudListing,
  seriesMetadataMap,
  seriesIndexMap,
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
    // The flat listing `cover-install.ts` reads (`getAllCloudVolumes`), held in
    // a mutable box so a test can install one without re-mocking the manager.
    cloudListing: { files: [] as Array<Record<string, unknown>> },
    seriesMetadataMap: createStore(new Map<string, unknown>()),
    seriesIndexMap: createStore(new Map<string, unknown>()),
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
    getCloudVolumesBySeries: () => [] as unknown[],
    getAllCloudVolumes: () => cloudListing.files
  }
}));
// Never reached on CONTRACT 4's image-only path; stubbed so the real module's
// download plumbing stays out of this file's graph. CONTRACT 5 drives it
// directly (`mockResolvedValue`) to hand `cover-install.ts` a cover without a
// network.
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: vi.fn(async () => null),
  getCachedCloudThumbnail: vi.fn(() => undefined)
}));
// Doubles as CONTRACT 4's "the batch has landed" signal: `materializeBatch`
// calls this once per cloud folder, after its materialize has committed. It
// touches no IndexedDB, which is what lets CONTRACT 4 wait for the real
// materialize batch window from INSIDE its counted block without polluting
// the transaction counts it is asserting on.
vi.mock('$lib/metadata/series-file-sync', () => ({
  scheduleSeriesFileWrite: (...a: unknown[]) => scheduleSeriesFileWriteMock(...a)
}));
// Only the cloud scan is spied on; every other export (the cloud-field
// lookup, `isIndexedPlaceholder`, the sidecar indexers) stays real, because
// CONTRACT 4's resolution path runs through them.
vi.mock('$lib/catalog/placeholders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/catalog/placeholders')>();
  return { ...actual, generatePlaceholders: vi.fn(actual.generatePlaceholders) };
});
vi.mock('$lib/util/hash-router', () => ({ routeParams }));
vi.mock('$lib/metadata/store', () => ({ seriesMetadataMap }));
vi.mock('$lib/metadata/series-index', () => ({ seriesIndexMap }));
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
import { volumes, volumesWithPlaceholders, VOLUMES_EMISSION_COALESCE_MS } from '$lib/catalog';
import { generatePlaceholders } from '$lib/catalog/placeholders';
import {
  cachedCoverPaths,
  _getCloudCoversForTests,
  putCloudCovers
} from '$lib/catalog/cloud-covers';
import { cachedCoverPathSet } from '$lib/catalog/cloud-covers-store';
import { fetchCloudThumbnail } from '$lib/catalog/cloud-thumbnails';
import { installCoversForSeries } from '$lib/catalog/cover-install';
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

/**
 * An INDEX-ADOPTED placeholder with a cover sidecar pointer — `cover-service.ts`'s case
 * 2, the common shape for a browsed catalog (a compiled index or a synced `series.json`
 * supplies it for nearly every volume). Deliberately the fixture CONTRACT 7 uses: case 2
 * goes STRAIGHT to `fetchCloudThumbnail`, so "did the network get touched" is a real
 * question there. A bare placeholder would answer it vacuously — with no listing behind
 * it, case 4 returns before ever reaching the network.
 */
function indexedPlaceholder(index: number): VolumeMetadata {
  const volumeTitle = `Volume ${index}`;
  return {
    volume_uuid: `idx-ph-${index}`,
    series_uuid: 's1',
    series_title: 'Dr Stone',
    volume_title: volumeTitle,
    mokuro_version: '0.2.1',
    page_count: 180,
    character_count: 5000,
    page_char_counts: [],
    isPlaceholder: true,
    indexed: true,
    cloudProvider: 'webdav',
    cloudFileId: `archive-${index}`,
    cloudPath: `Dr Stone/${volumeTitle}.cbz`,
    cloudSize: 12345,
    cloudModifiedTime: '2026-01-01T00:00:00.000Z',
    cloudThumbnailFileId: `cover-${index}`,
    cloudThumbnailPath: `Dr Stone/${volumeTitle}.webp`,
    cloudThumbnailSize: 4096,
    cloudThumbnailModifiedTime: '2026-01-01T00:00:00.000Z'
  } as VolumeMetadata;
}

function makeCover(): CloudThumbnailResult {
  return {
    file: new File([new Uint8Array([1])], 'c.webp', { type: 'image/webp' }),
    width: 250,
    height: 350
  };
}

/** The scope the mocked provider reports, i.e. the one every cached cover here is keyed under. */
const SCOPE = 'webdav:perf-contracts';

/**
 * Blob size of one cached cover fixture. Big enough that a full-table read is
 * unmistakable against the O(1) budget, small enough that a hundred of them
 * cost nothing to write — the real library's mean is ~31.6KB.
 */
const COVER_BYTES = 8192;

/** A `cloud_covers` row for the archive at `<series>/Volume <index>.cbz`. */
function cachedCover(series: string, index: number, bytes = COVER_BYTES) {
  return {
    account_scope: SCOPE,
    path: `${series}/Volume ${index}.cbz`,
    thumbnail: new File([new Uint8Array(bytes)], `v${index}.webp`, { type: 'image/webp' }),
    width: 250,
    height: 350,
    cached_at: 1000 + index
  };
}

/** A cloud listing of `count` archives under one series, in the shape `cloudFiles` carries. */
function archiveListing(series: string, count: number): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      series,
      Array.from({ length: count }, (_, i) => ({
        provider: 'webdav',
        fileId: `cbz-${i}`,
        path: `${series}/Volume ${i}.cbz`,
        size: 2,
        modifiedTime: '2026-01-01T00:00:00.000Z'
      }))
    ]
  ]);
}

beforeEach(() => {
  _resetCoverPersistForTests();
  _resetCoverServiceForTests();
  scheduleSeriesFileWriteMock.mockClear();
  readingHistory.set({});
  cloudListing.files = [];
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

  // THE BYTE COUNTER'S OWN FLOOR, and the reason it is asserted as an exact
  // total rather than "greater than zero": every byte contract below reads as
  // rigorous while being satisfied by a counter that measures nothing, and
  // this helper has already shipped two counters that silently counted zero
  // (a helper that never ran, and a transaction wrapper installed after Dexie
  // had captured `idbdb.transaction`). Exact equality also catches the
  // opposite failure — a cursor listener attributing the same row twice —
  // which would inflate every bound instead of collapsing it.
  it('measures the blob bytes a value-reading query deserializes', async () => {
    const N = 3;
    const covers = Array.from({ length: N }, (_, i) => cachedCover('One Piece', i));
    await putCloudCovers(covers);
    const paths = covers.map((c) => c.path);

    // The `getAll` shape: one request, one array of rows.
    const scanned = await countIdbOps(async () => {
      await db.cloud_covers.toArray();
    });
    expect(scanned['cloud_covers.getAll']).toBe(1);
    expect(scanned['cloud_covers.bytes']).toBe(N * COVER_BYTES);

    // The CURSOR shape, which is the one the pre-fix cover store used: one
    // request, one `success` per row walked. The row read's `anyOf` takes
    // Dexie's value-reading cursor branch — the exact query that deserialized
    // ~437 MB per re-read on the reference library.
    const cursored = await countIdbOps(async () => {
      await _getCloudCoversForTests(SCOPE, paths);
    });
    expect(cursored['cloud_covers.openCursor'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(cursored['cloud_covers.bytes']).toBe(N * COVER_BYTES);
  });

  it('reports no bytes for a keys-only read, and proves that read happened', async () => {
    const N = 3;
    const covers = Array.from({ length: N }, (_, i) => cachedCover('One Piece', i));
    await putCloudCovers(covers);

    const counts = await countIdbOps(async () => {
      await cachedCoverPaths(
        SCOPE,
        covers.map((c) => c.path)
      );
    });

    // Zero bytes is the CLAIM about `primaryKeys()`, and the previous test is
    // what makes it a claim about the query rather than about the counter: the
    // identical fixture, read for values, reports N * COVER_BYTES.
    expect(counts['cloud_covers.bytes'] ?? 0).toBe(0);
    // Anchor: the same zero would hold for a query that never ran.
    expect(counts['cloud_covers.openKeyCursor'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  // THE `get` SHAPE'S OWN PROOF. `get` is metered precisely because Dexie's
  // `bulkGet` lowers to `getMany` — one `IDBObjectStore.get` PER KEY — so a
  // keyed whole-table re-read stays visible as a `get` storm instead of
  // hiding behind a single innocuous `getAll` (see the note on `VALUE_OPS`).
  // Until now the only EXACT-byte proof of that escape hatch lived in
  // `cover-resolver.test.ts`, a file this suite does not control: if that
  // test were deleted or rewritten, the helper could silently lose the
  // guarantee and nothing here would notice. Same exact-total style as the
  // `getAll` and cursor self-tests above.
  it('measures the blob bytes a keyed get deserializes — the bulkGet escape hatch', async () => {
    const N = 3;
    const covers = Array.from({ length: N }, (_, i) => cachedCover('One Piece', i));
    await putCloudCovers(covers);

    const counts = await countIdbOps(async () => {
      for (const c of covers) {
        await db.cloud_covers.get([SCOPE, c.path]);
      }
    });

    expect(counts['cloud_covers.get']).toBe(N);
    expect(counts['cloud_covers.bytes']).toBe(N * COVER_BYTES);
  });

  // THE METERING HOLE `INDEX_OPS` USED TO HAVE. Dexie 4 does not lower any
  // query to `IDBIndex.get` today (index reads lower to a cursor or
  // `getAll`), so this drives it directly against the raw backing
  // `IDBDatabase` rather than through Dexie — the only way to prove the
  // COUNTER no longer has a blind spot here, independent of what today's
  // query planner happens to emit.
  it('meters bytes through an index get', async () => {
    const cover = cachedCover('One Piece', 0);
    await putCloudCovers([cover]);

    const idbdb = db.backendDB();
    const counts = await countIdbOps(async () => {
      await new Promise<void>((resolve, reject) => {
        const tx = idbdb.transaction('cloud_covers', 'readonly');
        const req = tx.objectStore('cloud_covers').index('cached_at').get(cover.cached_at);
        req.addEventListener('success', () => resolve());
        req.addEventListener('error', () => reject(req.error));
      });
    });

    expect(counts['cloud_covers.idx.get']).toBe(1);
    expect(counts['cloud_covers.bytes']).toBe(COVER_BYTES);
  });

  // THE STRAGGLER WINDOW. `fn` resolving does not mean every request it
  // issued has fired its `success` event — an un-awaited request is the
  // simplest way to prove it, and fake-indexeddb schedules `success` on a
  // genuine macrotask (`setImmediate`/`setTimeout`, never a microtask — see
  // `idb-op-counter.ts`'s import comment), so `fn`'s own microtask turns
  // cannot have produced it yet. Without draining, `counts` would come back
  // from `countIdbOps` with NO `cloud_covers.bytes` key at all, and the byte
  // attribution would land later on the very object this test already holds
  // — exactly the mutation-after-return Finding 2 describes, and, in
  // CONTRACT 8a's back-to-back shape, the mutation that can shrink an
  // EARLIER measurement instead of this one.
  it('drains a straggler request before resolving, so a late success cannot land after return', async () => {
    const cover = cachedCover('One Piece', 0);
    await putCloudCovers([cover]);

    const counts = await countIdbOps(async () => {
      void db.cloud_covers.get([SCOPE, cover.path]);
    });

    expect(counts['cloud_covers.get']).toBe(1);
    expect(counts['cloud_covers.bytes']).toBe(COVER_BYTES);
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
// write. `flushPendingCoverPersists` re-reads the batch's rows INSIDE its
// write transaction — deliberately, so a download that finished mid-fetch
// cannot have its page-measured thumbnail clobbered — and that re-read has to
// stay KEYED.
//
// It is now one `bulkGet` for the whole batch rather than the sequential
// `db.volumes.get()` per entry it started as. This count cannot see that
// change, and must not be read as if it could: Dexie's `bulkGet` lowers to
// `getMany`, which issues one `IDBObjectStore.get` PER KEY — measured at 2N
// `volumes.get` for both shapes — so the round-trip bound below is identical
// either way. What it does bound is the thing that actually matters here:
// reads scale with the BATCH, never with the table, and no `getAll` is issued
// at all.
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

// CONTRACT 4 — case-3 resolutions that GENUINELY co-arrive still commit as
// ONE write transaction, not one per volume.
//
// DESIGN CHANGE (2026-08, catalog-cover-ingest unbatching): this bound was
// written when a `volumes` write transaction was, in effect, a full catalog
// re-derive per commit — `cover-service.ts` once called
// `materializeSeriesVolumes` per resolved volume, which is what grew
// `volumes` from 434 to 11,354 rows on the 12,520-file library while the
// main thread stayed busy back to back. Two things have moved since:
// covers were decoupled from derivation outright (CONTRACTS 6/8 pin that a
// `cloud_covers` commit cannot reach `generatePlaceholders` at all), and the
// catalog scan itself is coalesced per quiet period (CONTRACT 1), so a
// `volumes` commit costs a change signal and a `count()`, with the full
// re-derive amortized across the burst. On the strength of that — and of the
// user's ruling that batch windows were making the UI feel less reactive and
// must never pace what the user is waiting to see — `cover-persist.ts`'s
// 750ms cover window was REMOVED, and the materialize window here shrank to
// a 100ms co-arrival group (see `MATERIALIZE_BATCH_WINDOW_MS`).
//
// What this contract still pins is the property that survived the redesign:
// a burst of resolutions arriving TOGETHER (one browse gesture's worth) must
// not un-group into a write transaction per card. `volumes` commits are
// cheaper than they were, not free — each is a change signal, a `count()`,
// and pressure on the scan coalescer — and grouping a genuine co-arrival
// costs no latency, which is exactly the kind of batching the ruling keeps.
// The bound is the same ≤3 as before because the grouping mechanism is the
// same; what changed is WHY it holds (a short co-arrival window, not a long
// pacing one) and how fast the burst lands (within ~100ms, not 750ms).
//
// Round-trip counts are structurally blind to this property: N rows written
// in one transaction and N rows written in N transactions issue exactly the
// same N `put`s. Only the transaction count separates them, and only when it
// is qualified by MODE — the reads (one keyed `db.volumes.get` per volume,
// in `resolveAndDeliver`) are per volume by design and would otherwise swamp
// the bound.
describe('CONTRACT 4: co-arriving case-3 row writes still group into one transaction', () => {
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

// CONTRACT 5 — OPENING a cloud series never writes a cover blob onto a
// `volumes` row either.
//
// CONTRACT 3 above proves `cover-persist.ts`'s ROUTER, and nothing more: it
// drives `installCover` directly, so a cover path that bypasses that router
// with a raw `db.volumes.update` of its own is invisible to it. One did.
// `cover-install.ts` — the series-open cover pass, reached from
// `series-open.ts` and from `series-backfill.ts`'s sweep — selected rows by
// `needsDownload(row) && !row.thumbnail`, i.e. DELIBERATELY targeting rows
// that are not installed, without ever consulting reading activity, and wrote
// the blob straight onto them. Measured on the live database while that write
// was in place: 3,428 `volumes` rows, 3,033 of them carrying 94.2MB of
// thumbnails, with `volume_files` and `volume_ocr` both empty — not one of
// those volumes was installed. So this contract drives the WHOLE pass, and
// asserts on the same currency CONTRACT 3 does: not one `put` reaches
// `volumes`.
describe('CONTRACT 5: the series-open cover pass stays off relationship-less rows', () => {
  it('writes no volumes rows when a browsed series installs its covers', async () => {
    const N = 10;
    // Rows a series open materialized, plus the listing that open was made
    // against: a cover sidecar and its archive per volume. No reading history
    // and nothing installed — the "minted by browsing" case again, this time
    // reached through the real pass instead of a direct `installCover`.
    for (let i = 0; i < N; i++) {
      await db.volumes.put(makeRow(`browsed-${i}`, { volume_title: `Volume ${i}` }));
      cloudListing.files.push(
        {
          provider: 'webdav',
          fileId: `cover-${i}`,
          path: `One Piece/Volume ${i}.webp`,
          size: 1,
          modifiedTime: '2026-01-01T00:00:00.000Z'
        },
        {
          provider: 'webdav',
          fileId: `cbz-${i}`,
          path: `One Piece/Volume ${i}.cbz`,
          size: 2,
          modifiedTime: '2026-01-01T00:00:00.000Z'
        }
      );
    }
    readingHistory.set({});
    vi.mocked(fetchCloudThumbnail).mockResolvedValue(makeCover());
    const before = await db.volumes.count();

    let installed = 0;
    const counts = await countIdbOps(async () => {
      installed = await installCoversForSeries('One Piece');
      await flushPendingCoverPersists();
    });

    // Not one write reached the `volumes` table.
    expect(counts['volumes.put'] ?? 0).toBe(0);
    expect(await db.volumes.count()).toBe(before);
    expect((await db.volumes.get('browsed-0'))?.thumbnail).toBeUndefined();

    // Anchor: the pass really did run and really did move every cover — the
    // assertion above would pass vacuously if it had simply found nothing.
    expect(installed).toBe(N);
    expect(await db.cloud_covers.count()).toBe(N);
  });
});

// CONTRACT 6 — a cover landing regenerates no placeholders.
//
// THE 1,784 ms. `cloudCoverMap` was an input to `volumesWithPlaceholders`, so
// every commit to `cloud_covers` re-ran the placeholder scan over all 12,520
// listed files, minted ~4,347 FRESH placeholder objects and handed new props
// to all 1,027 mounted `CatalogItem`s — for a change that cannot alter
// grouping, order, or which volumes exist. The `cloudCoverSignature` guard
// could not help: during ingest every emission genuinely differs, so it paid
// its O(N) build plus O(N log N) sort and recomputed anyway. Freezing exactly
// this re-derive, with identical write and read volume, dropped the worst
// long task to 122 ms — which is why the fix is decoupling rather than
// batching.
//
// Deliberately a CALL count, not an op count (unit 3 in this file's header):
// the cost is `generatePlaceholders` running and everything downstream
// re-rendering, whether or not IndexedDB was touched to trigger it.
//
// The real `cloud-covers-store` is NOT mocked in this file, so a regression
// that re-joins it to the catalog derivation is reachable from here: it starts
// its liveQuery as soon as something subscribes to a store that depends on it.
describe('CONTRACT 6: cover ingest is decoupled from catalog derivation', () => {
  it('does not re-run the placeholder scan when a cover lands', async () => {
    const scan = vi.mocked(generatePlaceholders);
    await db.volumes.put(makeRow('local-1', { volume_title: 'Volume 0' }));
    cloudFiles.set(
      new Map<string, unknown>([
        [
          'One Piece',
          Array.from({ length: 5 }, (_, i) => ({
            provider: 'webdav',
            fileId: `cbz-${i}`,
            path: `One Piece/Volume ${i}.cbz`,
            size: 2,
            modifiedTime: '2026-01-01T00:00:00.000Z'
          }))
        ]
      ])
    );

    const stop = trackSubscription(volumesWithPlaceholders.subscribe(() => {}));
    await settle();
    // Anchor: the scan really is wired up and really did run, so the zero
    // below is a decoupling result rather than a store that never started.
    expect(scan.mock.calls.length).toBeGreaterThanOrEqual(1);
    scan.mockClear();

    // Four covers commit, exactly as they do during ingest.
    for (let i = 0; i < 4; i++) {
      await putCloudCovers([
        {
          account_scope: 'webdav:perf-contracts',
          path: `One Piece/Volume ${i}.cbz`,
          thumbnail: new File([new Uint8Array(2048)], `v${i}.webp`, { type: 'image/webp' }),
          width: 250,
          height: 350,
          cached_at: 1000 + i
        }
      ]);
      await settle(40);
    }
    await settle();

    expect(scan.mock.calls.length).toBe(0);
    stop();
  });
});

// CONTRACT 7 — a cold page load never re-downloads a cover already cached.
//
// The guard that used to do this was an ACCIDENT of the decoration CONTRACT 6
// removes: `generatePlaceholders` stamped the cached blob onto the placeholder,
// so `isCoverFetchTarget` saw a `thumbnail` and declined. With covers out of
// the derivation, every cloud volume reads as a fetch target on a cold load —
// `cover-service.ts`'s `settled` ledger is session-scoped — so a ~4,347-cover
// library would pull the lot over the network on every reload. That would have
// traded the freeze for a network storm.
//
// The replacement is a keyed presence read against `cloud_covers`
// (`isCachedCoverPath`), the same primitive `cover-install.ts` filters its own
// candidates with. This contract is what stops it being removed again.
describe('CONTRACT 7: a cached cover is never re-downloaded', () => {
  it('fetches over the network when nothing is cached for the path', async () => {
    // ANCHOR for the two contracts below: with an empty cache this placeholder DOES go
    // to the network, so "not called" there is a result of the cache gate rather than of
    // a fixture that could never have fetched in the first place.
    const fetchMock = vi.mocked(fetchCloudThumbnail);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(makeCover());

    requestCover(indexedPlaceholder(1));
    await settle(400);

    expect(fetchMock).toHaveBeenCalled();
  });

  it('fetches nothing for a placeholder whose cover is already in the cache', async () => {
    const fetchMock = vi.mocked(fetchCloudThumbnail);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(makeCover());

    const placeholder = indexedPlaceholder(0);
    await putCloudCovers([
      {
        account_scope: 'webdav:perf-contracts',
        path: placeholder.cloudPath as string,
        thumbnail: new File([new Uint8Array(2048)], 'cached.webp', { type: 'image/webp' }),
        width: 250,
        height: 350,
        cached_at: 1000
      }
    ]);

    requestCover(placeholder);
    await settle(400);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('materializes no row for a BARE placeholder whose cover is already cached', async () => {
    // The other half of what the removed placeholder decoration used to do: a cached
    // cover made `isCoverFetchTarget` decline, so cases 3/4 never ran and no row was
    // minted. Waited out well past the materialize batch window (100ms), because that
    // batch is where the row would appear.
    const fetchMock = vi.mocked(fetchCloudThumbnail);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(makeCover());

    const placeholder = barePlaceholder(0);
    await putCloudCovers([
      {
        account_scope: 'webdav:perf-contracts',
        path: placeholder.cloudPath as string,
        thumbnail: new File([new Uint8Array(2048)], 'cached.webp', { type: 'image/webp' }),
        width: 250,
        height: 350,
        cached_at: 1000
      }
    ]);

    requestCover(placeholder);
    await settle(1600);

    expect(await db.volumes.count()).toBe(0);
  });

  it('still fetches when the row it belongs to has a stale cover of its own', async () => {
    // THE SELF-HEAL BRANCH, which the gate above must not suppress. A real row
    // carrying a thumbnail whose recorded stamp disagrees with the listing's
    // current sidecar stamp has to re-fetch — and it is reached even with a
    // `cloud_covers` row sitting under the same path.
    const fetchMock = vi.mocked(fetchCloudThumbnail);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(makeCover());

    const stale = makeRow('stale-1', {
      volume_title: 'Volume 7',
      thumbnail: new File([new Uint8Array([9])], 'old.webp', { type: 'image/webp' }),
      cover_size: 111,
      cover_modified: 1000,
      cloudProvider: 'webdav',
      cloudPath: 'One Piece/Volume 7.cbz',
      cloudThumbnailFileId: 'cover-7',
      cloudThumbnailPath: 'One Piece/Volume 7.webp',
      cloudThumbnailSize: 222,
      cloudThumbnailModifiedTime: '2026-06-01T00:00:00.000Z'
    });
    await db.volumes.put(stale);
    await putCloudCovers([
      {
        account_scope: 'webdav:perf-contracts',
        path: 'One Piece/Volume 7.cbz',
        thumbnail: new File([new Uint8Array(2048)], 'cached.webp', { type: 'image/webp' }),
        width: 250,
        height: 350,
        cached_at: 1000
      }
    ]);

    requestCover(stale);
    await settle(400);

    expect(fetchMock).toHaveBeenCalled();
  });
});

// CONTRACT 8 — inserting ONE cover costs O(1), in BYTES and in re-derives,
// whatever the library already holds.
//
// WHY THIS EXISTS AT ALL, given CONTRACTS 6 and 7 already stand: every other
// contract in this file bounds a COUNT, and a count could not have caught the
// defect this plan fixed. The measurement on the 12,520-file library was 23
// `cloud_covers` reads in 59 s — unremarkable as a number — and those 23 reads
// deserialized 3,886 MB of blobs (~437 MB each) while the main thread stalled
// for up to 1,784 ms. The defect was BYTES PER OPERATION, and a suite that only
// counts operations is structurally blind to it. So this contract measures
// bytes (`"<store>.bytes"`, see `idb-op-counter.ts`) and asserts they do not
// scale.
//
// TWO SIZES, NOT ONE BOUND. A single "under X MB" threshold is a number a
// later change can quietly raise. Measuring the SAME event at two clearly
// different library sizes and asserting the cost is the same makes it a
// scaling claim: the pre-fix store (a blob-returning row read over every listed path)
// fails it by construction, because its cost per insert IS the table.
describe('CONTRACT 8: one cover insert is O(1) in library size', () => {
  const SERIES = 'Dr Stone';
  const SMALL_N = 20;
  const LARGE_N = 80;

  /**
   * Seed `n` cached covers, subscribe the live cover key set the way the app
   * does, then count what inserting ONE more cover costs. Everything before
   * the insert is deliberately outside the counted block: the setup is not the
   * measurement.
   */
  async function measureCoverInsert(n: number): Promise<Record<string, number>> {
    await putCloudCovers(Array.from({ length: n }, (_, i) => cachedCover(SERIES, i)));
    // n + 1 archives listed, so the cover inserted below is a path the
    // subscription is actually watching — a listing of n would make the
    // insert invisible and the byte count zero for the wrong reason.
    cloudFiles.set(archiveListing(SERIES, n + 1));

    let latest: ReadonlySet<string> = new Set();
    const stop = cachedCoverPathSet.subscribe((paths) => (latest = paths));
    try {
      // Throws if the subscription never resolves the seeded keys, which is
      // what stops the whole measurement from being taken against a store
      // that never ran.
      await vi.waitFor(() => expect(latest.size).toBe(n), { timeout: 5000 });

      return await countIdbOps(async () => {
        await putCloudCovers([cachedCover(SERIES, n)]);
        await vi.waitFor(() => expect(latest.size).toBe(n + 1), { timeout: 5000 });
      });
    } finally {
      stop();
      cloudFiles.set(new Map());
      await db.cloud_covers.clear();
    }
  }

  it('deserializes bytes that do not scale with the number of cached covers', async () => {
    const small = await measureCoverInsert(SMALL_N);
    const large = await measureCoverInsert(LARGE_N);

    // ANCHOR, before the bytes mean anything: the subscription really did read
    // IndexedDB at both sizes — zero bytes is also what a subscription that
    // never woke up reports, and what one served entirely out of Dexie's
    // in-memory cache would report (this file's header, unit 3: a cached answer
    // still costs its consumer the whole row set, but deserializes nothing
    // through IndexedDB, so bytes would read as "not measured" rather than "not
    // paid"). Deliberately SHAPE-INDEPENDENT — a read transaction, not a
    // particular cursor op — so that a regression to a value-reading query is
    // reported by the byte assertions below rather than tripping over an
    // anchor that describes the fix instead of the property.
    expect(small['tx.cloud_covers.readonly'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(large['tx.cloud_covers.readonly'] ?? 0).toBeGreaterThanOrEqual(1);

    const smallBytes = small['cloud_covers.bytes'] ?? 0;
    const largeBytes = large['cloud_covers.bytes'] ?? 0;

    // THE SCALING CONTRACT. A 4x larger cover cache may cost at most one more
    // cover's worth of deserialization — the slack an implementation that read
    // back the row it just wrote would need, and nothing beyond it. The
    // pre-fix store re-materialised every row per insert, so this difference
    // was (LARGE_N - SMALL_N) covers; on the real library it was 437 MB.
    expect(largeBytes - smallBytes).toBeLessThanOrEqual(COVER_BYTES);
    // And the absolute budget, which catches a regression that reads a fixed
    // fat slice (constant, so invariant, but still wasteful). The shipped
    // shape reads zero bytes; one cover is the same slack as above.
    expect(largeBytes).toBeLessThanOrEqual(COVER_BYTES);

    // Last, the SHAPE that makes those zeroes structural rather than lucky:
    // `primaryKeys()` over an `anyOf` takes Dexie's keys-only branch. Asserted
    // after the bytes so it reads as corroboration, not as the contract.
    expect(small['cloud_covers.openKeyCursor'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(large['cloud_covers.openKeyCursor'] ?? 0).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('regenerates no placeholders when a cover lands, at library scale', async () => {
    // CONTRACT 6 pins this decoupling with four covers, a five-file listing and
    // nothing subscribed to the cover store. This is the same property under the
    // conditions that produced the 1,784 ms task: a cover cache the size of a real
    // one, and the live key-set subscription (`initCoverKeyWatch`'s store, which
    // production keeps running for the app's lifetime) active while the cover
    // lands. If cover ingest ever re-acquires a path into the catalog derivation,
    // this is the shape it comes back in.
    const scan = vi.mocked(generatePlaceholders);
    await db.volumes.put(makeRow('local-1', { volume_title: 'Volume 0' }));
    await putCloudCovers(Array.from({ length: LARGE_N }, (_, i) => cachedCover(SERIES, i)));
    cloudFiles.set(archiveListing(SERIES, LARGE_N + 1));
    pendingCleanups.push(() => cloudFiles.set(new Map()));

    let latest: ReadonlySet<string> = new Set();
    trackSubscription(cachedCoverPathSet.subscribe((paths) => (latest = paths)));
    trackSubscription(volumesWithPlaceholders.subscribe(() => {}));
    await vi.waitFor(() => expect(latest.size).toBe(LARGE_N), { timeout: 5000 });
    await settle();

    // Anchor: the placeholder scan really is wired up and really did run for
    // this listing, so the zero below is a decoupling result rather than a
    // derived that was never subscribed or a listing that produced nothing.
    expect(scan.mock.calls.length).toBeGreaterThanOrEqual(1);
    scan.mockClear();

    // The measured event. Waited out by the KEY SET rather than by a fixed
    // sleep, so the assertion cannot pass by being checked before the insert
    // was observed — then a further three coalesce windows, which is the
    // channel a re-derive would arrive through (`VOLUMES_EMISSION_COALESCE_MS`).
    await putCloudCovers([cachedCover(SERIES, LARGE_N)]);
    await vi.waitFor(() => expect(latest.size).toBe(LARGE_N + 1), { timeout: 5000 });
    await settle();

    expect(scan.mock.calls.length).toBe(0);
  }, 20000);
});
