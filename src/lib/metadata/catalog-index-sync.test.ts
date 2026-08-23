import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import type { CatalogIndexRecord } from './catalog-index';

const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/provider-manager', () => ({ providerManager: { getActiveProvider } }));
vi.mock('$lib/catalog/db', () => ({ db: {} }));

const listCatalogIndexes = vi.fn(async (): Promise<CatalogIndexRecord[]> => []);
const putCatalogIndexes = vi.fn(async (_recs: CatalogIndexRecord[]) => {});
const deleteCatalogIndexes = vi.fn(async (_keys: string[]) => {});
vi.mock('$lib/metadata/catalog-index', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/catalog-index')>(
    '$lib/metadata/catalog-index'
  );
  return {
    catalogNeedsRefresh: actual.catalogNeedsRefresh,
    listCatalogIndexes: () => listCatalogIndexes(),
    putCatalogIndexes: (recs: CatalogIndexRecord[]) => putCatalogIndexes(recs),
    deleteCatalogIndexes: (keys: string[]) => deleteCatalogIndexes(keys)
  };
});

const upsertFromSeriesFile = vi.fn(async (_title: string, _file: unknown) => true);
vi.mock('$lib/metadata/store', () => ({
  upsertFromSeriesFile: (title: string, file: unknown) => upsertFromSeriesFile(title, file)
}));

/**
 * Imported lazily (same as `series-index-sync.test.ts`): a static import would
 * run before the `vi.mock` factories can see their spies, and `vi.resetModules`
 * gives every test a fresh coalescing state.
 */
async function load() {
  return import('./catalog-index-sync');
}

function file(path: string, overrides: Partial<CloudFileMetadata> = {}): CloudFileMetadata {
  return {
    provider: 'webdav',
    fileId: path,
    path,
    modifiedTime: '2026-08-23T00:00:00.000Z',
    size: 100,
    ...overrides
  } as CloudFileMetadata;
}

function listing(...files: CloudFileMetadata[]): Map<string, CloudFileMetadata[]> {
  const map = new Map<string, CloudFileMetadata[]>();
  for (const f of files) {
    const folder = f.path.split('/')[0];
    const existing = map.get(folder);
    if (existing) existing.push(f);
    else map.set(folder, [f]);
  }
  return map;
}

const CATALOG_JSON = JSON.stringify({
  version: 1,
  updated_at: '2026-08-23T00:00:00.000Z',
  series: [
    {
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE' },
      synonyms: [],
      tag: 'HD Scan',
      updated_at: '2026-08-18T19:36:24.324Z'
    },
    {
      series_title: 'Bare Folder',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '1970-01-01T00:00:00.000Z'
    }
  ]
});

const downloadFile = vi.fn(async () => new Blob([CATALOG_JSON]));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  listCatalogIndexes.mockResolvedValue([]);
  downloadFile.mockResolvedValue(new Blob([CATALOG_JSON]));
  getActiveProvider.mockReturnValue({ type: 'webdav', downloadFile });
});

