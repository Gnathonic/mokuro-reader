import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import type { CatalogFileEntry } from './catalog-file';
import { countIdbOps } from '$lib/catalog/__tests__/idb-op-counter';

/**
 * The facts half of a catalog refresh, against a REAL Dexie (fake-indexeddb) —
 * no `db.transaction` stub anywhere in this file, and the real
 * `upsertManyFromSeriesFiles` doing the writing.
 *
 * That distinction is the whole point. `catalog-index-sync.test.ts` mocks the db
 * wholesale, so it can prove *how many* times the sync calls the store but never
 * runs a real transaction. A round of review wrapped the per-entry loop in a
 * single outer `db.transaction` to coalesce the liveQuery emissions, and the
 * mocked test happily passed — while against a real database it was a data-loss
 * bug: `upsertFromSeriesFile` opens its OWN `rw` transaction (store.ts), which
 * Dexie joins to the outer one as a SUB-transaction, and a sub-transaction that
 * rejects aborts its parent ("Transaction committed too early") no matter how
 * politely the caller catches the error.
 *
 * Both properties are asserted here, because the fix for one is the trap for the
 * other:
 *
 * - a whole catalog costs a BOUNDED number of commits, not one per series
 *   (`series_metadata` backs a liveQuery the catalog joins, and Dexie broadcasts
 *   `storagemutated` once per readwrite commit — so a commit is a full catalog
 *   re-derive);
 * - and one bad entry still costs exactly that one entry.
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

const POISON = 'Bad Entry';

/**
 * How the poisoned entry fails, set per test.
 *
 * Injected by corrupting the `SeriesFile` the sync lifts the entry into, which
 * leaves the REAL store, the REAL batch write and a REAL Dexie underneath — the
 * failure happens where a genuine one would, not in a stub standing in for the
 * code under test. `parseCatalogFile` sanitizes every entry it returns, so a
 * junk `catalog.json` cannot reach this far on its own; the reachable version of
 * this is a row IndexedDB refuses, which is what `'clone'` reproduces.
 */
const { poison } = vi.hoisted(() => ({ poison: { mode: 'clone' as 'clone' | 'merge' } }));

vi.mock('$lib/metadata/catalog-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/metadata/catalog-file')>();
  return {
    ...actual,
    catalogEntryToSeriesFile: (entry: CatalogFileEntry) => {
      const file = actual.catalogEntryToSeriesFile(entry);
      if (entry.series_title !== POISON) return file;
      return poison.mode === 'clone'
        ? // Passes the merge — a function is a truthy title value, so the entry
          // still HAS facts — and then fails at the `put`: IndexedDB cannot
          // structured-clone it.
          { ...file, titles: { romaji: (() => 'boom') as unknown as string } }
        : // Throws inside the merge itself, at `[...file.synonyms]`.
          { ...file, synonyms: null as unknown as string[] };
    }
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

function catalogJson(series: ReturnType<typeof entry>[]): string {
  return JSON.stringify({ version: 1, updated_at: '2026-08-23T00:00:00.000Z', series });
}

const CATALOG_JSON = catalogJson([entry('Good First', 1), entry(POISON, 2), entry('Good Last', 3)]);

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

function serveCatalog(json: string) {
  getActiveProvider.mockReturnValue({
    type: 'webdav',
    downloadFile: vi.fn(async () => new Blob([json]))
  });
}

afterEach(async () => {
  await db.series_metadata.clear();
  await db.catalog_index.clear();
  poison.mode = 'clone';
  vi.clearAllMocks();
});

describe('catalog refresh facts pass (real IndexedDB)', () => {
  it.each([
    ['a row IndexedDB refuses to store', 'clone' as const],
    ['a file the merge throws on', 'merge' as const]
  ])('lets one failing entry (%s) cost only itself', async (_label, mode) => {
    poison.mode = mode;
    serveCatalog(CATALOG_JSON);

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

  /**
   * THE COMMIT BOUND, and why it is counted in write transactions rather than
   * round trips: Dexie broadcasts `storagemutated` once per readwrite COMMIT, so
   * on `series_metadata` — a table the catalog joins through a liveQuery — a
   * commit is a change signal is one full O(V) re-derive over every volume in
   * the library. N `put`s in ONE transaction and N `put`s in N transactions
   * issue exactly the same N round trips, so only the transaction count can see
   * this regress.
   *
   * 1,027 is the real number from the library that produced the report: one
   * catalog entry per series. Before batching this cost 1,027 commits.
   */
  it('applies a 1,027-series catalog in ONE commit, not one per series', async () => {
    const series = Array.from({ length: 1027 }, (_, i) => entry(`Series ${i}`, i + 1));
    serveCatalog(catalogJson(series));

    const { refreshCatalogIndex } = await import('./catalog-index-sync');
    const counts = await countIdbOps(async () => {
      await refreshCatalogIndex(listing(), 'webdav');
    });

    // Vacuity guard: the fixture really did reach the write, and every entry
    // landed. Without this the bound below would pass most loudly when the sync
    // wrote nothing at all.
    expect(await db.series_metadata.count()).toBe(1027);
    expect(counts['series_metadata.put']).toBe(1027);

    // The bound itself. One commit is what the batch costs; the headroom is for
    // the row-by-row fallback (which shares the same transaction) and nothing
    // else — anything near 1,027 is the per-entry loop back again.
    expect(counts['tx.series_metadata.readwrite']).toBe(1);
  });
});
