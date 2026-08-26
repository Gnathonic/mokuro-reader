import { describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

/**
 * The `catalog` store re-groups, re-resolves display titles for and re-sorts the whole
 * library on every emission of its inputs. It used to join `catalogSettings`, an object
 * store that emits on EVERY settings write — including per-wheel-tick ones like
 * `pagedGap` — so scrolling a slider rebuilt the catalog. It now joins the primitive
 * `preferredTitleLanguage`, which dedupes by string value.
 *
 * Everything except the settings module is mocked so the store graph is: fake volumes →
 * catalog ← real settings.
 */
const {
  volumeRecord,
  cloudFiles,
  seriesMetadataMap,
  seriesIndexMap,
  cloudCoverMap,
  routeParams,
  generatePlaceholders,
  liveQueryState,
  emitMutationSignal,
  toArrayCalls,
  toArrayGate,
  toArrayResolvers,
  resolveNextToArray
} = vi.hoisted(() => {
  // vi.mock factories are hoisted above imports, so the stores they close over are
  // hand-rolled here rather than built with svelte/store's `writable`.
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

  const volume = {
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'One Piece',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 10,
    character_count: 100,
    page_char_counts: [10, 20]
  };

  // Holds the `next` callback the mocked liveQuery's current subscriber registered,
  // so a test can drive it as an explicit change signal via `emitMutationSignal`
  // — `volumes` now uses `liveQuery(() => db.volumes.count())` purely as a cheap
  // trigger, so the mock ignores the querier entirely and never needs to run it.
  const liveQueryState: { next: ((v: unknown) => void) | null } = { next: null };
  const toArrayCalls: unknown[] = [];

  // Lets a test hold a `toArray()` call open instead of letting it settle in
  // the same microtask, so the `running`/`dirty` reentrancy guard in
  // `runQuery` (index.ts) — and the disposal race it guards against — actually
  // have a window to be exercised in. The snapshot is captured at CALL time
  // (mirroring a real Dexie read), then handed to the matching queued resolver
  // via `resolveNextToArray`, so a later mutation to `volumeRecord` can't
  // retroactively change what an already-in-flight read delivers.
  const toArrayGate = { deferred: false };
  const toArrayResolvers: Array<() => void> = [];
  const resolveNextToArray = () => toArrayResolvers.shift()?.();

  return {
    volumeRecord: { v1: volume } as Record<string, unknown>,
    cloudFiles: createStore(new Map<string, unknown>()),
    seriesMetadataMap: createStore(new Map<string, unknown>()),
    seriesIndexMap: createStore(new Map<string, unknown>()),
    cloudCoverMap: createStore(new Map<string, unknown>()),
    routeParams: createStore({} as Record<string, string>),
    generatePlaceholders: vi.fn(() => [] as unknown[]),
    liveQueryState,
    emitMutationSignal: () => liveQueryState.next?.(undefined),
    toArrayCalls,
    toArrayGate,
    toArrayResolvers,
    resolveNextToArray
  };
});

// `volumes` reads through `db.volumes.toArray()` directly (not through
// liveQuery — see the `dexie` mock below), so it needs a real implementation
// here; `toArrayCalls` records every call so tests can assert the scan itself
// was coalesced, not just the downstream emission. When `toArrayGate.deferred`
// is set, the call parks its resolution in `toArrayResolvers` instead of
// settling immediately, so a test can hold a read open across a coalesce window
// and settle it later via `resolveNextToArray`.
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      toArray: () => {
        toArrayCalls.push(1);
        const snapshot = Object.values(volumeRecord);
        if (!toArrayGate.deferred) return Promise.resolve(snapshot);
        return new Promise((resolve) => {
          toArrayResolvers.push(() => resolve(snapshot));
        });
      }
    }
  }
}));
// The `volumes` readable subscribes to `liveQuery(() => db.volumes.count())` purely
// as a change signal — the mock ignores the querier function entirely and instead
// exposes the registered `next` callback via `emitMutationSignal`, mirroring Dexie
// re-firing the live query on any table write.
vi.mock('dexie', () => ({
  liveQuery: () => ({
    subscribe: ({ next }: { next: (v: unknown) => void }) => {
      liveQueryState.next = next;
      next(undefined);
      return {
        unsubscribe() {
          liveQueryState.next = null;
        }
      };
    }
  })
}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { cloudFiles }
}));
// Only the cloud scan is stubbed; the path index and the cloud-field lookup a
// metadata-only row is decorated with are the real ones.
vi.mock('$lib/catalog/placeholders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/catalog/placeholders')>();
  return { ...actual, generatePlaceholders };
});
vi.mock('$lib/util/hash-router', () => ({ routeParams }));
vi.mock('$lib/util/download-volume-repair', () => ({
  getLegacyImageOnlyVolumeUuid: () => undefined
}));
vi.mock('$lib/metadata/store', () => ({ seriesMetadataMap }));
vi.mock('$lib/metadata/series-index', () => ({ seriesIndexMap }));
vi.mock('$lib/catalog/cloud-covers-store', () => ({ cloudCoverMap }));
vi.mock('$lib/catalog/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/catalog/catalog')>();
  return { ...actual, deriveSeriesFromVolumes: vi.fn(actual.deriveSeriesFromVolumes) };
});

