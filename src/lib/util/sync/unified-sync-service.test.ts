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

const localSeries: Record<string, any> = {};
const replaceAll = vi.fn(async (records: Record<string, any>) => {
  for (const [k, v] of Object.entries(records)) localSeries[k] = v;
});
vi.mock('$lib/metadata/store', () => ({
  getAllSeriesMetadata: vi.fn(async () => ({ ...localSeries })),
  replaceAllSeriesMetadata: (records: Record<string, any>) => replaceAll(records)
}));

import { unifiedSyncService } from './unified-sync-service';
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

describe('syncSeriesMetadata — series-metadata.json', () => {
  const rec = (key: string, updated_at: string, tag: string) => ({
    series_key: key,
    series_title: key,
    external_ids: {},
    titles: {},
    synonyms: [],
    tag,
    read_count: 0,
    updated_at
  });

  beforeEach(() => {
    for (const k of Object.keys(localSeries)) delete localSeries[k];
    replaceAll.mockClear();
    getCache.mockReset();
  });

  it('merges newest-wins into local and uploads when the merged set differs from the cloud', async () => {
    localSeries.a = rec('a', '2026-03-01T00:00:00.000Z', 'local-newer');
    localSeries.b = rec('b', '2026-01-01T00:00:00.000Z', 'local-only');
    const cloud = {
      version: 1,
      series: {
        a: rec('a', '2026-02-01T00:00:00.000Z', 'cloud-older'),
        c: rec('c', '2026-02-01T00:00:00.000Z', 'cloud-only')
      }
    };
    const file = {
      provider: 'mega',
      fileId: 'sm',
      path: 'series-metadata.json'
    } as unknown as CloudFileMetadata;
    getCache.mockReturnValue({ get: (p: string) => (p === 'series-metadata.json' ? file : null) });
    const uploadFile = vi.fn<SyncProvider['uploadFile']>(async () => 'id');
    const provider = {
      type: 'mega',
      downloadFile: vi.fn(async () => jsonBlob(cloud)),
      uploadFile
    } as unknown as SyncProvider;

    await svc.syncSeriesMetadata(provider);

    expect(localSeries.a.tag).toBe('local-newer');
    expect(localSeries.c.tag).toBe('cloud-only');
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const [path, blob] = uploadFile.mock.calls[0];
    expect(path).toBe('series-metadata.json');
    const uploaded = JSON.parse(await (blob as Blob).text());
    expect(uploaded.version).toBe(1);
    expect(Object.keys(uploaded.series).sort()).toEqual(['a', 'b', 'c']);
  });

  it('uploads local records when the cloud has no file yet', async () => {
    localSeries.a = rec('a', '2026-03-01T00:00:00.000Z', 'x');
    getCache.mockReturnValue({ get: () => null });
    const uploadFile = vi.fn<SyncProvider['uploadFile']>(async () => 'id');
    const provider = { type: 'mega', downloadFile: vi.fn(), uploadFile } as unknown as SyncProvider;
    await svc.syncSeriesMetadata(provider);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(replaceAll).not.toHaveBeenCalled();
  });

  it('does nothing when both sides are empty', async () => {
    getCache.mockReturnValue({ get: () => null });
    const uploadFile = vi.fn();
    const provider = { type: 'mega', downloadFile: vi.fn(), uploadFile } as unknown as SyncProvider;
    await svc.syncSeriesMetadata(provider);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('heals a poisoned raw cloud record by re-uploading the sanitized (clamped) value', async () => {
    // Regression for: the upload decision used to compare `merged` against
    // the SANITIZED cloud map, so a raw far-future `updated_at` that got
    // clamped locally was never written back — it stayed poisoned in the
    // cloud file and re-clamped to a newer `now` on every later sync,
    // permanently outranking honest local edits. Local is empty here, so the
    // only source for the merged record is the poisoned cloud entry.
    // Only `Date` is faked — a real Blob's `.text()` (read back below) relies
    // on real timers internally under jsdom, and faking those too hangs the test.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
    try {
      const cloud = {
        version: 1,
        series: { a: rec('a', '2999-01-01T00:00:00.000Z', 'poisoned') }
      };
      const file = {
        provider: 'mega',
        fileId: 'sm',
        path: 'series-metadata.json'
      } as unknown as CloudFileMetadata;
      getCache.mockReturnValue({
        get: (p: string) => (p === 'series-metadata.json' ? file : null)
      });
      const uploadFile = vi.fn<SyncProvider['uploadFile']>(async () => 'id');
      const provider = {
        type: 'mega',
        downloadFile: vi.fn(async () => jsonBlob(cloud)),
        uploadFile
      } as unknown as SyncProvider;

      await svc.syncSeriesMetadata(provider);

      expect(uploadFile).toHaveBeenCalledTimes(1);
      const [, blob] = uploadFile.mock.calls[0];
      const uploaded = JSON.parse(await (blob as Blob).text());
      expect(Date.parse(uploaded.series.a.updated_at)).toBeLessThanOrEqual(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-upload when cloud and local are identical but key order differs', async () => {
    const shared = {
      series_key: 'a',
      series_title: 'A',
      external_ids: {},
      titles: {},
      synonyms: [],
      tag: 'same',
      read_count: 0,
      updated_at: '2026-01-01T00:00:00.000Z'
    };
    localSeries.a = shared;
    // Same record, same values, fields declared in reverse order.
    const cloudA = Object.fromEntries(Object.entries(shared).reverse());
    const cloud = { version: 1, series: { a: cloudA } };
    const file = {
      provider: 'mega',
      fileId: 'sm',
      path: 'series-metadata.json'
    } as unknown as CloudFileMetadata;
    getCache.mockReturnValue({ get: (p: string) => (p === 'series-metadata.json' ? file : null) });
    const uploadFile = vi.fn<SyncProvider['uploadFile']>(async () => 'id');
    const provider = {
      type: 'mega',
      downloadFile: vi.fn(async () => jsonBlob(cloud)),
      uploadFile
    } as unknown as SyncProvider;

    await svc.syncSeriesMetadata(provider);

    expect(uploadFile).not.toHaveBeenCalled();
  });
});
