import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeVolumeTitleKey } from '$lib/metadata/series-key';
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
        ((await localVolumes()) as { volume_uuid?: string }[]).find((v) => v.volume_uuid === uuid),
      // `volumesForFoldedSeriesTitle`'s two indexed reads (the heal preview's
      // row source), derived from the SAME `localVolumes` fixture the scan
      // reads — so preview and write see one truth here, as in production.
      orderBy: (_index: string) => ({
        uniqueKeys: async () =>
          [
            ...new Set(
              ((await localVolumes()) as { series_title?: string }[]).map((v) => v.series_title)
            )
          ].filter((t): t is string => !!t)
      }),
      where: (_index: string) => ({
        anyOf: (values: string[]) => ({
          toArray: async () =>
            ((await localVolumes()) as { series_title?: string }[]).filter((v) =>
              values.includes(v.series_title as string)
            )
        })
      })
    },
    transaction: async (_mode: string, _tables: unknown, body: () => Promise<unknown>) => body()
  }
}));

const getSeriesMetadataForTitle = vi.fn(async (_title: string): Promise<unknown> => undefined);
const getAllSeriesMetadata = vi.fn(async (): Promise<Record<string, unknown>> => ({}));
const upsertFromSeriesFile = vi.fn(
  async (_title: string, _file: unknown): Promise<boolean> => true
);
/**
 * The `folded_key` lookups, DERIVED from the same `getAllSeriesMetadata`
 * fixture every test here already seeds — never stubbed on their own.
 *
 * A separately-stubbed double answers whatever the test told it to, so it would
 * report a match even for a production bug that folded the wrong side of the
 * comparison; and it would let a fixture drift out of agreement with the rows
 * the rest of the file asserts against. Folding the fixture's rows here is what
 * the `folded_key` index does in the database, using the same function
 * `toStoredSeriesMetadata` stamps rows with.
 */
const foldedMetaRows = async (): Promise<Array<Record<string, unknown>>> =>
  Object.values(await getAllSeriesMetadata()).map((meta) => ({
    ...(meta as Record<string, unknown>),
    folded_key: normalizeVolumeTitleKey((meta as { series_title: string }).series_title)
  }));

