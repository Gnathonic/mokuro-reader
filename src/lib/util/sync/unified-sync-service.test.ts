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
  profilesWithTrash,
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

  it('unions bogus-series detection across every readable copy and lets the honest copy win the fold', async () => {
    // The poison sits on the NON-surviving duplicate (readable[1], deleted
    // after the fold). Deriving bogus-key detection from only the survivor's
    // raw section (readable[0]) would miss it entirely, and folding without
    // forfeit-awareness would let the bogus, now-clamped-to-"now" stamp
    // clobber the honest entry from the surviving copy.
    const [first, second] = [fileMeta('first'), fileMeta('second')];
    stubCache([first, second]);
    const provider = makeProvider(async (file) =>
      jsonBlob({
        ...goodData,
        series:
          file.fileId === 'first'
            ? { 'one piece': { read_count: 4, lastUpdated: '2026-08-20T00:00:00.000Z' } }
            : { 'one piece': { read_count: 2, lastUpdated: '2999-01-01T00:00:00.000Z' } }
      })
    );

    const result = await svc.downloadVolumeDataFile(provider);

    // The fold prefers the honest copy's content over the bogus one,
    // regardless of which copy happens to survive the delete sweep.
    expect(result.series['one piece'].read_count).toBe(4);
    // The union still flags the key as bogus — the OTHER, non-surviving copy
    // needed clamping — which is what protects a pending local edit
    // downstream even though the fold itself resolved to honest content.
    expect(result.bogusSeriesKeys.has('one piece')).toBe(true);
    expect(provider.deleteFile).toHaveBeenCalledWith(second);
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

  it('protects a pending local edit from a still-poisoned cloud section during the first heal', async () => {
    // FORFEIT-ON-BOGUS regression: clamping alone sets the healed stamp to
    // exactly this device's own `now`, which always ties-or-beats a pending
    // local edit (a local edit is, by definition, timestamped at or before
    // `now`). A cloud entry whose RAW stamp is bogus must forfeit to local
    // content instead — the pending edit survives the FIRST sync, and the
    // upload that heals the cloud copy carries the honest local content, not
    // the stale cloud content under a fabricated "now" stamp.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    try {
      setSeriesReadingStates({
        'one piece': { read_count: 9, lastUpdated: '2026-08-23T11:59:00.000Z' }
      });
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

      expect(get(seriesReadingState)['one piece']).toEqual({
        read_count: 9,
        lastUpdated: '2026-08-23T11:59:00.000Z'
      });
      expect(uploads).toHaveLength(1);
      expect(uploads[0].series['one piece']).toEqual({
        read_count: 9,
        lastUpdated: '2026-08-23T11:59:00.000Z'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('protects a pending local edit even when the poison is on a non-surviving duplicate copy', async () => {
    // The compound edge: bogus-key detection has to union across every
    // readable copy, not just the one that survives the delete sweep. Here
    // the SURVIVING copy has no entry at all for this series — only the
    // duplicate that gets deleted after the fold is poisoned — so a
    // union-blind implementation sees no bogus stamp anywhere and lets the
    // clamped-to-"now" fold result silently beat the pending local edit.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    try {
      setSeriesReadingStates({
        'one piece': { read_count: 9, lastUpdated: '2026-08-23T11:59:00.000Z' }
      });
      stubCache([fileMeta('first'), fileMeta('second')]);
      const uploads: Array<Record<string, any>> = [];
      const provider = {
        type: 'mega',
        downloadFile: vi.fn(async (file: CloudFileMetadata) =>
          jsonBlob(
            file.fileId === 'first'
              ? seriesJson({}) // survivor: no entry for this series at all
              : seriesJson({
                  'one piece': { read_count: 2, lastUpdated: '2999-01-01T00:00:00.000Z' }
                }) // deleted duplicate: the poison
          )
        ),
        deleteFile: vi.fn(async () => {}),
        uploadFile: vi.fn(async (_path: string, blob: Blob) => {
          uploads.push(JSON.parse(await blob.text()));
        })
      } as unknown as SyncProvider;

      await svc.syncVolumeData(provider);

      expect(get(seriesReadingState)['one piece']).toEqual({
        read_count: 9,
        lastUpdated: '2026-08-23T11:59:00.000Z'
      });
      expect(uploads).toHaveLength(1);
      expect(uploads[0].series['one piece']).toEqual({
        read_count: 9,
        lastUpdated: '2026-08-23T11:59:00.000Z'
      });
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

describe('profiles.json', () => {
  it('is read, merged and pushed on every provider sync — no flag to ask for it', async () => {
    const profilesMeta = { ...fileMeta('profiles'), path: 'profiles.json' };
    getCache.mockReturnValue({
      getAll: vi.fn(() => []),
      get: vi.fn((name: string) => (name === 'profiles.json' ? profilesMeta : null)),
      fetch: vi.fn(async () => {})
    });

    const provider = {
      type: 'mega',
      name: 'MEGA',
      isAuthenticated: () => true,
      downloadFile: vi.fn(async () =>
        jsonBlob({ Desktop: { lastUpdated: '2026-08-20T00:00:00.000Z', charCount: 3 } })
      ),
      uploadFile: vi.fn(async () => {})
    } as unknown as SyncProvider;

    const result = await unifiedSyncService.syncProvider(provider);

    expect(result.success).toBe(true);
    expect(provider.downloadFile).toHaveBeenCalledWith(profilesMeta);
  });

  it('does not re-upload profiles whose state matches but whose key order differs', async () => {
    // Same guarantee the volume-data half already has: byte-order churn from
    // differing insertion order across devices is not a change.
    profilesWithTrash.set({
      Desktop: { lastUpdated: '2026-08-20T00:00:00.000Z', charCount: 3 },
      Mobile: { lastUpdated: '2026-08-19T00:00:00.000Z', charCount: 1 }
    } as any);
    const profilesMeta = { ...fileMeta('profiles'), path: 'profiles.json' };
    getCache.mockReturnValue({
      getAll: vi.fn(() => []),
      get: vi.fn((name: string) => (name === 'profiles.json' ? profilesMeta : null)),
      fetch: vi.fn(async () => {})
    });
    const uploads: unknown[] = [];
    const provider = {
      type: 'mega',
      name: 'MEGA',
      isAuthenticated: () => true,
      downloadFile: vi.fn(async () =>
        jsonBlob({
          Mobile: { charCount: 1, lastUpdated: '2026-08-19T00:00:00.000Z' },
          Desktop: { charCount: 3, lastUpdated: '2026-08-20T00:00:00.000Z' }
        })
      ),
      uploadFile: vi.fn(async (_path: string, blob: Blob) => {
        uploads.push(JSON.parse(await blob.text()));
      })
    } as unknown as SyncProvider;

    await unifiedSyncService.syncProvider(provider);

    expect(uploads).toEqual([]);
  });

  function stubProfilesCache() {
    const profilesMeta = { ...fileMeta('profiles'), path: 'profiles.json' };
    getCache.mockReturnValue({
      getAll: vi.fn(() => []),
      get: vi.fn((name: string) => (name === 'profiles.json' ? profilesMeta : null)),
      fetch: vi.fn(async () => {})
    });
  }

  function makeProfilesProvider(
    download: () => Promise<Blob>,
    uploads: Array<Record<string, any>>
  ): SyncProvider {
    return {
      type: 'mega',
      name: 'MEGA',
      isAuthenticated: () => true,
      downloadFile: vi.fn(download),
      uploadFile: vi.fn(async (_path: string, blob: Blob) => {
        uploads.push(JSON.parse(await blob.text()));
      })
    } as unknown as SyncProvider;
  }

  it('heals a future-stamped cloud profile instead of letting it outrank every later edit', async () => {
    // Regression for the clock-skew hazard: `touchProfile`/`deleteProfile`
    // stamp the writing device's raw clock with no ceiling, so a fast-clock
    // device's single edit would otherwise permanently outrank every honest
    // later edit (`Math.max` can never let a real timestamp catch up to one
    // already in the future). The upload compare is already against the RAW
    // cloud bytes, so a clamped/healed merge that differs uploads the healed
    // profile and the poison is gone after one sync — mirrors the series
    // section's `rawSeries` fix. Only `Date` is faked — a real Blob's
    // `.text()` needs real timers under jsdom.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    try {
      profilesWithTrash.set({} as any);
      stubProfilesCache();
      const uploads: Array<Record<string, any>> = [];
      const downloadFile = vi.fn(async () =>
        jsonBlob({ Desktop: { charCount: 2, lastUpdated: '2999-01-01T00:00:00.000Z' } })
      );
      const provider = makeProfilesProvider(downloadFile, uploads);

      await svc.syncProfiles(provider);

      // One upload, carrying the clamped stamp — the cloud is now healed.
      expect(uploads).toHaveLength(1);
      expect(uploads[0].Desktop.lastUpdated).toBe('2026-08-23T12:00:00.000Z');

      // A minute later, an honest local edit wins the next merge instead of
      // being reverted by a stamp that would otherwise re-clamp to a fresher
      // `now` forever.
      vi.setSystemTime(new Date('2026-08-23T12:01:00.000Z'));
      profilesWithTrash.update(
        (p: any) =>
          ({
            ...p,
            Desktop: { charCount: 9, lastUpdated: new Date().toISOString() }
          }) as any
      );
      const healed = uploads[0];
      downloadFile.mockImplementation(async () => jsonBlob(healed));

      await svc.syncProfiles(provider);

      expect((get(profilesWithTrash) as any).Desktop.charCount).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('protects a pending local edit from a still-poisoned cloud profile during the first heal', async () => {
    // FORFEIT-ON-BOGUS regression, profiles half: same race as the series
    // section — clamping alone sets the healed stamp to exactly this
    // device's own `now`, which always ties-or-beats a pending local edit.
    // A bogus cloud entry must forfeit to local content when local exists;
    // the upload that heals the cloud copy must carry the honest local
    // content, not the stale cloud content under a fabricated stamp.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    try {
      profilesWithTrash.set({
        Desktop: { charCount: 9, lastUpdated: '2026-08-23T11:59:00.000Z' }
      } as any);
      stubProfilesCache();
      const uploads: Array<Record<string, any>> = [];
      const provider = makeProfilesProvider(
        async () =>
          jsonBlob({ Desktop: { charCount: 2, lastUpdated: '2999-01-01T00:00:00.000Z' } }),
        uploads
      );

      await svc.syncProfiles(provider);

      expect((get(profilesWithTrash) as any).Desktop).toEqual({
        charCount: 9,
        lastUpdated: '2026-08-23T11:59:00.000Z'
      });
      expect(uploads).toHaveLength(1);
      expect(uploads[0].Desktop).toEqual({
        charCount: 9,
        lastUpdated: '2026-08-23T11:59:00.000Z'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('forfeits a bogus deletedOn to local content too — a poisoned deletion cannot silently wipe a profile', async () => {
    // Round 2, bullet 3: FORFEIT-ON-BOGUS must apply to `deletedOn` exactly
    // like `lastUpdated` — a far-future tombstone is still a bogus cloud
    // stamp, and clamping it alone would set it to this device's own `now`,
    // which (via Math.max) would outrank the local active profile's honest,
    // ordinary-dated edit and silently delete it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    try {
      profilesWithTrash.set({
        Custom1: { charCount: 7, lastUpdated: '2026-08-23T11:00:00.000Z' }
      } as any);
      stubProfilesCache();
      const uploads: Array<Record<string, any>> = [];
      const provider = makeProfilesProvider(
        async () =>
          jsonBlob({
            Custom1: {
              deletedOn: '2999-01-01T00:00:00.000Z',
              lastUpdated: '2999-01-01T00:00:00.000Z'
            }
          }),
        uploads
      );

      await svc.syncProfiles(provider);

      expect((get(profilesWithTrash) as any).Custom1.deletedOn).toBeUndefined();
      expect((get(profilesWithTrash) as any).Custom1.charCount).toBe(7);
      expect(uploads).toHaveLength(1);
      expect(uploads[0].Custom1.deletedOn).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a deletion across sync when the tombstone postdates the other side's edit", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    try {
      // Local doesn't know about the remote deletion yet — it only has a
      // stale edit from before the deletion happened.
      profilesWithTrash.set({
        Custom1: { lastUpdated: '2026-08-01T00:00:00.000Z', charCount: 5 }
      } as any);
      stubProfilesCache();
      const uploads: Array<Record<string, any>> = [];
      const downloadFile = vi.fn(async () =>
        jsonBlob({
          Custom1: {
            deletedOn: '2026-08-10T00:00:00.000Z',
            lastUpdated: '2026-08-10T00:00:00.000Z'
          }
        })
      );
      const provider = makeProfilesProvider(downloadFile, uploads);

      await svc.syncProfiles(provider);

      expect((get(profilesWithTrash) as any).Custom1.deletedOn).toBe('2026-08-10T00:00:00.000Z');
      // Merged already equals the raw cloud tombstone byte-for-byte: no
      // upload needed, converged in one sync.
      expect(uploads).toEqual([]);

      // A second automatic sync round against the same cloud tombstone
      // doesn't resurrect it.
      await svc.syncProfiles(provider);

      expect((get(profilesWithTrash) as any).Custom1.deletedOn).toBe('2026-08-10T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resurrects a deleted profile when the other side has a genuinely newer edit (current Math.max rule, documented)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    try {
      // Local tombstoned the profile, then someone edited it on another
      // device AFTER the deletion (e.g. re-created it under the same name).
      profilesWithTrash.set({
        Custom1: { deletedOn: '2026-08-01T00:00:00.000Z', lastUpdated: '2026-08-01T00:00:00.000Z' }
      } as any);
      stubProfilesCache();
      const uploads: Array<Record<string, any>> = [];
      const provider = makeProfilesProvider(
        async () =>
          jsonBlob({ Custom1: { charCount: 12, lastUpdated: '2026-08-15T00:00:00.000Z' } }),
        uploads
      );

      await svc.syncProfiles(provider);

      // Documented current behavior: a later plain edit outranks an earlier
      // deletion purely by being the more recent timestamp — the tombstone
      // does not win just by being a deletion. This re-creates the profile;
      // it is the existing Math.max rule, pinned rather than changed here.
      expect((get(profilesWithTrash) as any).Custom1.deletedOn).toBeUndefined();
      expect((get(profilesWithTrash) as any).Custom1.charCount).toBe(12);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('direct config uploads record a targeted cache entry', () => {
  it('uploadProfiles makes the new profiles.json visible to the cache without any listing', async () => {
    // `findProfilesFiles` resolves profiles.json FROM the provider cache, so a
    // first-ever upload used to be invisible until the next full listing on
    // every provider except Drive (whose in-provider refetch papered over it,
    // at the cost of a whole-account walk per upload). The targeted add is
    // the provider-neutral replacement.
    const add = vi.fn();
    getCache.mockReturnValue({ add });
    const provider = {
      type: 'webdav',
      name: 'WebDAV',
      uploadFile: vi.fn(async () => ({
        fileId: 'profiles-1',
        modifiedTime: '2026-08-27T01:00:00.000Z',
        size: 11
      }))
    };

    await unifiedSyncService.uploadProfiles(provider as never, { default: {} });

    // Positive control: the upload really went to the provider...
    expect(provider.uploadFile).toHaveBeenCalledTimes(1);
    // ...and the cache learned about it with the response's own provenance.
    expect(add).toHaveBeenCalledTimes(1);
    const [path, entry] = add.mock.calls[0];
    expect(path).toBe('profiles.json');
    expect(entry).toMatchObject({
      provider: 'webdav',
      fileId: 'profiles-1',
      modifiedTime: '2026-08-27T01:00:00.000Z',
      modifiedTimeProvisional: false,
      size: 11
    });
  });
});
