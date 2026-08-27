import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

const providerStatus = vi.hoisted(() => {
  let value = {
    providers: {} as Record<string, { isReadOnly?: boolean } | null>,
    hasAnyAuthenticated: true,
    needsAttention: false,
    currentProviderType: 'webdav' as string | null
  };
  const subs = new Set<(v: typeof value) => void>();
  return {
    subscribe(fn: (v: typeof value) => void) {
      subs.add(fn);
      fn(value);
      return () => subs.delete(fn);
    },
    set(v: typeof value) {
      value = v;
      subs.forEach((fn) => fn(value));
    }
  };
});

vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { status: providerStatus }
}));

const writeSeriesFile = vi.hoisted(() => vi.fn(async () => 'written' as const));
const backfillSeriesEntries = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./series-backfill', () => ({
  backfillSeriesEntries,
  backfillNewlyLinkedSeries: vi.fn(async () => {})
}));
const fetchAllCloudVolumes = vi.hoisted(() => vi.fn(async (_options?: unknown) => {}));
const cloudListing = vi.hoisted(() => ({ files: [] as { path: string }[] }));
const getAllCloudVolumes = vi.hoisted(() => vi.fn(() => cloudListing.files));
// The per-series backup gate reads the same listing fixture the pass itself
// walks, derived the way the real manager derives it (folder keyed exactly, then
// the `.cbz` basenames). This suite is about which folders get a write queued,
// and every folder in the fixture is backed up by construction.
const cloudVolumeTitlesFor = vi.hoisted(() =>
  vi.fn((seriesTitle: string) => {
    const titles = new Set<string>();
    for (const file of cloudListing.files) {
      const parts = file.path.split('/');
      if (parts.length !== 2 || parts[0] !== seriesTitle) continue;
      if (!parts[1].toLowerCase().endsWith('.cbz')) continue;
      titles.add(parts[1].slice(0, -4));
    }
    return titles;
  })
);

vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    writeSeriesFile,
    cloudVolumeTitlesFor,
    fetchAllCloudVolumes,
    getAllCloudVolumes
  }
}));

const scheduleCatalogFileWrite = vi.hoisted(() => vi.fn());
vi.mock('$lib/metadata/catalog-file-sync', () => ({ scheduleCatalogFileWrite }));

const { volumeRows, dbScans, metaRows, metaToArraySpy } = vi.hoisted(() => ({
  // A whole-table read of `series_metadata`. Its own spy so a regression back
  // to one can be asserted against directly — the keyed reads go through
  // `where('folded_key')` below and never touch it.
  metaToArraySpy: vi.fn(async () => [] as Record<string, unknown>[]),
  volumeRows: [] as Record<string, unknown>[],
  dbScans: { count: 0 },
  metaRows: new Map<string, Record<string, unknown>>()
}));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      // `locallyKnownSeriesKeys` (one full read per pass — the assertion
      // below on `dbScans.count`) still calls this bare method.
      toArray: async () => {
        dbScans.count += 1;
        return [...volumeRows];
      },
      // `hasBackedUpVolume`'s indexed per-series lookup
      // (`volumesForFoldedSeriesTitle`), fired when a scheduled write's
      // debounce elapses. Deliberately NOT counted by `dbScans` — the whole
      // point of narrowing it is that it no longer costs a table scan.
      where(index: string) {
        return {
          anyOf: (values: unknown[]) => ({
            toArray: async () => volumeRows.filter((r) => values.includes(r[index]))
          })
        };
      },
      orderBy(index: string) {
        return {
          uniqueKeys: async () => [...new Set(volumeRows.map((r) => r[index]))]
        };
      }
    },
    series_metadata: {
      get: async (key: string) => metaRows.get(key),
      put: async (rec: { series_key: string }) => {
        metaRows.set(rec.series_key, rec);
      },
      // The `folded_key` index, matched against whatever `store.ts` actually
      // WROTE onto the row — never re-derived here. A double that folded the
      // row itself would answer correctly even if production stopped stamping
      // the key, which is the one regression this index can suffer.
      where(index: string) {
        const rows = () => [...metaRows.values()];
        return {
          equals: (value: unknown) => ({
            toArray: async () => rows().filter((r) => r[index] === value)
          }),
          anyOf: (values: unknown[]) => ({
            toArray: async () => rows().filter((r) => values.includes(r[index]))
          })
        };
      },
      toArray: async (...args: Parameters<typeof metaToArraySpy>) => {
        await metaToArraySpy(...args);
        return [...metaRows.values()];
      }
    },
    transaction: async (_mode: string, _table: unknown, body: () => Promise<unknown>) => body()
  }
}));

