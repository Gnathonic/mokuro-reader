import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDeterministicUUID } from '$lib/util/series-extraction';

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

const writeSeriesFile = vi.hoisted(() =>
  vi.fn(
    async (_seriesTitle: string, _options?: { cloudMeasuredVolumes?: Record<string, unknown>[] }) =>
      'written' as const
  )
);
const backfillSeriesEntries = vi.hoisted(() => vi.fn(async () => {}));
const backfillNewlyLinkedSeries = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./series-backfill', () => ({ backfillSeriesEntries, backfillNewlyLinkedSeries }));

/**
 * The provider's file cache, as the listing of paths it holds.
 *
 * The backup gate's double derives its answer from THIS fixture the way the real
 * manager does (`cacheManager.getBySeries` keys the folder exactly, then the
 * `.cbz` basenames name the volumes) instead of echoing back the title it was
 * asked about. An echoing double makes every comparison the gate performs look
 * like a match, which is exactly how a byte-wise probe passed its tests while
 * dropping every write for a folder whose filenames are decomposed.
 */
const cloudPaths = vi.hoisted(() => [] as string[]);
const cloudVolumeTitlesFor = vi.hoisted(() =>
  vi.fn((seriesTitle: string) => {
    // The manager resolves the caller's title to the folder the LISTING spells
    // before reading it (`resolveCloudFolderTitle`, tested there): exact folder
    // key first, else the one whose folded key matches. Mirrored here so the
    // gate meets the same contract it meets in production.
    const folders = new Set(
      cloudPaths.map((path) => path.split('/')[0]).filter((folder) => !!folder)
    );
    const folder = folders.has(seriesTitle)
      ? seriesTitle
      : [...folders].find(
          (candidate) => candidate.normalize('NFC') === seriesTitle.normalize('NFC')
        );

    const titles = new Set<string>();
    if (!folder) return titles;
    for (const path of cloudPaths) {
      const parts = path.split('/');
      if (parts.length !== 2 || parts[0] !== folder) continue;
      if (!parts[1].toLowerCase().endsWith('.cbz')) continue;
      titles.add(parts[1].slice(0, -4));
    }
    return titles;
  })
);
const fetchAllCloudVolumes = vi.hoisted(() => vi.fn(async (_options?: unknown) => {}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { writeSeriesFile, cloudVolumeTitlesFor, fetchAllCloudVolumes }
}));

// An in-memory stand-in for the two tables involved: the gate reads the
// installed volumes, and `store.ts` writes the series_metadata rows whose fact
// changes drive the listener. Deliberately NOT fake-indexeddb: it schedules its
// transactions on setImmediate, which vitest's fake timers freeze.
const { volumeRows, metaRows, volumesToArraySpy, metaToArraySpy } = vi.hoisted(() => ({
  volumeRows: [] as Record<string, unknown>[],
  metaRows: new Map<string, Record<string, unknown>>(),
  // Its own `vi.fn()`, not an inline arrow: a full-table-scan regression test
  // needs to assert it was never reached, distinct from the indexed
  // `where(...)`/`orderBy(...)` reads below.
  volumesToArraySpy: vi.fn(async () => [] as Record<string, unknown>[]),
  // The same distinction for `series_metadata`: `hasPublishableFacts` now
  // answers off the `folded_key` index, so a whole-table read here is a
  // regression rather than the normal path.
  metaToArraySpy: vi.fn(async () => [] as Record<string, unknown>[])
}));

vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      toArray: (...args: Parameters<typeof volumesToArraySpy>) => volumesToArraySpy(...args),
      // Minimal stand-ins for the two indexed reads
      // `volumesForFoldedSeriesTitle` performs — never the full-table scan
      // `toArray` above would be.
      where(index: string) {
        return {
          equals: (value: unknown) => ({
            toArray: async () => volumeRows.filter((r) => r[index] === value)
          }),
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
  _resetWriteSlotsForTests,
  cancelScheduledSeriesFileWrite,
  flushSeriesFileWrites,
  initSeriesFileSync,
  LISTING_TIMEOUT_MS,
  LISTING_TTL_MS,
  markListingFresh,
  scheduleSeriesFileWrite
} from './series-file-sync';
import { updateSeriesReadingState } from '$lib/settings/series-data';
import { updateSeriesMetadata, unlinkSeries, upsertFromSeriesFile } from './store';

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

/** Put a volume's archive in the cloud listing fixture, spelled exactly as given. */
function backUp(seriesTitle: string, volumeTitle: string) {
  cloudPaths.push(`${seriesTitle}/${volumeTitle}.cbz`);
}

let dispose: (() => void) | undefined;

describe('series-file-sync', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetListingRefreshForTests();
    _resetWriteSlotsForTests();
    writeSeriesFile.mockResolvedValue('written');
    fetchAllCloudVolumes.mockResolvedValue(undefined);
    cloudPaths.length = 0;
    backUp('One Piece', 'Volume 1');
    providerStatus.set({
      providers: {},
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'webdav'
    });
    volumeRows.length = 0;
    metaRows.clear();
    addVolume('One Piece', 'Volume 1');
    dispose = initSeriesFileSync();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
  });

  it('coalesces a burst of edits into one write per series', async () => {
    scheduleSeriesFileWrite('One Piece');
    scheduleSeriesFileWrite('One Piece');
    scheduleSeriesFileWrite('One Piece');
    expect(writeSeriesFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('a 20-volume batch install coalesces to ONE write and ONE listing refresh', async () => {
    // The install trigger (download-queue.ts / import-service.ts) schedules
    // once per completed volume under the same folder key. Twenty completions
    // inside the debounce window must cost one PUT, not twenty — and the one
    // debounced write pays at most one whole-account listing refresh.
    for (let i = 0; i < 20; i++) scheduleSeriesFileWrite('One Piece');
    expect(writeSeriesFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
    expect(fetchAllCloudVolumes).toHaveBeenCalledTimes(1);
  });

  it('debounces per series — two series each get their own write', async () => {
    addVolume('Berserk', 'Volume 1');
    backUp('Berserk', 'Volume 1');

    scheduleSeriesFileWrite('One Piece');
    scheduleSeriesFileWrite('Berserk');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile.mock.calls.map((args: unknown[]) => args[0]).sort()).toEqual([
      'Berserk',
      'One Piece'
    ]);
  });

  it('refreshes the cloud listing once for every series flushed together', async () => {
    addVolume('Berserk', 'Volume 1');
    backUp('Berserk', 'Volume 1');

    scheduleSeriesFileWrite('One Piece');
    scheduleSeriesFileWrite('Berserk');
    await flushSeriesFileWrites();

    // One listing for the whole flush — it is a whole-account fetch, so N
    // series must not cost N of them. And never the index refresh: that pass
    // downloads sidecars, and this is a write path.
    expect(fetchAllCloudVolumes).toHaveBeenCalledTimes(1);
    expect(fetchAllCloudVolumes).toHaveBeenCalledWith({ refreshIndexes: false });
    expect(writeSeriesFile).toHaveBeenCalledTimes(2);
  });

  it('shares a listing refresh that is still in flight with the next series due', async () => {
    // A real listing is a network round trip, so the second debounce timer of a
    // burst fires while the first write is still waiting for it.
    addVolume('Berserk', 'Volume 1');
    backUp('Berserk', 'Volume 1');
    fetchAllCloudVolumes.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 50))
    );

    scheduleSeriesFileWrite('One Piece');
    scheduleSeriesFileWrite('Berserk');
    await vi.advanceTimersByTimeAsync(2100);

    expect(fetchAllCloudVolumes).toHaveBeenCalledTimes(1);
    expect(writeSeriesFile).toHaveBeenCalledTimes(2);
  });

  it('decides the write on the refreshed listing, not the one the edit saw', async () => {
    // At edit time nothing is backed up (the listing predates the upload); the
    // refresh is what reveals the archive.
    cloudPaths.length = 0;
    fetchAllCloudVolumes.mockImplementation(async () => {
      backUp('One Piece', 'Volume 1');
    });

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('reuses a listing that succeeded within the TTL instead of fetching again', async () => {
    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchAllCloudVolumes).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LISTING_TTL_MS / 2);
    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchAllCloudVolumes).toHaveBeenCalledTimes(1);
    expect(writeSeriesFile).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(LISTING_TTL_MS);
    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchAllCloudVolumes).toHaveBeenCalledTimes(2);
  });

  it('reuses a listing another module already paid for, until the TTL runs out', async () => {
    // The backup run fetches the whole-account listing itself before writing its
    // indexes. Stamping it means the writes that follow reuse THAT listing
    // instead of paying for a second whole-account fetch per run.
    markListingFresh();

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchAllCloudVolumes).not.toHaveBeenCalled();
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);

    // Still the same TTL as a refresh this module ran itself — a stamp is not a
    // licence to write against an ancient view forever.
    await vi.advanceTimersByTimeAsync(LISTING_TTL_MS);
    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchAllCloudVolumes).toHaveBeenCalledTimes(1);
  });

  it('skips the listing refresh for a run-scheduled write, but never the writer’s own re-read', async () => {
    // 2026-08-23 design amendment: a write scheduled from inside a backup run
    // (`duringBackupRun`) skips the whole-account listing refresh — the run
    // already primed that listing and keeps it current via its own optimistic
    // `cache.add()` as it uploads, so refetching it mid-run is pure waste.
    //
    // The writer's own re-read is NOT skipped: it only fires when the listing
    // shows a stamp our cache does not have, i.e. exactly when another device
    // wrote the file. Suppressing it there is how a mid-run PUT clobbers that
    // device's series.json.
    scheduleSeriesFileWrite('One Piece', { duringBackupRun: true });
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchAllCloudVolumes).not.toHaveBeenCalled();
    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('still refreshes the listing and re-reads normally for a write NOT scheduled from a run', async () => {
    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchAllCloudVolumes).toHaveBeenCalledTimes(1);
    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('coalesces schedule options the same way it coalesces the title — the LAST call for a series wins', async () => {
    // A fact edit landing in the same 2s window as a run-scheduled write for
    // the same series should not silently keep the run's network-free
    // options; whichever call was scheduled last describes the write that
    // actually happens.
    scheduleSeriesFileWrite('One Piece', { duringBackupRun: true });
    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
    expect(fetchAllCloudVolumes).toHaveBeenCalledTimes(1);
  });

  it('threads `cloudMeasuredVolumes` straight through to the writer', async () => {
    // The mechanism `cover-service.ts`'s render-demand publish (decision-tree
    // case 3) relies on: a caller's freshly-pulled, fully-stamped entry must
    // reach `unifiedCloudManager.writeSeriesFile`'s own `cloudMeasuredVolumes`
    // parameter, not be silently dropped by the debounced path.
    const entry = {
      volume_uuid: 'real-uuid',
      volume_title: 'Volume 1',
      page_count: 12,
      character_count: 300,
      mokuro_version: '0.4.12',
      mokuro_size: 500,
      mokuro_modified: 1_700_000_000
    };
    scheduleSeriesFileWrite('One Piece', { cloudMeasuredVolumes: [entry] });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece', {
      cloudMeasuredVolumes: [entry]
    });
  });

  it('omits the second argument entirely when nothing was threaded through — same call shape as before this option existed', async () => {
    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
    expect(writeSeriesFile.mock.calls[0]).toHaveLength(1);
  });

  it('ACCUMULATES `cloudMeasuredVolumes` across coalesced calls for the same series — unlike every other option, a later call must not drop an earlier one’s entry', async () => {
    const entryA = {
      volume_uuid: 'uuid-a',
      volume_title: 'Volume 1',
      page_count: 1,
      character_count: 1,
      mokuro_version: '0.4.11'
    };
    const entryB = {
      volume_uuid: 'uuid-b',
      volume_title: 'Volume 2',
      page_count: 2,
      character_count: 2,
      mokuro_version: '0.4.11'
    };
    scheduleSeriesFileWrite('One Piece', { cloudMeasuredVolumes: [entryA] });
    scheduleSeriesFileWrite('One Piece', { cloudMeasuredVolumes: [entryB] });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    const [, options = {}] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes).toEqual(expect.arrayContaining([entryA, entryB]));
    expect(options.cloudMeasuredVolumes).toHaveLength(2);
  });

  it('keeps the LATEST entry for the same uuid when two coalesced calls both describe it', async () => {
    const stale = {
      volume_uuid: 'uuid-a',
      volume_title: 'Volume 1',
      page_count: 1,
      character_count: 1,
      mokuro_version: '0.4.11'
    };
    const fresh = {
      volume_uuid: 'uuid-a',
      volume_title: 'Volume 1',
      page_count: 5,
      character_count: 50,
      mokuro_version: '0.4.12'
    };
    scheduleSeriesFileWrite('One Piece', { cloudMeasuredVolumes: [stale] });
    scheduleSeriesFileWrite('One Piece', { cloudMeasuredVolumes: [fresh] });
    await vi.advanceTimersByTimeAsync(2000);

    const [, options = {}] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes).toEqual([fresh]);
  });

  it('replaces an accumulated no-metadata entry when a later call brings the real mokuro uuid for the same file', async () => {
    // Two render-demand resolutions in one debounce window can describe the
    // SAME archive: an image-only fallback first (derived uuid, zero counts),
    // then the real sidecar's entry (its own uuid). A by-uuid accumulator kept
    // both — the exact doubled-entry bug — so the join is the folded title.
    const placeholder = {
      volume_uuid: generateDeterministicUUID('One Piece/Volume 1'),
      volume_title: 'Volume 1',
      page_count: 0,
      character_count: 0,
      mokuro_version: ''
    };
    const real = {
      volume_uuid: 'real-uuid',
      volume_title: 'Volume 1',
      page_count: 12,
      character_count: 300,
      mokuro_version: '0.4.12'
    };
    scheduleSeriesFileWrite('One Piece', { cloudMeasuredVolumes: [placeholder] });
    scheduleSeriesFileWrite('One Piece', { cloudMeasuredVolumes: [real] });
    await vi.advanceTimersByTimeAsync(2000);

    const [, options = {}] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes).toEqual([real]);
  });

  it('does not let `cloudMeasuredVolumes` bleed the "last option wins" rule for duringBackupRun the other way either', async () => {
    // A `cloudMeasuredVolumes` call followed by a plain `duringBackupRun`
    // call for the same series: `duringBackupRun` still simply overwrites
    // (per the existing "last call wins" contract), while the entries
    // accumulated so far are preserved rather than dropped.
    const entry = {
      volume_uuid: 'uuid-a',
      volume_title: 'Volume 1',
      page_count: 1,
      character_count: 1,
      mokuro_version: '0.4.11'
    };
    scheduleSeriesFileWrite('One Piece', { cloudMeasuredVolumes: [entry] });
    scheduleSeriesFileWrite('One Piece', { duringBackupRun: true });
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchAllCloudVolumes).not.toHaveBeenCalled(); // duringBackupRun's own effect still applies
    const [, options = {}] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes).toEqual([entry]);
  });

  it('gives up on a listing refresh that hangs, and the next flush tries again', async () => {
    fetchAllCloudVolumes.mockImplementationOnce(() => new Promise<void>(() => {}));
    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LISTING_TIMEOUT_MS + 1);
    expect(writeSeriesFile).not.toHaveBeenCalled();

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchAllCloudVolumes).toHaveBeenCalledTimes(2);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
  });

  it('skips the write when the listing refresh fails (never writes against a stale view)', async () => {
    fetchAllCloudVolumes.mockRejectedValue(new Error('offline'));

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('does not refresh the listing when the gates already rule the write out', async () => {
    providerStatus.set({
      providers: { webdav: { isReadOnly: true } },
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'webdav'
    });

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchAllCloudVolumes).not.toHaveBeenCalled();
  });

  it('does not write when no cloud provider is connected', async () => {
    providerStatus.set({
      providers: {},
      hasAnyAuthenticated: false,
      needsAttention: false,
      currentProviderType: null
    });

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('does not write to a read-only provider', async () => {
    providerStatus.set({
      providers: { webdav: { isReadOnly: true } },
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'webdav'
    });

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('does not write for a series with nothing backed up', async () => {
    cloudPaths.length = 0;

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('ignores a series whose only cloud files are sidecars (no archive)', async () => {
    cloudPaths.length = 0;
    cloudPaths.push('One Piece/Volume 1.mokuro');

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('writes a facts-only file for a linked series with nothing local (placeholder library)', async () => {
    // The user browsed the cloud and linked a series they never downloaded.
    // The folder exists up there full of archives; the link is worth
    // publishing even though this device cannot vouch for a single volume
    // entry — entries fill in later (downloads here, another device's backup,
    // or a server compiling them itself).
    volumeRows.length = 0;
    await updateSeriesMetadata('One Piece', { external_ids: { anilist: 123 } });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('does not write a factless file for a folder this device merely sees', async () => {
    // No local rows AND no facts: nothing to say. Without this rule every
    // placeholder folder in the account would get an empty series.json.
    volumeRows.length = 0;

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('facts alone never CREATE a folder: no archives in the cloud, no write', async () => {
    volumeRows.length = 0;
    cloudPaths.length = 0;
    await updateSeriesMetadata('One Piece', { external_ids: { anilist: 123 } });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('writes for a decomposed folder AND decomposed filenames, rows being composed', async () => {
    // The whole NFD case, not half of it: a backend that decomposes names does it
    // to the FILES as well as the folder. The reconcile pass folds the folder name
    // and schedules the write; this gate has to fold the volume titles too — the
    // same fold `buildSeriesFile`'s listing prune applies — or the write is
    // dropped, the folder still has no series.json, and the very next listing
    // schedules it again: an eternal schedule/drop loop, one volumes scan each.
    const composedSeries = 'ポケモン';
    const composedVolume = 'ポケモン 1';
    const series = composedSeries.normalize('NFD');
    const volumeTitle = composedVolume.normalize('NFD');
    expect(series).not.toBe(composedSeries);
    expect(volumeTitle).not.toBe(composedVolume);

    cloudPaths.length = 0;
    backUp(series, volumeTitle);
    addVolume(composedSeries, composedVolume);

    scheduleSeriesFileWrite(series);
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledWith(series);
  });

  it('writes for a fact edit that carries the composed title of a decomposed folder', async () => {
    // How the folder is reached AFTER the reconcile pass: a fact edit (or a
    // per-completion schedule) names the series with the local composed title,
    // while the cloud folder is decomposed. Dropping those writes is permanent —
    // reconcile only revisits folders that have no series.json — so the folder's
    // facts would never move again.
    const composedSeries = 'ポケモン';
    const series = composedSeries.normalize('NFD');
    cloudPaths.length = 0;
    backUp(series, 'Volume 1'.normalize('NFD'));
    addVolume(composedSeries, 'Volume 1');

    scheduleSeriesFileWrite(composedSeries);
    await vi.advanceTimersByTimeAsync(2000);

    // Handed on with the caller's spelling: the manager resolves the folder (and
    // writes under the listing's path) itself.
    expect(writeSeriesFile).toHaveBeenCalledWith(composedSeries);
  });

  it('asks about one series without scanning the whole table', async () => {
    // A series with a local row matching the schedule exactly: the ordinary
    // case. `hasBackedUpVolume` must answer entirely off the `series_title`
    // index — never the bare `db.volumes.toArray()` a full-table scan is.
    backUp('One Piece', 'Volume 1');
    addVolume('One Piece', 'Volume 1');

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(volumesToArraySpy).not.toHaveBeenCalled();
    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('answers "nothing here" for a cloud-only series with zero local rows, without scanning the whole table', async () => {
    // The overwhelmingly common case during a reconcile pass over a large
    // cloud library: a series this device has never imported or linked. The
    // table already holds an unrelated series's rows (`One Piece`, from
    // `beforeEach`) — proving the lookup costs no full scan even though the
    // table is non-empty, not just when it is empty outright.
    backUp('Cloud Only Series', 'Volume 1');
    // Deliberately no addVolume('Cloud Only Series', ...) — no local row
    // anywhere in the table for this series.

    scheduleSeriesFileWrite('Cloud Only Series');
    await vi.advanceTimersByTimeAsync(2000);

    expect(volumesToArraySpy).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalledWith('Cloud Only Series');
  });

  it('asks whether a series has publishable facts without scanning the metadata table', async () => {
    // The facts-only publish path: a series the user LINKED but never
    // downloaded, so `hasBackedUpVolume` is false and the answer rests entirely
    // on `hasPublishableFacts`. That gate runs once per series being published,
    // and used to read the whole `series_metadata` table to do it.
    //
    // The fold is load-bearing here, not incidental: the cloud folder is
    // decomposed while the record is written from the composed title, so only
    // the `folded_key` index can match them. A byte-wise `get` would miss and
    // the write would be dropped — which is why this asserts the write HAPPENED
    // as well as asserting how it was reached.
    const composedSeries = 'ポケモン';
    const folder = composedSeries.normalize('NFD');
    cloudPaths.length = 0;
    volumeRows.length = 0;
    backUp(folder, 'Volume 1'.normalize('NFD'));
    // A second, unrelated record in the table: the bound has to hold because
    // the read is keyed, not because there was only ever one row to find.
    await updateSeriesMetadata('Naruto', { external_ids: { anilist: 20 } });
    await updateSeriesMetadata(composedSeries, { external_ids: { anilist: 30013 } });
    vi.clearAllMocks();
    writeSeriesFile.mockResolvedValue('written');

    scheduleSeriesFileWrite(composedSeries);
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledWith(composedSeries);
    expect(metaToArraySpy).not.toHaveBeenCalled();
  });

  it('swallows a write failure — a background index write never breaks an edit', async () => {
    writeSeriesFile.mockRejectedValue(new Error('offline'));

    scheduleSeriesFileWrite('One Piece');
    // No unhandled rejection, no throw out of the timer callback.
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
  });

  it('caps the fan-out at two writes in flight, however many series come due', async () => {
    // The debounce is per series, so a burst — a reconcile pass over a big
    // library, an import batch, a tagging spree — puts every timer on the SAME
    // 2000 ms mark. Uncapped that is N whole-table scans and N PUTs at once.
    const titles = ['A', 'B', 'C', 'D', 'E'];
    for (const title of titles) {
      addVolume(title, 'Volume 1');
      backUp(title, 'Volume 1');
    }

    let inFlight = 0;
    let peak = 0;
    writeSeriesFile.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return 'written';
    });

    for (const title of titles) scheduleSeriesFileWrite(title);
    await vi.advanceTimersByTimeAsync(2000 + 25 * titles.length + 25);

    expect(peak).toBe(2);
    // Capped, not dropped: every series still gets its write.
    expect(writeSeriesFile.mock.calls.map((args: unknown[]) => args[0]).sort()).toEqual(titles);
  });

  it('flush writes everything pending immediately', async () => {
    scheduleSeriesFileWrite('One Piece');
    await flushSeriesFileWrites();

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    // The timer is cancelled, not merely fired early.
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending write for one series without touching the others', async () => {
    // The drain pass writes the run's indexes directly. Whatever the live
    // per-completion schedule left pending for the same series is now redundant:
    // firing it too would be a second PUT of identical bytes (mtime churn on
    // every other device) racing the direct write for the same file.
    addVolume('Berserk', 'Volume 1');
    backUp('Berserk', 'Volume 1');

    scheduleSeriesFileWrite('One Piece');
    scheduleSeriesFileWrite('Berserk');
    cancelScheduledSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile.mock.calls.map((args: unknown[]) => args[0])).toEqual(['Berserk']);
  });

  it('waits for a write already in flight instead of letting a caller race it', async () => {
    // Cancelling a TIMER is not enough: the debounce may already have fired and
    // the write be sitting on its PUT (the drain runs right after a whole-account
    // fetch, which is exactly long enough for that). The drain must be able to
    // wait for it, or two writes for one series are in flight at once — the race
    // nothing else serializes.
    let finishPut: (() => void) | undefined;
    writeSeriesFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPut = () => resolve('written');
        })
    );

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    expect(finishPut).toBeDefined();

    let settled = false;
    const cancelled = cancelScheduledSeriesFileWrite('One Piece').then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    finishPut!();
    await cancelled;
    expect(settled).toBe(true);
    // Nothing new was started by the cancel itself.
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
  });

  it('resolves immediately when nothing is queued or in flight', async () => {
    let settled = false;
    const cancelled = cancelScheduledSeriesFileWrite('Nothing Here').then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    await cancelled;
    expect(settled).toBe(true);
  });

  it('cancels by the same key the schedule used, whatever the caller spells it', async () => {
    scheduleSeriesFileWrite('One Piece');
    cancelScheduledSeriesFileWrite('  one   piece  ');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('fires after a fact edit through the store', async () => {
    await updateSeriesMetadata('One Piece', { tag: 'color' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('fires after an unlink (the cleared facts have to be published)', async () => {
    await updateSeriesMetadata('One Piece', { external_ids: { anilist: 13 } });
    await vi.advanceTimersByTimeAsync(2000);
    writeSeriesFile.mockClear();

    await unlinkSeries('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('fires after an offset edit — the shelf alignment is published too', async () => {
    await updateSeriesMetadata('One Piece', { spine_offset: 6 });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
    // Index data: the facts clock must not have moved.
    expect(metaRows.get('one piece')?.facts_updated_at).toBeUndefined();
  });

  it('does NOT fire for a per-user edit (link bookkeeping, reading state)', async () => {
    // A write that is neither a fact nor an index key (spine_offset,
    // volume_offsets) publishes nothing…
    await updateSeriesMetadata('One Piece', { linked_at: '2026-01-01T00:00:00.000Z' });
    // …and the reading state cannot even reach this record: the type does not
    // admit it, and its own store has no listener into the sidecar writer.
    // @ts-expect-error read_count left SeriesMetadata for the reading-state store
    await updateSeriesMetadata('One Piece', { read_count: 2 });
    // @ts-expect-error tracking left SeriesMetadata for the reading-state store
    await updateSeriesMetadata('One Piece', { tracking: { number_overrides: { a: 2 } } });
    updateSeriesReadingState('one piece', {
      read_count: 2,
      tracking: { number_overrides: { a: 2 } }
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('collapses a single patch that touches a fact AND an index key into one write', async () => {
    await updateSeriesMetadata('One Piece', { tag: 'color', spine_offset: 9 });
    await vi.advanceTimersByTimeAsync(2000);

    // Both the facts and the index listener fire for this one patch (see
    // store.test.ts), but they schedule the same per-series debounced write —
    // one PUT, not two.
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('does NOT fire when a fact write changes nothing', async () => {
    await updateSeriesMetadata('One Piece', { tag: 'color' });
    await vi.advanceTimersByTimeAsync(2000);
    writeSeriesFile.mockClear();

    await updateSeriesMetadata('One Piece', { tag: 'color' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('does NOT fire when a sidecar read-back applies facts (no write loop)', async () => {
    await upsertFromSeriesFile('One Piece', {
      version: 2,
      series_title: 'One Piece',
      external_ids: { anilist: 13 },
      titles: {},
      synonyms: [],
      updated_at: '2026-08-17T00:00:00.000Z',
      volumes: []
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('stops scheduling once disposed and re-registers idempotently', async () => {
    // A second init while one is live must not double-register the listener.
    const second = initSeriesFileSync();
    await updateSeriesMetadata('One Piece', { tag: 'blue' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);

    second();
    dispose = undefined;
    await updateSeriesMetadata('One Piece', { tag: 'green' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
  });
});

describe('series-file-sync — the link-event backfill trigger', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetListingRefreshForTests();
    _resetWriteSlotsForTests();
    writeSeriesFile.mockResolvedValue('written');
    fetchAllCloudVolumes.mockResolvedValue(undefined);
    cloudPaths.length = 0;
    providerStatus.set({
      providers: {},
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'webdav'
    });
    volumeRows.length = 0;
    metaRows.clear();
    dispose = initSeriesFileSync();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
  });

  it('backfills IMMEDIATELY (not debounced) when a fact edit makes series.json publishable for a series with nothing local', async () => {
    // A cloud folder exists (the archive is backed up by SOMEONE), but this
    // device holds no row for it at all — the "linked a series never
    // downloaded" case `hasPublishableFacts` exists for.
    backUp('One Piece', 'Volume 1');

    await updateSeriesMetadata('One Piece', { tag: 'color' });
    await vi.waitFor(() => {
      expect(backfillNewlyLinkedSeries).toHaveBeenCalledWith('One Piece');
    });
    // Immediately — no need to advance the 2s write debounce for the trigger
    // itself (the scheduled `series.json` WRITE still debounces separately).
    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('does NOT backfill when the series already has a locally backed-up volume', async () => {
    backUp('One Piece', 'Volume 1');
    addVolume('One Piece', 'Volume 1'); // a real local row matching the cloud title

    await updateSeriesMetadata('One Piece', { tag: 'color' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(backfillNewlyLinkedSeries).not.toHaveBeenCalled();
  });

  it('does NOT backfill when there is no cloud folder for the series yet', async () => {
    // No `backUp()` call: the folder does not exist in the cloud listing.
    await updateSeriesMetadata('One Piece', { tag: 'color' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(backfillNewlyLinkedSeries).not.toHaveBeenCalled();
  });

  it('does NOT backfill for a per-user edit that carries no facts change', async () => {
    backUp('One Piece', 'Volume 1');
    await updateSeriesMetadata('One Piece', { linked_at: '2026-01-01T00:00:00.000Z' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(backfillNewlyLinkedSeries).not.toHaveBeenCalled();
  });

  it('does NOT re-enqueue when the backfill (or any write) later completes — hooked off the facts-change side only', async () => {
    backUp('One Piece', 'Volume 1');

    await updateSeriesMetadata('One Piece', { tag: 'color' });
    await vi.waitFor(() => {
      expect(backfillNewlyLinkedSeries).toHaveBeenCalledTimes(1);
    });

    // The debounced facts-only write now fires too. `writeSeriesFile`
    // completing must not be a trigger of its own — only a genuine local fact
    // edit (`registerFactsChangeListener`) is.
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    expect(backfillNewlyLinkedSeries).toHaveBeenCalledTimes(1);
  });
});
