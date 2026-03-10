import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudFileMetadata } from './provider-interface';

const fetchAll = vi.fn();
const getBySeries = vi.fn();
const getCache = vi.fn();
const getActiveProvider = vi.fn();

vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: {
    fetchAll,
    getBySeries,
    getCache,
    getAllFiles: vi.fn(),
    allFiles: { subscribe: vi.fn() },
    isFetchingState: { subscribe: vi.fn() }
  }
}));

vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: {
    getActiveProvider
  }
}));

vi.mock('$lib/util/sync/unified-sync-service', () => ({
  unifiedSyncService: {
    isSyncing: { subscribe: vi.fn() },
    syncProvider: vi.fn()
  }
}));

describe('UnifiedCloudManager rename operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renames a volume archive and its sidecars through the active provider', async () => {
    const cache = {
      removeById: vi.fn(),
      add: vi.fn()
    };
    const provider = {
      type: 'webdav',
      renameFile: vi.fn(async (file: CloudFileMetadata, newPath: string) => ({
        ...file,
        fileId: `renamed-${file.fileId}`,
        path: newPath
      }))
    };

    const files: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Old Series/Volume 1.cbz',
        modifiedTime: '2026-03-10T00:00:00.000Z',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'mokuro-1',
        path: 'Old Series/Volume 1.mokuro',
        modifiedTime: '2026-03-10T00:00:00.000Z',
        size: 10
      },
      {
        provider: 'webdav',
        fileId: 'thumb-1',
        path: 'Old Series/Volume 1.webp',
        modifiedTime: '2026-03-10T00:00:00.000Z',
        size: 5
      },
      {
        provider: 'webdav',
        fileId: 'other-1',
        path: 'Old Series/Volume 2.cbz',
        modifiedTime: '2026-03-10T00:00:00.000Z',
        size: 100
      }
    ];

    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((seriesTitle: string) =>
      files.filter((file) => file.path.startsWith(`${seriesTitle}/`))
    );
    getCache.mockReturnValue(cache);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const renamedCount = await unifiedCloudManager.renameVolume(
      'Old Series',
      'Volume 1',
      'New Series',
      'Volume X'
    );

    expect(renamedCount).toBe(3);
    expect(fetchAll).toHaveBeenCalledTimes(1);
    expect(provider.renameFile).toHaveBeenCalledTimes(3);
    expect(provider.renameFile).toHaveBeenNthCalledWith(1, files[0], 'New Series/Volume X.cbz');
    expect(provider.renameFile).toHaveBeenNthCalledWith(2, files[1], 'New Series/Volume X.mokuro');
    expect(provider.renameFile).toHaveBeenNthCalledWith(3, files[2], 'New Series/Volume X.webp');
    expect(cache.removeById).toHaveBeenCalledTimes(3);
    expect(cache.add).toHaveBeenCalledTimes(3);
    expect(cache.add).toHaveBeenCalledWith(
      'New Series/Volume X.cbz',
      expect.objectContaining({ fileId: 'renamed-cbz-1', path: 'New Series/Volume X.cbz' })
    );
  });

  it('renames a series folder and replaces cache entries with returned metadata', async () => {
    const cache = {
      removeById: vi.fn(),
      add: vi.fn()
    };
    const provider = {
      type: 'google-drive',
      renameFolder: vi.fn(async () => [
        {
          provider: 'google-drive',
          fileId: 'file-1',
          path: 'Renamed Series/Volume 1.cbz',
          modifiedTime: '2026-03-10T00:00:00.000Z',
          size: 100
        },
        {
          provider: 'google-drive',
          fileId: 'file-2',
          path: 'Renamed Series/Volume 1.webp',
          modifiedTime: '2026-03-10T00:00:00.000Z',
          size: 5
        }
      ])
    };

    const existingFiles: CloudFileMetadata[] = [
      {
        provider: 'google-drive',
        fileId: 'file-1',
        path: 'Original Series/Volume 1.cbz',
        modifiedTime: '2026-03-10T00:00:00.000Z',
        size: 100
      },
      {
        provider: 'google-drive',
        fileId: 'file-2',
        path: 'Original Series/Volume 1.webp',
        modifiedTime: '2026-03-10T00:00:00.000Z',
        size: 5
      }
    ];

    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((seriesTitle: string) =>
      seriesTitle === 'Original Series' ? existingFiles : []
    );
    getCache.mockReturnValue(cache);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const renamedCount = await unifiedCloudManager.renameSeries(
      'Original Series',
      'Renamed Series'
    );

    expect(renamedCount).toBe(2);
    expect(fetchAll).toHaveBeenCalledTimes(1);
    expect(provider.renameFolder).toHaveBeenCalledWith('Original Series', 'Renamed Series');
    expect(cache.removeById).toHaveBeenCalledTimes(2);
    expect(cache.add).toHaveBeenCalledTimes(2);
    expect(cache.add).toHaveBeenCalledWith(
      'Renamed Series/Volume 1.cbz',
      expect.objectContaining({ fileId: 'file-1' })
    );
  });
});
