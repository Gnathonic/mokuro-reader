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

const { volumeRows, dbScans, metaRows } = vi.hoisted(() => ({
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
      toArray: async () => [...metaRows.values()]
    },
    transaction: async (_mode: string, _table: unknown, body: () => Promise<unknown>) => body()
  }
}));

import {
  _resetListingRefreshForTests,
  _resetReconcileForTests,
  _resetWriteSlotsForTests,
  markListingFresh,
  reconcileMissingMetadataFiles,
  SERIES_FILE_WRITE_DEBOUNCE_MS
} from './series-file-sync';

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
    metaRows.set('naruto', {
      series_key: 'naruto',
      series_title: 'Naruto',
      external_ids: { anilist: 42 },
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

  it('never throws out of the fire-and-forget call sites', async () => {
    getAllCloudVolumes.mockImplementation(() => {
      throw new Error('cache exploded');
    });

    await expect(reconcileMissingMetadataFiles()).resolves.toBeUndefined();
  });
});