describe('refreshCatalogIndex', () => {
  it('caches every entry in ONE write and applies the facts', async () => {
    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');

    expect(putCatalogIndexes).toHaveBeenCalledTimes(1);
    const rows = putCatalogIndexes.mock.calls[0][0];
    expect(rows.map((r) => r.series_key)).toEqual(['dr stone (hd scan)', 'bare folder']);
    expect(rows[0].source).toEqual({
      provider: 'webdav',
      path: 'catalog.json',
      size: 100,
      modifiedTime: '2026-08-23T00:00:00.000Z'
    });
    expect(upsertFromSeriesFile).toHaveBeenCalledTimes(2);
    // Applied as a facts-only SeriesFile, so store.ts owns the factless rules.
    expect(upsertFromSeriesFile).toHaveBeenCalledWith(
      'Dr Stone (HD Scan)',
      expect.objectContaining({ version: 2, volumes: [], updated_at: '2026-08-18T19:36:24.324Z' })
    );
  });

  it('does nothing when the cached stamp already matches', async () => {
    listCatalogIndexes.mockResolvedValue([
      {
        series_key: 'dr stone (hd scan)',
        series_title: 'Dr Stone (HD Scan)',
        entry: {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2026-08-18T19:36:24.324Z'
        },
        source: {
          provider: 'webdav',
          path: 'catalog.json',
          size: 100,
          modifiedTime: '2026-08-23T00:00:00.000Z'
        },
        fetched_at: '2026-08-23T00:00:01.000Z'
      }
    ]);
    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(putCatalogIndexes).not.toHaveBeenCalled();
  });

  it('drops rows of THIS provider whose series left the catalog', async () => {
    listCatalogIndexes.mockResolvedValue([
      {
        series_key: 'deleted series',
        series_title: 'Deleted Series',
        entry: {
          series_title: 'Deleted Series',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        },
        source: { provider: 'webdav', path: 'catalog.json', size: 9, modifiedTime: 'old' },
        fetched_at: '2026-08-01T00:00:00.000Z'
      },
      {
        series_key: 'other account',
        series_title: 'Other Account',
        entry: {
          series_title: 'Other Account',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        },
        source: { provider: 'mega', path: 'catalog.json', size: 9, modifiedTime: 'old' },
        fetched_at: '2026-08-01T00:00:00.000Z'
      }
    ]);
    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    expect(deleteCatalogIndexes).toHaveBeenCalledWith(['deleted series']);
  });

  it('never cleans up against an empty listing', async () => {
    listCatalogIndexes.mockResolvedValue([
      {
        series_key: 'anything',
        series_title: 'Anything',
        entry: {
          series_title: 'Anything',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        },
        source: { provider: 'webdav', path: 'catalog.json', size: 9, modifiedTime: 'old' },
        fetched_at: '2026-08-01T00:00:00.000Z'
      }
    ]);
    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(new Map(), 'webdav');
    expect(deleteCatalogIndexes).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('never lets a catalog that parses to zero entries wipe the cache', async () => {
    // A truncated-but-valid file, a half-written upload, or a server that
    // published an empty catalog says nothing about the library. Treating it as
    // authoritative would delete every row for this provider AND store no stamp
    // (an empty put is a no-op), leaving the cache empty and re-downloading on
    // every listing forever. Keep the rows and retry on the next listing.
    listCatalogIndexes.mockResolvedValue([
      {
        series_key: 'still here',
        series_title: 'Still Here',
        entry: {
          series_title: 'Still Here',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        },
        source: { provider: 'webdav', path: 'catalog.json', size: 9, modifiedTime: 'old' },
        fetched_at: '2026-08-01T00:00:00.000Z'
      }
    ]);
    downloadFile.mockResolvedValue(
      new Blob([JSON.stringify({ version: 1, updated_at: '2026-08-23T00:00:00.000Z', series: [] })])
    );

    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');

    expect(deleteCatalogIndexes).not.toHaveBeenCalled();
    expect(putCatalogIndexes).not.toHaveBeenCalled();
    expect(upsertFromSeriesFile).not.toHaveBeenCalled();
  });

  it('does nothing when the listing has no catalog.json (a bare share)', async () => {
    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(listing(file('Dr Stone/Volume 1.cbz')), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(deleteCatalogIndexes).not.toHaveBeenCalled();
  });

  it('is dropped when the provider changed since the listing', async () => {
    getActiveProvider.mockReturnValue({ type: 'mega', downloadFile });
    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('never rejects on a junk or failed download', async () => {
    const { refreshCatalogIndex } = await load();
    downloadFile.mockResolvedValueOnce(new Blob(['<html>proxy error</html>']));
    await expect(
      refreshCatalogIndex(listing(file('catalog.json')), 'webdav')
    ).resolves.toBeUndefined();
    expect(putCatalogIndexes).not.toHaveBeenCalled();

    downloadFile.mockRejectedValueOnce(new Error('network down'));
    await expect(
      refreshCatalogIndex(listing(file('catalog.json')), 'webdav')
    ).resolves.toBeUndefined();
  });

  it('coalesces a burst of listings into at most one extra pass', async () => {
    const { refreshCatalogIndex } = await load();
    const first = refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    void refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    void refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    await first;
    expect(downloadFile.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