import {
  catalog,
  volumes,
  volumesWithPlaceholders,
  VOLUMES_EMISSION_COALESCE_MS
} from '$lib/catalog';
import { deriveSeriesFromVolumes } from '$lib/catalog/catalog';
import { updateCatalogSetting, updateSetting } from '$lib/settings/settings';

/**
 * `volumes` coalesces its liveQuery emissions on a trailing-edge timer (see
 * `VOLUMES_EMISSION_COALESCE_MS` in `$lib/catalog`), so subscribing to it — or to
 * anything that joins it, like `volumesWithPlaceholders` and `catalog` — always
 * computes once synchronously against the readable's `undefined` initial value
 * before the real data lands. Tests below only care about the settled state, so
 * they subscribe through this helper, which arms fake timers, lets the coalesce
 * window elapse, and restores real timers before returning.
 *
 * `volumes`'s quiet-period read (`runQuery`) is a genuine `async` function —
 * it awaits `db.volumes.toArray()` — so flushing the timer alone isn't enough;
 * the microtask the `await` yields to also has to run before the settled value
 * has actually landed. `advanceTimersByTimeAsync` yields between timer firings
 * for exactly that, so this helper must be awaited by its callers.
 */
async function subscribeSettled<T>(
  store: { subscribe: (fn: (v: T) => void) => () => void },
  fn: (v: T) => void
) {
  vi.useFakeTimers();
  const unsubscribe = store.subscribe(fn);
  await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS);
  vi.useRealTimers();
  return unsubscribe;
}

/**
 * Before `volumes` delivers its first coalesced emission, `catalog` must
 * expose its loading sentinel (`null`) rather than falling through to an
 * empty catalog — `Catalog.svelte` and `SeriesView.svelte` both branch on
 * `$catalog === null` to render a spinner instead of "Your catalog is
 * currently empty." / "Series not found.". Before this fix, `volumes` and
 * `volumesWithPlaceholders` both defaulted to `{}`, so that branch was dead
 * code: every fresh mount (app boot, and every navigation, since the router
 * tears down and rebuilds this subscription chain per route) rendered the
 * empty-library message for the length of one coalesce window.
 *
 * This is a store-level assertion rather than a component render test: the
 * existing component test for `Catalog.svelte` (`Catalog.grouping.test.ts`)
 * mocks `$lib/catalog` directly, bypassing this store chain entirely, so it
 * can't exercise the bug or the fix — `Catalog.svelte`'s own `{#if $catalog
 * === null}` branch was already correct, only the store chain feeding it was
 * dead. Proving this meaningfully at the component level would mean
 * duplicating this file's real-module mocking (the mocked `dexie` liveQuery,
 * cloud/series-index/cover stores) inside a full component render harness,
 * which is disproportionate for what is fundamentally a store-wiring fix.
 *
 * Must run before any other test in this file subscribes to `catalog`,
 * `volumesWithPlaceholders`, or `volumes`: Svelte stores retain their last
 * delivered value across a full unsubscribe/resubscribe cycle, so once any
 * test lets a real emission flow through once, every later subscribe in this
 * file sees that retained value immediately instead of the genuine
 * "nothing has loaded yet" `undefined`/`null` state.
 */
