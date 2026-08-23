import { db } from '$lib/catalog/db';
import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import type { CatalogFileEntry } from './catalog-file';
import { normalizeSeriesKey } from './series-key';
import { sourceStampChanged } from './series-index';

/**
 * One series' entry from the root `catalog.json`, plus the cloud file stamp
 * (`size`/`modifiedTime`) the whole file was fetched at. PK =
 * `normalizeSeriesKey(series_title)`, the same key space as `series_metadata`
 * and `series_index`.
 *
 * Purely a download cache and a name source: the facts inside `entry` still flow
 * through `upsertFromSeriesFile` in `store.ts` (which is what applies the
 * factless rules), and nothing here is authoritative over local data. Rows exist
 * so the catalog can list a series by name before anything about its volumes is
 * known — opening it is what fetches `series.json`.
 */
export interface CatalogIndexRecord {
  series_key: string;
  series_title: string;
  entry: CatalogFileEntry;
  source: { provider: string; path: string; size: number; modifiedTime: string };
  fetched_at: string;
}

export async function listCatalogIndexes(): Promise<CatalogIndexRecord[]> {
  return db.catalog_index.toArray();
}

/**
 * Cache several rows at once. The table backs a liveQuery the catalog joins, so
 * a refresh that touched N series must emit ONE change, not N — each emission
 * re-derives the name-only card set for the whole library.
 */
export async function putCatalogIndexes(records: CatalogIndexRecord[]): Promise<void> {
  if (records.length === 0) return;
  await db.catalog_index.bulkPut(records);
}

/** Drop rows in one write, for the same reason `putCatalogIndexes` batches. */
export async function deleteCatalogIndexes(seriesKeys: string[]): Promise<void> {
  if (seriesKeys.length === 0) return;
  await db.catalog_index.bulkDelete(seriesKeys);
}

/**
 * Point one provider's slice of the cache at exactly `records`: rows fetched
 * from that provider which are no longer listed are dropped, everything else is
 * written, and both happen in ONE transaction.
 *
 * The single transaction is the point. This table feeds a liveQuery the catalog
 * joins, so a separate delete and put emit twice and rebuild the whole card set
 * a second time — visible flicker on a big library. It also means a refresh can
 * never be observed half-applied.
 *
 * Rows from OTHER providers are never touched: a listing from one account says
 * nothing about another's. And an empty `records` is refused outright — a
 * catalog that yielded nothing is never grounds for emptying the cache (see
 * `catalog-index-sync.ts`, which declines to get this far).
 */
export async function replaceCatalogIndexesForProvider(
  provider: string,
  records: CatalogIndexRecord[]
): Promise<void> {
  if (records.length === 0) return;

  await db.transaction('rw', db.catalog_index, async () => {
    const keep = new Set(records.map((r) => r.series_key));
    const stale = (await db.catalog_index.toArray())
      .filter((row) => row.source.provider === provider && !keep.has(row.series_key))
      .map((row) => row.series_key);
    if (stale.length > 0) await db.catalog_index.bulkDelete(stale);
    await db.catalog_index.bulkPut(records);
  });
}

/**
 * After a series rename: carry the cached entry to the new key. Mirrors
 * `moveSeriesIndexKey` — on a collision the newer `fetched_at` wins rather than
 * the rows being merged, since this is a disposable cache: the loser is simply
 * re-fetched on the next catalog refresh.
 */
export async function moveCatalogIndexKey(oldTitle: string, newTitle: string): Promise<void> {
  const oldKey = normalizeSeriesKey(oldTitle);
  const newKey = normalizeSeriesKey(newTitle);

  await db.transaction('rw', db.catalog_index, async () => {
    const oldRec = await db.catalog_index.get(oldKey);
    if (!oldRec) return;

    if (oldKey === newKey) {
      await db.catalog_index.put({ ...oldRec, series_title: newTitle });
      return;
    }

    const newRec = await db.catalog_index.get(newKey);
    const winner: CatalogIndexRecord =
      newRec && newRec.fetched_at > oldRec.fetched_at
        ? newRec
        : { ...oldRec, series_key: newKey, series_title: newTitle };
    await db.catalog_index.put(winner);
    await db.catalog_index.delete(oldKey);
  });
}

/** Reactive view of the whole table, keyed by series_key. Empty Map before first emission. */
export const catalogIndexMap: Readable<Map<string, CatalogIndexRecord>> = readable(
  new Map<string, CatalogIndexRecord>(),
  (set) => {
    const subscription = liveQuery(() => db.catalog_index.toArray()).subscribe({
      next: (rows) => set(new Map(rows.map((r) => [r.series_key, r]))),
      error: (err) => console.error('catalog_index liveQuery failed:', err)
    });
    return () => subscription.unsubscribe();
  }
);

/**
 * Should the root `catalog.json` be re-downloaded?
 *
 * Every row of a fetch carries that fetch's file stamp, so comparing the NEWEST
 * row is comparing the file. An empty table means "never fetched" (or a catalog
 * that legitimately listed nothing), which is cheap to retry.
 *
 * Pure — no I/O, so it is cheap to call on every cloud listing.
 */
export function catalogNeedsRefresh(
  rows: CatalogIndexRecord[],
  cloud: { size: number; modifiedTime: string },
  provider?: string
): boolean {
  if (rows.length === 0) return true;
  const newest = rows.reduce((a, b) => (a.fetched_at >= b.fetched_at ? a : b));
  return sourceStampChanged(newest.source, cloud, provider);
}
