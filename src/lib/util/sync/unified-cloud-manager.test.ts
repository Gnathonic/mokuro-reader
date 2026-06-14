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

const generateSidecars = vi.fn();
vi.mock('$lib/util/compress-volume', () => ({
  generateVolumeSidecarsFromDb: (...args: unknown[]) => generateSidecars(...args)
}));

/** A writable provider mock exposing every primitive renameVolume composes. */
function makeRenameProvider(overrides: Record<string, unknown> = {}) {
  return {
    type: 'webdav',
    getStatus: vi.fn(() => ({ isReadOnly: false })),
    uploadFile: vi.fn(async () => 'uploaded-fileid'),
    renameFile: vi.fn(async (file: CloudFileMetadata, newPath: string) => ({
      ...file,
      fileId: `renamed-${file.fileId}`,
      path: newPath
    })),
    deleteFile: vi.fn(async () => {}),
    removeDirectoryIfEmpty: vi.fn(async () => {}),
    ...overrides
  };
}

function oldSeriesFiles(): CloudFileMetadata[] {
  return [
    {
      provider: 'webdav',
      fileId: 'cbz-1',
      path: 'Old Series/Volume 1.cbz',
      modifiedTime: 't',
      size: 100
    },
    {
      provider: 'webdav',
      fileId: 'mokuro-1',
      path: 'Old Series/Volume 1.mokuro',
      modifiedTime: 't',
      size: 10
    },
    {
      provider: 'webdav',
      fileId: 'thumb-1',
      path: 'Old Series/Volume 1.webp',
      modifiedTime: 't',
      size: 5
    }
  ];
}

describe('UnifiedCloudManager rename operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('regenerates the .mokuro at the new path, moves cbz+cover, and deletes the stale .mokuro', async () => {
    const cache = { removeById: vi.fn(), add: vi.fn() };
    const provider = makeRenameProvider();
    const files = oldSeriesFiles();

    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((seriesTitle: string) =>
      files.filter((file) => file.path.startsWith(`${seriesTitle}/`))
    );
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({
      mokuro: { filename: 'Volume X.mokuro', blob: new Blob(['{"title":"New Series"}']) }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const changed = await unifiedCloudManager.renameVolume(
      'Old Series',
      'Volume 1',
      'New Series',
      'Volume X',
      'uuid-1'
    );

    // fresh .mokuro built with the NEW names (DB still old) and uploaded to new path
    expect(generateSidecars).toHaveBeenCalledWith('uuid-1', {
      seriesTitle: 'New Series',
      volumeTitle: 'Volume X'
    });
    expect(provider.uploadFile).toHaveBeenCalledWith(
      'New Series/Volume X.mokuro',
      expect.any(Blob),
      undefined,
      undefined
    );
    // cbz + cover MOVED (never the mokuro)
    expect(provider.renameFile).toHaveBeenCalledTimes(2);
    expect(provider.renameFile).toHaveBeenCalledWith(files[0], 'New Series/Volume X.cbz');
    expect(provider.renameFile).toHaveBeenCalledWith(files[2], 'New Series/Volume X.webp');
    // stale .mokuro DELETED (destructive step, after the fresh upload)
    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
    expect(provider.deleteFile).toHaveBeenCalledWith(files[1]);
    // upload + 2 moves + delete
    expect(changed).toBe(4);
  });

  it('throws on a read-only provider instead of letting the local rename desync', async () => {
    const provider = makeRenameProvider({ getStatus: vi.fn(() => ({ isReadOnly: true })) });
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue({ removeById: vi.fn(), add: vi.fn() });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(
      unifiedCloudManager.renameVolume('Old Series', 'Volume 1', 'New Series', 'Volume X', 'uuid-1')
    ).rejects.toMatchObject({ name: 'ProviderError', code: 'READ_ONLY' });
    expect(provider.renameFile).not.toHaveBeenCalled();
    expect(provider.uploadFile).not.toHaveBeenCalled();
  });

  it('image-only volume (no OCR): just moves files, no mokuro upload/delete', async () => {
    const cache = { removeById: vi.fn(), add: vi.fn() };
    const provider = makeRenameProvider();
    const files: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Old Series/Volume 1.cbz',
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'thumb-1',
        path: 'Old Series/Volume 1.webp',
        modifiedTime: 't',
        size: 5
      }
    ];
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({}); // no mokuro for image-only

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const changed = await unifiedCloudManager.renameVolume(
      'Old Series',
      'Volume 1',
      'New Series',
      'Volume X',
      'uuid-1'
    );

    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
    expect(provider.renameFile).toHaveBeenCalledTimes(2);
    expect(changed).toBe(2);
  });

  it('refuses to rename an OCR volume whose sidecar cannot be regenerated, before any remote write', async () => {
    // mokuro_version set but volume_ocr missing → generateSidecars yields no
    // mokuro while a stale .mokuro exists in the cloud. Moving it would
    // silently revert the rename, so we must throw before mutating anything.
    const cache = { removeById: vi.fn(), add: vi.fn() };
    const provider = makeRenameProvider();
    const files = oldSeriesFiles(); // includes a .mokuro
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({}); // OCR data missing → no fresh mokuro

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(
      unifiedCloudManager.renameVolume('Old Series', 'Volume 1', 'New Series', 'Volume X', 'uuid-1')
    ).rejects.toMatchObject({ name: 'ProviderError', code: 'SIDECAR_REGEN_FAILED' });
    // nothing remote was touched
    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(provider.renameFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
  });

  it('is idempotent: a file already moved by a prior partial run (404) is skipped, not fatal', async () => {
    const cache = { removeById: vi.fn(), add: vi.fn() };
    const provider = makeRenameProvider({
      renameFile: vi.fn(async (file: CloudFileMetadata, newPath: string) => {
        if (file.fileId === 'cbz-1') throw new Error('Request failed with status 404 Not Found');
        return { ...file, fileId: `renamed-${file.fileId}`, path: newPath };
      })
    });
    const files = oldSeriesFiles();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({
      mokuro: { filename: 'Volume X.mokuro', blob: new Blob(['{}']) }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const changed = await unifiedCloudManager.renameVolume(
      'Old Series',
      'Volume 1',
      'New Series',
      'Volume X',
      'uuid-1'
    );

    // upload(1) + webp move(1) + delete(1); cbz skipped (already moved)
    expect(changed).toBe(3);
    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('prunes the old series directory only when it is left empty', async () => {
    const cache = { removeById: vi.fn(), add: vi.fn() };
    const provider = makeRenameProvider();
    const files = oldSeriesFiles();
    getActiveProvider.mockReturnValue(provider);
    // first call (find files) returns them; the later prune check sees it empty
    getBySeries.mockReturnValueOnce(files).mockReturnValue([]);
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({
      mokuro: { filename: 'Volume X.mokuro', blob: new Blob(['{}']) }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.renameVolume(
      'Old Series',
      'Volume 1',
      'New Series',
      'Volume X',
      'uuid-1'
    );

    expect(provider.removeDirectoryIfEmpty).toHaveBeenCalledWith('Old Series');
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