describe('volumes loading state (must run first in this file — see comment above)', () => {
  it('reports catalog as null until volumes settles, then resolves to the real data', async () => {
    vi.useFakeTimers();

    let latest: unknown = 'not yet emitted';
    const unsubscribe = catalog.subscribe((value) => (latest = value));

    // Before the first coalesced `volumes` emission lands, `catalog` must be
    // the loading sentinel, not an empty array.
    expect(latest).toBeNull();

    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS);

    expect(latest).not.toBeNull();
    expect((latest as Array<{ title: string }>)[0].title).toBe('One Piece');

    unsubscribe();
    vi.useRealTimers();
  });
});

describe('catalog store recomputes', () => {
  it('rebuilds only when the title language actually changes', async () => {
    const derive = vi.mocked(deriveSeriesFromVolumes);
    derive.mockClear();

    let latest: ReturnType<typeof deriveSeriesFromVolumes> | null = null;
    const unsubscribe = await subscribeSettled(catalog, (value) => (latest = value));

    expect(derive).toHaveBeenCalled();
    expect((latest as unknown as Array<{ title: string }>)[0].title).toBe('One Piece');
    derive.mockClear();

    // An unrelated setting (this one fires once per wheel tick in the reader)
    updateSetting('pagedGap', 12);
    updateSetting('pagedGap', 13);
    expect(derive).toHaveBeenCalledTimes(0);

    // A different catalog setting object-identity change, still not the language
    updateCatalogSetting('stackCount', 4);
    expect(derive).toHaveBeenCalledTimes(0);

    // The language itself does rebuild the catalog
    updateCatalogSetting('preferredTitleLanguage', 'romaji');
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenLastCalledWith(
      expect.any(Array) as unknown as VolumeMetadata[],
      expect.any(Map),
      'romaji'
    );

    // Re-selecting the same language is a no-op
    updateCatalogSetting('preferredTitleLanguage', 'romaji');
    expect(derive).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});

/**
 * `volumesWithPlaceholders` now also joins the cached `series.json` indexes, so
 * cloud-only volumes can carry their real uuid and counts. That store is a
 * Dexie liveQuery: it re-runs (and emits a brand-new Map of brand-new row
 * objects) on ANY write to the table, including writes that change nothing this
 * store cares about. Rebuilding the placeholder set on each of those would
 * re-run the whole cloud scan — and its OCR-upgrade side effects — per write.
 */
describe('volumesWithPlaceholders', () => {
  const cloudListing = new Map<string, unknown>([
    [
      'One Piece',
      [
        {
          provider: 'webdav',
          fileId: 'f1',
          path: 'One Piece/Volume 2.cbz',
          modifiedTime: '2026-08-17T00:00:00.000Z',
          size: 42
        }
      ]
    ]
  ]);

  function indexRecord(fetched_at: string) {
    return {
      series_key: 'one piece',
      series_title: 'One Piece',
      file: { version: 2, series_title: 'One Piece', volumes: [] },
      source: { provider: 'webdav', path: 'One Piece/series.json', size: 1, modifiedTime: 't' },
      fetched_at
    };
  }

  it('passes the index to generatePlaceholders and recomputes only on real changes', async () => {
    const generate = vi.mocked(generatePlaceholders);
    generate.mockClear();
    cloudFiles.set(cloudListing);
    seriesIndexMap.set(new Map([['one piece', indexRecord('2026-08-17T00:00:00.000Z')]]));

    const unsubscribe = await subscribeSettled(volumesWithPlaceholders, () => {});

    expect(generate).toHaveBeenLastCalledWith(
      cloudListing,
      expect.any(Array),
      expect.any(Map) as unknown as Map<string, unknown>,
      expect.any(Map) as unknown as Map<string, unknown>
    );
    generate.mockClear();

    // A liveQuery re-emission carrying the same records (fresh Map, fresh row
    // objects) must NOT rebuild the placeholders.
    seriesIndexMap.set(new Map([['one piece', indexRecord('2026-08-17T00:00:00.000Z')]]));
    seriesIndexMap.set(new Map([['one piece', indexRecord('2026-08-17T00:00:00.000Z')]]));
    expect(generate).toHaveBeenCalledTimes(0);

    // A refresh that actually stored something new does.
    seriesIndexMap.set(new Map([['one piece', indexRecord('2026-08-17T09:00:00.000Z')]]));
    expect(generate).toHaveBeenCalledTimes(1);

    // As does a new series arriving in the index.
    seriesIndexMap.set(
      new Map([
        ['one piece', indexRecord('2026-08-17T09:00:00.000Z')],
        ['naruto', { ...indexRecord('2026-08-17T09:00:00.000Z'), series_key: 'naruto' }]
      ])
    );
    expect(generate).toHaveBeenCalledTimes(2);

    unsubscribe();
    cloudFiles.set(new Map());
  });

  it('passes the cover map to generatePlaceholders and recomputes only when its content changes', async () => {
    const generate = vi.mocked(generatePlaceholders);
    generate.mockClear();
    cloudFiles.set(cloudListing);
    seriesIndexMap.set(new Map([['one piece', indexRecord('2026-08-17T00:00:00.000Z')]]));

    const coverAt = (cachedAt: number, blobLength = 3) => ({
      account_scope: 'webdav:h|nathan',
      path: 'One Piece/Volume 2.cbz',
      thumbnail: new File([new Uint8Array(blobLength)], 'c.webp'),
      width: 250,
      height: 350,
      cached_at: cachedAt
    });
    cloudCoverMap.set(new Map([['One Piece/Volume 2.cbz', coverAt(1000)]]));

    const unsubscribe = await subscribeSettled(volumesWithPlaceholders, () => {});
    expect(generate).toHaveBeenLastCalledWith(
      cloudListing,
      expect.any(Array),
      expect.any(Map) as unknown as Map<string, unknown>,
      expect.any(Map) as unknown as Map<string, unknown>
    );
    generate.mockClear();

    // A rewrite (e.g. a re-fetch after the TTL sweep expired the old row)
    // stamps a fresh cached_at and re-emits a fresh Map, but the cached blob
    // — and therefore what a placeholder would show — hasn't changed.
    cloudCoverMap.set(new Map([['One Piece/Volume 2.cbz', coverAt(2000)]]));
    expect(generate).toHaveBeenCalledTimes(0);

    // A genuinely different blob does recompute.
    cloudCoverMap.set(new Map([['One Piece/Volume 2.cbz', coverAt(2000, 4)]]));
    expect(generate).toHaveBeenCalledTimes(1);

    unsubscribe();
    cloudFiles.set(new Map());
    cloudCoverMap.set(new Map());
  });

  it('decorates a metadata-only row with the cloud file it can be downloaded from', async () => {
    // The row shadows its own placeholder (generatePlaceholders skips a path
    // that has a local row), so without this join there would be no fileId to
    // download it with.
    volumeRecord.v2 = {
      volume_uuid: 'v2',
      series_uuid: 's1',
      series_title: 'One Piece',
      volume_title: 'Volume 2',
      mokuro_version: '0.4.11',
      page_count: 10,
      character_count: 100,
      page_char_counts: [],
      metadata_only: true
    };
    cloudFiles.set(new Map(cloudListing));

    let latest: Record<string, VolumeMetadata> = {};
    const unsubscribe = await subscribeSettled(
      volumesWithPlaceholders,
      (value) => (latest = value ?? {})
    );

    expect(latest.v2.cloudFileId).toBe('f1');
    expect(latest.v2.cloudProvider).toBe('webdav');
    expect(latest.v2.metadata_only).toBe(true);
    // The stored row is never decorated — the fileId belongs to the listing.
    expect(volumeRecord.v2).not.toHaveProperty('cloudFileId');
    // An installed row is left exactly as it came out of the database.
    expect(latest.v1).toBe(volumeRecord.v1);

    unsubscribe();
    delete volumeRecord.v2;
    cloudFiles.set(new Map());
  });

  /**
   * Regression for the final whole-plan review's Finding 3: opening a series
   * materializes bare metadata-only rows (`series-open.ts`) with no
   * thumbnail of their own. Before this fix, such a row's card went blank
   * and `cover-install.ts`/`cover-service.ts` re-fetched over the network a
   * blob already sitting in `cloud_covers` from an earlier browse. The join
   * below is what makes that unnecessary: the decorated copy carries the
   * cached blob directly, so the card never blanks, AND — because
   * `isCoverFetchTarget` (`cover-service.test.ts`) only re-fetches when
   * `vol.thumbnail` is falsy or the row's OWN `cover_size`/`cover_modified`
   * stamps say the sidecar moved on — a just-materialized row (which has
   * neither stamp) is correctly read as "not stale", so no fetch follows.
   */
  it('decorates a metadata-only row with its cached cover, without a network fetch', async () => {
    volumeRecord.v2 = {
      volume_uuid: 'v2',
      series_uuid: 's1',
      series_title: 'One Piece',
      volume_title: 'Volume 2',
      mokuro_version: '0.4.11',
      page_count: 10,
      character_count: 100,
      page_char_counts: [],
      metadata_only: true
      // No thumbnail, no cover_size/cover_modified — exactly what
      // `materializeSeriesVolumes` produces for a bare row.
    };
    cloudFiles.set(new Map(cloudListing));

    const cachedThumbnail = new File([new Uint8Array([1, 2, 3])], 'c.webp');
    cloudCoverMap.set(
      new Map([
        [
          'One Piece/Volume 2.cbz',
          {
            account_scope: 'webdav:h|nathan',
            path: 'One Piece/Volume 2.cbz',
            thumbnail: cachedThumbnail,
            width: 250,
            height: 350,
            cached_at: 1000
          }
        ]
      ])
    );

    let latest: Record<string, VolumeMetadata> = {};
    const unsubscribe = await subscribeSettled(
      volumesWithPlaceholders,
      (value) => (latest = value ?? {})
    );

    expect(latest.v2.thumbnail).toBe(cachedThumbnail);
    expect(latest.v2.thumbnail_width).toBe(250);
    expect(latest.v2.thumbnail_height).toBe(350);
    // Same cover-sidecar pointer fields as before — the cache join is
    // additive, not a replacement for the download affordance.
    expect(latest.v2.cloudFileId).toBe('f1');
    // The stored row is never decorated — the cache join belongs to the copy.
    expect(volumeRecord.v2).not.toHaveProperty('thumbnail');

    unsubscribe();
    delete volumeRecord.v2;
    cloudFiles.set(new Map());
    cloudCoverMap.set(new Map());
  });
});

/**
 * The catalog only shows what this device holds or the ACTIVE listing can deliver.
 * A metadata-only row whose cloud file is gone — or lives on a provider that is
 * not connected right now — keeps its DB row, its thumbnail and its history, but
 * gets no card and no "Available in <provider>" seat: an offer nothing can honor
 * is exactly the ghost-entry problem the placeholder pass already solved once.
 */
describe('catalog visibility', () => {
  it('hides a metadata-only row the active listing cannot deliver', async () => {
    // One Piece v2 is backed by the listing; Ghost Series exists only as a
    // retained row — its cloud copy was deleted (or lives on another provider).
    volumeRecord.v2 = {
      volume_uuid: 'v2',
      series_uuid: 's1',
      series_title: 'One Piece',
      volume_title: 'Volume 2',
      mokuro_version: '0.4.11',
      page_count: 10,
      character_count: 100,
      page_char_counts: [],
      metadata_only: true
    };
    volumeRecord.g1 = {
      volume_uuid: 'g1',
      series_uuid: 's9',
      series_title: 'Ghost Series',
      volume_title: 'Ghost 1',
      mokuro_version: '0.4.11',
      page_count: 10,
      character_count: 100,
      page_char_counts: [],
      metadata_only: true
    };
    cloudFiles.set(
      new Map([
        [
          'One Piece',
          [
            {
              provider: 'webdav',
              fileId: 'f1',
              path: 'One Piece/Volume 2.cbz',
              modifiedTime: '2026-08-17T00:00:00.000Z',
              size: 42
            }
          ]
        ]
      ])
    );

    let latest: Array<{ title: string; volumes: VolumeMetadata[] }> = [];
    const unsubscribe = await subscribeSettled(
      catalog,
      (value) => (latest = value as unknown as typeof latest)
    );

    const titles = latest.map((s) => s.title);
    expect(titles).toContain('One Piece');
    expect(titles).not.toContain('Ghost Series');
    // The backed row kept its seat next to the installed one.
    const onePiece = latest.find((s) => s.title === 'One Piece')!;
    expect(onePiece.volumes.map((v) => v.volume_uuid).sort()).toEqual(['v1', 'v2']);

    unsubscribe();
    delete volumeRecord.v2;
    delete volumeRecord.g1;
    cloudFiles.set(new Map());
  });

  it('hides metadata-only rows entirely when no listing is loaded', async () => {
    volumeRecord.g1 = {
      volume_uuid: 'g1',
      series_uuid: 's9',
      series_title: 'Ghost Series',
      volume_title: 'Ghost 1',
      mokuro_version: '0.4.11',
      page_count: 10,
      character_count: 100,
      page_char_counts: [],
      metadata_only: true
    };
    cloudFiles.set(new Map());

    let latest: Array<{ title: string }> = [];
    const unsubscribe = await subscribeSettled(
      catalog,
      (value) => (latest = value as unknown as typeof latest)
    );

    expect(latest.map((s) => s.title)).toEqual(['One Piece']);

    unsubscribe();
    delete volumeRecord.g1;
  });
});

/**
 * A burst of writes must cost ONE recompute, not one per write — and, more
 * specifically, ONE `db.volumes.toArray()` scan, not one per write.
 *
 * `volumes` used to wrap the scan directly inside `liveQuery`, then debounce
 * only the downstream emission — Dexie re-executes a liveQuery querier on
 * EVERY mutation, so the expensive scan had already happened by the time the
 * debounce ran; only the recompute it fed was collapsed. Measured on a large
 * library: 145 full-table scans in 20 seconds, queueing behind each other
 * until the worst case took 16.5 seconds. The fix inverts it: `liveQuery`
 * wraps a cheap `count()` used only as a change signal (see the `dexie` mock
 * above — it ignores the querier entirely and exposes the signal as
 * `emitMutationSignal`), and the scan itself (`db.volumes.toArray`, counted
 * via `toArrayCalls` in the `db` mock above) runs at most once per quiet
 * period. A test that only counts subscriber emissions (the first test below)
 * would also have passed on the broken code, since the old version already
 * coalesced emissions without coalescing the scan behind them — the
 * `toArrayCalls` assertions are what actually prove the fix.
 */
describe('volumes emissions coalesce', () => {
  it('collapses a burst of writes into one subscriber emission', async () => {
    vi.useFakeTimers();
    let emissions = 0;
    const unsub = volumes.subscribe(() => emissions++);
    emissions = 0;

    for (let i = 0; i < 20; i++) emitMutationSignal();
    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS * 2);

    expect(emissions).toBe(1);
    unsub();
    vi.useRealTimers();
  });

  it('runs ONE toArray for a burst of writes, not one per write', async () => {
    vi.useFakeTimers();
    toArrayCalls.length = 0;
    const unsubscribe = volumes.subscribe(() => {});

    // 20 mutations inside one quiet period
    for (let i = 0; i < 20; i++) emitMutationSignal();
    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS * 2);

    expect(toArrayCalls.length).toBe(1);
    unsubscribe();
    vi.useRealTimers();
  });

  it('re-reads again after a later, separate burst', async () => {
    vi.useFakeTimers();
    toArrayCalls.length = 0;
    const unsubscribe = volumes.subscribe(() => {});

    emitMutationSignal();
    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS * 2);
    emitMutationSignal();
    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS * 2);

    expect(toArrayCalls.length).toBe(2);
    unsubscribe();
    vi.useRealTimers();
  });
});

