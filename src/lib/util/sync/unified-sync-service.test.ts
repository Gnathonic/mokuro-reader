import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  return {
    volumesWithTrash: writable({}),
    profiles: writable({}),
    profilesWithTrash: writable({}),
    migrateProfiles: vi.fn((p: unknown) => p),
    parseVolumesFromJson: vi.fn((json: string) => JSON.parse(json))
  };
});

import { unifiedSyncService } from './unified-sync-service';

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

    expect(result).toEqual(goodData);
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

    expect(result).toEqual(goodData);
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

    await expect(svc.downloadVolumeDataFile(provider)).resolves.toEqual(goodData);
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

    expect(result['vol-1'].progress).toBe(9);
    expect(result['vol-2'].progress).toBe(1);
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
