import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';

/**
 * The facts half of a catalog refresh, against a REAL Dexie (fake-indexeddb) —
 * no `db.transaction` stub anywhere in this file.
 *
 * That distinction is the whole point. `catalog-index-sync.test.ts` mocks the db
 * wholesale, so it can prove *how many* transactions the sync opens but never
 * runs a real one. A round of review wrapped the per-entry loop in a single
 * outer `db.transaction` to coalesce the liveQuery emissions, and the mocked
 * test happily passed — while against a real database it was a data-loss bug:
 * `upsertFromSeriesFile` opens its OWN `rw` transaction (store.ts), which Dexie
 * joins to the outer one as a SUB-transaction, and a sub-transaction that
 * rejects aborts its parent ("Transaction committed too early") no matter how
 * politely the caller catches the error. One malformed entry would therefore
 * roll back every entry already written and fail every entry after it.
 *
 * So: one bad entry must cost exactly that one entry.
 */

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('catalog-index-sync-facts-test');
  db.version(1).stores({ series_metadata: 'series_key', catalog_index: 'id' });
  return { db };
});

const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/provider-manager', () => ({ providerManager: { getActiveProvider } }));

/**
 * The real `upsertFromSeriesFile` for every series but one. The poisoned title
 * fails the way a real one would — from inside its own nested `rw` transaction
 * (a ConstraintError/DataError on the put) — rather than by throwing before any
 * transaction is opened, which would not exercise the nesting at all.
 */
const POISON = 'Bad Entry';
vi.mock('$lib/metadata/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/metadata/store')>();
  const { db } = await import('$lib/catalog/db');
  return {
    ...actual,
    upsertFromSeriesFile: vi.fn(async (title: string, file: unknown) => {
      if (title !== POISON) {
        return actual.upsertFromSeriesFile(title, file as never);
      }
      return db.transaction('rw', db.series_metadata, async () => {
        await db.series_metadata.get('anything');
        throw new Error('simulated IndexedDB failure inside the nested transaction');
      });
    })
  };
});

import { db } from '$lib/catalog/db';

function entry(series_title: string, anilist: number) {
  return {
    series_title,
    external_ids: { anilist },
    titles: { native: `${series_title} native` },
    synonyms: [],
    updated_at: '2026-08-18T19:36:24.324Z'
  };
}

const CATALOG_JSON = JSON.stringify({
  version: 1,
  updated_at: '2026-08-23T00:00:00.000Z',
  series: [entry('Good First', 1), entry(POISON, 2), entry('Good Last', 3)]
});

function listing(): Map<string, CloudFileMetadata[]> {
  return new Map([
    [
      '',
      [
        {
          provider: 'webdav',
          fileId: 'catalog.json',
          path: 'catalog.json',
          modifiedTime: '2026-08-23T00:00:00.000Z',
          size: 100
        } as CloudFileMetadata
      ]
    ]
  ]);
}

afterEach(async () => {
  await db.series_metadata.clear();
  await db.catalog_index.clear();
  vi.clearAllMocks();
});

describe('catalog refresh facts pass (real IndexedDB)', () => {
  it('lets one failing entry cost only itself', async () => {
    getActiveProvider.mockReturnValue({
      type: 'webdav',
      downloadFile: vi.fn(async () => new Blob([CATALOG_JSON]))
    });

    const { refreshCatalogIndex } = await import('./catalog-index-sync');
    await refreshCatalogIndex(listing(), 'webdav');

    // The two healthy entries' facts are stored. Under one shared transaction
    // 'good first' was rolled back and 'good last' never ran at all.
    expect(await db.series_metadata.get('good first')).toMatchObject({
      series_title: 'Good First',
      external_ids: { anilist: 1 }
    });
    expect(await db.series_metadata.get('good last')).toMatchObject({
      series_title: 'Good Last',
      external_ids: { anilist: 3 }
    });
    // The bad one stored nothing, and took nothing else down with it.
    expect(await db.series_metadata.get('bad entry')).toBeUndefined();

    // Names are cached for all three regardless — the catalog can still list
    // and search a series whose facts failed to apply. One row, holding the
    // whole file.
    const rows = await db.catalog_index.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].file.series.map((e: { series_title: string }) => e.series_title).sort()).toEqual(
      ['Bad Entry', 'Good First', 'Good Last']
    );
  });
});