/**
 * The two tests above never actually exercise the `running`/`dirty`
 * reentrancy guard in `runQuery`: their mocked `toArray()` settles inside a
 * single microtask, so it always resolves before a second timer could fire
 * while `running` was still true. Deleting the guard entirely would leave
 * both of those tests green — `schedule()`'s own `if (!timer)` dedup already
 * explains their assertions on its own. This test uses `toArrayGate` to hold
 * a read open across a full coalesce window so the guard's `running` branch
 * is actually reached, and restores a property the guard exists for in the
 * first place: the value ultimately delivered reflects the LAST write of a
 * burst, not whichever read happened to be in flight when the burst started.
 */
describe('volumes running/dirty reentrancy guard', () => {
  it('does not drop a mutation that lands while a read is in flight', async () => {
    vi.useFakeTimers();
    toArrayCalls.length = 0;
    toArrayGate.deferred = true;

    let latest: Record<string, unknown> | undefined;
    const unsubscribe = volumes.subscribe((v) => (latest = v as typeof latest));

    // The mocked liveQuery fires its `next` synchronously on subscribe, so
    // the first coalesce window is already running; let it elapse to start
    // the first (deferred, still-pending) read.
    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS);
    expect(toArrayCalls.length).toBe(1);

    // A later write lands, and a FULL coalesce window elapses, while that
    // first read is still pending. This is the only way to reach the
    // `running` branch: `runQuery` has to be re-entered while `running` is
    // still true from the call above.
    volumeRecord.v2 = { volume_uuid: 'v2' };
    emitMutationSignal();
    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS * 2);

    // The guard must have folded that re-entry into `dirty` rather than
    // starting a second, concurrent scan.
    expect(toArrayCalls.length).toBe(1);

    // Only now does the first, now-stale read settle — with the snapshot it
    // captured before `v2` existed.
    resolveNextToArray();
    await vi.advanceTimersByTimeAsync(0);

    // `dirty` must trigger exactly one more read...
    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS);
    expect(toArrayCalls.length).toBe(2);
    resolveNextToArray();
    await vi.advanceTimersByTimeAsync(0);

    // ...and the value ultimately delivered is the LATER write, not the
    // snapshot the first, in-flight read captured.
    expect(latest).toHaveProperty('v2');

    unsubscribe();
    vi.useRealTimers();
    toArrayGate.deferred = false;
    delete volumeRecord.v2;
  });
});

