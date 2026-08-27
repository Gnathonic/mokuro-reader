import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

/**
 * The accessors run against the app's `db` singleton, so it is pointed at a
 * throwaway database here — but at the REAL `CatalogDexieV3` schema, never a
 * hand-written one. A test-local `stores({...})` would keep passing after
 * db-v3.ts's primary key moved out from under it, which is exactly the round
 * trip these tests exist to prove.
 */
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } = await import('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('catalog-index-accessor-test') };
});

import { db } from '$lib/catalog/db';
import type { CatalogDexieV3 } from '$lib/catalog/db-v3';
import {
  CATALOG_INDEX_ID,
  catalogNeedsRefresh,
  dropCatalogEntries,
  getCatalogIndex,
  moveCatalogIndexKey,
  putCatalogIndex,
  type CatalogIndexRecord
} from './catalog-index';
import { buildCatalogFile, catalogEntryFromMeta, catalogSeriesEqual } from './catalog-file';
import type { CatalogFile, CatalogFileEntry } from './catalog-file';

const table = () => (db as unknown as CatalogDexieV3).catalog_index;

const SOURCE = {
  provider: 'webdav',
  path: 'catalog.json',
  size: 1234,
  modifiedTime: '2026-08-23T00:00:00.000Z'
};

/** A series this library knows facts about. */
function linked(series_title: string, anilist: number, updated_at: string): CatalogFileEntry {
  return { series_title, external_ids: { anilist }, titles: {}, synonyms: [], updated_at };
}

/** A name and nothing else — the shape only this cache preserves. */
function factless(series_title: string, updated_at = '1970-01-01T00:00:00.000Z'): CatalogFileEntry {
  return { series_title, external_ids: {}, titles: {}, synonyms: [], updated_at };
}

function catalog(...series: CatalogFileEntry[]): CatalogFile {
  return { version: 1, updated_at: '2026-08-23T00:00:00.000Z', series };
}

function record(overrides: Partial<CatalogIndexRecord> = {}): Omit<CatalogIndexRecord, 'id'> {
  return {
    file: catalog(linked('Dr Stone (HD Scan)', 98416, '2026-08-18T19:36:24.324Z')),
    source: SOURCE,
    fetched_at: '2026-08-23T00:00:01.000Z',
    ...overrides
  };
}

beforeEach(async () => {
  await table().clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the catalog_index single row', () => {
  it('round-trips a whole CatalogFile under the production schema', async () => {
    const file = catalog(
      linked('Dr Stone (HD Scan)', 98416, '2026-08-18T19:36:24.324Z'),
      factless('Bare Folder')
    );
    await putCatalogIndex(record({ file }));

    const read = await getCatalogIndex();
    expect(read?.id).toBe(CATALOG_INDEX_ID);
    expect(read?.file).toEqual(file);
    expect(read?.source).toEqual(SOURCE);
    expect(read?.fetched_at).toBe('2026-08-23T00:00:01.000Z');
    // One remote file, one row — never a row per series.
    expect(await table().count()).toBe(1);
  });

  it('replaces the previous copy rather than accumulating rows', async () => {
    await putCatalogIndex(record());
    await putCatalogIndex(record({ file: catalog(factless('Only This')) }));

    expect(await table().count()).toBe(1);
    expect((await getCatalogIndex())?.file.series.map((e) => e.series_title)).toEqual([
      'Only This'
    ]);
  });

  it('refuses to cache a catalog that lists nothing', async () => {
    // A truncated upload or a half-written file is never grounds for forgetting
    // what this device knows — and storing it would park a current stamp on an
    // empty copy, hiding the real catalog until its size/mtime moved again.
    await putCatalogIndex(record());
    await putCatalogIndex(record({ file: catalog() }));

    expect((await getCatalogIndex())?.file.series).toHaveLength(1);
  });
});