vi.mock('$lib/metadata/store', () => ({
  getSeriesMetadataForTitle: (title: string) => getSeriesMetadataForTitle(title),
  getAllSeriesMetadata: () => getAllSeriesMetadata(),
  getSeriesMetadataByFoldedTitle: async (title: string) => {
    const key = normalizeVolumeTitleKey(title);
    if (!key) return [];
    return (await foldedMetaRows()).filter((row) => row.folded_key === key);
  },
  getSeriesMetadataByFoldedTitles: async (titles: Iterable<string>) => {
    const keys = new Set([...titles].map(normalizeVolumeTitleKey).filter(Boolean));
    return (await foldedMetaRows()).filter((row) => keys.has(row.folded_key as string));
  },
  upsertFromSeriesFile: (title: string, file: unknown) => upsertFromSeriesFile(title, file)
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

const catalogCache = vi.fn(async (): Promise<unknown> => undefined);
const dropCatalogEntries = vi.fn(async (_keys: string[]) => {});
const moveCatalogIndexKey = vi.fn(async (_old: string, _next: string) => {});
const putCatalogIndex = vi.fn(async (_rec: { file: { series: unknown[] } }) => {});
vi.mock('$lib/metadata/catalog-index', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/catalog-index')>(
    '$lib/metadata/catalog-index'
  );
  return {
    // The real size/mtime comparison decides whether the write re-reads first.
    catalogNeedsRefresh: actual.catalogNeedsRefresh,
    getCatalogIndex: () => catalogCache(),
    dropCatalogEntries: (keys: string[]) => dropCatalogEntries(keys),
    putCatalogIndex: (rec: { file: { series: unknown[] } }) => putCatalogIndex(rec),
    moveCatalogIndexKey: (o: string, n: string) => moveCatalogIndexKey(o, n)
  };
});

const refreshSeriesIndexes = vi.fn(async (_map: unknown, _providerType?: string) => {});
vi.mock('$lib/metadata/series-index-sync', () => ({
  refreshSeriesIndexes: (map: unknown, providerType: string) =>
    refreshSeriesIndexes(map, providerType)
}));

const refreshCatalogIndex = vi.fn(async (_map: unknown, _providerType?: string) => {});
vi.mock('$lib/metadata/catalog-index-sync', () => ({
  refreshCatalogIndex: (map: unknown, providerType: string) =>
    refreshCatalogIndex(map, providerType)
}));

const reconcileMissingMetadataFiles = vi.fn(async (_files?: unknown) => {});
const markListingFresh = vi.fn();
const scheduleSeriesFileWrite = vi.fn();
const scheduleCatalogFileWrite = vi.fn();
vi.mock('$lib/metadata/catalog-file-sync', () => ({
  scheduleCatalogFileWrite: () => scheduleCatalogFileWrite()
}));
vi.mock('$lib/metadata/series-file-sync', () => ({
  reconcileMissingMetadataFiles: (files?: unknown) => reconcileMissingMetadataFiles(files),
  markListingFresh: () => markListingFresh(),
  scheduleSeriesFileWrite: (title: string, options?: unknown) =>
    scheduleSeriesFileWrite(title, options)
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
    // The real WebDAV shape: a fileId and NO server mtime (a PUT response
    // carries none), so upload-time cache entries stay provisional.
    uploadFile: vi.fn(async () => ({ fileId: 'uploaded-fileid' })),
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

  it('a cross-series rename schedules series.json rewrites for BOTH folders and a catalog write', async () => {
    // The old folder keeps other volumes, so its series.json still lists the
    // moved one until rewritten; the new folder needs the arrival added.
    const cache = loadedCache();
    const provider = makeRenameProvider();
    const files = [
      ...oldSeriesFiles(),
      {
        provider: 'webdav',
        fileId: 'cbz-2',
        path: 'Old Series/Volume 2.cbz',
        modifiedTime: 't',
        size: 5
      }
    ];
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

    const scheduled = scheduleSeriesFileWrite.mock.calls.map((c) => c[0]);
    expect(scheduled).toContain('Old Series');
    expect(scheduled).toContain('New Series');
    expect(scheduleCatalogFileWrite).toHaveBeenCalled();
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

  it('refuses a rename onto a decomposed destination folder that is already occupied', async () => {
    // The case this gate exists for, on a normalizing backend: the caller names
    // the destination composed, the cloud spells it decomposed, and they are ONE
    // folder. Comparing the caller's spelling against the resolved destination
    // files can never match, so the rename would sail past the gate and its
    // .mokuro upload (an overwrite everywhere) would corrupt the occupant.
    const composedNew = 'ポケモン';
    const decomposedNew = composedNew.normalize('NFD');
    const cache = loadedCache();
    const provider = makeRenameProvider();
    const state: CloudFileMetadata[] = [
      ...oldSeriesFiles(),
      {
        provider: 'webdav',
        fileId: 'other-cbz',
        path: `${decomposedNew}/Volume X.cbz`,
        modifiedTime: 't',
        size: 999
      }
    ];
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => state.filter((f) => f.path.startsWith(`${s}/`)));
    getAllFiles.mockImplementation(() => state);
    getCache.mockReturnValue(cache);
    generateSidecars.mockResolvedValue({
      mokuro: { filename: 'Volume X.mokuro', blob: new Blob(['{}']) }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(
      unifiedCloudManager.renameVolume('Old Series', 'Volume 1', composedNew, 'Volume X', 'uuid-1')
    ).rejects.toMatchObject({ name: 'ProviderError', code: 'TARGET_EXISTS' });

    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(provider.renameFile).not.toHaveBeenCalled();
    expect(provider.deleteFile).not.toHaveBeenCalled();

    getAllFiles.mockReturnValue([]);
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

describe('metadata maintenance on delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a volume delete schedules a series.json rewrite and a catalog write', async () => {
    const provider = makeRenameProvider();
    const files = oldSeriesFiles();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(loadedCache());

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.deleteManagedVolume('Old Series', 'Volume 1');

    expect(scheduleSeriesFileWrite.mock.calls.map((c) => c[0])).toContain('Old Series');
    expect(scheduleCatalogFileWrite).toHaveBeenCalled();
  });

  it('a series delete schedules a catalog write', async () => {
    const provider = makeRenameProvider();
    const files = oldSeriesFiles();
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => files.filter((f) => f.path.startsWith(`${s}/`)));
    getCache.mockReturnValue(loadedCache());

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.deleteSeriesFolder('Old Series');

    expect(scheduleCatalogFileWrite).toHaveBeenCalled();
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
    // `vi.clearAllMocks()` clears calls, not queued return values: reset the
    // whole-table read here too, or one test's records leak into the next.
    getAllSeriesMetadata.mockResolvedValue({});
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

  it('a mid-run write still re-reads a FOREIGN stamp, so the other device’s volumes survive the PUT', async () => {
    // 2026-08-23 ruling, amending the earlier `skipRemoteRefresh` amendment: the
    // re-read is gated on the listing stamp differing from our cache, which is
    // exactly the case where another device wrote the file. Skipping it there —
    // the only case where it costs anything — is how a mid-run PUT clobbers that
    // device's series.json. Every SELF-write path is already download-free via
    // the stamp match (the two tests around this one), so the user's zero-read
    // intent holds without the option.
    const cache = loadedCache();
    const provider = makeRenameProvider({
      downloadFile: vi.fn(
        async () =>
          new Blob([
            seriesFileJson(
              [{ uuid: 'uuid-device-b', title: 'Volume 3' }],
              '2026-08-16T00:00:00.000Z'
            )
          ])
      )
    });
    const remoteFile = cloudFile('One Piece/series.json', { fileId: 'sj', size: 999 });
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    getBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 1.cbz'),
      cloudFile('One Piece/Volume 3.cbz'),
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
      'uuid-device-b'
    ]);
  });

  it('a run-scheduled write followed by the drain-time catch-all succeeds as a cheap, still-no-network union', async () => {
    // The two writers `series-file-sync.ts` and `backup-queue.ts`'s drain pass
    // both target the same series in short order (the debounced write races
    // the run, and `writeSeriesIndexesForRun` is a catch-all whether or not it
    // won). Neither may throw, and the second should not need a download
    // either — the first write already stamped the cache with exactly what it
    // uploaded.
    const cache = loadedCache();
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    getBySeries.mockReturnValue([cloudFile('One Piece/Volume 1.cbz')]);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);
    getSeriesIndex.mockResolvedValue(undefined);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');

    // The live per-completion write, mid-run. Nothing to re-read: the listing
    // shows no series.json yet, so the write costs no network read of its own.
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('written');
    expect(provider.downloadFile).not.toHaveBeenCalled();

    // `putSeriesIndex` is mocked (it doesn't actually persist), so wire the
    // read side to what the write just uploaded — standing in for the record
    // the real cache would now hold.
    const written = await uploadedSeriesFile(provider);
    getSeriesIndex.mockResolvedValue({
      series_key: 'one piece',
      series_title: 'One Piece',
      file: written,
      source: {
        provider: 'webdav',
        path: 'One Piece/series.json',
        size: 100,
        modifiedTime: '2026-08-17T00:00:00.000Z'
      },
      fetched_at: '2026-08-17T00:00:00.000Z'
    });
    getBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 1.cbz'),
      cloudFile('One Piece/series.json', { fileId: 'sj', size: 100 })
    ]);

    // The drain-time catch-all: full gates, no skip — but the stamp already
    // matches what we just wrote, so it is STILL a no-download union.
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('written');
    expect(provider.downloadFile).not.toHaveBeenCalled();
  });

  it('publishes the facts of an NFD folder’s composed series record', async () => {
    // The volumes filter folds, so the index came out full of volumes and empty
    // of facts: series.json unlinking the series while catalog.json (which does
    // fold its lookup) publishes it linked. The two must agree.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);

    const cache = loadedCache();
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    getBySeries.mockReturnValue([cloudFile(`${decomposed}/Volume 1.cbz`)]);
    localVolumes.mockResolvedValue([volume(composed, 'Volume 1')]);
    // The record is filed under the COMPOSED title, so the exact-key lookup —
    // which folds case and whitespace but not the unicode form — finds nothing.
    getAllSeriesMetadata.mockResolvedValue({
      [composed.toLowerCase()]: {
        series_key: composed.toLowerCase(),
        series_title: composed,
        external_ids: { anilist: 4242 },
        titles: {},
        synonyms: [],
        read_count: 0,
        updated_at: '2026-08-23T00:00:00.000Z',
        facts_updated_at: '2026-08-23T00:00:00.000Z'
      }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile(decomposed)).toBe('written');

    const file = await uploadedSeriesFile(provider);
    expect(file.external_ids).toEqual({ anilist: 4242 });
    expect(file.updated_at).toBe('2026-08-23T00:00:00.000Z');
  });

  it('writes under the LISTING’s folder spelling when the caller has the composed one', async () => {
    // The reconcile pass schedules with the folder name the listing shows (NFD),
    // but every LATER trigger — a fact edit, a per-completion schedule — carries
    // the local composed title. The cache is keyed by the folder name exactly,
    // so every one of those writes found no `.cbz`, returned 'skipped', and the
    // folder's facts never moved again once its series.json existed.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    const listing = [cloudFile(`${decomposed}/Volume 1.cbz`)];

    const cache = loadedCache();
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    // Faithful to the provider caches: an exact `<folder>/` prefix match.
    getBySeries.mockImplementation((series: string) =>
      listing.filter((file) => file.path.startsWith(`${series}/`))
    );
    getAllFiles.mockReturnValue(listing);
    localVolumes.mockResolvedValue([volume(composed, 'Volume 1')]);
    getAllSeriesMetadata.mockResolvedValue({
      [composed.toLowerCase()]: {
        series_key: composed.toLowerCase(),
        series_title: composed,
        external_ids: { anilist: 4242 },
        titles: {},
        synonyms: [],
        read_count: 0,
        updated_at: '2026-08-23T00:00:00.000Z',
        facts_updated_at: '2026-08-23T00:00:00.000Z'
      }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile(composed)).toBe('written');

    // The path IS the folder: written under the spelling the cloud actually has,
    // never a second folder that only differs in unicode form.
    expect(provider.uploadFile).toHaveBeenCalledWith(
      `${decomposed}/series.json`,
      expect.any(Blob),
      undefined,
      undefined
    );
    const file = await uploadedSeriesFile(provider);
    expect(file.series_title).toBe(decomposed);
    expect(file.external_ids).toEqual({ anilist: 4242 });
    expect(file.volumes).toHaveLength(1);
  });

  it('picks the same folder every time when two of them fold alike', async () => {
    // Two real folders on a case-sensitive backend can fold to one key. Neither
    // is "the" folder, but the answer must not depend on listing order — a write
    // that alternates between two folders publishes half an index to each.
    // One listing behind BOTH cache accessors, as the provider caches are.
    let listing = [cloudFile('ONE PIECE/Volume 1.cbz'), cloudFile('One  Piece/Volume 2.cbz')];
    getBySeries.mockImplementation((series: string) =>
      listing.filter((file) => file.path.startsWith(`${series}/`))
    );
    getAllFiles.mockImplementation(() => listing);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const first = unifiedCloudManager.resolveCloudFolderTitle('One Piece');
    listing = [...listing].reverse();
    const second = unifiedCloudManager.resolveCloudFolderTitle('One Piece');

    expect(first).toBe(second);
    expect(['ONE PIECE', 'One  Piece']).toContain(first);

    // An exact folder still wins outright over any folded candidate.
    listing = [...listing, cloudFile('One Piece/Volume 3.cbz')];
    expect(unifiedCloudManager.resolveCloudFolderTitle('One Piece')).toBe('One Piece');
  });

  it('reports the archives of a decomposed folder for a composed title', async () => {
    // The accessor the backup gate reads. Byte-wise it answers "nothing is
    // backed up" for a folder full of archives.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    const listing = [cloudFile(`${decomposed}/Volume 1.cbz`)];
    getBySeries.mockImplementation((series: string) =>
      listing.filter((file) => file.path.startsWith(`${series}/`))
    );
    getAllFiles.mockReturnValue(listing);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect([...unifiedCloudManager.cloudVolumeTitlesFor(composed)]).toEqual(['Volume 1']);
    // A series the cloud does not hold at all still reports nothing.
    expect(unifiedCloudManager.cloudVolumeTitlesFor('Berserk').size).toBe(0);
  });

  it('picks the record WITH facts when two spellings fold to one series', async () => {
    // A cloud upsert can file a record under the decomposed title while a local
    // import filed one under the composed one. Both fold to this folder, and
    // whichever comes first in the table is an accident of key order — the one
    // that says something has to win, or a write silently publishes an unlink.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');

    const factless = {
      series_key: decomposed.toLowerCase(),
      series_title: decomposed,
      external_ids: {},
      titles: {},
      synonyms: [],
      read_count: 0,
      updated_at: '2026-08-24T00:00:00.000Z'
    };
    const linked = {
      series_key: composed.toLowerCase(),
      series_title: composed,
      external_ids: { anilist: 4242 },
      titles: {},
      synonyms: [],
      read_count: 0,
      updated_at: '2026-08-20T00:00:00.000Z',
      facts_updated_at: '2026-08-20T00:00:00.000Z'
    };

    for (const records of [
      { a: factless, b: linked },
      { a: linked, b: factless }
    ]) {
      vi.clearAllMocks();
      const cache = loadedCache();
      const provider = makeRenameProvider();
      getActiveProvider.mockReturnValue(provider);
      getCache.mockReturnValue(cache);
      getBySeries.mockReturnValue([cloudFile(`${decomposed}/Volume 1.cbz`)]);
      localVolumes.mockResolvedValue([volume(composed, 'Volume 1')]);
      getSeriesMetadataForTitle.mockResolvedValue(undefined);
      getSeriesIndex.mockResolvedValue(undefined);
      getAllSeriesMetadata.mockResolvedValue({
        [records.a.series_key]: records.a,
        [records.b.series_key]: records.b
      });

      const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
      expect(await unifiedCloudManager.writeSeriesFile(decomposed)).toBe('written');

      const file = await uploadedSeriesFile(provider);
      // Never the factless record, however the table happens to be ordered — and
      // never its (newer) per-user stamp either.
      expect(file.external_ids).toEqual({ anilist: 4242 });
      expect(file.updated_at).toBe('2026-08-20T00:00:00.000Z');
    }
  });

  it('picks the newest facts clock when both spellings carry facts', async () => {
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');

    const cache = loadedCache();
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    getBySeries.mockReturnValue([cloudFile(`${decomposed}/Volume 1.cbz`)]);
    localVolumes.mockResolvedValue([volume(composed, 'Volume 1')]);
    getAllSeriesMetadata.mockResolvedValue({
      [decomposed.toLowerCase()]: {
        series_key: decomposed.toLowerCase(),
        series_title: decomposed,
        external_ids: { anilist: 1 },
        titles: {},
        synonyms: [],
        read_count: 0,
        updated_at: '2026-08-21T00:00:00.000Z',
        facts_updated_at: '2026-08-21T00:00:00.000Z'
      },
      [composed.toLowerCase()]: {
        series_key: composed.toLowerCase(),
        series_title: composed,
        external_ids: { anilist: 2 },
        titles: {},
        synonyms: [],
        read_count: 0,
        updated_at: '2026-08-22T00:00:00.000Z',
        facts_updated_at: '2026-08-22T00:00:00.000Z'
      }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile(decomposed)).toBe('written');

    const file = await uploadedSeriesFile(provider);
    expect(file.external_ids).toEqual({ anilist: 2 });
  });

  it('reads the local rows of an NFD folder name, whose rows are stored composed', async () => {
    // A folder name that made the round trip through a filesystem can come back
    // decomposed while the IndexedDB rows stay composed. Byte-wise, the filter
    // then matches nothing: the index is published with an empty volumes list
    // (or skipped outright), which is what left the reconcile pass scheduling
    // and dropping the same folder forever.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);

    const cache = loadedCache();
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    getCache.mockReturnValue(cache);
    getBySeries.mockReturnValue([cloudFile(`${decomposed}/Volume 1.cbz`)]);
    localVolumes.mockResolvedValue([volume(composed, 'Volume 1')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile(decomposed)).toBe('written');

    const file = await uploadedSeriesFile(provider);
    expect(file.volumes.map((v: { volume_uuid: string }) => v.volume_uuid)).toEqual([
      'uuid-Volume 1'
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

  // ---- Stamp provenance: upload-time cache entries vs published stamps ----
  //
  // `cloud-sidecar-stamps.ts` forbids client-clock stamps in `series.json`,
  // but `uploadFile` used to cache every upload with `new Date()` presented
  // as a real mtime — and a reconcile pass running off the live cache (the
  // backup buttons call `reconcileMissingMetadataFiles()` with NO listing)
  // published it. These tests drive the REAL uploadFile → cache → REAL
  // writeSeriesFile chain over a functional in-memory cache, exactly the
  // sequence the defect used.

  /** A functional cache: `add` stores entries and `getBySeries` serves them back. */
  function liveCacheStore(seed: CloudFileMetadata[]) {
    const store: CloudFileMetadata[] = [...seed];
    const cache = loadedCache({
      add: vi.fn((path: string, entry: object) => {
        // `cache.add` callers omit `provider`; a real cache serves entries
        // for its own provider, so default it without overriding one given.
        const next = { provider: 'webdav', ...entry } as CloudFileMetadata;
        const at = store.findIndex((f) => f.path === path);
        if (at >= 0) store[at] = next;
        else store.push(next);
      })
    });
    getCache.mockReturnValue(cache);
    getBySeries.mockImplementation(() => [...store]);
    return store;
  }

  it('a sidecar uploaded with NO server mtime is cached provisional and published STAMPLESS by a cache-driven write', async () => {
    const store = liveCacheStore([cloudFile('One Piece/Volume 1.cbz')]);
    const provider = makeRenameProvider(); // WebDAV shape: { fileId } only
    getActiveProvider.mockReturnValue(provider);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');

    // 1. The sidecar-backfill upload shape (`unifiedCloudManager.uploadFile`).
    await unifiedCloudManager.uploadFile('One Piece/Volume 1.mokuro', new Blob(['x']));

    // The cache entry is a client-clock fallback — and says so.
    const cached = store.find((f) => f.path === 'One Piece/Volume 1.mokuro');
    expect(cached?.modifiedTimeProvisional).toBe(true);
    expect(typeof cached?.modifiedTime).toBe('string');

    // 2. The reconcile-triggered write with NO fresh listing in between:
    //    `writeSeriesFile` derives its stamps from the SAME live cache.
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('written');
    const file = await uploadedSeriesFile(provider);
    expect(file.volumes).toHaveLength(1);
    // Positive control: the entry itself published (real local facts)…
    expect(file.volumes[0]).toMatchObject({ volume_uuid: 'uuid-Volume 1', page_count: 2 });
    // …but carries NO stamp for the provisionally-cached sidecar — neither
    // the fabricated client mtime nor a size to go with it.
    expect(file.volumes[0].mokuro_modified).toBeUndefined();
    expect(file.volumes[0].mokuro_size).toBeUndefined();
  });

  it('the stamp publishes once the next real listing replaces the provisional entry with the server record', async () => {
    // The convergence leg: a full `fetch()` rebuilds the cache from the
    // listing, so the sidecar's entry now carries the SERVER mtime and no
    // provisional flag. The very next cache-driven write publishes the stamp.
    liveCacheStore([
      cloudFile('One Piece/Volume 1.cbz'),
      cloudFile('One Piece/Volume 1.mokuro', {
        modifiedTime: '2026-08-27T08:30:00.000Z',
        size: 7
      })
    ]);
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('written');
    const file = await uploadedSeriesFile(provider);
    expect(file.volumes[0].mokuro_modified).toBe(
      Math.floor(Date.parse('2026-08-27T08:30:00.000Z') / 1000)
    );
    expect(file.volumes[0].mokuro_size).toBe(7);
  });

  it('a provider whose upload response carries the server mtime gets a REAL stamp published with no listing in between', async () => {
    const store = liveCacheStore([cloudFile('One Piece/Volume 1.cbz')]);
    // Drive/OneDrive/MEGA/filesystem shape: the upload response reports the
    // server's own mtime (and size).
    const provider = makeRenameProvider({
      uploadFile: vi.fn(async () => ({
        fileId: 'up-2',
        modifiedTime: '2026-08-27T09:00:00.000Z',
        size: 5
      }))
    });
    getActiveProvider.mockReturnValue(provider);
    localVolumes.mockResolvedValue([volume('One Piece', 'Volume 1')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.uploadFile('One Piece/Volume 1.mokuro', new Blob(['x']));

    // The cache entry carries the SERVER's time — not the client clock — and
    // is therefore not provisional. Explicitly `false`, not merely absent:
    // `add()`'s metadata type requires the caller to say so (see
    // `CacheAddMetadata` in `cloud-cache-interface.ts`).
    const cached = store.find((f) => f.path === 'One Piece/Volume 1.mokuro');
    expect(cached?.modifiedTime).toBe('2026-08-27T09:00:00.000Z');
    expect(cached?.modifiedTimeProvisional).toBe(false);
    expect(cached?.size).toBe(5);

    expect(await unifiedCloudManager.writeSeriesFile('One Piece')).toBe('written');
    const file = await uploadedSeriesFile(provider);
    expect(file.volumes[0].mokuro_modified).toBe(
      Math.floor(Date.parse('2026-08-27T09:00:00.000Z') / 1000)
    );
    expect(file.volumes[0].mokuro_size).toBe(5);
  });
});

describe('UnifiedCloudManager series.json on rename and delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localVolumes.mockResolvedValue([]);
    getSeriesMetadataForTitle.mockResolvedValue(undefined);
    // `vi.clearAllMocks()` clears calls, not queued return values: reset the
    // whole-table read here too, or one test's records leak into the next.
    getAllSeriesMetadata.mockResolvedValue({});
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

  it('cleans a decomposed folder’s sidecar and index when its last volume goes', async () => {
    // `deleteManagedVolume` is called with the LOCAL title. Byte-wise it finds
    // no files in a decomposed folder at all: nothing is deleted, and the
    // sidecar plus its cached record outlive the volumes they describe.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    const provider = makeRenameProvider();
    const state: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: `${decomposed}/Volume 1.cbz`,
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'sj',
        path: `${decomposed}/series.json`,
        modifiedTime: 't',
        size: 20
      }
    ];
    getActiveProvider.mockReturnValue(provider);
    mutableCache(state);
    getAllFiles.mockImplementation(() => state);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.deleteManagedVolume(composed, 'Volume 1');

    const deleted = provider.deleteFile.mock.calls.map(
      (args: unknown[]) => (args[0] as CloudFileMetadata).path
    );
    expect(deleted).toContain(`${decomposed}/Volume 1.cbz`);
    expect(deleted).toContain(`${decomposed}/series.json`);
    expect(deleteSeriesIndex).toHaveBeenCalledWith(decomposed.toLowerCase());
  });

  it('deletes a volume whose FILENAME is decomposed, like its folder', async () => {
    // A backend that decomposes names decomposes the filenames too — the very
    // premise this wave folds on everywhere else. Byte-wise the managed-file
    // lookup matches nothing, so the delete is a silent no-op the UI reports as
    // success, and the sidecar clean-up never runs.
    const composedSeries = 'ポケモン';
    const composedVolume = 'ポケモン 1';
    const folder = composedSeries.normalize('NFD');
    const filename = composedVolume.normalize('NFD');
    expect(filename).not.toBe(composedVolume);

    const provider = makeRenameProvider();
    const state: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: `${folder}/${filename}.cbz`,
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'mok-1',
        path: `${folder}/${filename}.mokuro`,
        modifiedTime: 't',
        size: 10
      },
      {
        provider: 'webdav',
        fileId: 'sj',
        path: `${folder}/series.json`,
        modifiedTime: 't',
        size: 20
      }
    ];
    getActiveProvider.mockReturnValue(provider);
    mutableCache(state);
    getAllFiles.mockImplementation(() => state);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.deleteManagedVolume(composedSeries, composedVolume);

    const deleted = provider.deleteFile.mock.calls.map(
      (args: unknown[]) => (args[0] as CloudFileMetadata).path
    );
    expect(deleted).toContain(`${folder}/${filename}.cbz`);
    expect(deleted).toContain(`${folder}/${filename}.mokuro`);
    // …and with the last archive gone, the folder's sidecar goes with it.
    expect(deleted).toContain(`${folder}/series.json`);
    expect(deleteSeriesIndex).toHaveBeenCalledWith(folder.toLowerCase());
  });

  it('never widens a delete past the file that is spelled exactly right', async () => {
    // The folded match is a FALLBACK. With a byte-exact filename present, that
    // is the volume being deleted — a sibling that merely folds the same way is
    // somebody else's backup.
    const provider = makeRenameProvider();
    const state: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'exact',
        path: 'One Piece/Vol 1.cbz',
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'folds-alike',
        path: 'One Piece/VOL  1.cbz',
        modifiedTime: 't',
        size: 100
      }
    ];
    getActiveProvider.mockReturnValue(provider);
    mutableCache(state);
    getAllFiles.mockImplementation(() => state);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.deleteManagedVolume('One Piece', 'Vol 1');

    const deleted = provider.deleteFile.mock.calls.map(
      (args: unknown[]) => (args[0] as CloudFileMetadata).path
    );
    expect(deleted).toEqual(['One Piece/Vol 1.cbz']);
  });

  it('drops the cached index of a decomposed folder deleted whole', async () => {
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
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
        path: `${decomposed}/Volume 1.cbz`,
        modifiedTime: 't',
        size: 100
      },
      {
        provider: 'webdav',
        fileId: 'sj',
        path: `${decomposed}/series.json`,
        modifiedTime: 't',
        size: 20
      }
    ];
    getActiveProvider.mockReturnValue(provider);
    getBySeries.mockImplementation((s: string) => state.filter((f) => f.path.startsWith(`${s}/`)));
    getAllFiles.mockImplementation(() => state);
    getCache.mockReturnValue(loadedCache());

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.deleteSeriesFolder(composed);

    expect(deleted).toContain(`${decomposed}/series.json`);
    // Keyed by the folder, which is where every writer here cached it.
    expect(deleteSeriesIndex).toHaveBeenCalledWith(decomposed.toLowerCase());
    expect(dropCatalogEntries).toHaveBeenCalledWith([decomposed.toLowerCase()]);
  });

  it('retires the stale sidecar of a decomposed folder after a rename', async () => {
    const composedOld = 'ポケモン';
    const oldFolder = composedOld.normalize('NFD');
    const provider = makeRenameProvider();
    const sidecar: CloudFileMetadata = {
      provider: 'webdav',
      fileId: 'sj',
      path: `${oldFolder}/series.json`,
      modifiedTime: 't',
      size: 20
    };
    const state: CloudFileMetadata[] = [
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: `${oldFolder}/Volume 1.cbz`,
        modifiedTime: 't',
        size: 100
      },
      sidecar
    ];
    getActiveProvider.mockReturnValue(provider);
    mutableCache(state);
    getAllFiles.mockImplementation(() => state);
    generateSidecars.mockResolvedValue({});
    // The DB still holds the OLD title, in the composed spelling it was imported with.
    localVolumes.mockResolvedValue([
      {
        volume_uuid: 'uuid-1',
        series_uuid: 's',
        series_title: composedOld,
        volume_title: 'Volume 1',
        mokuro_version: '0.4.11',
        page_count: 1,
        character_count: 1,
        page_char_counts: [1]
      }
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.renameSeries(composedOld, 'New Series', [
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
    // `vi.clearAllMocks()` clears calls, not queued return values: reset the
    // whole-table read here too, or one test's records leak into the next.
    getAllSeriesMetadata.mockResolvedValue({});
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

    // The root catalog rides the SAME listing — one listing, both refreshes.
    expect(refreshCatalogIndex).toHaveBeenCalledTimes(1);
    expect(refreshCatalogIndex.mock.calls[0][0]).toBe(listing);
    expect(refreshCatalogIndex.mock.calls[0][1]).toBe('webdav');
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
    expect(refreshCatalogIndex).not.toHaveBeenCalled();
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
    expect(refreshCatalogIndex).not.toHaveBeenCalled();
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
   * The cached catalog copy, holding a factless entry per named series, as the
   * last fetch left it. `sourceOverrides` is how a test makes the cache look
   * STALE against the listing, which is what sends the write down the re-read
   * path.
   */
  function cachedCatalog(seriesTitles: string[], sourceOverrides: Record<string, unknown> = {}) {
    return {
      id: 'catalog',
      file: {
        version: 1,
        updated_at: '2026-08-22T00:00:00.000Z',
        series: seriesTitles.map((series_title) => ({
          series_title,
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        }))
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
    catalogCache.mockResolvedValue(undefined);
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
    const cached = putCatalogIndex.mock.calls.at(-1)![0] as {
      file: { series: Array<{ series_title: string }> };
    };
    expect(cached.file.series.map((e) => e.series_title)).toEqual(['Dr Stone', 'Other']);
  });

  it('gives an NFD folder the facts of its composed series record', async () => {
    // Same fold as the series index: the folder name comes off a filesystem and
    // may be decomposed, while `series_metadata` is keyed off the composed local
    // title. A byte-wise lookup misses, and the series lands in the catalog as a
    // factless epoch entry — its links dropped for every device that reads it.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);

    getActiveProvider.mockReturnValue(provider());
    getAllFiles.mockReturnValue([
      {
        provider: 'webdav',
        fileId: 'nfd',
        path: `${decomposed}/Volume 1.cbz`,
        size: 10,
        modifiedTime: '2026-08-23T00:00:00.000Z'
      }
    ]);
    getAllSeriesMetadata.mockResolvedValue({
      [composed.toLowerCase()]: {
        series_key: composed.toLowerCase(),
        series_title: composed,
        external_ids: { anilist: 4242 },
        titles: {},
        synonyms: [],
        read_count: 0,
        updated_at: '2026-08-23T00:00:00.000Z',
        facts_updated_at: '2026-08-23T00:00:00.000Z'
      }
    });

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('written');

    const [, blob] = uploadFile.mock.calls.at(-1)!;
    const written = JSON.parse(await (blob as Blob).text());
    // The FOLDER name is what gets published (never derived), carrying the facts
    // of the record filed under the composed spelling.
    expect(written.series).toHaveLength(1);
    expect(written.series[0].series_title).toBe(decomposed);
    expect(written.series[0].external_ids).toEqual({ anilist: 4242 });
    expect(written.series[0].updated_at).toBe('2026-08-23T00:00:00.000Z');
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
    let stored: Record<string, unknown> | undefined;
    catalogCache.mockImplementation(async () => stored);
    putCatalogIndex.mockImplementation(async (rec: unknown) => {
      stored = { id: 'catalog', ...(rec as Record<string, unknown>) };
    });

    try {
      const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');

      await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('skipped');
      expect(p.downloadFile).toHaveBeenCalledTimes(1);
      expect(
        (stored as { file: { series: Array<{ series_title: string }> } }).file.series.map(
          (e) => e.series_title
        )
      ).toEqual(['Dr Stone', 'Other']);

      await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('skipped');
      expect(p.downloadFile).toHaveBeenCalledTimes(1);
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      putCatalogIndex.mockImplementation(async () => {});
    }
  });

  it('still publishes when the cloud has no catalog.json, however well the cache matches', async () => {
    // `existing` comes from the CACHE here, and matching the cache says nothing
    // about a cloud that has no such file at all.
    getActiveProvider.mockReturnValue(provider());
    getAllFiles.mockReturnValue(listing.filter((f) => f.path !== 'catalog.json'));
    catalogCache.mockResolvedValue(cachedCatalog(['Dr Stone', 'Other']));

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
    catalogCache.mockResolvedValue(cachedCatalog(['Dr Stone', 'Other'], stale));

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.writeCatalogFile()).resolves.toBe('written');
    expect(uploadFile).toHaveBeenCalled();
  });

  it('re-stamps the cache with the published copy, dropping a series that left', async () => {
    getActiveProvider.mockReturnValue(provider());
    catalogCache.mockResolvedValue(cachedCatalog(['Gone']));
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.writeCatalogFile();

    const stamped = putCatalogIndex.mock.calls.at(-1)![0] as {
      file: { series: Array<{ series_title: string }> };
      source: { provider: string };
    };
    expect(stamped.source.provider).toBe('webdav');
    // 'Gone' has no folder in the listing, so the published copy — and with it
    // the cache — no longer mentions it.
    expect(stamped.file.series.map((e) => e.series_title)).not.toContain('Gone');
  });
});

describe('UnifiedCloudManager.refreshSeriesIndexForSeries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localVolumes.mockResolvedValue([]);
    getSeriesIndex.mockResolvedValue(undefined);
    getAllFiles.mockReturnValue([]);
  });

  const SERIES_JSON = {
    version: 2,
    series_title: 'One Piece',
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at: '2026-08-18T00:00:00.000Z',
    volumes: [
      {
        volume_uuid: 'uuid-1',
        volume_title: 'Volume 1',
        page_count: 200,
        character_count: 5000,
        mokuro_version: '0.4.11'
      }
    ]
  };

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

  /** A series folder holding one archive and its sidecar. */
  function listSeriesFolder(
    files: CloudFileMetadata[] = [
      cloudFile('One Piece/Volume 1.cbz', { fileId: 'cbz-1' }),
      cloudFile('One Piece/series.json', { fileId: 'sj' })
    ]
  ) {
    getBySeries.mockImplementation((series: string) =>
      files.filter((f) => f.path.startsWith(`${series}/`))
    );
    return files;
  }

  /** The cached record matching the listing stamp exactly. */
  function cachedRecord(overrides: Record<string, unknown> = {}) {
    return {
      series_key: 'one piece',
      series_title: 'One Piece',
      file: { ...SERIES_JSON, updated_at: '2026-01-01T00:00:00.000Z' },
      source: {
        provider: 'webdav',
        path: 'One Piece/series.json',
        size: 100,
        modifiedTime: '2026-08-17T00:00:00.000Z'
      },
      fetched_at: '2026-08-17T01:00:00.000Z',
      ...overrides
    };
  }

  it('does not download when the cloud stamp matches the cache', async () => {
    const provider = makeRenameProvider();
    getActiveProvider.mockReturnValue(provider);
    listSeriesFolder();
    const cached = cachedRecord();
    getSeriesIndex.mockResolvedValue(cached);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const result = await unifiedCloudManager.refreshSeriesIndexForSeries('One Piece');

    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(putSeriesIndex).not.toHaveBeenCalled();
    expect(upsertFromSeriesFile).not.toHaveBeenCalled();
    // The freshest copy this device has is still returned, so the caller can
    // materialize from it without a round trip.
    expect(result).toBe(cached.file);
  });

  it('downloads, caches and applies the facts when the stamp moved', async () => {
    const provider = makeRenameProvider({
      downloadFile: vi.fn(async () => new Blob([JSON.stringify(SERIES_JSON)]))
    });
    getActiveProvider.mockReturnValue(provider);
    listSeriesFolder();
    getSeriesIndex.mockResolvedValue(
      cachedRecord({ source: { ...cachedRecord().source, size: 42 } })
    );

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const result = await unifiedCloudManager.refreshSeriesIndexForSeries('One Piece');

    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    expect(result?.volumes).toEqual(SERIES_JSON.volumes);
    expect(putSeriesIndex).toHaveBeenCalledTimes(1);
    expect(putSeriesIndex.mock.calls[0][0]).toMatchObject({
      series_key: 'one piece',
      series_title: 'One Piece',
      source: {
        provider: 'webdav',
        path: 'One Piece/series.json',
        size: 100,
        modifiedTime: '2026-08-17T00:00:00.000Z'
      }
    });
    expect(upsertFromSeriesFile).toHaveBeenCalledWith('One Piece', result);
  });

  it('caches a decomposed folder’s index ONCE, under the folder’s own key', async () => {
    // The view opens the series by its local (composed) title while the cloud
    // folder is decomposed. Reading the gate through the resolver but keying the
    // record with the caller's spelling leaves TWO records for one folder — and
    // the listing-driven pass keeps rewriting the other one.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    const seriesJson = { ...SERIES_JSON, series_title: decomposed };
    const provider = makeRenameProvider({
      downloadFile: vi.fn(async () => new Blob([JSON.stringify(seriesJson)]))
    });
    getActiveProvider.mockReturnValue(provider);
    const files = [
      cloudFile(`${decomposed}/Volume 1.cbz`, { fileId: 'cbz-1' }),
      cloudFile(`${decomposed}/series.json`, { fileId: 'sj' })
    ];
    listSeriesFolder(files);
    getAllFiles.mockReturnValue(files);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const result = await unifiedCloudManager.refreshSeriesIndexForSeries(composed);

    expect(result?.volumes).toEqual(SERIES_JSON.volumes);
    // Read AND written under the folder key: one record per cloud folder.
    expect(getSeriesIndex).toHaveBeenCalledWith(decomposed.toLowerCase());
    expect(getSeriesIndex).not.toHaveBeenCalledWith(composed.toLowerCase());
    expect(putSeriesIndex).toHaveBeenCalledTimes(1);
    expect(putSeriesIndex.mock.calls[0][0]).toMatchObject({
      series_key: decomposed.toLowerCase(),
      series_title: decomposed,
      source: { path: `${decomposed}/series.json` }
    });
    // …and the facts land on the folder's series, not a second one named the
    // same in another unicode form.
    expect(upsertFromSeriesFile).toHaveBeenCalledWith(decomposed, result);
  });

  it('re-fetches when the cached stamp came from another provider', async () => {
    // Same size and mtime, different provider — the cached source never saw
    // THIS provider's copy, so it says nothing about it.
    const provider = makeRenameProvider({
      downloadFile: vi.fn(async () => new Blob([JSON.stringify(SERIES_JSON)]))
    });
    getActiveProvider.mockReturnValue(provider);
    listSeriesFolder();
    getSeriesIndex.mockResolvedValue(
      cachedRecord({ source: { ...cachedRecord().source, provider: 'gdrive' } })
    );

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await unifiedCloudManager.refreshSeriesIndexForSeries('One Piece');

    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    expect(putSeriesIndex).toHaveBeenCalledTimes(1);
  });

  it('resolves with the cached copy when the download throws', async () => {
    const provider = makeRenameProvider({
      downloadFile: vi.fn(async () => {
        throw new Error('offline');
      })
    });
    getActiveProvider.mockReturnValue(provider);
    listSeriesFolder();
    const cached = cachedRecord({ source: { ...cachedRecord().source, size: 42 } });
    getSeriesIndex.mockResolvedValue(cached);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    await expect(unifiedCloudManager.refreshSeriesIndexForSeries('One Piece')).resolves.toBe(
      cached.file
    );
    expect(putSeriesIndex).not.toHaveBeenCalled();
  });

  it('ignores an orphan series.json in a folder with no archive', async () => {
    // Same contract as the listing-wide pass: a sidecar whose volumes are gone
    // must not seed an index or a series_metadata row, and must not be
    // re-downloaded on every open.
    const provider = makeRenameProvider({
      downloadFile: vi.fn(async () => new Blob([JSON.stringify(SERIES_JSON)]))
    });
    getActiveProvider.mockReturnValue(provider);
    listSeriesFolder([cloudFile('One Piece/series.json', { fileId: 'sj' })]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const result = await unifiedCloudManager.refreshSeriesIndexForSeries('One Piece');

    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(putSeriesIndex).not.toHaveBeenCalled();
    expect(upsertFromSeriesFile).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('cloudVolumeTitlesFor lists the .cbz titles of the folder', async () => {
    getActiveProvider.mockReturnValue(makeRenameProvider());
    listSeriesFolder([
      cloudFile('One Piece/Volume 1.cbz'),
      cloudFile('One Piece/Volume 2.cbz'),
      cloudFile('One Piece/Volume 1.mokuro'),
      cloudFile('One Piece/series.json')
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(unifiedCloudManager.cloudVolumeTitlesFor('One Piece')).toEqual(
      new Set(['Volume 1', 'Volume 2'])
    );
  });
});

describe('UnifiedCloudManager.refreshSeriesIndexesInBackground', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllFiles.mockReturnValue([]);
  });

  function cloudFile(path: string): CloudFileMetadata {
    return {
      provider: 'webdav',
      fileId: path,
      path,
      modifiedTime: '2026-08-17T00:00:00.000Z',
      size: 100
    };
  }

  it('backfills the missing metadata files from the listing it just read', async () => {
    getActiveProvider.mockReturnValue(makeRenameProvider());
    const files = [cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/Volume 1.mokuro')];
    getAllFiles.mockReturnValue(files);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    unifiedCloudManager.refreshSeriesIndexesInBackground();

    // The same listing the index refreshes ride, not a second fetch.
    expect(reconcileMissingMetadataFiles).toHaveBeenCalledTimes(1);
    expect(reconcileMissingMetadataFiles).toHaveBeenCalledWith(files);
  });

  it('stamps the listing it just read so the backfill does not refetch it', async () => {
    getActiveProvider.mockReturnValue(makeRenameProvider());
    getAllFiles.mockReturnValue([cloudFile('One Piece/Volume 1.cbz')]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    unifiedCloudManager.refreshSeriesIndexesInBackground();

    // Without the stamp the debounced write opens 2 s later with a second
    // whole-account fetch of the listing that is already in hand.
    expect(markListingFresh).toHaveBeenCalledTimes(1);
  });

  it('does not backfill without a provider or without a listing', async () => {
    getActiveProvider.mockReturnValue(null);
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    unifiedCloudManager.refreshSeriesIndexesInBackground();
    expect(reconcileMissingMetadataFiles).not.toHaveBeenCalled();

    getActiveProvider.mockReturnValue(makeRenameProvider());
    getAllFiles.mockReturnValue([]);
    unifiedCloudManager.refreshSeriesIndexesInBackground();
    expect(reconcileMissingMetadataFiles).not.toHaveBeenCalled();
  });

  it('survives a backfill that throws — the index refresh is fire-and-forget', async () => {
    getActiveProvider.mockReturnValue(makeRenameProvider());
    getAllFiles.mockReturnValue([cloudFile('One Piece/Volume 1.cbz')]);
    reconcileMissingMetadataFiles.mockRejectedValueOnce(new Error('boom'));

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    expect(() => unifiedCloudManager.refreshSeriesIndexesInBackground()).not.toThrow();
  });
});

describe('blindUploadFile — the write-and-forget upload', () => {
  function loadedCacheWithAdd() {
    const added: Array<{ path: string; entry: Record<string, unknown> }> = [];
    getCache.mockReturnValue({
      isLoaded: () => true,
      add: vi.fn((path: string, entry: Record<string, unknown>) => added.push({ path, entry }))
    });
    return added;
  }

  it('routes through the provider blindUploadFile when it has one, with the same targeted cache add', async () => {
    const added = loadedCacheWithAdd();
    const provider = {
      type: 'google-drive',
      uploadFile: vi.fn(async () => {
        throw new Error('blind path must not use the refetching uploadFile');
      }),
      blindUploadFile: vi.fn(async () => ({
        fileId: 'blind-1',
        modifiedTime: '2026-08-27T00:00:00.000Z',
        size: 7
      }))
    };
    getActiveProvider.mockReturnValue(provider);
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');

    const fileId = await unifiedCloudManager.blindUploadFile('S/V.mokuro', new Blob(['x']));

    expect(fileId).toBe('blind-1');
    expect(provider.blindUploadFile).toHaveBeenCalledTimes(1);
    expect(provider.uploadFile).not.toHaveBeenCalled();
    // The SAME provenance-correct cache entry an ordinary upload earns: the
    // server mtime from the upload response, not provisional.
    expect(added).toHaveLength(1);
    expect(added[0].path).toBe('S/V.mokuro');
    expect(added[0].entry).toMatchObject({
      fileId: 'blind-1',
      modifiedTime: '2026-08-27T00:00:00.000Z',
      modifiedTimeProvisional: false,
      size: 7
    });
  });

  it('falls back to the ordinary uploadFile for a provider without a blind variant — it is already blind', async () => {
    const added = loadedCacheWithAdd();
    const provider = {
      type: 'webdav',
      uploadFile: vi.fn(async () => ({ fileId: 'plain-1' }))
    };
    getActiveProvider.mockReturnValue(provider);
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');

    const fileId = await unifiedCloudManager.blindUploadFile('S/V.webp', new Blob(['xy']));

    expect(fileId).toBe('plain-1');
    expect(provider.uploadFile).toHaveBeenCalledTimes(1);
    // No server mtime in the response: the entry is the provisional
    // client-clock fallback, exactly as with an ordinary upload.
    expect(added[0].entry).toMatchObject({ fileId: 'plain-1', modifiedTimeProvisional: true });
    expect(added[0].entry.size).toBe(2);
  });

  it('the ordinary uploadFile never takes the blind provider path', async () => {
    loadedCacheWithAdd();
    const provider = {
      type: 'google-drive',
      uploadFile: vi.fn(async () => ({ fileId: 'legacy-1' })),
      blindUploadFile: vi.fn(async () => ({ fileId: 'wrong' }))
    };
    getActiveProvider.mockReturnValue(provider);
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');

    const fileId = await unifiedCloudManager.uploadFile('S/V.cbz', new Blob(['x']));

    expect(fileId).toBe('legacy-1');
    expect(provider.blindUploadFile).not.toHaveBeenCalled();
  });
});

describe('UnifiedCloudManager.previewSeriesFileBuild (the heal preview)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localVolumes.mockResolvedValue([]);
    getSeriesMetadataForTitle.mockResolvedValue(undefined);
    getAllSeriesMetadata.mockResolvedValue({});
    getSeriesIndex.mockResolvedValue(undefined);
  });

  function previewProvider(overrides: Record<string, unknown> = {}) {
    return {
      type: 'webdav',
      getStatus: vi.fn(() => ({ isReadOnly: false })),
      downloadFile: vi.fn(async () => new Blob(['{}'])),
      ...overrides
    };
  }

  function file(path: string, size = 100): CloudFileMetadata {
    return {
      provider: 'webdav',
      fileId: path,
      path,
      modifiedTime: '2026-08-17T00:00:00.000Z',
      size
    };
  }

  const publishedWithZeroVol2 = {
    version: 2 as const,
    series_title: 'One Piece',
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at: '2026-08-17T00:00:00.000Z',
    volumes: [
      {
        volume_uuid: 'mokuro-uuid-1',
        volume_title: 'Vol 1',
        page_count: 180,
        character_count: 12000,
        mokuro_version: '0.4.11'
      },
      {
        volume_uuid: 'derived-uuid-2',
        volume_title: 'Vol 2',
        page_count: 0,
        character_count: 0,
        mokuro_version: '',
        archive_size: 4444
      }
    ]
  };

  it('runs the REAL shared assembly: installed rows supersede the published 0/0 entry, stamped from the listing, keys folded', async () => {
    getActiveProvider.mockReturnValue(previewProvider());
    getCache.mockReturnValue({ isLoaded: () => true });
    getBySeries.mockReturnValue([
      file('One Piece/Vol 1.cbz'),
      file('One Piece/Vol 2.cbz'),
      file('One Piece/Vol 2.mokuro', 321)
    ]);
    localVolumes.mockResolvedValue([
      {
        volume_uuid: 'mokuro-uuid-2',
        series_uuid: 'series-uuid',
        series_title: 'One Piece',
        volume_title: 'Vol 2',
        mokuro_version: '0.4.11',
        page_count: 90,
        character_count: 9000,
        page_char_counts: []
      }
    ]);

    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const preview = await unifiedCloudManager.previewSeriesFileBuild(
      'One Piece',
      publishedWithZeroVol2
    );

    const vol2 = preview!.built!.volumes.find((v) => v.volume_title === 'Vol 2')!;
    expect(vol2.volume_uuid).toBe('mokuro-uuid-2'); // measured row replaced the derived-uuid 0/0
    expect(vol2.page_count).toBe(90);
    expect(vol2.character_count).toBe(9000);
    expect(vol2.archive_size).toBe(4444); // inherited from the entry it displaced
    expect(vol2.mokuro_size).toBe(321); // stamped from the CURRENT listing, never invented
    // Vol 1's foreign measured entry rides through untouched.
    expect(preview!.built!.volumes.find((v) => v.volume_title === 'Vol 1')).toEqual(
      publishedWithZeroVol2.volumes[0]
    );
    expect(preview!.cloudTitleKeys).toEqual(
      new Set([normalizeVolumeTitleKey('Vol 1'), normalizeVolumeTitleKey('Vol 2')])
    );
  });

  it('returns undefined behind every write gate: read-only provider, unloaded cache, archiveless folder', async () => {
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');

    getActiveProvider.mockReturnValue(
      previewProvider({ getStatus: vi.fn(() => ({ isReadOnly: true })) })
    );
    getCache.mockReturnValue({ isLoaded: () => true });
    getBySeries.mockReturnValue([file('One Piece/Vol 1.cbz')]);
    await expect(
      unifiedCloudManager.previewSeriesFileBuild('One Piece', publishedWithZeroVol2)
    ).resolves.toBeUndefined();

    getActiveProvider.mockReturnValue(previewProvider());
    getCache.mockReturnValue({ isLoaded: () => false });
    await expect(
      unifiedCloudManager.previewSeriesFileBuild('One Piece', publishedWithZeroVol2)
    ).resolves.toBeUndefined();

    getCache.mockReturnValue({ isLoaded: () => true });
    getBySeries.mockReturnValue([]);
    await expect(
      unifiedCloudManager.previewSeriesFileBuild('One Piece', publishedWithZeroVol2)
    ).resolves.toBeUndefined();
  });
});

describe('the raw-doubles flag on cached records (raw_entry_collapse)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localVolumes.mockResolvedValue([]);
    getSeriesMetadataForTitle.mockResolvedValue(undefined);
    getAllSeriesMetadata.mockResolvedValue({});
    getSeriesIndex.mockResolvedValue(undefined);
  });

  function file(path: string, size = 100): CloudFileMetadata {
    return {
      provider: 'webdav',
      fileId: path,
      path,
      modifiedTime: '2026-08-17T00:00:00.000Z',
      size
    };
  }

  function cloudSeriesJson(volumes: unknown[]): string {
    return JSON.stringify({
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-08-17T00:00:00.000Z',
      volumes
    });
  }

  const realEntry = {
    volume_uuid: 'mokuro-uuid-1',
    volume_title: 'Vol 1',
    page_count: 180,
    character_count: 12000,
    mokuro_version: '0.4.11'
  };
  const doubledEntry = {
    volume_uuid: 'derived-uuid-1',
    volume_title: 'Vol 1',
    page_count: 0,
    character_count: 0,
    mokuro_version: ''
  };

  async function refreshWith(body: string) {
    getActiveProvider.mockReturnValue({
      type: 'webdav',
      getStatus: vi.fn(() => ({ isReadOnly: false })),
      downloadFile: vi.fn(async () => new Blob([body]))
    });
    getBySeries.mockReturnValue([file('One Piece/Vol 1.cbz'), file('One Piece/series.json', 50)]);
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    return unifiedCloudManager.refreshSeriesIndexForSeries('One Piece');
  }

  it('a RAW cloud copy holding the same volume twice caches a healed file WITH the flag', async () => {
    const fresh = await refreshWith(cloudSeriesJson([doubledEntry, realEntry]));

    expect(fresh?.volumes).toHaveLength(1); // healed view for every reader
    expect(putSeriesIndex).toHaveBeenCalledTimes(1);
    expect(putSeriesIndex.mock.calls[0][0]).toMatchObject({ raw_entry_collapse: true });
  });

  it('a clean cloud copy caches no flag at all', async () => {
    await refreshWith(cloudSeriesJson([realEntry]));

    expect(putSeriesIndex).toHaveBeenCalledTimes(1);
    expect(putSeriesIndex.mock.calls[0][0]).not.toHaveProperty('raw_entry_collapse');
  });
});
