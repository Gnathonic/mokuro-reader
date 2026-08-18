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
const getManagedCloudFilesForVolume = vi.hoisted(() =>
  vi.fn((_series: string, volumeTitle: string) => [{ path: `One Piece/${volumeTitle}.cbz` }])
);
const fetchAllCloudVolumes = vi.hoisted(() => vi.fn(async (_options?: unknown) => {}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { writeSeriesFile, getManagedCloudFilesForVolume, fetchAllCloudVolumes }
}));

// An in-memory stand-in for the two tables involved: the gate reads the
// installed volumes, and `store.ts` writes the series_metadata rows whose fact
// changes drive the listener. Deliberately NOT fake-indexeddb: it schedules its
// transactions on setImmediate, which vitest's fake timers freeze.
const { volumeRows, metaRows } = vi.hoisted(() => ({
  volumeRows: [] as Record<string, unknown>[],
  metaRows: new Map<string, Record<string, unknown>>()
}));

vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { toArray: async () => [...volumeRows] },
    series_metadata: {
      get: async (key: string) => metaRows.get(key),
      put: async (rec: { series_key: string }) => {
        metaRows.set(rec.series_key, rec);
      }
    },
    transaction: async (_mode: string, _table: unknown, body: () => Promise<unknown>) => body()
  }
}));

import {
  _resetListingRefreshForTests,
  flushSeriesFileWrites,
  initSeriesFileSync,
  LISTING_TIMEOUT_MS,
  LISTING_TTL_MS,
  scheduleSeriesFileWrite
} from './series-file-sync';
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

let dispose: (() => void) | undefined;

describe('series-file-sync', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetListingRefreshForTests();
    writeSeriesFile.mockResolvedValue('written');
    fetchAllCloudVolumes.mockResolvedValue(undefined);
    getManagedCloudFilesForVolume.mockImplementation((_s: string, volumeTitle: string) => [
      { path: `One Piece/${volumeTitle}.cbz` }
    ]);
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

  it('debounces per series — two series each get their own write', async () => {
    addVolume('Berserk', 'Volume 1');
    getManagedCloudFilesForVolume.mockImplementation((series: string, volumeTitle: string) => [
      { path: `${series}/${volumeTitle}.cbz` }
    ]);

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
    getManagedCloudFilesForVolume.mockImplementation((series: string, volumeTitle: string) => [
      { path: `${series}/${volumeTitle}.cbz` }
    ]);

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
    getManagedCloudFilesForVolume.mockImplementation((series: string, volumeTitle: string) => [
      { path: `${series}/${volumeTitle}.cbz` }
    ]);
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
    let refreshed = false;
    fetchAllCloudVolumes.mockImplementation(async () => {
      refreshed = true;
    });
    getManagedCloudFilesForVolume.mockImplementation((series: string, volumeTitle: string) =>
      refreshed ? [{ path: `${series}/${volumeTitle}.cbz` }] : []
    );

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
    getManagedCloudFilesForVolume.mockReturnValue([]);

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('ignores a series whose only cloud files are sidecars (no archive)', async () => {
    getManagedCloudFilesForVolume.mockReturnValue([{ path: 'One Piece/Volume 1.mokuro' }]);

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('swallows a write failure — a background index write never breaks an edit', async () => {
    writeSeriesFile.mockRejectedValue(new Error('offline'));

    scheduleSeriesFileWrite('One Piece');
    // No unhandled rejection, no throw out of the timer callback.
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
  });

  it('flush writes everything pending immediately', async () => {
    scheduleSeriesFileWrite('One Piece');
    await flushSeriesFileWrites();

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    // The timer is cancelled, not merely fired early.
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
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

  it('does NOT fire for a per-user edit (spine offsets, rereads, tracking)', async () => {
    await updateSeriesMetadata('One Piece', { read_count: 2 });
    await updateSeriesMetadata('One Piece', { tracking: { number_overrides: { a: 2 } } });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
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
