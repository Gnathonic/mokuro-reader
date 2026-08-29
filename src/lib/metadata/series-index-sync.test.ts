import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';
import type { SeriesIndexRecord } from './series-index';

const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { getActiveProvider }
}));

// The table itself is exercised in series-index.test.ts; here only the calls matter.
vi.mock('$lib/catalog/db', () => ({ db: {} }));

const listSeriesIndexes = vi.fn(async (): Promise<SeriesIndexRecord[]> => []);
const putSeriesIndexes = vi.fn(async (_recs: SeriesIndexRecord[]) => {});
const deleteSeriesIndex = vi.fn(async (_key: string) => {});
vi.mock('$lib/metadata/series-index', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/series-index')>(
    '$lib/metadata/series-index'
  );
  return {
    // The real size/mtime comparison decides what gets re-downloaded.
    indexNeedsRefresh: actual.indexNeedsRefresh,
    listSeriesIndexes: () => listSeriesIndexes(),
    putSeriesIndexes: (recs: SeriesIndexRecord[]) => putSeriesIndexes(recs),
    deleteSeriesIndex: (key: string) => deleteSeriesIndex(key)
  };
});

const upsertFromSeriesFile = vi.fn(async (_title: string, _file: unknown) => {});
vi.mock('$lib/metadata/store', () => ({
  upsertFromSeriesFile: (title: string, file: unknown) => upsertFromSeriesFile(title, file)
}));

function cloudFile(path: string, overrides: Partial<CloudVolumeWithProvider> = {}) {
  return {
    provider: 'webdav',
    fileId: path,
    path,
    modifiedTime: '2026-08-17T00:00:00.000Z',
    size: 100,
    ...overrides
  } as CloudVolumeWithProvider;
}

/** The listing shape `fetchAllCloudVolumes` hands over: folder name → files. */
function listing(...files: CloudVolumeWithProvider[]): Map<string, CloudVolumeWithProvider[]> {
  const map = new Map<string, CloudVolumeWithProvider[]>();
  for (const file of files) {
    const folder = file.path.split('/')[0];
    const existing = map.get(folder);
    if (existing) existing.push(file);
    else map.set(folder, [file]);
  }
  return map;
}

function seriesJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    series_title: 'One Piece',
    external_ids: { anilist: 30013 },
    titles: {},
    synonyms: [],
    updated_at: '2026-08-16T00:00:00.000Z',
    volumes: [
      {
        volume_uuid: 'uuid-1',
        volume_title: 'Volume 1',
        page_count: 200,
        character_count: 5000,
        mokuro_version: '0.4.11'
      }
    ],
    ...overrides
  });
}

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    type: 'webdav',
    downloadFile: vi.fn(async () => new Blob([seriesJson()])),
    ...overrides
  };
}

function cachedRecord(overrides: Partial<SeriesIndexRecord> = {}): SeriesIndexRecord {
  return {
    series_key: 'one piece',
    series_title: 'One Piece',
    file: JSON.parse(seriesJson()),
    source: {
      provider: 'webdav',
      path: 'One Piece/series.json',
      size: 100,
      modifiedTime: '2026-08-17T00:00:00.000Z'
    },
    fetched_at: '2026-08-17T00:00:00.000Z',
    ...overrides
  } as SeriesIndexRecord;
}

async function load() {
  return import('./series-index-sync');
}