/**
 * `runQuery` has no way to abort a `toArray()` read that is already in
 * flight when its subscription is torn down (the hash router does this on
 * every navigation): the teardown closure can only clear a pending timer and
 * unsubscribe the count signal. Before the `disposed` flag, that stale read
 * would still call the shared `set` when it eventually settled — even after
 * a brand-new subscription had already delivered current data — silently
 * clobbering it back to the old snapshot. This test reproduces that
 * sequence directly against the exported `volumes` store.
 */
describe('volumes disposal guard', () => {
  it('does not let a stale read from a torn-down subscription clobber a fresher one', async () => {
    vi.useFakeTimers();
    toArrayCalls.length = 0;
    toArrayGate.deferred = true;

    let latest: Record<string, unknown> | undefined;
    const unsubscribeA = volumes.subscribe((v) => (latest = v as typeof latest));

    // Subscription A's first coalesce window elapses, starting its
    // (deferred, still-pending) read.
    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS);
    expect(toArrayCalls.length).toBe(1);

    // The hash router tears A down mid-read. This can only clear a pending
    // timer and unsubscribe the count signal — it cannot cancel the read
    // already in flight.
    unsubscribeA();

    // A fresher volume shows up, and a brand-new subscription (B) starts,
    // completing its OWN read before A's stale one settles.
    volumeRecord.v2 = { volume_uuid: 'v2' };
    toArrayGate.deferred = false;
    const unsubscribeB = volumes.subscribe((v) => (latest = v as typeof latest));
    await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS);
    expect(toArrayCalls.length).toBe(2);
    expect(latest).toHaveProperty('v2');

    // A's stale read finally resolves, with the snapshot it captured before
    // `v2` existed and before A was torn down.
    resolveNextToArray();
    await vi.advanceTimersByTimeAsync(0);

    // The disposed subscription's stale result must not clobber B's current one.
    expect(latest).toHaveProperty('v2');

    unsubscribeB();
    vi.useRealTimers();
    delete volumeRecord.v2;
  });
});
