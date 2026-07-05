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
    const files = oldSeriesFiles();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue({ removeById: vi.fn(), add: vi.fn() });

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
    getCache.mockReturnValue({ removeById: vi.fn(), add: vi.fn() });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(
      unifiedCloudManager.renameVolume('Old Series', 'Volume 1', 'New Series', 'Volume X', 'uuid-1')
    ).resolves.toBe(0);
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

  it('aborts BEFORE the destructive delete when a move fails — even a 404', async () => {
    // A NOT_FOUND during a move is a GENUINE failure (deleted elsewhere,
    // stale cached id) — never "already moved by a prior attempt": an
    // already-moved file is absent from the fresh source listing and never
    // reaches the move loop. Swallowing it here would delete the stale
    // .mokuro and report success while the cbz is stranded or gone.
    const cache = { removeById: vi.fn(), add: vi.fn() };
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
    const cache = { removeById: vi.fn(), add: vi.fn() };
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
    const cache = { removeById: vi.fn(), add: vi.fn() };
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
    const cache = { removeById: vi.fn(), add: vi.fn() };
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
    const cache = { removeById: vi.fn(), add: vi.fn() };
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
    const cache = { removeById: vi.fn(), add: vi.fn() };
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
    const cache = { removeById: vi.fn(), add: vi.fn() };
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

  it('collects a per-volume failure — with no remote writes for it — when a sidecar cannot be regenerated', async () => {
    const cache = { removeById: vi.fn(), add: vi.fn() };
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
    const cache = { removeById: vi.fn(), add: vi.fn() };
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
    const cache = { removeById: vi.fn(), add: vi.fn() };
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
