import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudFileMetadata } from './provider-interface';

const fetchAll = vi.fn();
const getBySeries = vi.fn();
const getCache = vi.fn();
const getAllFiles = vi.fn(() => [] as unknown[]);
const getActiveProvider = vi.fn();

vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: {
    fetchAll,
    getBySeries,
    getCache,
    getAllFiles,
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

const localVolumes = vi.fn(async (): Promise<unknown[]> => []);
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      toArray: () => localVolumes(),
      // The rename path reads the row to tell a metadata-only volume (no OCR
      // here to rebuild its sidecar from) apart from a DB inconsistency.
      get: async (uuid: string) =>
        ((await localVolumes()) as { volume_uuid?: string }[]).find((v) => v.volume_uuid === uuid)
    }
  }
}));

const getSeriesMetadataForTitle = vi.fn(async (_title: string): Promise<unknown> => undefined);
const getAllSeriesMetadata = vi.fn(async (): Promise<Record<string, unknown>> => ({}));
vi.mock('$lib/metadata/store', () => ({
  getSeriesMetadataForTitle: (title: string) => getSeriesMetadataForTitle(title),
  getAllSeriesMetadata: () => getAllSeriesMetadata()
}));

const getSeriesIndex = vi.fn(async (_key: string): Promise<unknown> => undefined);
const putSeriesIndex = vi.fn(async (_rec: unknown) => {});
const deleteSeriesIndex = vi.fn(async (_key: string) => {});
const moveSeriesIndexKey = vi.fn(async (_old: string, _next: string) => {});
vi.mock('$lib/metadata/series-index', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/series-index')>(
    '$lib/metadata/series-index'
  );
  return {
    // indexNeedsRefresh stays REAL — the size/mtime comparison is the thing
    // deciding whether a write re-reads the cloud copy first. `catalog-index`
    // (kept real for `catalogNeedsRefresh`) imports `sourceStampChanged` from
    // here, so the mock must carry it too or that module fails to load.
    indexNeedsRefresh: actual.indexNeedsRefresh,
    sourceStampChanged: actual.sourceStampChanged,
    getSeriesIndex: (key: string) => getSeriesIndex(key),
    putSeriesIndex: (rec: unknown) => putSeriesIndex(rec),
    deleteSeriesIndex: (key: string) => deleteSeriesIndex(key),
    moveSeriesIndexKey: (o: string, n: string) => moveSeriesIndexKey(o, n)
  };
});

const catalogRows = vi.fn(async (): Promise<unknown[]> => []);
const putCatalogIndexes = vi.fn(async (_recs: unknown[]) => {});
const deleteCatalogIndexes = vi.fn(async (_keys: string[]) => {});
const moveCatalogIndexKey = vi.fn(async (_old: string, _next: string) => {});
const replaceCatalogIndexes = vi.fn(async (_provider: string, _recs: unknown[]) => {});
vi.mock('$lib/metadata/catalog-index', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/catalog-index')>(
    '$lib/metadata/catalog-index'
  );
  return {
    // The real size/mtime comparison decides whether the write re-reads first.
    catalogNeedsRefresh: actual.catalogNeedsRefresh,
    listCatalogIndexes: () => catalogRows(),
    putCatalogIndexes: (recs: unknown[]) => putCatalogIndexes(recs),
    deleteCatalogIndexes: (keys: string[]) => deleteCatalogIndexes(keys),
    replaceCatalogIndexesForProvider: (provider: string, recs: unknown[]) =>
      replaceCatalogIndexes(provider, recs),
    moveCatalogIndexKey: (o: string, n: string) => moveCatalogIndexKey(o, n)
  };
});

const refreshSeriesIndexes = vi.fn(async (_map: unknown, _providerType?: string) => {});
vi.mock('$lib/metadata/series-index-sync', () => ({
  refreshSeriesIndexes: (map: unknown, providerType: string) =>
    refreshSeriesIndexes(map, providerType)
}));

/**
 * A file cache whose fetch has COMPLETED. Every metadata write gates on
 * `isLoaded()`, because a listing that is merely non-empty can still be this
 * device's own uploads mid-`fetchAll()` — see `writeSeriesFile`.
 */