describe('refreshSeriesIndexes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    listSeriesIndexes.mockResolvedValue([]);
  });

  it('downloads a changed series.json, caches it and applies its facts', async () => {
    const provider = makeProvider();
    getActiveProvider.mockReturnValue(provider);
    listSeriesIndexes.mockResolvedValue([
      cachedRecord({ source: { ...cachedRecord().source, size: 55 } })
    ]);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(
      listing(cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json')),
      'webdav'
    );

    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    expect(putSeriesIndexes).toHaveBeenCalledWith([
      expect.objectContaining({
        series_key: 'one piece',
        // The FOLDER name is the stored title, never the one inside the file.
        series_title: 'One Piece',
        source: {
          provider: 'webdav',
          path: 'One Piece/series.json',
          size: 100,
          modifiedTime: '2026-08-17T00:00:00.000Z'
        }
      })
    ]);
    expect(upsertFromSeriesFile).toHaveBeenCalledWith(
      'One Piece',
      expect.objectContaining({ external_ids: { anilist: 30013 } })
    );
  });

  it('stores the folder name even when the file disagrees about the title', async () => {
    const provider = makeProvider({
      downloadFile: vi.fn(async () => new Blob([seriesJson({ series_title: 'ワンピース' })]))
    });
    getActiveProvider.mockReturnValue(provider);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(
      listing(cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json')),
      'webdav'
    );

    expect(putSeriesIndexes).toHaveBeenCalledWith([
      expect.objectContaining({ series_key: 'one piece', series_title: 'One Piece' })
    ]);
    expect(upsertFromSeriesFile).toHaveBeenCalledWith('One Piece', expect.anything());
  });

  it('does not re-download a file whose size and mtime still match the cache', async () => {
    const provider = makeProvider();
    getActiveProvider.mockReturnValue(provider);
    listSeriesIndexes.mockResolvedValue([cachedRecord()]);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(
      listing(cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json')),
      'webdav'
    );

    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(putSeriesIndexes).not.toHaveBeenCalled();
    expect(deleteSeriesIndex).not.toHaveBeenCalled();
  });

  it('ignores a folder that holds no .cbz — an orphan sidecar creates no record', async () => {
    const provider = makeProvider();
    getActiveProvider.mockReturnValue(provider);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(
      listing(cloudFile('Ghost Series/series.json'), cloudFile('One Piece/Volume 1.cbz')),
      'webdav'
    );

    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(putSeriesIndexes).not.toHaveBeenCalled();
    expect(upsertFromSeriesFile).not.toHaveBeenCalled();
  });

  it('drops a cached index whose folder lost its .cbz files', async () => {
    const provider = makeProvider();
    getActiveProvider.mockReturnValue(provider);
    listSeriesIndexes.mockResolvedValue([
      cachedRecord({ series_key: 'ghost series', series_title: 'Ghost Series' })
    ]);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(
      listing(cloudFile('Ghost Series/series.json'), cloudFile('One Piece/Volume 1.cbz')),
      'webdav'
    );

    expect(deleteSeriesIndex).toHaveBeenCalledWith('ghost series');
  });

  it('drops a cached index whose folder no longer has a series.json', async () => {
    const provider = makeProvider();
    getActiveProvider.mockReturnValue(provider);
    listSeriesIndexes.mockResolvedValue([cachedRecord()]);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(listing(cloudFile('One Piece/Volume 1.cbz')), 'webdav');

    expect(deleteSeriesIndex).toHaveBeenCalledWith('one piece');
    expect(provider.downloadFile).not.toHaveBeenCalled();
  });

  it('leaves another provider’s cached indexes alone', async () => {
    const provider = makeProvider();
    getActiveProvider.mockReturnValue(provider);
    listSeriesIndexes.mockResolvedValue([
      cachedRecord({
        series_key: 'other',
        series_title: 'Other',
        source: { ...cachedRecord().source, provider: 'mega' }
      })
    ]);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(listing(cloudFile('One Piece/Volume 1.cbz')), 'webdav');

    expect(deleteSeriesIndex).not.toHaveBeenCalled();
  });

  it('never deletes anything from an empty listing (a failed fetch is not an empty cloud)', async () => {
    getActiveProvider.mockReturnValue(makeProvider());
    listSeriesIndexes.mockResolvedValue([cachedRecord()]);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(new Map(), 'webdav');

    expect(deleteSeriesIndex).not.toHaveBeenCalled();
  });

  it('caps concurrent downloads at 4', async () => {
    let active = 0;
    let peak = 0;
    const provider = makeProvider({
      downloadFile: vi.fn(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active--;
        return new Blob([seriesJson()]);
      })
    });
    getActiveProvider.mockReturnValue(provider);

    const files: CloudVolumeWithProvider[] = [];
    for (let i = 0; i < 9; i++) {
      files.push(cloudFile(`Series ${i}/Volume 1.cbz`));
      files.push(cloudFile(`Series ${i}/series.json`));
    }

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(listing(...files), 'webdav');

    expect(provider.downloadFile).toHaveBeenCalledTimes(9);
    expect(peak).toBe(4);
  });

  it('drops an unparsable file with a single warning and no record', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = makeProvider({
      downloadFile: vi.fn(async () => new Blob(['not json at all']))
    });
    getActiveProvider.mockReturnValue(provider);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(
      listing(cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json')),
      'webdav'
    );

    expect(putSeriesIndexes).not.toHaveBeenCalled();
    expect(upsertFromSeriesFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('drops a file that fails validation and keeps refreshing the other folders', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = makeProvider({
      downloadFile: vi.fn(async (file: { path: string }) =>
        file.path.startsWith('Bad')
          ? new Blob([JSON.stringify({ version: 9, series_title: 'Bad' })])
          : new Blob([seriesJson()])
      )
    });
    getActiveProvider.mockReturnValue(provider);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(
      listing(
        cloudFile('Bad Series/Volume 1.cbz'),
        cloudFile('Bad Series/series.json'),
        cloudFile('One Piece/Volume 1.cbz'),
        cloudFile('One Piece/series.json')
      ),
      'webdav'
    );

    expect(putSeriesIndexes).toHaveBeenCalledTimes(1);
    expect(putSeriesIndexes).toHaveBeenCalledWith([
      expect.objectContaining({ series_key: 'one piece' })
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('survives a download failure without rejecting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = makeProvider({
      downloadFile: vi.fn(async () => {
        throw new Error('offline');
      })
    });
    getActiveProvider.mockReturnValue(provider);

    const { refreshSeriesIndexes } = await load();
    await expect(
      refreshSeriesIndexes(
        listing(cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json')),
        'webdav'
      )
    ).resolves.toBeUndefined();

    expect(putSeriesIndexes).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does nothing without a connected provider', async () => {
    getActiveProvider.mockReturnValue(null);
    listSeriesIndexes.mockResolvedValue([cachedRecord()]);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(listing(cloudFile('One Piece/Volume 1.cbz')), 'webdav');

    expect(deleteSeriesIndex).not.toHaveBeenCalled();
  });

  it('bails when the provider changed between the listing and the run', async () => {
    // The listing was captured on webdav; by the time the refresh runs the user
    // has switched accounts. Downloading these file ids against the new provider
    // (or cleaning up against a listing from the other account) is nonsense.
    const provider = makeProvider({ type: 'mega' });
    getActiveProvider.mockReturnValue(provider);
    listSeriesIndexes.mockResolvedValue([cachedRecord()]);

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(
      listing(cloudFile('Ghost Series/series.json'), cloudFile('One Piece/series.json')),
      'webdav'
    );

    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(putSeriesIndexes).not.toHaveBeenCalled();
    expect(deleteSeriesIndex).not.toHaveBeenCalled();
  });

  it('drops a queued replay whose provider is no longer active', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = makeProvider({
      downloadFile: vi.fn(async () => {
        await gate;
        return new Blob([seriesJson()]);
      })
    });
    getActiveProvider.mockReturnValue(provider);
    // Nothing cached, so the replay would re-download every sidecar of the
    // listing if it ran at all.
    listSeriesIndexes.mockResolvedValue([]);

    const map = listing(cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json'));

    const { refreshSeriesIndexes } = await load();
    const first = refreshSeriesIndexes(map, 'webdav');
    const queuedReplay = refreshSeriesIndexes(map, 'webdav');
    // The provider switches while the first run is still downloading.
    const switchedTo = makeProvider({ type: 'mega' });
    getActiveProvider.mockReturnValue(switchedTo);
    release();
    await Promise.all([first, queuedReplay]);

    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    // The replay must not run against the account that is now active: its file
    // ids and folder set belong to the old one.
    expect(switchedTo.downloadFile).not.toHaveBeenCalled();
    expect(putSeriesIndexes).toHaveBeenCalledTimes(1);
  });

  it('writes every refreshed record in a single bulk put', async () => {
    const provider = makeProvider();
    getActiveProvider.mockReturnValue(provider);

    const files: CloudVolumeWithProvider[] = [];
    for (let i = 0; i < 3; i++) {
      files.push(cloudFile(`Series ${i}/Volume 1.cbz`));
      files.push(cloudFile(`Series ${i}/series.json`));
    }

    const { refreshSeriesIndexes } = await load();
    await refreshSeriesIndexes(listing(...files), 'webdav');

    // One liveQuery emission for the whole run, not one per folder — each
    // emission rebuilds the catalog's placeholder join.
    expect(putSeriesIndexes).toHaveBeenCalledTimes(1);
    expect(putSeriesIndexes.mock.calls[0][0]).toHaveLength(3);
    expect(upsertFromSeriesFile).toHaveBeenCalledTimes(3);
  });

  it('coalesces calls made while a run is in flight into exactly one more run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = makeProvider({
      downloadFile: vi.fn(async () => {
        await gate;
        return new Blob([seriesJson()]);
      })
    });
    getActiveProvider.mockReturnValue(provider);

    const map = listing(cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json'));

    const { refreshSeriesIndexes } = await load();
    const first = refreshSeriesIndexes(map, 'webdav');
    const second = refreshSeriesIndexes(map, 'webdav');
    const third = refreshSeriesIndexes(map, 'webdav');
    release();
    await Promise.all([first, second, third]);

    // Two runs total: the one in flight, plus a single queued replay for the
    // two calls that arrived while it was running.
    expect(provider.downloadFile).toHaveBeenCalledTimes(2);
  });
});