import {
  _resetListingRefreshForTests,
  _resetReconcileForTests,
  _resetWriteSlotsForTests,
  LISTING_TTL_MS,
  markListingFresh,
  reconcileMissingMetadataFiles,
  scheduleSeriesFileWrite,
  SERIES_FILE_WRITE_DEBOUNCE_MS
} from './series-file-sync';
import { toStoredSeriesMetadata, type SeriesMetadata } from './types';

/**
 * Seed one `series_metadata` row the way `store.ts` would have written it —
 * through the real `toStoredSeriesMetadata`, so it carries the `folded_key` the
 * indexed reads match on. A hand-built row without it is not a row production
 * can produce, and would make an indexed lookup look broken.
 */
function addMeta(record: SeriesMetadata): void {
  const stored = toStoredSeriesMetadata(record);
  metaRows.set(stored.series_key, stored as unknown as Record<string, unknown>);
}

function addVolume(seriesTitle: string, volumeTitle: string, extra: object = {}) {
  volumeRows.push({
    volume_uuid: `${seriesTitle}/${volumeTitle}`,
    series_uuid: 's',
    series_title: seriesTitle,
    volume_title: volumeTitle,
    mokuro_version: '0.4.11',
    page_count: 1,
    character_count: 1,
    page_char_counts: [1],
    ...extra
  });
}

/** Titles the debounced writer actually published. */
function writtenTitles(): string[] {
  return writeSeriesFile.mock.calls.map((args: unknown[]) => args[0] as string).sort();
}