describe('factless, name-only entries survive a republish', () => {
  /**
   * The one thing this cache holds that nothing else does. A rebuild only knows
   * the series THIS device has facts for; every other folder in the listing
   * projects to a factless epoch entry. The cached copy is what carries the
   * other devices' facts — and the stamp of an unlink somebody else published,
   * which an epoch entry must not roll back — into `buildCatalogFile`'s
   * `existing` merge.
   */
  const cloudTitles = new Set(['Dr Stone (HD Scan)', 'Bare Folder', 'Unlinked Elsewhere']);
  const cached = catalog(
    linked('Dr Stone (HD Scan)', 98416, '2026-08-18T19:36:24.324Z'),
    factless('Bare Folder'),
    factless('Unlinked Elsewhere', '2026-08-20T00:00:00.000Z')
  );

  it('carries them out of the cache and back into the rebuilt catalog', async () => {
    await putCatalogIndex(record({ file: cached }));
    const existing = (await getCatalogIndex())?.file;

    // What this device would publish on its own: it knows no facts at all.
    const entries = [...cloudTitles].map((title) => catalogEntryFromMeta(title, undefined));
    const rebuilt = buildCatalogFile({ entries, existing, cloudSeriesTitles: cloudTitles });

    expect(rebuilt?.series.map((e) => e.series_title).sort()).toEqual([
      'Bare Folder',
      'Dr Stone (HD Scan)',
      'Unlinked Elsewhere'
    ]);
    // Another device's link, still there.
    expect(rebuilt?.series.find((e) => e.series_title === 'Dr Stone (HD Scan)')).toEqual(
      linked('Dr Stone (HD Scan)', 98416, '2026-08-18T19:36:24.324Z')
    );
    // A published unlink keeps its stamp: rolled back to the epoch it would sit
    // below every stale link still out there and be re-linked by one of them.
    expect(rebuilt?.series.find((e) => e.series_title === 'Unlinked Elsewhere')?.updated_at).toBe(
      '2026-08-20T00:00:00.000Z'
    );
    // And because nothing changed, the republish is a no-op — the whole reason
    // the cache has to hold the factless entries too.
    expect(catalogSeriesEqual(rebuilt!.series, cached.series)).toBe(true);
  });
});

describe('catalogNeedsRefresh', () => {
  const cloud = { size: 1234, modifiedTime: '2026-08-23T00:00:00.000Z' };
  const cachedRecord: CatalogIndexRecord = { id: CATALOG_INDEX_ID, ...record() };

  it('is true when nothing is cached', () => {
    expect(catalogNeedsRefresh(undefined, cloud, 'webdav')).toBe(true);
  });

  it('is false when the cached stamp matches', () => {
    expect(catalogNeedsRefresh(cachedRecord, cloud, 'webdav')).toBe(false);
  });

  it('is true when the size differs', () => {
    expect(catalogNeedsRefresh(cachedRecord, { ...cloud, size: 9999 }, 'webdav')).toBe(true);
  });

  it('is true when the modifiedTime differs', () => {
    expect(
      catalogNeedsRefresh(
        cachedRecord,
        { ...cloud, modifiedTime: '2026-08-24T00:00:00.000Z' },
        'webdav'
      )
    ).toBe(true);
  });

  it('is true when the cache came from another provider', () => {
    expect(catalogNeedsRefresh(cachedRecord, cloud, 'mega')).toBe(true);
  });

  it('treats equivalent ISO representations of one instant as unchanged', () => {
    expect(
      catalogNeedsRefresh(
        cachedRecord,
        { size: 1234, modifiedTime: '2026-08-23T00:00:00+00:00' },
        'webdav'
      )
    ).toBe(false);
  });
});

describe('dropCatalogEntries', () => {
  it('removes only the named series from the cached file', async () => {
    await putCatalogIndex(
      record({ file: catalog(factless('Gone'), factless('Kept'), factless('Also Kept')) })
    );
    await dropCatalogEntries(['gone']);

    const read = await getCatalogIndex();
    expect(read?.file.series.map((e) => e.series_title)).toEqual(['Kept', 'Also Kept']);
    expect(read?.source).toEqual(SOURCE);
  });

  it('drops the whole record when nothing is left, so the next listing re-fetches', async () => {
    await putCatalogIndex(record({ file: catalog(factless('Only One')) }));
    await dropCatalogEntries(['only one']);

    expect(await getCatalogIndex()).toBeUndefined();
  });
});

describe('moveCatalogIndexKey', () => {
  it('re-titles the entry in place, keeping its facts', async () => {
    await putCatalogIndex(
      record({
        file: catalog(linked('Old Name', 42, '2026-08-18T00:00:00.000Z'), factless('Other'))
      })
    );
    await moveCatalogIndexKey('Old Name', 'New Name');

    const series = (await getCatalogIndex())?.file.series ?? [];
    expect(series.map((e) => e.series_title).sort()).toEqual(['New Name', 'Other']);
    expect(series.find((e) => e.series_title === 'New Name')?.external_ids).toEqual({
      anilist: 42
    });
  });

  it('collapses a collision onto the moved entry', async () => {
    await putCatalogIndex(
      record({
        file: catalog(linked('Old Name', 42, '2026-08-18T00:00:00.000Z'), factless('New Name'))
      })
    );
    await moveCatalogIndexKey('Old Name', 'New Name');

    const series = (await getCatalogIndex())?.file.series ?? [];
    expect(series).toHaveLength(1);
    expect(series[0]).toEqual({
      series_title: 'New Name',
      external_ids: { anilist: 42 },
      titles: {},
      synonyms: [],
      updated_at: '2026-08-18T00:00:00.000Z'
    });
  });

  it('does nothing when the old title is not cached', async () => {
    await putCatalogIndex(record({ file: catalog(factless('Untouched')) }));
    await moveCatalogIndexKey('Absent', 'Whatever');

    expect((await getCatalogIndex())?.file.series.map((e) => e.series_title)).toEqual([
      'Untouched'
    ]);
  });
});