function loadedCache(overrides: object = {}) {
  return { removeById: vi.fn(), add: vi.fn(), isLoaded: () => true, ...overrides };
}

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
    downloadFile: vi.fn(async () => new Blob(['{}'])),
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
    const cache = loadedCache();
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
    const files = oldSeriesFiles();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(loadedCache());

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(
      unifiedCloudManager.renameVolume('Old Series', 'Volume 1', 'New Series', 'Volume X', 'uuid-1')
    ).rejects.toMatchObject({ name: 'ProviderError', code: 'READ_ONLY' });
    expect(provider.renameFile).not.toHaveBeenCalled();
    expect(provider.uploadFile).not.toHaveBeenCalled();
  });

  it('read-only provider with nothing backed up: purely-local rename proceeds (returns 0)', async () => {
    // The zero-files check must come BEFORE the read-only gate: a read-only
    // provider (anonymous session, auto-demoted server) has nothing to keep
    // in sync for a never-backed-up volume, so it must not block the rename.
    const provider = makeRenameProvider({ getStatus: vi.fn(() => ({ isReadOnly: true })) });
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockReturnValue([]);
    getCache.mockReturnValue(loadedCache());

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(
      unifiedCloudManager.renameVolume('Old Series', 'Volume 1', 'New Series', 'Volume X', 'uuid-1')
    ).resolves.toBe(0);
  });

  it('image-only volume (no OCR): just moves files, no mokuro upload/delete', async () => {
    const cache = loadedCache();
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
    const cache = loadedCache();
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

  it('refuses to rename a metadata-only volume that has a .mokuro in the cloud', async () => {
    // Its OCR is not on this device, so the sidecar cannot be rebuilt with the
    // new names — and moving the stale one would revert the rename on the next
    // download. Same gate, a message that says what to do about it.
    const cache = loadedCache();
    const provider = makeRenameProvider();
    const files = oldSeriesFiles(); // includes a .mokuro
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(cache);
    localVolumes.mockResolvedValue([
      {
        volume_uuid: 'uuid-1',
        series_title: 'Old Series',
        volume_title: 'Volume 1',
        mokuro_version: '0.4.11',
        metadata_only: true
      }
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(
      unifiedCloudManager.renameVolume('Old Series', 'Volume 1', 'New Series', 'Volume X', 'uuid-1')
    ).rejects.toMatchObject({
      code: 'SIDECAR_REGEN_FAILED',
      message: expect.stringContaining('not on this device')
    });
    // The OCR is not here, so nothing even tried to read it.
    expect(generateSidecars).not.toHaveBeenCalled();
    expect(provider.renameFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();

    // `clearAllMocks` keeps implementations: put the shared table back.
    localVolumes.mockResolvedValue([]);
  });

  it('aborts BEFORE the destructive delete when a move fails — even a 404', async () => {
    // A NOT_FOUND during a move is a GENUINE failure (deleted elsewhere,
    // stale cached id) — never "already moved by a prior attempt": an
    // already-moved file is absent from the fresh source listing and never
    // reaches the move loop. Swallowing it here would delete the stale
    // .mokuro and report success while the cbz is stranded or gone.
    const cache = loadedCache();
    const provider = makeRenameProvider({
      renameFile: vi.fn(async (file: CloudFileMetadata) => {
        if (file.fileId === 'cbz-1') throw new Error('Request failed with status 404 Not Found');
        throw new Error('unexpected');
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
    await expect(
      unifiedCloudManager.renameVolume('Old Series', 'Volume 1', 'New Series', 'Volume X', 'uuid-1')
    ).rejects.toThrow('404');

    // The destructive step never ran: the stale .mokuro survives.
    expect(provider.deleteFile).not.toHaveBeenCalled();
  });

  it('converges on retry: files a prior run already moved are simply absent from the source set', async () => {
    // State after a partial run (fresh fetch): the cbz+cover already sit at
    // the new path; only the stale .mokuro remains at the old path. The retry
    // must not re-move anything (and must not read the moved files as a
    // TARGET_EXISTS collision — collisions require the SOURCE to still exist).
    const cache = loadedCache();
    const provider = makeRenameProvider();
    const state: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'mokuro-1',
        path: 'Old Series/Volume 1.mokuro',
        modifiedTime: 't',
        size: 10
      },
      {
        provider: 'webdav',
        fileId: 'renamed-cbz-1',
        path: 'New Series/Volume X.cbz',
        modifiedTime: 't',
        size: 100
      }
    ];
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => state.filter((f) => f.path.startsWith(`${s}/`)));
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

    // upload fresh mokuro (overwrite) + delete stale mokuro; no moves at all
    expect(changed).toBe(2);
    expect(provider.renameFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('refuses to rename onto an occupied name before any remote write (TARGET_EXISTS)', async () => {
    // Another volume's backup occupies the destination while our source still
    // exists. Step 1's .mokuro upload is an overwrite on every provider, so
    // the gate must fire BEFORE it — otherwise the occupant's sidecar is
    // corrupted before the cbz move could fail.
    const cache = loadedCache();
    const provider = makeRenameProvider();
    const state: CloudFileMetadata[] = [
      ...oldSeriesFiles(),
      {
        provider: 'webdav',
        fileId: 'other-cbz',
        path: 'New Series/Volume X.cbz',
        modifiedTime: 't',
        size: 999
      },
      {
        provider: 'webdav',
        fileId: 'other-mok',
        path: 'New Series/Volume X.mokuro',
        modifiedTime: 't',
        size: 11
      }
    ];
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => state.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({
      mokuro: { filename: 'Volume X.mokuro', blob: new Blob(['{}']) }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(
      unifiedCloudManager.renameVolume('Old Series', 'Volume 1', 'New Series', 'Volume X', 'uuid-1')
    ).rejects.toMatchObject({ name: 'ProviderError', code: 'TARGET_EXISTS' });

    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(provider.renameFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
  });

  it('overwrite option deletes the occupant first, then renames cleanly', async () => {
    const cache = loadedCache();
    const provider = makeRenameProvider();
    const occupantCbz: CloudFileMetadata = {
      provider: 'webdav',
      fileId: 'other-cbz',
      path: 'New Series/Volume X.cbz',
      modifiedTime: 't',
      size: 999
    };
    const occupantMok: CloudFileMetadata = {
      provider: 'webdav',
      fileId: 'other-mok',
      path: 'New Series/Volume X.mokuro',
      modifiedTime: 't',
      size: 11
    };
    const files = oldSeriesFiles();
    const state = [...files, occupantCbz, occupantMok];
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => state.filter((f) => f.path.startsWith(`${s}/`)));
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
      'uuid-1',
      { overwrite: true }
    );

    // occupants deleted (2) + upload (1) + cbz/webp moves (2) + stale mokuro delete (1)
    expect(changed).toBe(6);
    expect(provider.deleteFile).toHaveBeenCalledWith(occupantCbz);
    expect(provider.deleteFile).toHaveBeenCalledWith(occupantMok);
    expect(provider.renameFile).toHaveBeenCalledTimes(2);
  });

  it('asks the provider to prune the old series directory after a cross-series rename', async () => {
    // The prune decision is the PROVIDER's (server-checked emptiness) — the
    // local cache is never consulted, because a debounced provider-event
    // rebuild can transiently repopulate old-path entries mid-rename and a
    // cache gate then skips real prunes.
    const cache = loadedCache();
    const provider = makeRenameProvider();
    const files = oldSeriesFiles();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
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

  it('does not prune when only the volume title changed (same series)', async () => {
    const cache = loadedCache();
    const provider = makeRenameProvider();
    const files = oldSeriesFiles();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({
      mokuro: { filename: 'Volume X.mokuro', blob: new Blob(['{}']) }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.renameVolume(
      'Old Series',
      'Volume 1',
      'Old Series',
      'Volume X',
      'uuid-1'
    );

    expect(provider.removeDirectoryIfEmpty).not.toHaveBeenCalled();
  });

  it('renames a series folder and replaces cache entries with returned metadata', async () => {
    const cache = {
      removeById: vi.fn(),
      add: vi.fn()
    };
    const provider = {
      type: 'google-drive',
      getStatus: vi.fn(() => ({ isReadOnly: false })),
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
    const result = await unifiedCloudManager.renameSeries('Original Series', 'Renamed Series');

    expect(result.changed).toBe(2);
    expect(result.failures).toEqual([]);
    expect(fetchAll).toHaveBeenCalledTimes(1);
    expect(provider.renameFolder).toHaveBeenCalledWith('Original Series', 'Renamed Series');
    expect(cache.removeById).toHaveBeenCalledTimes(2);
    expect(cache.add).toHaveBeenCalledTimes(2);
    expect(cache.add).toHaveBeenCalledWith(
      'Renamed Series/Volume 1.cbz',
      expect.objectContaining({ fileId: 'file-1' })
    );
  });

  it('renames an OCR series via the per-volume path so each .mokuro is regenerated', async () => {
    const cache = loadedCache();
    const existing: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Old Series/Volume 1.cbz',
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'mok-1',
        path: 'Old Series/Volume 1.mokuro',
        modifiedTime: 't',
        size: 10
      }
    ];
    // No renameFolder on the mock: if the code took the bulk-move path it would
    // call an undefined method and throw — so passing proves the per-volume path.
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) =>
      existing.filter((f) => f.path.startsWith(`${s}/`))
    );
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({
      mokuro: { filename: 'Volume 1.mokuro', blob: new Blob(['{"title":"New Series"}']) }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.renameSeries('Old Series', 'New Series', [
      { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' }
    ]);

    // sidecar regenerated with the new SERIES title (volume title unchanged)
    expect(generateSidecars).toHaveBeenCalledWith('uuid-1', {
      seriesTitle: 'New Series',
      volumeTitle: 'Volume 1'
    });
    expect(provider.uploadFile).toHaveBeenCalledWith(
      'New Series/Volume 1.mokuro',
      expect.any(Blob),
      undefined,
      undefined
    );
    // cbz moved, stale .mokuro deleted last
    expect(provider.renameFile).toHaveBeenCalledWith(existing[0], 'New Series/Volume 1.cbz');
    expect(provider.deleteFile).toHaveBeenCalledWith(existing[1]);
  });

  it('refuses the whole series rename when a volume is not on this device', async () => {
    // Left to the fan-out this volume fails AFTER its siblings moved, splitting
    // the series across two cloud folders with no retry that can converge — so
    // it is a pre-flight rejection, before anything is touched.
    const cache = loadedCache();
    const existing: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Old Series/Volume 1.cbz',
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'mok-1',
        path: 'Old Series/Volume 1.mokuro',
        modifiedTime: 't',
        size: 10
      }
    ];
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) =>
      existing.filter((f) => f.path.startsWith(`${s}/`))
    );
    getCache.mockReturnValue(cache);
    localVolumes.mockResolvedValue([
      {
        volume_uuid: 'uuid-1',
        series_title: 'Old Series',
        volume_title: 'Volume 1',
        mokuro_version: '0.4.11',
        metadata_only: true
      }
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(
      unifiedCloudManager.renameSeries('Old Series', 'New Series', [
        { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' }
      ])
    ).rejects.toMatchObject({
      code: 'CLOUD_ONLY_VOLUMES',
      message: expect.stringContaining('not on this device')
    });

    // Nothing was touched: no sidecar read, no remote write, no series record move.
    expect(generateSidecars).not.toHaveBeenCalled();
    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(provider.renameFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
    expect(moveSeriesIndexKey).not.toHaveBeenCalled();

    localVolumes.mockResolvedValue([]);
  });

  it('renames an image-only volume that is not on this device (no sidecar to rewrite)', async () => {
    const cache = loadedCache();
    const existing: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Old Series/Volume 1.cbz',
        modifiedTime: 't',
        size: 100
      }
    ];
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) =>
      existing.filter((f) => f.path.startsWith(`${s}/`))
    );
    getCache.mockReturnValue(cache);
    localVolumes.mockResolvedValue([
      {
        volume_uuid: 'uuid-1',
        series_title: 'Old Series',
        volume_title: 'Volume 1',
        mokuro_version: '',
        metadata_only: true
      }
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const result = await unifiedCloudManager.renameSeries('Old Series', 'New Series', [
      { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' }
    ]);

    expect(result.renamedVolumeUuids).toEqual(['uuid-1']);
    expect(provider.renameFile).toHaveBeenCalledWith(existing[0], 'New Series/Volume 1.cbz');

    localVolumes.mockResolvedValue([]);
  });

  it('collects a per-volume failure — with no remote writes for it — when a sidecar cannot be regenerated', async () => {
    const cache = loadedCache();
    const existing: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Old Series/Volume 1.cbz',
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'mok-1',
        path: 'Old Series/Volume 1.mokuro',
        modifiedTime: 't',
        size: 10
      }
    ];
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) =>
      existing.filter((f) => f.path.startsWith(`${s}/`))
    );
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({}); // OCR data missing → no fresh .mokuro

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const result = await unifiedCloudManager.renameSeries('Old Series', 'New Series', [
      { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' }
    ]);

    expect(result.renamedVolumeUuids).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' });
    expect(result.failures[0].error).toMatchObject({ code: 'SIDECAR_REGEN_FAILED' });

    // The volume's gate fired before any remote mutation — nothing was touched.
    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(provider.renameFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
  });

  it('blocks a series rename when the cloud holds volumes missing from the local library', async () => {
    // Cloud-only volumes can't have their .mokuro regenerated (no local OCR),
    // so renaming around them would split the series across two cloud folders.
    // The gate fires before any remote write.
    // (Proper fix — downloading .mokuro/metadata without the full volume —
    // is blocked on the metadata-persistence data update.)
    const cache = loadedCache();
    const existing: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Old Series/Volume 1.cbz',
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'mok-1',
        path: 'Old Series/Volume 1.mokuro',
        modifiedTime: 't',
        size: 10
      },
      {
        provider: 'webdav',
        fileId: 'cbz-2',
        path: 'Old Series/Volume 2.cbz',
        modifiedTime: 't',
        size: 100
      }
    ];
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) =>
      existing.filter((f) => f.path.startsWith(`${s}/`))
    );
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({
      mokuro: { filename: 'Volume 1.mokuro', blob: new Blob(['{}']) }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(
      unifiedCloudManager.renameSeries('Old Series', 'New Series', [
        { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' } // Volume 2 is cloud-only
      ])
    ).rejects.toMatchObject({ name: 'ProviderError', code: 'CLOUD_ONLY_VOLUMES' });

    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(provider.renameFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
  });

  it('continues past a failed volume and reports per-volume outcomes', async () => {
    const cache = loadedCache();
    const existing: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Old Series/Volume 1.cbz',
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'mok-1',
        path: 'Old Series/Volume 1.mokuro',
        modifiedTime: 't',
        size: 10
      },
      {
        provider: 'webdav',
        fileId: 'cbz-2',
        path: 'Old Series/Volume 2.cbz',
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'mok-2',
        path: 'Old Series/Volume 2.mokuro',
        modifiedTime: 't',
        size: 10
      }
    ];
    const provider = makeRenameProvider({
      renameFile: vi.fn(async (file: CloudFileMetadata, newPath: string) => {
        if (file.fileId === 'cbz-1') throw new Error('network hiccup');
        return { ...file, fileId: `renamed-${file.fileId}`, path: newPath };
      })
    });
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) =>
      existing.filter((f) => f.path.startsWith(`${s}/`))
    );
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({
      mokuro: { filename: 'x.mokuro', blob: new Blob(['{}']) }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const result = await unifiedCloudManager.renameSeries('Old Series', 'New Series', [
      { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' },
      { volumeUuid: 'uuid-2', volumeTitle: 'Volume 2' }
    ]);

    // Volume 1's cbz move failed → its stale .mokuro was NOT deleted and it is
    // reported as a failure; Volume 2 completed fully.
    expect(result.renamedVolumeUuids).toEqual(['uuid-2']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' });
    expect(provider.deleteFile).toHaveBeenCalledTimes(1);
    expect(provider.deleteFile).toHaveBeenCalledWith(existing[3]); // mok-2 only
    // One prune attempt after the fan-out — the provider's server check makes
    // it safe even though volume 1's files still occupy the old directory.
    expect(provider.removeDirectoryIfEmpty).toHaveBeenCalledTimes(1);
    expect(provider.removeDirectoryIfEmpty).toHaveBeenCalledWith('Old Series');
  });
});

describe('UnifiedCloudManager.deleteManagedVolume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseFiles = (): CloudFileMetadata[] => [
    { provider: 'mega', fileId: 'cbz-1', path: 'S/Vol 1.cbz', modifiedTime: '', size: 100 },
    { provider: 'mega', fileId: 'mokuro-1', path: 'S/Vol 1.mokuro', modifiedTime: '', size: 10 },
    { provider: 'mega', fileId: 'thumb-1', path: 'S/Vol 1.webp', modifiedTime: '', size: 5 },
    { provider: 'mega', fileId: 'other-1', path: 'S/Vol 2.cbz', modifiedTime: '', size: 100 }
  ];

  it('deletes the archive and all sidecars (archive last) and clears the cache', async () => {
    const cache = { removeById: vi.fn() };
    const deleted: string[] = [];
    const provider = {
      type: 'mega',
      deleteFile: vi.fn(async (file: CloudFileMetadata) => {
        deleted.push(file.path);
      })
    };
    const files = baseFiles();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(cache);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.deleteManagedVolume('S', 'Vol 1');

    // Only Vol 1's three files (not Vol 2), and the .cbz archive is deleted LAST.
    expect(provider.deleteFile).toHaveBeenCalledTimes(3);
    expect(deleted).not.toContain('S/Vol 2.cbz');
    expect(deleted[deleted.length - 1]).toBe('S/Vol 1.cbz');
    expect(cache.removeById).toHaveBeenCalledTimes(3);
  });

  it('reports a summary on partial failure but still clears the successes', async () => {
    const cache = { removeById: vi.fn() };
    const provider = {
      type: 'mega',
      deleteFile: vi.fn(async (file: CloudFileMetadata) => {
        if (file.path.endsWith('.mokuro')) throw new Error('boom');
      })
    };
    const files = baseFiles();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(cache);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.deleteManagedVolume('S', 'Vol 1')).rejects.toThrow(
      /Failed to delete 1 of 3/
    );
    // The .cbz and .webp still got removed from cache; only the .mokuro failed.
    expect(cache.removeById).toHaveBeenCalledWith('cbz-1');
    expect(cache.removeById).toHaveBeenCalledWith('thumb-1');
    expect(cache.removeById).not.toHaveBeenCalledWith('mokuro-1');
  });
});

describe('UnifiedCloudManager.writeSeriesFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localVolumes.mockResolvedValue([]);
    getSeriesMetadataForTitle.mockResolvedValue(undefined);
    getSeriesIndex.mockResolvedValue(undefined);
  });

  /** A local (installed) volume — only the index fields matter here. */
  function volume(seriesTitle: string, volumeTitle: string, overrides: object = {}) {
    return {
      volume_uuid: `uuid-${volumeTitle}`,
      series_uuid: 'series-uuid',
      series_title: seriesTitle,
      volume_title: volumeTitle,
      mokuro_version: '0.4.11',
      page_count: 2,
      character_count: 20,
      page_char_counts: [10, 20],
      ...overrides
    };
  }

  function cloudFile(path: string, overrides: Partial<CloudFileMetadata> = {}): CloudFileMetadata {
    return {
      provider: 'webdav',
      fileId: path,
      path,
      modifiedTime: '2026-08-17T00:00:00.000Z',
      size: 100,
      ...overrides
    };
  }

  /** The JSON body of the `series.json` upload. */
  async function uploadedSeriesFile(provider: { uploadFile: ReturnType<typeof vi.fn> }) {
    const call = provider.uploadFile.mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].endsWith('series.json')
    );
    expect(call).toBeTruthy();
    return JSON.parse(await (call![1] as Blob).text());
  }

  function seriesFileJson(volumes: Array<{ uuid: string; title: string }>, updated_at: string) {
    return JSON.stringify({
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at,
      volumes: volumes.map((v) => ({
        volume_uuid: v.uuid,
        volume_title: v.title,
        page_count: 1,
        character_count: 1,
        page_char_counts: [1],
        mokuro_version: '0.4.11'
      }))
    });
  }

  it('uploads the index at <Series>/series.json and caches what it wrote', async () => {
    const cache = loadedCache();
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    getBySeries.mockReturnValue([cloudFile('One Piece/Volume 1.cbz')]);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('written');

    expect(provider.uploadFile).toHaveBeenCalledWith(
      'One Piece/series.json',
      expect.any(Blob),
      undefined,
      undefined
    );
    const file = await uploadedSeriesFile(provider);
    expect(file.version).toBe(2);
    expect(file.series_title).toBe('One Piece');
    expect(file.volumes).toHaveLength(1);
    expect(file.volumes[0]).toMatchObject({ volume_uuid: 'uuid-Volume 1', page_count: 2 });

    // The cache learns the new file (overwrite → one entry, at the same path)
    expect(cache.add).toHaveBeenCalledWith(
      'One Piece/series.json',
      expect.objectContaining({
        path: 'One Piece/series.json'
      })
    );
    // …and the local index cache is stamped with what we uploaded, so the next
    // listing does not re-download our own write.
    expect(putSeriesIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        series_key: 'one piece',
        series_title: 'One Piece',
        source: expect.objectContaining({ provider: 'webdav', path: 'One Piece/series.json' })
      })
    );
  });

  it('overwrites an existing cloud copy at the same path (no delete/rename dance)', async () => {
    const cache = loadedCache();
    const provider = makeRenameProvider();
    const existingCloud = cloudFile('One Piece/series.json', { fileId: 'sj', size: 42 });
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    getBySeries.mockReturnValue([cloudFile('One Piece/Volume 1.cbz'), existingCloud]);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);
    // Cached record matches the listing stamp → nothing to re-download.
    getSeriesIndex.mockResolvedValue({
      series_key: 'one piece',
      series_title: 'One Piece',
      file: JSON.parse(seriesFileJson([], '2026-01-01T00:00:00.000Z')),
      source: {
        provider: 'webdav',
        path: 'One Piece/series.json',
        size: 42,
        modifiedTime: '2026-08-17T00:00:00.000Z'
      },
      fetched_at: '2026-08-17T00:00:00.000Z'
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('written');

    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();
    expect(provider.uploadFile).toHaveBeenCalledWith(
      'One Piece/series.json',
      expect.any(Blob),
      undefined,
      undefined
    );
  });

  it('re-reads a cloud copy the cache has not seen and unions its volumes with the local ones', async () => {
    // Another device wrote the file after our last fetch (different size), so the
    // cached copy is stale: writing straight from it would drop that device's
    // volumes from the index.
    const cache = loadedCache();
    const provider = makeRenameProvider({
      downloadFile: vi.fn(
        async () =>
          new Blob([
            seriesFileJson([{ uuid: 'uuid-remote', title: 'Volume 2' }], '2026-08-16T00:00:00.000Z')
          ])
      )
    });
    const remoteFile = cloudFile('One Piece/series.json', { fileId: 'sj', size: 999 });
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    getBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 1.cbz'),
      cloudFile('One Piece/Volume 2.cbz'),
      remoteFile
    ]);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);
    getSeriesIndex.mockResolvedValue({
      series_key: 'one piece',
      series_title: 'One Piece',
      file: JSON.parse(seriesFileJson([], '2026-01-01T00:00:00.000Z')),
      source: {
        provider: 'webdav',
        path: 'One Piece/series.json',
        size: 1,
        modifiedTime: '2026-08-01T00:00:00.000Z'
      },
      fetched_at: '2026-08-01T00:00:00.000Z'
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('written');

    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    const file = await uploadedSeriesFile(provider);
    expect(file.volumes.map((v: { volume_uuid: string }) => v.volume_uuid).sort()).toEqual([
      'uuid-Volume 1',
      'uuid-remote'
    ]);
  });

  it('prunes index entries for volumes that are neither in the cloud listing nor installed', async () => {
    const cache = loadedCache();
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    getBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 1.cbz'),
      cloudFile('One Piece/series.json', { fileId: 'sj', size: 42 })
    ]);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);
    getSeriesIndex.mockResolvedValue({
      series_key: 'one piece',
      series_title: 'One Piece',
      file: JSON.parse(
        seriesFileJson(
          [
            { uuid: 'uuid-Volume 1', title: 'Volume 1' },
            { uuid: 'uuid-deleted', title: 'Volume 9' }
          ],
          '2026-01-01T00:00:00.000Z'
        )
      ),
      source: {
        provider: 'webdav',
        path: 'One Piece/series.json',
        size: 42,
        modifiedTime: '2026-08-17T00:00:00.000Z'
      },
      fetched_at: '2026-08-17T00:00:00.000Z'
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.writeSeriesFile('One Piece');

    const file = await uploadedSeriesFile(provider);
    expect(file.volumes.map((v: { volume_title: string }) => v.volume_title)).toEqual(['Volume 1']);
  });

  it('skips a folder the listing shows no volume archives in', async () => {
    // Callers prime the listing right before writing, so "no .cbz in this
    // folder" means the folder holds no volumes — writing would conjure
    // `<Series>/series.json` (and the folder) out of thin air for a series
    // that is only local, or resurrect one whose volumes were all deleted.
    const cache = loadedCache();
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    getBySeries.mockReturnValue([]);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);
    getSeriesIndex.mockResolvedValue({
      series_key: 'one piece',
      series_title: 'One Piece',
      file: JSON.parse(
        seriesFileJson([{ uuid: 'uuid-remote', title: 'Volume 7' }], '2026-01-01T00:00:00.000Z')
      ),
      source: { provider: 'webdav', path: 'One Piece/series.json', size: 42, modifiedTime: 't' },
      fetched_at: '2026-08-17T00:00:00.000Z'
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('skipped');

    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(putSeriesIndex).not.toHaveBeenCalled();
  });

  it('skips a folder holding only an orphaned series.json (no volumes left)', async () => {
    const cache = loadedCache();
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    getBySeries.mockReturnValue([cloudFile('One Piece/series.json', { fileId: 'sj', size: 42 })]);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('skipped');

    expect(provider.uploadFile).not.toHaveBeenCalled();
  });

  it('skips a read-only provider without touching the cloud', async () => {
    const provider = makeRenameProvider({ getStatus: vi.fn(() => ({ isReadOnly: true })) });
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(loadedCache());
    getBySeries.mockReturnValue([cloudFile('One Piece/Volume 1.cbz')]);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('read-only');
    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(putSeriesIndex).not.toHaveBeenCalled();
  });

  it('skips when there is nothing worth publishing (no facts, no volumes)', async () => {
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(loadedCache());
    getBySeries.mockReturnValue([]);
    localVolumes.mockResolvedValue([]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('skipped');
    expect(provider.uploadFile).not.toHaveBeenCalled();
  });

  it('skips when no provider is connected', async () => {
    getActiveProvider.mockReturnValue(null);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('skipped');
    expect(putSeriesIndex).not.toHaveBeenCalled();
  });

  it('ignores a placeholder (cloud-only) volume — its uuid and counts are derived', async () => {
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(loadedCache());
    getBySeries.mockReturnValue([cloudFile('One Piece/Volume 1.cbz')]);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1', { isPlaceholder: true })]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('skipped');
    expect(provider.uploadFile).not.toHaveBeenCalled();
  });

  it('skips while the provider cache is still filling', async () => {
    // Identical exposure to the catalog write: a folder listing that is not
    // empty is still not COMPLETE while `fetchAll()` runs, because `uploadFile`
    // adds every upload to the cache. Pruning `<Series>/series.json` against a
    // listing holding only this device's uploads drops the volumes every other
    // device published.
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(loadedCache({ isLoaded: () => false }));
    getBySeries.mockReturnValue([cloudFile('One Piece/Volume 1.cbz')]);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('skipped');
    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(putSeriesIndex).not.toHaveBeenCalled();
  });

  it('skips the write when the cloud copy exists but cannot be re-read', async () => {
    // A refresh we cannot perform means we do not know what is out there —
    // overwriting blind could clobber another device's newer facts, so skip.
    const provider = makeRenameProvider({
      downloadFile: vi.fn(async () => {
        throw new Error('offline');
      })
    });
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(loadedCache());
    getBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 1.cbz'),
      cloudFile('One Piece/series.json', { fileId: 'sj', size: 999 })
    ]);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('skipped');
    expect(provider.uploadFile).not.toHaveBeenCalled();
  });
});