describe('reconcileMissingMetadataFiles', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetListingRefreshForTests();
    _resetReconcileForTests();
    _resetWriteSlotsForTests();
    writeSeriesFile.mockResolvedValue('written');
    fetchAllCloudVolumes.mockResolvedValue(undefined);
    getAllCloudVolumes.mockImplementation(() => cloudListing.files);
    providerStatus.set({
      providers: {},
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'webdav'
    });
    volumeRows.length = 0;
    metaRows.clear();
    dbScans.count = 0;
    cloudListing.files = [];
    addVolume('One Piece', 'Volume 1');
    addVolume('Berserk', 'Volume 1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes series.json for a folder that has archives but no sidecar', async () => {
    cloudListing.files = [
      { path: 'One Piece/Volume 1.cbz' },
      { path: 'One Piece/Volume 1.mokuro' },
      { path: 'catalog.json' }
    ];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writtenTitles()).toEqual(['One Piece']);
  });

  it('sweeps a folder that ALREADY has a sidecar for gap-fill (the OTHER half of convergence)', async () => {
    cloudListing.files = [
      { path: 'One Piece/Volume 1.cbz' },
      { path: 'One Piece/series.json' },
      { path: 'catalog.json' }
    ];

    await reconcileMissingMetadataFiles();

    expect(backfillSeriesEntries).toHaveBeenCalledWith('One Piece');
    // Not the "missing sidecar" scheduling path — no debounced write queued
    // for it, the backfill (mocked here) is the whole story for this folder.
    expect(writtenTitles()).toEqual([]);
  });

  it('never sweeps a bare folder that has no sidecar at all', async () => {
    cloudListing.files = [{ path: 'One Piece/Volume 1.cbz' }, { path: 'catalog.json' }];

    await reconcileMissingMetadataFiles();

    expect(backfillSeriesEntries).not.toHaveBeenCalled();
  });

  it('publishes a facts-only series.json for a linked series with no local rows', async () => {
    // The user linked a cloud series they never downloaded. The folder is
    // missing its sidecar; the facts are this device's contribution — entries
    // fill in later. Scheduler and gate must agree (same fold, same facts
    // test) or this folder loops schedule/drop forever.
    volumeRows.length = 0;
    // Stamped through the real `toStoredSeriesMetadata`, exactly as `store.ts`
    // stamps every row it writes: this fixture has to be indexable by
    // `folded_key` or it is not the row production would have stored.
    addMeta({
      series_key: 'naruto',
      series_title: 'Naruto',
      external_ids: { anilist: 42 },
      titles: {},
      synonyms: [],
      updated_at: '2026-08-24T00:00:00.000Z',
      facts_updated_at: '2026-08-24T00:00:00.000Z'
    });
    cloudListing.files = [{ path: 'Naruto/Volume 1.cbz' }, { path: 'catalog.json' }];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writtenTitles()).toEqual(['Naruto']);
  });

  it('does not schedule a folder this device has no rows AND no facts for', async () => {
    volumeRows.length = 0;
    cloudListing.files = [{ path: 'Naruto/Volume 1.cbz' }, { path: 'catalog.json' }];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writtenTitles()).toEqual([]);
  });

  it('leaves a folder alone when its series.json is already in the listing', async () => {
    cloudListing.files = [
      { path: 'One Piece/Volume 1.cbz' },
      { path: 'One Piece/series.json' },
      { path: 'catalog.json' }
    ];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writeSeriesFile).not.toHaveBeenCalled();
    expect(scheduleCatalogFileWrite).not.toHaveBeenCalled();
  });

  it('ignores a folder whose only files are sidecars (nothing is backed up there)', async () => {
    cloudListing.files = [
      { path: 'One Piece/Volume 1.mokuro' },
      { path: 'One Piece/Volume 1.webp' },
      { path: 'catalog.json' }
    ];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writeSeriesFile).not.toHaveBeenCalled();
    expect(scheduleCatalogFileWrite).not.toHaveBeenCalled();
  });

  it('backfills only the folders that are missing a sidecar', async () => {
    cloudListing.files = [
      { path: 'One Piece/Volume 1.cbz' },
      { path: 'One Piece/series.json' },
      { path: 'Berserk/Volume 1.cbz' },
      { path: 'catalog.json' }
    ];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writtenTitles()).toEqual(['Berserk']);
  });

  it('queues the catalog when a series.json was queued', async () => {
    cloudListing.files = [{ path: 'One Piece/Volume 1.cbz' }, { path: 'catalog.json' }];

    await reconcileMissingMetadataFiles();

    expect(scheduleCatalogFileWrite).toHaveBeenCalledTimes(1);
  });

  it('queues the catalog when the root catalog.json is absent, sidecars or not', async () => {
    cloudListing.files = [{ path: 'One Piece/Volume 1.cbz' }, { path: 'One Piece/series.json' }];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    // Nothing per-series to fix, but the library has no index at all.
    expect(writeSeriesFile).not.toHaveBeenCalled();
    expect(scheduleCatalogFileWrite).toHaveBeenCalledTimes(1);
  });

  it('does not treat a nested catalog.json as the root one', async () => {
    cloudListing.files = [
      { path: 'One Piece/Volume 1.cbz' },
      { path: 'One Piece/series.json' },
      { path: 'One Piece/catalog.json' }
    ];

    await reconcileMissingMetadataFiles();

    expect(scheduleCatalogFileWrite).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all for an empty or unfetched listing', async () => {
    cloudListing.files = [];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writeSeriesFile).not.toHaveBeenCalled();
    expect(scheduleCatalogFileWrite).not.toHaveBeenCalled();
  });

  it('does nothing when the listing holds only root config files', async () => {
    cloudListing.files = [{ path: 'volume-data.json' }, { path: 'profiles.json' }];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writeSeriesFile).not.toHaveBeenCalled();
    expect(scheduleCatalogFileWrite).not.toHaveBeenCalled();
  });

  it('accepts a listing passed by the caller instead of re-reading the cache', async () => {
    // The cache holds BOTH folders; the caller hands over One Piece only. Reading
    // the cache instead of the argument would queue Berserk as well — and the
    // per-series gate downstream reads the cache either way, which is why the
    // fixture has to contain what the argument names.
    cloudListing.files = [{ path: 'Berserk/Volume 1.cbz' }, { path: 'One Piece/Volume 1.cbz' }];

    await reconcileMissingMetadataFiles([{ path: 'One Piece/Volume 1.cbz' }]);
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(getAllCloudVolumes).not.toHaveBeenCalled();
    expect(writtenTitles()).toEqual(['One Piece']);
  });

  it('coalesces a second reconcile onto the one already running', async () => {
    cloudListing.files = [{ path: 'One Piece/Volume 1.cbz' }];

    const first = reconcileMissingMetadataFiles();
    const second = reconcileMissingMetadataFiles();
    expect(second).toBe(first);

    await first;
    await second;
    expect(getAllCloudVolumes).toHaveBeenCalledTimes(1);
    expect(scheduleCatalogFileWrite).toHaveBeenCalledTimes(1);

    // Once settled, a later reconcile runs for real again.
    await reconcileMissingMetadataFiles();
    expect(getAllCloudVolumes).toHaveBeenCalledTimes(2);
  });

  it('skips a folder this device holds no row for at all', async () => {
    // A second device that has never imported this series can never publish its
    // index: `hasBackedUpVolume` looks for a non-placeholder row and finds none.
    // Queuing it anyway would re-fire — and re-scan the whole volumes table — on
    // every single listing, forever, without ever converging.
    volumeRows.length = 0;
    cloudListing.files = [{ path: 'One Piece/Volume 1.cbz' }, { path: 'catalog.json' }];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writeSeriesFile).not.toHaveBeenCalled();
    expect(scheduleCatalogFileWrite).not.toHaveBeenCalled();
  });

  it('reconciles a folder whose only local rows are metadata-only', async () => {
    // A library whose files were removed from this device keeps its rows, its
    // uuids and its history — and `hasBackedUpVolume` accepts them, so the
    // write really does go through. This is the flagship case for retained
    // rows, not an edge: excluding it would leave exactly those libraries
    // without an index forever.
    volumeRows.length = 0;
    addVolume('One Piece', 'Volume 1', { metadata_only: true });
    cloudListing.files = [{ path: 'One Piece/Volume 1.cbz' }, { path: 'catalog.json' }];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writtenTitles()).toEqual(['One Piece']);
  });

  it('skips a folder whose only local rows are cloud placeholders', async () => {
    // Placeholders are synthesised from the listing itself: no history, no
    // uuids of our own, nothing local to publish. `hasBackedUpVolume` excludes
    // them too, so scheduling one could never converge either.
    volumeRows.length = 0;
    addVolume('One Piece', 'Volume 1', { isPlaceholder: true });
    cloudListing.files = [{ path: 'One Piece/Volume 1.cbz' }, { path: 'catalog.json' }];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('schedules on a mix of installed and metadata-only rows', async () => {
    volumeRows.length = 0;
    addVolume('One Piece', 'Volume 1', { metadata_only: true });
    addVolume('One Piece', 'Volume 2');
    cloudListing.files = [
      { path: 'One Piece/Volume 1.cbz' },
      { path: 'One Piece/Volume 2.cbz' },
      { path: 'catalog.json' }
    ];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writtenTitles()).toEqual(['One Piece']);
  });

  it('reads the volumes table once for the whole pass, not once per folder', async () => {
    cloudListing.files = [
      { path: 'One Piece/Volume 1.cbz' },
      { path: 'Berserk/Volume 1.cbz' },
      { path: 'catalog.json' }
    ];

    await reconcileMissingMetadataFiles();

    // Before the writes fire — those scan again, by design, on the fresh view.
    expect(dbScans.count).toBe(1);
  });

  it('reads the metadata table by folded key, never whole, when deciding what to schedule', async () => {
    // `locallyKnownSeriesKeys` is the second half of the schedule gate: a
    // folder with no local row still qualifies if this device has FACTS for it.
    // It used to answer that by reading every `series_metadata` row and folding
    // each one in JS; it now asks the `folded_key` index about the candidate
    // folders only.
    //
    // The fold is what the fixture is built around — the folder is decomposed,
    // the record composed — so a lookup that lost the fold would schedule
    // nothing, and the `writtenTitles` assertion is what says the keyed read
    // still found it rather than quietly finding nothing.
    volumeRows.length = 0;
    const folder = 'ポケモン'.normalize('NFD');
    addMeta({
      series_key: 'ポケモン',
      series_title: 'ポケモン',
      external_ids: { anilist: 30013 },
      titles: {},
      synonyms: [],
      updated_at: '2026-08-24T00:00:00.000Z',
      facts_updated_at: '2026-08-24T00:00:00.000Z'
    });
    // A second record the pass must never need to look at.
    addMeta({
      series_key: 'naruto',
      series_title: 'Naruto',
      external_ids: { anilist: 20 },
      titles: {},
      synonyms: [],
      updated_at: '2026-08-24T00:00:00.000Z',
      facts_updated_at: '2026-08-24T00:00:00.000Z'
    });
    cloudListing.files = [{ path: `${folder}/Volume 1.cbz` }, { path: 'catalog.json' }];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writtenTitles()).toEqual([folder]);
    expect(metaToArraySpy).not.toHaveBeenCalled();
  });

  it('does not touch the volumes table when every folder already has a sidecar', async () => {
    cloudListing.files = [
      { path: 'One Piece/Volume 1.cbz' },
      { path: 'One Piece/series.json' },
      { path: 'catalog.json' }
    ];

    await reconcileMissingMetadataFiles();

    expect(dbScans.count).toBe(0);
  });

  it('keys folders verbatim, so a case-variant sibling cannot vouch for one', async () => {
    // `cloudSeriesTitles` treats these as two folders (they ARE two folders on
    // any case-sensitive backend); folding them together here would let the
    // sidecar in one suppress the write the other needs.
    cloudListing.files = [
      { path: 'Berserk/Volume 1.cbz' },
      { path: 'berserk/series.json' },
      { path: 'catalog.json' }
    ];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writtenTitles()).toEqual(['Berserk']);
  });

  it('reuses a listing the caller already stamped instead of refetching it', async () => {
    // `refreshSeriesIndexesInBackground` stamps the listing it just fetched
    // before handing it here; without that the write 2 s later would open with
    // a second whole-account fetch.
    markListingFresh();
    cloudListing.files = [{ path: 'One Piece/Volume 1.cbz' }, { path: 'catalog.json' }];

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
    expect(fetchAllCloudVolumes).not.toHaveBeenCalled();
  });

  /**
   * THE HAZARD THIS PAIR OF TESTS EXISTS FOR.
   *
   * `runReconcile` has two callers with two different truth guarantees:
   *
   * - the post-listing hook (`unified-cloud-manager.ts`) hands over `files`
   *   it just fetched — a genuinely fresh listing;
   * - the "Backup all" / "Backup series" buttons (`SeriesView.svelte`,
   *   `CloudView.svelte`) call `reconcileMissingMetadataFiles()` with NO
   *   argument, so `runReconcile` falls back to whatever the provider cache
   *   already holds — which can be arbitrarily stale (`cache?.isLoaded()` in
   *   `unified-cloud-manager.ts` is happy with a cache from hours ago).
   *
   * Only the first caller may skip `ensureFreshCloudListing()` at write time
   * — that is what `fromCloudListing` is FOR. Marking every reconcile-
   * scheduled write with it regardless of which caller produced it meant a
   * button press past `LISTING_TTL_MS` built `writeSeriesFile`'s prune step
   * (`cloudVolumeTitles`) against a stale view — silently deleting another
   * device's freshly-uploaded volume from `series.json`.
   *
   * Both tests hold the listing equally stale (marked fresh once, then aged
   * past the TTL); the only variable is whether `files` was actually handed
   * to `reconcileMissingMetadataFiles`.
   */
  it('a reconcile pass with no files argument (the button path) refreshes a stale listing before writing', async () => {
    markListingFresh();
    cloudListing.files = [{ path: 'One Piece/Volume 1.cbz' }, { path: 'catalog.json' }];
    await vi.advanceTimersByTimeAsync(LISTING_TTL_MS + 1000);

    await reconcileMissingMetadataFiles();
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
    expect(fetchAllCloudVolumes).toHaveBeenCalled();
  });

  it('a reconcile pass GIVEN files (the post-listing hook) still skips the refresh once stale', async () => {
    markListingFresh();
    const files = [{ path: 'One Piece/Volume 1.cbz' }, { path: 'catalog.json' }];
    cloudListing.files = files;
    await vi.advanceTimersByTimeAsync(LISTING_TTL_MS + 1000);

    await reconcileMissingMetadataFiles(files);
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
    expect(fetchAllCloudVolumes).not.toHaveBeenCalled();
  });

  /**
   * THE LOOP THIS PAIR OF TESTS EXISTS FOR.
   *
   * A reconcile pass over a half-converged library queues one write per
   * folder, and they drain two at a time (`write-slot.ts`). Every write used
   * to open with `ensureFreshCloudListing()`, whose stamp expires after
   * `LISTING_TTL_MS` — so a queue that takes longer than 30 s to drain paid
   * for a fresh WHOLE-ACCOUNT listing every 30 s, forever, to re-learn the
   * folder set it was scheduled from. On a provider whose listing is a slow
   * paged whole-account query the user watches the connection badge
   * oscillate for as long as the app is open.
   *
   * The two tests are deliberately identical except for HOW the writes were
   * scheduled, so the assertion cannot be satisfied by both branches: the
   * control below must see refetches for the same queue, same timings, same
   * number of writes.
   */
  const SLOW_WRITE_MS = 20_000;

  /** Six folders, no sidecars, all locally known — 3 rounds of 2 slots. */
  function seedSixCandidateFolders(): string[] {
    const titles = ['A', 'B', 'C', 'D', 'E', 'F'];
    cloudListing.files = titles.map((t) => ({ path: `${t}/Volume 1.cbz` }));
    cloudListing.files.push({ path: 'catalog.json' });
    for (const title of titles) addVolume(title, 'Volume 1');
    // Long enough that 6 writes through 2 slots (3 rounds x 20 s = 60 s)
    // outlast the 30 s TTL twice over — a shorter write would let the queue
    // drain inside one window and the test would pass without the fix.
    writeSeriesFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('written'), SLOW_WRITE_MS);
        })
    );
    return titles;
  }

  /** Advance past the debounce and then through the whole drain. */
  async function drain(): Promise<void> {
    await vi.advanceTimersByTimeAsync(SERIES_FILE_WRITE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(SLOW_WRITE_MS * 4);
  }

  it('a burst of reconcile-scheduled writes draining past the TTL refetches nothing', async () => {
    markListingFresh();
    const titles = seedSixCandidateFolders();

    // The real listing-driven caller (`unified-cloud-manager.ts`'s
    // post-listing hook) always hands `runReconcile` the `files` array it
    // just fetched — that is what makes `fromCloudListing` true and skipping
    // the refresh below safe. Calling with no argument here would exercise
    // the OTHER caller shape (the backup buttons, which pass nothing and fall
    // back to the cache) instead of the one this test is about.
    await reconcileMissingMetadataFiles(cloudListing.files);
    await drain();

    // The queue really did outlast the window this test claims to test.
    expect(SLOW_WRITE_MS * 3).toBeGreaterThan(LISTING_TTL_MS);
    expect(writtenTitles()).toEqual(titles);
    expect(fetchAllCloudVolumes).not.toHaveBeenCalled();
  });

  it('CONTROL: the same burst scheduled by a fact edit DOES refetch past the TTL', async () => {
    // Same folders, same slow writes, same drain — the only difference is
    // that these writes were not scheduled off a just-fetched listing, so
    // they are the ones that legitimately have to go and get one.
    markListingFresh();
    const titles = seedSixCandidateFolders();

    for (const title of titles) scheduleSeriesFileWrite(title);
    await drain();

    expect(writtenTitles()).toEqual(titles);
    expect(fetchAllCloudVolumes).toHaveBeenCalled();
  });

  it('never throws out of the fire-and-forget call sites', async () => {
    getAllCloudVolumes.mockImplementation(() => {
      throw new Error('cache exploded');
    });

    await expect(reconcileMissingMetadataFiles()).resolves.toBeUndefined();
  });
});
