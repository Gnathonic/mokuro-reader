import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { ProviderError } from './provider-interface';
import type { CloudFileMetadata, SyncProvider } from './provider-interface';

const getCache = vi.fn();

vi.mock('./cache-manager', () => ({
  cacheManager: { getCache: (...args: unknown[]) => getCache(...args) }
}));

vi.mock('../snackbar', () => ({ showSnackbar: vi.fn() }));

vi.mock('../progress-tracker', () => ({
  progressTrackerStore: {
    addProcess: vi.fn(),
    updateProcess: vi.fn(),
    removeProcess: vi.fn()
  }
}));

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  // The series half is the real module — these tests exercise the actual
  // parse/merge rules, not a stand-in for them.
  const seriesData = await vi.importActual<typeof import('$lib/settings/series-data')>(
    '$lib/settings/series-data'
  );
  return {
    ...seriesData,
    volumesWithTrash: writable({}),
    profiles: writable({}),
    profilesWithTrash: writable({}),
    migrateProfiles: vi.fn((p: unknown) => p),
    // Stand-in for the real parser (no VolumeData instances), but it must keep
    // the one behavior this file depends on: the reserved `series` section is
    // not a volume.
    parseVolumesFromJson: vi.fn((json: string) =>
      Object.fromEntries(
        Object.entries(JSON.parse(json)).filter(([key]) => key !== seriesData.SERIES_SECTION_KEY)
      )
    )
  };
});

// `restartSeries` is driven for real below (the store->upload seam), so the two
// things it needs beyond the reading-state store are doubled here: the volume
// store (the real module opens IndexedDB) and the AniList push.
vi.mock('$lib/settings/volume-data', async () => {
  const { writable } = await import('svelte/store');
  return {
    volumes: writable<Record<string, { completed?: boolean }>>({}),
    archiveAndResetVolumes: vi.fn()
  };
});
vi.mock('$lib/metadata/progress-tracker', () => ({ onSeriesRestarted: vi.fn() }));

import { unifiedSyncService } from './unified-sync-service';
import { restartSeries } from '$lib/metadata/reread';
import { volumes as volumeCompletion } from '$lib/settings/volume-data';
import type { VolumeMetadata } from '$lib/types';
import {
  seriesReadingState,
  setSeriesReadingStates,
  updateSeriesReadingState,
  volumesWithTrash
} from '$lib/settings';

// downloadVolumeDataFile is private; these tests target it directly because it
// owns the duplicate-merge behavior that broke MEGA sync (ghost duplicates).
const svc = unifiedSyncService as any;

function fileMeta(fileId: string): CloudFileMetadata {
  return {
    provider: 'mega',
    fileId,
    path: 'volume-data.json',
    modifiedTime: '2026-01-01T00:00:00Z'
  } as unknown as CloudFileMetadata;
}

const jsonBlob = (data: unknown) => ({ text: async () => JSON.stringify(data) }) as unknown as Blob;

const notFound = () => new ProviderError('File not found: volume-data.json', 'mega', 'NOT_FOUND');

function makeProvider(
  download: (file: CloudFileMetadata) => Promise<Blob>,
  del: (file: CloudFileMetadata) => Promise<void> = async () => {}
): SyncProvider {
  return {
    type: 'mega',
    downloadFile: vi.fn(download),
    deleteFile: vi.fn(del)
  } as unknown as SyncProvider;
}

/**
 * The store is typed as `VolumeData` instances; these fixtures are the plain
 * JSON shape the sync layer round-trips (`parseVolumesFromJson` is mocked here,
 * so nothing ever constructs an instance).
 */
function setLocalVolumes(volumes: Record<string, unknown>) {
  volumesWithTrash.set(volumes as Parameters<typeof volumesWithTrash.set>[0]);
}