describe('UnifiedCloudManager series.json on rename and delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localVolumes.mockResolvedValue([]);
    getSeriesMetadataForTitle.mockResolvedValue(undefined);
    getSeriesIndex.mockResolvedValue(undefined);
  });

  /** A cache mock backed by a mutable listing, so moves/deletes are visible. */
  function mutableCache(state: CloudFileMetadata[]) {
    getBySeries.mockImplementation((s: string) => state.filter((f) => f.path.startsWith(`${s}/`)));
    const cache = {
      removeById: vi.fn((fileId: string) => {
        const index = state.findIndex((f) => f.fileId === fileId);
        if (index >= 0) state.splice(index, 1);
      }),
      add: vi.fn((path: string, meta: CloudFileMetadata) => {
        state.push({ ...meta, path, fileId: meta.fileId ?? path });
      }),
      isLoaded: () => true
    };
    getCache.mockReturnValue(cache);
    return cache;
  }

  it('writes the index at the new title, drops the old file and moves the cached record', async () => {
    const provider = makeRenameProvider();
    const sidecar: CloudFileMetadata = {
      provider: 'webdav',
      fileId: 'sj',
      path: 'Old Series/series.json',
      modifiedTime: 't',
      size: 20
    };
    const state: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Old Series/Volume 1.cbz',
        modifiedTime: 't',
        size: 100
      },
      sidecar
    ];
    getActiveProvider.mockReturnValue(provider);
    mutableCache(state);
    generateSidecars.mockResolvedValue({});
    // The DB still holds the OLD title while the cloud rename gates the local commit.
    localVolumes.mockResolvedValue([
      {
        volume_uuid: 'uuid-1',
        series_uuid: 's',
        series_title: 'Old Series',
        volume_title: 'Volume 1',
        mokuro_version: '0.4.11',
        page_count: 1,
        character_count: 1,
        page_char_counts: [1]
      }
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const result = await unifiedCloudManager.renameSeries('Old Series', 'New Series', [
      { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' }
    ]);

    // The sidecar is NOT a volume: it must not trip the cloud-only-volumes gate.
    expect(result.failures).toEqual([]);
    expect(result.renamedVolumeUuids).toEqual(['uuid-1']);

    expect(moveSeriesIndexKey).toHaveBeenCalledWith('Old Series', 'New Series');
    expect(provider.uploadFile).toHaveBeenCalledWith(
      'New Series/series.json',
      expect.any(Blob),
      undefined,
      undefined
    );
    expect(provider.deleteFile).toHaveBeenCalledWith(sidecar);
  });

  it('carries series.json across the rename even when the catalog cache move fails', async () => {
    // The catalog cache is a disposable download cache. A Dexie abort while
    // moving its key must not skip the series.json carry-over, which is the
    // only step of the rename that touches the cloud.
    const provider = makeRenameProvider();
    const sidecar: CloudFileMetadata = {
      provider: 'webdav',
      fileId: 'sj',
      path: 'Old Series/series.json',
      modifiedTime: 't',
      size: 20
    };
    const state: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Old Series/Volume 1.cbz',
        modifiedTime: 't',
        size: 100
      },
      sidecar
    ];
    getActiveProvider.mockReturnValue(provider);
    mutableCache(state);
    generateSidecars.mockResolvedValue({});
    moveCatalogIndexKey.mockRejectedValueOnce(new Error('dexie transaction aborted'));
    localVolumes.mockResolvedValue([
      {
        volume_uuid: 'uuid-1',
        series_uuid: 's',
        series_title: 'Old Series',
        volume_title: 'Volume 1',
        mokuro_version: '0.4.11',
        page_count: 1,
        character_count: 1,
        page_char_counts: [1]
      }
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.renameSeries('Old Series', 'New Series', [
      { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' }
    ]);

    expect(provider.uploadFile).toHaveBeenCalledWith(
      'New Series/series.json',
      expect.any(Blob),
      undefined,
      undefined
    );
    expect(provider.deleteFile).toHaveBeenCalledWith(sidecar);
  });

  it('does not create a series.json for a folder whose only file was an orphan sidecar', async () => {
    // Nothing is backed up under the old title but a stale `series.json`. The
    // rename must clean it up without minting `<new>/series.json` for a folder
    // that holds no volumes.
    const provider = makeRenameProvider();
    const orphan: CloudFileMetadata = {
      provider: 'webdav',
      fileId: 'sj',
      path: 'Old Series/series.json',
      modifiedTime: 't',
      size: 20
    };
    getActiveProvider.mockReturnValue(provider);
    mutableCache([orphan]);
    generateSidecars.mockResolvedValue({});
    localVolumes.mockResolvedValue([
      {
        volume_uuid: 'uuid-1',
        series_uuid: 's',
        series_title: 'Old Series',
        volume_title: 'Volume 1',
        mokuro_version: '0.4.11',
        page_count: 1,
        character_count: 1,
        page_char_counts: [1]
      }
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.renameSeries('Old Series', 'New Series', [
      { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' }
    ]);

    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).toHaveBeenCalledWith(orphan);
  });

  it('keeps the old sidecar when the moved archives have not surfaced under the new title', async () => {
    // A cache without removeById/add cannot reflect the rename locally: the
    // archives stay listed under the OLD folder and the write at the new title
    // is skipped (no volumes there). The old index must survive until the next
    // listing/backup rather than leave the series with none.
    const provider = makeRenameProvider();
    const sidecar: CloudFileMetadata = {
      provider: 'webdav',
      fileId: 'sj',
      path: 'Old Series/series.json',
      modifiedTime: 't',
      size: 20
    };
    const state: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Old Series/Volume 1.cbz',
        modifiedTime: 't',
        size: 100
      },
      sidecar
    ];
    getActiveProvider.mockReturnValue(provider);
    // No removeById/add: the listing never changes locally.
    getBySeries.mockImplementation((s: string) => state.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue({});
    generateSidecars.mockResolvedValue({});
    localVolumes.mockResolvedValue([
      {
        volume_uuid: 'uuid-1',
        series_uuid: 's',
        series_title: 'Old Series',
        volume_title: 'Volume 1',
        mokuro_version: '0.4.11',
        page_count: 1,
        character_count: 1,
        page_char_counts: [1]
      }
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.renameSeries('Old Series', 'New Series', [
      { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' }
    ]);

    expect(provider.uploadFile).not.toHaveBeenCalledWith(
      'New Series/series.json',
      expect.anything(),
      undefined,
      undefined
    );
    expect(provider.deleteFile).not.toHaveBeenCalledWith(sidecar);
  });

  it('deletes the sidecar with the series folder and drops the cached index', async () => {
    const cache = loadedCache();
    const deleted: string[] = [];
    const provider = {
      type: 'webdav',
      getStatus: vi.fn(() => ({ isReadOnly: false })),
      deleteFile: vi.fn(async (file: CloudFileMetadata) => {
        deleted.push(file.path);
      })
    };
    const state: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'One Piece/Volume 1.cbz',
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'sj',
        path: 'One Piece/series.json',
        modifiedTime: 't',
        size: 20
      }
    ];
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => state.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(cache);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const result = await unifiedCloudManager.deleteSeriesFolder('One Piece');

    expect(deleted).toContain('One Piece/series.json');
    expect(result.failed).toBe(0);
    expect(deleteSeriesIndex).toHaveBeenCalledWith('one piece');
  });
});

describe('UnifiedCloudManager series.json lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localVolumes.mockResolvedValue([]);
    getSeriesMetadataForTitle.mockResolvedValue(undefined);
    getSeriesIndex.mockResolvedValue(undefined);
    getAllFiles.mockReturnValue([]);
  });

  function file(path: string, overrides: Partial<CloudFileMetadata> = {}): CloudFileMetadata {
    return {
      provider: 'webdav',
      fileId: path,
      path,
      modifiedTime: '2026-08-17T00:00:00.000Z',
      size: 100,
      ...overrides
    };
  }

  /** The JSON body of the `series.json` upload. */
  async function uploadedJson(provider: { uploadFile: ReturnType<typeof vi.fn> }) {
    const call = provider.uploadFile.mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].endsWith('series.json')
    );
    expect(call).toBeTruthy();
    return JSON.parse(await (call![1] as Blob).text());
  }

  /** A cache mock backed by a mutable listing, so deletes/uploads are visible. */
  function statefulCache(
    state: CloudFileMetadata[],
    addOverrides: Partial<CloudFileMetadata> = {}
  ) {
    getBySeries.mockImplementation((series: string) =>
      state.filter((f) => f.path.startsWith(`${series}/`))
    );
    const cache = {
      removeById: vi.fn((fileId: string) => {
        const index = state.findIndex((f) => f.fileId === fileId);
        if (index >= 0) state.splice(index, 1);
      }),
      add: vi.fn((path: string, meta: CloudFileMetadata) => {
        state.push({ ...meta, path, fileId: meta.fileId ?? path, ...addOverrides });
      }),
      isLoaded: () => true
    };
    getCache.mockReturnValue(cache);
    return cache;
  }

  it('kicks off an index refresh after a listing, without awaiting it', async () => {
    getActiveProvider.mockReturnValue(makeRenameProvider());
    getAllFiles.mockReturnValue([file('One Piece/Volume 1.cbz'), file('One Piece/series.json')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.fetchAllCloudVolumes();

    expect(fetchAll).toHaveBeenCalled();
    expect(refreshSeriesIndexes).toHaveBeenCalledTimes(1);
    const listing = refreshSeriesIndexes.mock.calls[0][0] as Map<string, CloudFileMetadata[]>;
    expect(listing.get('One Piece')).toHaveLength(2);
    // Bound to the provider the listing came from, so a switch invalidates it.
    expect(refreshSeriesIndexes.mock.calls[0][1]).toBe('webdav');
  });

  it('does not refresh indexes from a pre-rename listing (volume move)', async () => {
    // The listing still shows the OLD folder. A refresh from it would call
    // upsertFromSeriesFile with the old title and recreate the series_metadata
    // row the rename just moved.
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    const state = [
      file('One Piece/Volume 1.cbz', { fileId: 'cbz-1' }),
      file('One Piece/series.json', { fileId: 'sj' })
    ];
    statefulCache(state);
    getAllFiles.mockImplementation(() => state);
    generateSidecars.mockResolvedValue({});

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.renameVolume('One Piece', 'Volume 1', 'Naruto', 'Volume 1', 'uuid-1');

    expect(fetchAll).toHaveBeenCalled();
    expect(refreshSeriesIndexes).not.toHaveBeenCalled();
  });

  it('does not refresh indexes from a pre-rename listing (series rename)', async () => {
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    const state = [
      file('Old Series/Volume 1.cbz', { fileId: 'cbz-1' }),
      file('Old Series/series.json', { fileId: 'sj' })
    ];
    statefulCache(state);
    getAllFiles.mockImplementation(() => state);
    generateSidecars.mockResolvedValue({});

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.renameSeries('Old Series', 'New Series', [
      { volumeUuid: 'uuid-1', volumeTitle: 'Volume 1' }
    ]);

    expect(fetchAll).toHaveBeenCalled();
    expect(refreshSeriesIndexes).not.toHaveBeenCalled();
  });

  it('keeps the cached entries when the cloud copy is unparsable junk', async () => {
    // Junk is not "no index": another device's volumes are still known from the
    // last good fetch, and discarding them here would drop them from the file we
    // are about to write.
    const provider = makeRenameProvider({
      downloadFile: vi.fn(async () => new Blob(['<html>proxy error</html>']))
    });
    getActiveProvider.mockReturnValue(provider);
    statefulCache([
      file('One Piece/Volume 1.cbz'),
      // Volume 2 is backed up but not installed here — exactly the entry only
      // the cached index knows about.
      file('One Piece/Volume 2.cbz'),
      file('One Piece/series.json', { size: 999 })
    ]);
    localVolumes.mockResolvedValue([
      {
        volume_uuid: 'local-uuid',
        series_uuid: 's',
        series_title: 'One Piece',
        volume_title: 'Volume 1',
        mokuro_version: '0.4.11',
        page_count: 1,
        character_count: 1,
        page_char_counts: [1]
      }
    ]);
    getSeriesIndex.mockResolvedValue({
      series_key: 'one piece',
      series_title: 'One Piece',
      file: {
        version: 2,
        series_title: 'One Piece',
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: '2026-01-01T00:00:00.000Z',
        volumes: [
          {
            volume_uuid: 'other-device-uuid',
            volume_title: 'Volume 2',
            page_count: 3,
            character_count: 3,
            page_char_counts: [3],
            mokuro_version: '0.4.11'
          }
        ]
      },
      source: {
        provider: 'webdav',
        path: 'One Piece/series.json',
        size: 42,
        modifiedTime: '2026-08-01T00:00:00.000Z'
      },
      fetched_at: '2026-08-01T00:00:00.000Z'
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('written');

    const uploaded = await uploadedJson(provider);
    // Volume 2 came only from the cached copy; the junk cloud file must not have
    // erased it.
    expect(uploaded.volumes.map((v: { volume_uuid: string }) => v.volume_uuid)).toContain(
      'other-device-uuid'
    );
  });

  it('stamps the cached index with the size/mtime the file cache holds', async () => {
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    // The cache normalises what it stores (some providers report their own
    // stamp); the index must be stamped with THAT, not a second new Date().
    statefulCache([file('One Piece/Volume 1.cbz')], {
      size: 4242,
      modifiedTime: '2026-08-17T12:00:00.000Z'
    });
    localVolumes.mockResolvedValue([
      {
        volume_uuid: 'local-uuid',
        series_uuid: 's',
        series_title: 'One Piece',
        volume_title: 'Volume 1',
        mokuro_version: '0.4.11',
        page_count: 1,
        character_count: 1,
        page_char_counts: [1]
      }
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('written');

    expect(putSeriesIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          path: 'One Piece/series.json',
          size: 4242,
          modifiedTime: '2026-08-17T12:00:00.000Z'
        })
      })
    );
  });

  it('deletes the sidecar and the cached index when the last volume leaves a folder', async () => {
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    statefulCache([
      file('One Piece/Volume 1.cbz', { fileId: 'cbz-1' }),
      file('One Piece/Volume 1.mokuro', { fileId: 'mokuro-1' }),
      file('One Piece/series.json', { fileId: 'sj' })
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.deleteManagedVolume('One Piece', 'Volume 1');

    expect(provider.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'sj' }));
    expect(deleteSeriesIndex).toHaveBeenCalledWith('one piece');
  });

  it('keeps the sidecar while other volumes remain in the folder', async () => {
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    statefulCache([
      file('One Piece/Volume 1.cbz', { fileId: 'cbz-1' }),
      file('One Piece/Volume 2.cbz', { fileId: 'cbz-2' }),
      file('One Piece/series.json', { fileId: 'sj' })
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.deleteManagedVolume('One Piece', 'Volume 1');

    expect(provider.deleteFile).not.toHaveBeenCalledWith(expect.objectContaining({ fileId: 'sj' }));
    expect(deleteSeriesIndex).not.toHaveBeenCalled();
  });

  it('cleans up the emptied folder’s sidecar after a cross-series volume move', async () => {
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    statefulCache([
      file('One Piece/Volume 1.cbz', { fileId: 'cbz-1' }),
      file('One Piece/series.json', { fileId: 'sj' })
    ]);
    generateSidecars.mockResolvedValue({});

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.renameVolume('One Piece', 'Volume 1', 'Naruto', 'Volume 1', 'uuid-1');

    expect(provider.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'sj' }));
    expect(deleteSeriesIndex).toHaveBeenCalledWith('one piece');
    // The directory prune runs after the sidecar is gone, or it can never be empty.
    expect(provider.removeDirectoryIfEmpty).toHaveBeenCalledWith('One Piece');
  });

  it('leaves the sidecar alone when a rename stays inside the series', async () => {
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    statefulCache([
      file('One Piece/Volume 1.cbz', { fileId: 'cbz-1' }),
      file('One Piece/series.json', { fileId: 'sj' })
    ]);
    generateSidecars.mockResolvedValue({});

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.renameVolume('One Piece', 'Volume 1', 'One Piece', 'Vol 1', 'uuid-1');

    expect(provider.deleteFile).not.toHaveBeenCalledWith(expect.objectContaining({ fileId: 'sj' }));
    expect(deleteSeriesIndex).not.toHaveBeenCalled();
  });
});

