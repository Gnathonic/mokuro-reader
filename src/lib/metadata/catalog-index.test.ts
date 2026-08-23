import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

// The accessors below run against the app's `db` singleton, so it is pointed at
// a throwaway fake-indexeddb database for this file.
vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('catalog-index-accessor-test');
  db.version(1).stores({ catalog_index: 'series_key' });
  return { db };
});

import { CatalogDexieV3 } from '$lib/catalog/db-v3';
import { db as appDb } from '$lib/catalog/db';
import type { CatalogIndexRecord } from './catalog-index';
import { catalogNeedsRefresh, replaceCatalogIndexesForProvider } from './catalog-index';

const DB_NAME = 'mokuro_v3_catalog_index_test';
let db: CatalogDexieV3 | null = null;

afterEach(async () => {
  db?.close();
  db = null;
  await Dexie.delete(DB_NAME);
});

function record(overrides: Partial<CatalogIndexRecord> = {}): CatalogIndexRecord {
  return {
    series_key: 'dr stone (hd scan)',
    series_title: 'Dr Stone (HD Scan)',
    entry: {
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: {},
      synonyms: [],
      updated_at: '2026-08-18T19:36:24.324Z'
    },
    source: {
      provider: 'webdav',
      path: 'catalog.json',
      size: 1234,
      modifiedTime: '2026-08-23T00:00:00.000Z'
    },
    fetched_at: '2026-08-23T00:00:01.000Z',
    ...overrides
  };
}

describe('catalog_index table', () => {
  it('stores and reads back a record keyed by series_key', async () => {
    db = new CatalogDexieV3(DB_NAME);
    await db.open();
    await db.catalog_index.put(record());
    expect(await db.catalog_index.get('dr stone (hd scan)')).toMatchObject({
      series_title: 'Dr Stone (HD Scan)'
    });
  });
});

describe('catalogNeedsRefresh', () => {
  const cloud = { size: 1234, modifiedTime: '2026-08-23T00:00:00.000Z' };

  it('is true when nothing is cached', () => {
    expect(catalogNeedsRefresh([], cloud, 'webdav')).toBe(true);
  });

  it('is false when the newest cached stamp matches', () => {
    expect(catalogNeedsRefresh([record()], cloud, 'webdav')).toBe(false);
  });

  it('is true when the size differs', () => {
    expect(catalogNeedsRefresh([record()], { ...cloud, size: 9999 }, 'webdav')).toBe(true);
  });

  it('is true when the cache came from another provider', () => {
    expect(catalogNeedsRefresh([record()], cloud, 'mega')).toBe(true);
  });

  it('treats equivalent ISO representations of one instant as unchanged', () => {
    expect(
      catalogNeedsRefresh(
        [record()],
        { size: 1234, modifiedTime: '2026-08-23T00:00:00+00:00' },
        'webdav'
      )
    ).toBe(false);
  });

  it('uses the newest row when rows disagree', () => {
    const stale = record({
      series_key: 'other',
      source: {
        provider: 'webdav',
        path: 'catalog.json',
        size: 1,
        modifiedTime: '2026-01-01T00:00:00.000Z'
      },
      fetched_at: '2026-01-01T00:00:00.000Z'
    });
    expect(catalogNeedsRefresh([stale, record()], cloud, 'webdav')).toBe(false);
  });
});

describe('replaceCatalogIndexesForProvider', () => {
  const table = () => (appDb as unknown as CatalogDexieV3).catalog_index;

  beforeEach(async () => {
    await table().clear();
  });

  it('drops this provider rows that left the catalog and keeps the rest', async () => {
    await table().bulkPut([
      record({ series_key: 'gone', series_title: 'Gone' }),
      record({ series_key: 'kept', series_title: 'Kept' }),
      record({
        series_key: 'other account',
        series_title: 'Other Account',
        source: { provider: 'mega', path: 'catalog.json', size: 9, modifiedTime: 'old' }
      })
    ]);

    await replaceCatalogIndexesForProvider('webdav', [
      record({ series_key: 'kept', series_title: 'Kept' }),
      record({ series_key: 'fresh', series_title: 'Fresh' })
    ]);

    const keys = (await table().toArray()).map((r) => r.series_key).sort();
    // 'gone' is this provider's and absent from the new set; 'other account' is
    // another account's row, which this listing says nothing about.
    expect(keys).toEqual(['fresh', 'kept', 'other account']);
  });

  it('refuses to empty the table when handed no records', async () => {
    await table().bulkPut([record({ series_key: 'kept', series_title: 'Kept' })]);
    await replaceCatalogIndexesForProvider('webdav', []);
    expect(await table().count()).toBe(1);
  });

  it('writes the delete and the put in ONE transaction', async () => {
    // The table feeds a liveQuery the catalog joins: two writes would emit twice
    // and rebuild the whole card set a second time (visible flicker).
    await table().bulkPut([record({ series_key: 'gone', series_title: 'Gone' })]);
    const transaction = vi.spyOn(appDb, 'transaction');

    await replaceCatalogIndexesForProvider('webdav', [
      record({ series_key: 'fresh', series_title: 'Fresh' })
    ]);

    expect(transaction).toHaveBeenCalledTimes(1);
    transaction.mockRestore();
  });
});
