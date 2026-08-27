import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import type { CatalogIndexRecord } from './catalog-index';

const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/provider-manager', () => ({ providerManager: { getActiveProvider } }));
// Nothing in this file touches the database: the store and the index accessors
// are both mocked below. The facts pass is exercised against a REAL Dexie in
// `catalog-index-sync.facts.test.ts` instead — mocking `db.transaction` here
// once hid a transaction-nesting bug precisely because the body never ran.
vi.mock('$lib/catalog/db', () => ({ db: {} }));

const getCatalogIndex = vi.fn(async (): Promise<CatalogIndexRecord | undefined> => undefined);
const putCatalogIndex = vi.fn(async (_rec: Omit<CatalogIndexRecord, 'id'>) => {});
vi.mock('$lib/metadata/catalog-index', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/catalog-index')>(
    '$lib/metadata/catalog-index'
  );
  return {
    catalogNeedsRefresh: actual.catalogNeedsRefresh,
    getCatalogIndex: () => getCatalogIndex(),
    putCatalogIndex: (rec: Omit<CatalogIndexRecord, 'id'>) => putCatalogIndex(rec)
  };
});

const upsertManyFromSeriesFiles = vi.fn(async (entries: { seriesTitle: string }[]) => {
  return entries.length;
});
vi.mock('$lib/metadata/store', () => ({
  upsertManyFromSeriesFiles: (entries: { seriesTitle: string }[]) =>
    upsertManyFromSeriesFiles(entries)
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

/** The cached copy of one earlier fetch, stamped `source`. */
function cached(
  source: { size: number; modifiedTime: string },
  ...titles: string[]
): CatalogIndexRecord {
  return {
    id: 'catalog',
    file: {
      version: 1,
      updated_at: '2026-08-01T00:00:00.000Z',
      series: titles.map((series_title) => ({
        series_title,
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: '1970-01-01T00:00:00.000Z'
      }))
    },
    source: { provider: 'webdav', path: 'catalog.json', ...source },
    fetched_at: '2026-08-01T00:00:00.000Z'
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  getCatalogIndex.mockResolvedValue(undefined);
  downloadFile.mockResolvedValue(new Blob([CATALOG_JSON]));
  getActiveProvider.mockReturnValue({ type: 'webdav', downloadFile });
});

describe('refreshCatalogIndex', () => {
  it('caches the parsed file in ONE write and applies the facts', async () => {
    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');

    expect(putCatalogIndex).toHaveBeenCalledTimes(1);
    const cached = putCatalogIndex.mock.calls[0][0];
    // The whole document, factless entries included — never a per-series shred.
    expect(cached.file.series.map((e) => e.series_title)).toEqual([
      'Dr Stone (HD Scan)',
      'Bare Folder'
    ]);
    expect(cached.file.version).toBe(1);
    expect(cached.source).toEqual({
      provider: 'webdav',
      path: 'catalog.json',
      size: 100,
      modifiedTime: '2026-08-23T00:00:00.000Z'
    });
    // ONE batched call for the whole file, not one per series: `series_metadata`
    // backs a liveQuery the catalog joins, so a commit per entry is a full
    // catalog re-derive per entry. The commit count itself is asserted against a
    // real Dexie in `catalog-index-sync.facts.test.ts`.
    expect(upsertManyFromSeriesFiles).toHaveBeenCalledTimes(1);
    const batch = upsertManyFromSeriesFiles.mock.calls[0][0];
    expect(batch.map((e) => e.seriesTitle)).toEqual(['Dr Stone (HD Scan)', 'Bare Folder']);
    // Applied as facts-only SeriesFiles, so store.ts owns the factless rules.
    expect(batch[0]).toEqual({
      seriesTitle: 'Dr Stone (HD Scan)',
      file: expect.objectContaining({
        version: 2,
        volumes: [],
        updated_at: '2026-08-18T19:36:24.324Z'
      })
    });
  });

  it('does nothing when the cached stamp already matches', async () => {
    getCatalogIndex.mockResolvedValue(
      cached({ size: 100, modifiedTime: '2026-08-23T00:00:00.000Z' }, 'Dr Stone (HD Scan)')
    );
    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(putCatalogIndex).not.toHaveBeenCalled();
  });

  it('replaces the cached copy wholesale, so a series that left the catalog goes', async () => {
    getCatalogIndex.mockResolvedValue(cached({ size: 9, modifiedTime: 'old' }, 'Deleted Series'));
    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');

    const stored = putCatalogIndex.mock.calls.at(-1)![0];
    expect(stored.source.provider).toBe('webdav');
    expect(stored.file.series.map((e) => e.series_title)).toEqual([
      'Dr Stone (HD Scan)',
      'Bare Folder'
    ]);
  });

  it('never touches the cache against an empty listing', async () => {
    getCatalogIndex.mockResolvedValue(cached({ size: 9, modifiedTime: 'old' }, 'Anything'));
    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(new Map(), 'webdav');
    expect(putCatalogIndex).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('never lets a catalog that parses to zero entries wipe the cache', async () => {
    // A truncated-but-valid file, a half-written upload, or a server that
    // published an empty catalog says nothing about the library. Caching it
    // would replace what this device knows with an empty copy carrying a
    // CURRENT stamp, hiding the real catalog until its size/mtime moved again.
    getCatalogIndex.mockResolvedValue(cached({ size: 9, modifiedTime: 'old' }, 'Still Here'));
    downloadFile.mockResolvedValue(
      new Blob([JSON.stringify({ version: 1, updated_at: '2026-08-23T00:00:00.000Z', series: [] })])
    );

    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(listing(file('catalog.json')), 'webdav');

    expect(putCatalogIndex).not.toHaveBeenCalled();
    expect(upsertManyFromSeriesFiles).not.toHaveBeenCalled();
  });

  it('does nothing when the listing has no catalog.json (a bare share)', async () => {
    const { refreshCatalogIndex } = await load();
    await refreshCatalogIndex(listing(file('Dr Stone/Volume 1.cbz')), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(putCatalogIndex).not.toHaveBeenCalled();
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
    expect(putCatalogIndex).not.toHaveBeenCalled();

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