function stubCache(files: CloudFileMetadata[]) {
  const cache = {
    getAll: vi.fn(() => files),
    get: vi.fn(() => null),
    fetch: vi.fn(async () => {})
  };
  getCache.mockReturnValue(cache);
  return cache;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('downloadVolumeDataFile — duplicate handling with ghost copies', () => {
  const goodData = { 'vol-1': { lastProgressUpdate: '2026-01-02T00:00:00Z', progress: 5 } };

  it('merges the readable copies and skips a ghost duplicate instead of discarding everything', async () => {
    const [good, ghost] = [fileMeta('good'), fileMeta('ghost')];
    const cache = stubCache([good, ghost]);
    const provider = makeProvider(async (file) => {
      if (file.fileId === 'ghost') throw notFound();
      return jsonBlob(goodData);
    });

    const result = await svc.downloadVolumeDataFile(provider);

    expect(result.volumes).toEqual(goodData);
    expect(result.series).toEqual({});
    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
    expect(provider.deleteFile).toHaveBeenCalledWith(ghost);
    expect(cache.fetch).not.toHaveBeenCalled();
  });

  it('keeps the readable copy when the FIRST listed duplicate is the ghost', async () => {
    const [ghost, good] = [fileMeta('ghost'), fileMeta('good')];
    stubCache([ghost, good]);
    const provider = makeProvider(async (file) => {
      if (file.fileId === 'ghost') throw notFound();
      return jsonBlob(goodData);
    });

    const result = await svc.downloadVolumeDataFile(provider);

    expect(result.volumes).toEqual(goodData);
    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
    expect(provider.deleteFile).toHaveBeenCalledWith(ghost);
  });

  it('tolerates NOT_FOUND from deleting a ghost duplicate (already converged)', async () => {
    const [good, ghost] = [fileMeta('good'), fileMeta('ghost')];
    stubCache([good, ghost]);
    const provider = makeProvider(
      async (file) => {
        if (file.fileId === 'ghost') throw notFound();
        return jsonBlob(goodData);
      },
      async () => {
        throw notFound();
      }
    );

    await expect(svc.downloadVolumeDataFile(provider)).resolves.toMatchObject({
      volumes: goodData
    });
  });

  it('returns null after one cache refresh when every copy is missing', async () => {
    const cache = stubCache([fileMeta('ghost-1'), fileMeta('ghost-2')]);
    const provider = makeProvider(async () => {
      throw notFound();
    });

    const result = await svc.downloadVolumeDataFile(provider);

    expect(result).toBeNull();
    expect(cache.fetch).toHaveBeenCalledTimes(1);
    expect(provider.deleteFile).not.toHaveBeenCalled();
  });

  it('merges duplicates newest-lastProgressUpdate-wins and deletes the extra copy', async () => {
    const [first, second] = [fileMeta('first'), fileMeta('second')];
    stubCache([first, second]);
    const newerData = {
      'vol-1': { lastProgressUpdate: '2026-01-03T00:00:00Z', progress: 9 },
      'vol-2': { lastProgressUpdate: '2026-01-01T00:00:00Z', progress: 1 }
    };
    const provider = makeProvider(async (file) =>
      jsonBlob(file.fileId === 'first' ? goodData : newerData)
    );

    const result = await svc.downloadVolumeDataFile(provider);

    expect(result.volumes['vol-1'].progress).toBe(9);
    expect(result.volumes['vol-2'].progress).toBe(1);
    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
    expect(provider.deleteFile).toHaveBeenCalledWith(second);
  });

  it('propagates transient download errors rather than treating them as missing data', async () => {
    stubCache([fileMeta('good'), fileMeta('flaky')]);
    const provider = makeProvider(async (file) => {
      if (file.fileId === 'flaky') throw new Error('network down');
      return jsonBlob(goodData);
    });

    await expect(svc.downloadVolumeDataFile(provider)).rejects.toThrow('network down');
    expect(provider.deleteFile).not.toHaveBeenCalled();
  });
});

describe('the series section of volume-data.json', () => {
  const seriesJson = (series: unknown) => ({
    'vol-1': { lastProgressUpdate: '2026-01-02T00:00:00Z', progress: 5 },
    series
  });

  beforeEach(() => {
    // Both halves are module-level stores shared across tests in this file.
    setLocalVolumes({});
    setSeriesReadingStates({});
  });

  it('reads the section out of the file instead of treating it as a volume', async () => {
    stubCache([fileMeta('only')]);
    const provider = makeProvider(async () =>
      jsonBlob(
        seriesJson({ 'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' } })
      )
    );

    const result = await svc.downloadVolumeDataFile(provider);

    expect(Object.keys(result.volumes)).toEqual(['vol-1']);
    expect(result.series).toEqual({
      'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' }
    });
  });

  it('folds the section across duplicate copies, newest per series wins', async () => {
    const [first, second] = [fileMeta('first'), fileMeta('second')];
    stubCache([first, second]);
    const provider = makeProvider(async (file) =>
      jsonBlob(
        seriesJson(
          file.fileId === 'first'
            ? { 'one piece': { read_count: 1, lastUpdated: '2026-08-01T00:00:00.000Z' } }
            : { 'one piece': { read_count: 4, lastUpdated: '2026-08-20T00:00:00.000Z' } }
        )
      )
    );

    const result = await svc.downloadVolumeDataFile(provider);

    expect(result.series['one piece'].read_count).toBe(4);
  });

  it('writes the merged section back locally and uploads it beside the volumes', async () => {
    setSeriesReadingStates({
      berserk: { read_count: 7, lastUpdated: '2026-08-22T00:00:00.000Z' }
    });
    stubCache([fileMeta('only')]);
    const uploads: Array<{ path: string; body: unknown }> = [];
    const provider = {
      type: 'mega',
      downloadFile: vi.fn(async () =>
        jsonBlob(
          seriesJson({ 'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' } })
        )
      ),
      uploadFile: vi.fn(async (path: string, blob: Blob) => {
        uploads.push({ path, body: JSON.parse(await blob.text()) });
      })
    } as unknown as SyncProvider;

    await svc.syncVolumeData(provider);

    expect(get(seriesReadingState)).toEqual({
      berserk: { read_count: 7, lastUpdated: '2026-08-22T00:00:00.000Z' },
      'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' }
    });
    expect(uploads).toHaveLength(1);
    expect((uploads[0].body as Record<string, unknown>).series).toEqual({
      berserk: { read_count: 7, lastUpdated: '2026-08-22T00:00:00.000Z' },
      'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' }
    });
  });

  it('carries a real restartSeries bump through the compose and into the upload', async () => {
    // The one join this suite otherwise seeds by hand: a consumer action writes
    // the reading-state store, and the composed `volume-data.json` has to carry
    // what it wrote. Driven end to end — `restartSeries` is the real module, and
    // nothing between it and `uploadFile` is stubbed.
    (volumeCompletion as unknown as { set: (v: unknown) => void }).set({
      'vol-a': { completed: true }
    });
    stubCache([fileMeta('only')]);
    const uploads: Array<Record<string, any>> = [];
    const provider = {
      type: 'mega',
      downloadFile: vi.fn(async () =>
        jsonBlob({ 'vol-1': { lastProgressUpdate: '2026-01-02T00:00:00Z', progress: 5 } })
      ),
      uploadFile: vi.fn(async (_path: string, blob: Blob) => {
        uploads.push(JSON.parse(await blob.text()));
      })
    } as unknown as SyncProvider;

    await restartSeries('One Piece', [
      {
        volume_uuid: 'vol-a',
        volume_title: 'Vol 01',
        series_title: 'One Piece',
        series_uuid: 's'
      } as VolumeMetadata
    ]);
    expect(get(seriesReadingState)['one piece'].read_count).toBe(1);

    await svc.syncVolumeData(provider);

    expect(uploads).toHaveLength(1);
    expect(uploads[0].series['one piece']).toMatchObject({ read_count: 1 });
    expect(uploads[0].series['one piece'].lastUpdated).toEqual(expect.any(String));
  });

  it('merges a cloud file that has no section at all without losing local state', async () => {
    // A file written by a reader that predates the section: no `series` key.
    setSeriesReadingStates({ berserk: { read_count: 7, lastUpdated: '2026-08-22T00:00:00.000Z' } });
    stubCache([fileMeta('only')]);
    const uploads: Array<Record<string, unknown>> = [];
    const provider = {
      type: 'mega',
      downloadFile: vi.fn(async () =>
        jsonBlob({ 'vol-1': { lastProgressUpdate: '2026-01-02T00:00:00Z', progress: 5 } })
      ),
      uploadFile: vi.fn(async (_path: string, blob: Blob) => {
        uploads.push(JSON.parse(await blob.text()));
      })
    } as unknown as SyncProvider;

    await svc.syncVolumeData(provider);

    expect(get(seriesReadingState)).toEqual({
      berserk: { read_count: 7, lastUpdated: '2026-08-22T00:00:00.000Z' }
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].series).toEqual({
      berserk: { read_count: 7, lastUpdated: '2026-08-22T00:00:00.000Z' }
    });
    // The volume half round-trips untouched beside it.
    expect(uploads[0]['vol-1']).toEqual({
      lastProgressUpdate: '2026-01-02T00:00:00Z',
      progress: 5
    });
  });

  it('heals a future-stamped cloud section instead of re-clamping it forever', async () => {
    // Regression for the clamp-poison hazard: `parseSeriesSection` clamps a
    // `lastUpdated` more than five minutes ahead back to this device's `now`.
    // Comparing the merge against the PARSED section made that clamped value
    // look identical to the cloud's, so the poison was never written back —
    // every device re-clamped it to a fresher `now` on every sync, so the
    // poisoned entry outranked (and silently reverted) every honest edit to
    // that series, permanently. Comparing against the RAW section heals it in
    // one upload. Only `Date` is faked — a real Blob's `.text()` needs real
    // timers under jsdom.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    try {
      setSeriesReadingStates({});
      stubCache([fileMeta('only')]);
      const uploads: Array<Record<string, any>> = [];
      const downloadFile = vi.fn(async () =>
        jsonBlob(
          seriesJson({ 'one piece': { read_count: 2, lastUpdated: '2999-01-01T00:00:00.000Z' } })
        )
      );
      const provider = {
        type: 'mega',
        downloadFile,
        uploadFile: vi.fn(async (_path: string, blob: Blob) => {
          uploads.push(JSON.parse(await blob.text()));
        })
      } as unknown as SyncProvider;

      await svc.syncVolumeData(provider);

      // One upload, carrying the clamped stamp — the cloud is now healed.
      expect(uploads).toHaveLength(1);
      expect(uploads[0].series['one piece'].lastUpdated).toBe('2026-08-23T12:00:00.000Z');

      // A minute later, an honest local edit wins the next merge instead of
      // being reverted by a stamp that re-clamps to a fresher `now`.
      vi.setSystemTime(new Date('2026-08-23T12:01:00.000Z'));
      updateSeriesReadingState('one piece', { read_count: 3 });
      const healed = uploads[0];
      downloadFile.mockImplementation(async () => jsonBlob(healed));

      await svc.syncVolumeData(provider);

      expect(get(seriesReadingState)['one piece'].read_count).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes the fold back over the surviving copy even when local already matches it', async () => {
    // Two copies; the one that survives the delete sweep holds the STALE
    // series entry. Local already equals the fold, so only a comparison
    // against the surviving copy's raw section can notice that the merged
    // value still has to be written — otherwise the newer copy is deleted and
    // its state is lost with it.
    const volume = { 'vol-1': { lastProgressUpdate: '2026-01-02T00:00:00Z', progress: 5 } };
    setLocalVolumes({ ...volume });
    setSeriesReadingStates({
      'one piece': { read_count: 4, lastUpdated: '2026-08-20T00:00:00.000Z' }
    });
    stubCache([fileMeta('first'), fileMeta('second')]);
    const uploads: Array<Record<string, any>> = [];
    const provider = {
      type: 'mega',
      downloadFile: vi.fn(async (file: CloudFileMetadata) =>
        jsonBlob({
          ...volume,
          series:
            file.fileId === 'first'
              ? { 'one piece': { read_count: 1, lastUpdated: '2026-08-01T00:00:00.000Z' } }
              : { 'one piece': { read_count: 4, lastUpdated: '2026-08-20T00:00:00.000Z' } }
        })
      ),
      deleteFile: vi.fn(async () => {}),
      uploadFile: vi.fn(async (_path: string, blob: Blob) => {
        uploads.push(JSON.parse(await blob.text()));
      })
    } as unknown as SyncProvider;

    await svc.syncVolumeData(provider);

    expect(uploads).toHaveLength(1);
    expect(uploads[0].series['one piece'].read_count).toBe(4);
  });

  it('does not re-upload a file whose state matches but whose key order differs', async () => {
    // Two devices build the same maps in different insertion orders. Byte-order
    // churn is not a change: no upload, no mtime bump, no ping-pong.
    setLocalVolumes({
      'vol-1': { lastProgressUpdate: '2026-01-02T00:00:00Z', progress: 5 },
      'vol-2': { lastProgressUpdate: '2026-01-03T00:00:00Z', progress: 7 }
    });
    setSeriesReadingStates({
      berserk: { read_count: 7, lastUpdated: '2026-08-22T00:00:00.000Z' },
      'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' }
    });
    stubCache([fileMeta('only')]);
    const uploads: Array<Record<string, any>> = [];
    const provider = {
      type: 'mega',
      downloadFile: vi.fn(async () =>
        jsonBlob({
          'vol-2': { progress: 7, lastProgressUpdate: '2026-01-03T00:00:00Z' },
          'vol-1': { progress: 5, lastProgressUpdate: '2026-01-02T00:00:00Z' },
          series: {
            'one piece': { lastUpdated: '2026-08-20T00:00:00.000Z', read_count: 2 },
            berserk: { lastUpdated: '2026-08-22T00:00:00.000Z', read_count: 7 }
          }
        })
      ),
      uploadFile: vi.fn(async (_path: string, blob: Blob) => {
        uploads.push(JSON.parse(await blob.text()));
      })
    } as unknown as SyncProvider;

    await svc.syncVolumeData(provider);

    expect(uploads).toEqual([]);
  });

  it('omits the section entirely when there is no series state at all', async () => {
    setSeriesReadingStates({});
    stubCache([]);
    const uploads: Array<Record<string, unknown>> = [];
    const provider = {
      type: 'mega',
      downloadFile: vi.fn(),
      uploadFile: vi.fn(async (_path: string, blob: Blob) => {
        uploads.push(JSON.parse(await blob.text()));
      })
    } as unknown as SyncProvider;

    await svc.syncVolumeData(provider);

    // Nothing to say and nothing in the cloud: no upload at all.
    expect(uploads).toEqual([]);
  });
});