describe('UnifiedCloudManager.writeCatalogFile', () => {
  const listing: CloudFileMetadata[] = [
    {
      provider: 'webdav',
      fileId: 'f1',
      path: 'Dr Stone/Volume 1.cbz',
      size: 10,
      modifiedTime: '2026-08-23T00:00:00.000Z'
    },
    {
      provider: 'webdav',
      fileId: 'f2',
      path: 'Other/Volume 1.cbz',
      size: 10,
      modifiedTime: '2026-08-23T00:00:00.000Z'
    },
    {
      provider: 'webdav',
      fileId: 'cat',
      path: 'catalog.json',
      size: 5,
      modifiedTime: '2026-08-22T00:00:00.000Z'
    }
  ];

  const CLOUD_CATALOG = {
    version: 1,
    updated_at: '2026-08-22T00:00:00.000Z',
    series: [
      {
        series_title: 'Other',
        external_ids: { anilist: 1 },
        titles: {},
        synonyms: [],
        updated_at: '2026-08-22T00:00:00.000Z'
      },
      {
        series_title: 'Gone',
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: '2026-08-22T00:00:00.000Z'
      }
    ]
  };

  let uploadFile: ReturnType<typeof vi.fn>;

  function provider(statusOverrides: Record<string, unknown> = {}) {
    uploadFile = vi.fn(async () => 'uploaded-fileid');
    return {
      type: 'webdav',
      getStatus: vi.fn(() => ({
        isAuthenticated: true,
        hasStoredCredentials: true,
        needsAttention: false,
        statusMessage: 'Connected',
        isReadOnly: false,
        serverCompilesMetadata: false,
        ...statusOverrides
      })),
      uploadFile,
      downloadFile: vi.fn(async () => new Blob([JSON.stringify(CLOUD_CATALOG)]))
    };
  }

  /**
   * A cached catalog row for a factless series, as the last fetch left it.
   * `sourceOverrides` is how a test makes the cache look STALE against the
   * listing, which is what sends the write down the re-read path.
   */
  function cachedRow(seriesTitle: string, sourceOverrides: Record<string, unknown> = {}) {
    return {
      series_key: seriesTitle.toLowerCase(),
      series_title: seriesTitle,
      entry: {
        series_title: seriesTitle,
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: '1970-01-01T00:00:00.000Z'
      },
      source: {
        provider: 'webdav',
        path: 'catalog.json',
        size: 5,
        modifiedTime: '2026-08-22T00:00:00.000Z',
        ...sourceOverrides
      },
      fetched_at: '2026-08-22T00:00:00.000Z'
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    catalogRows.mockResolvedValue([]);
    getAllSeriesMetadata.mockResolvedValue({});
    getAllFiles.mockReturnValue(listing);
    getCache.mockReturnValue(loadedCache());
  });

  it('skips entirely on a server-compiled provider', async () => {
    getActiveProvider.mockReturnValue(provider({ serverCompilesMetadata: true }));
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('server-compiled');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('skips on a read-only provider', async () => {
    getActiveProvider.mockReturnValue(provider({ isReadOnly: true }));
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('read-only');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('skips when the listing shows no series folders', async () => {
    getActiveProvider.mockReturnValue(provider());
    getAllFiles.mockReturnValue([]);
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('skipped');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('skips while the provider cache is still filling', async () => {
    // A non-empty listing is NOT proof of a complete one: `uploadFile` adds every
    // upload to the cache, so a backup that runs before `fetchAll()` finishes
    // leaves a listing holding this device's own uploads and nothing else.
    // Pruning the catalog against that blanks the library for every other device.
    getActiveProvider.mockReturnValue(provider());
    getCache.mockReturnValue(loadedCache({ isLoaded: () => false }));
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('skipped');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('publishes compact JSON unioned with the cloud copy and pruned to the listing', async () => {
    getActiveProvider.mockReturnValue(provider());
    getAllSeriesMetadata.mockResolvedValue({
      'dr stone': {
        series_key: 'dr stone',
        series_title: 'Dr Stone',
        external_ids: { anilist: 98416 },
        titles: {},
        synonyms: [],
        read_count: 0,
        updated_at: '2026-08-23T00:00:00.000Z',
        facts_updated_at: '2026-08-23T00:00:00.000Z'
      }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('written');

    const [path, blob] = uploadFile.mock.calls.at(-1)!;
    expect(path).toBe('catalog.json');
    const text = await (blob as Blob).text();
    expect(text).not.toContain('\n'); // compact, never pretty-printed
    const written = JSON.parse(text);
    expect(written.version).toBe(1);
    // 'Dr Stone' from this device, 'Other' carried through from the cloud copy,
    // 'Gone' pruned because the listing has no such folder.
    expect(written.series.map((s: { series_title: string }) => s.series_title)).toEqual([
      'Dr Stone',
      'Other'
    ]);
    expect(written.series[0].external_ids).toEqual({ anilist: 98416 });

    // The cache is stamped so the very next listing does not re-download our own write.
    const cached = replaceCatalogIndexes.mock.calls.at(-1)![1] as Array<{ series_key: string }>;
    expect(cached.map((r) => r.series_key)).toEqual(['dr stone', 'other']);
  });

  /**
   * A provider whose cloud copy already says exactly what this device would
   * rebuild: same two series, same facts, same stamps.
   */
  function noOpRebuildProvider() {
    const unchanged = {
      version: 1,
      updated_at: '2026-08-22T00:00:00.000Z',
      series: [
        {
          series_title: 'Dr Stone',
          external_ids: { anilist: 98416 },
          titles: {},
          synonyms: [],
          updated_at: '2026-08-23T00:00:00.000Z'
        },
        {
          series_title: 'Other',
          external_ids: { anilist: 1 },
          titles: {},
          synonyms: [],
          updated_at: '2026-08-22T00:00:00.000Z'
        }
      ]
    };
    const p = provider();
    p.downloadFile = vi.fn(async () => new Blob([JSON.stringify(unchanged)]));
    getAllSeriesMetadata.mockResolvedValue({
      'dr stone': {
        series_key: 'dr stone',
        series_title: 'Dr Stone',
        external_ids: { anilist: 98416 },
        titles: {},
        synonyms: [],
        read_count: 0,
        updated_at: '2026-08-23T00:00:00.000Z',
        facts_updated_at: '2026-08-23T00:00:00.000Z'
      }
    });
    return p;
  }

  it('skips the upload when the rebuild says exactly what the cloud already says', async () => {
    // A no-op rebuild used to publish anyway: identical entries, fresh build
    // stamp, new bytes — which flips `catalogNeedsRefresh` on every other
    // device and makes them all re-download a file that did not change.
    getActiveProvider.mockReturnValue(noOpRebuildProvider());

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('skipped');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('stamps the cache on that skip, so the next no-op write re-downloads nothing', async () => {
    // Skipping without stamping leaves `catalogNeedsRefresh` true for good: the
    // cache never learns what the cloud holds, so EVERY later write downloads
    // catalog.json again just to reach the same conclusion.
    const p = noOpRebuildProvider();
    getActiveProvider.mockReturnValue(p);

    // The real `catalog_index` table is stateful, and that is the whole point
    // here — the second attempt must see what the first one wrote.
    const rows: Array<{ series_key: string }> = [];
    catalogRows.mockImplementation(async () => [...rows]);
    replaceCatalogIndexes.mockImplementation(async (_provider: string, recs: unknown[]) => {
      rows.length = 0;
      rows.push(...(recs as Array<{ series_key: string }>));
    });

    try {
      const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');

      await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('skipped');
      expect(p.downloadFile).toHaveBeenCalledTimes(1);
      expect(rows.map((row) => row.series_key)).toEqual(['dr stone', 'other']);

      await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('skipped');
      expect(p.downloadFile).toHaveBeenCalledTimes(1);
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      replaceCatalogIndexes.mockImplementation(async () => {});
    }
  });

  it('still publishes when the cloud has no catalog.json, however well the cache matches', async () => {
    // `existing` comes from the CACHE here, and matching the cache says nothing
    // about a cloud that has no such file at all.
    getActiveProvider.mockReturnValue(provider());
    getAllFiles.mockReturnValue(listing.filter((f) => f.path !== 'catalog.json'));
    catalogRows.mockResolvedValue([cachedRow('Dr Stone'), cachedRow('Other')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('written');
    expect(uploadFile).toHaveBeenCalled();
  });

  it('republishes over a junk cloud copy even when the cache matches the rebuild', async () => {
    // Hand-edited, truncated, or a proxy error page: the merge falls back to the
    // cache, and the whole point of the write is to replace that junk.
    const p = provider();
    p.downloadFile = vi.fn(async () => new Blob(['<html>502</html>']));
    getActiveProvider.mockReturnValue(p);
    // Stale stamp, so the write re-reads the cloud copy and finds the junk.
    const stale = { modifiedTime: '2026-08-01T00:00:00.000Z' };
    catalogRows.mockResolvedValue([cachedRow('Dr Stone', stale), cachedRow('Other', stale)]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('written');
    expect(uploadFile).toHaveBeenCalled();
  });

  it('drops cached rows of THIS provider whose series left the catalog', async () => {
    getActiveProvider.mockReturnValue(provider());
    catalogRows.mockResolvedValue([
      {
        series_key: 'gone',
        series_title: 'Gone',
        entry: {
          series_title: 'Gone',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        },
        source: {
          provider: 'webdav',
          path: 'catalog.json',
          size: 5,
          modifiedTime: '2026-08-22T00:00:00.000Z'
        },
        fetched_at: '2026-08-22T00:00:00.000Z'
      }
    ]);
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.writeCatalogFile();
    // The prune runs inside `replaceCatalogIndexesForProvider` (one transaction,
    // tested in catalog-index.test.ts); what matters here is that the write
    // hands it THIS provider and a set with no 'gone' in it.
    const [providerType, recs] = replaceCatalogIndexes.mock.calls.at(-1)! as [
      string,
      Array<{ series_key: string }>
    ];
    expect(providerType).toBe('webdav');
    expect(recs.map((r) => r.series_key)).not.toContain('gone');
  });
});
