import { db } from '$lib/catalog/db';
import type { CatalogFile } from './catalog-file';
import { normalizeSeriesKey } from './series-key';
import { sourceStampChanged } from './series-index';

/** The one and only key: there is exactly one root `catalog.json`. */
export const CATALOG_INDEX_ID = 'catalog';

/**
 * The cached root `catalog.json` — ONE remote file, ONE row.
 *
 * The file is fetched whole and read back whole, so it is stored whole. (It was
 * once shredded into a row per series, which bought nothing: every read
 * reassembled the file immediately, and the single fetch's stamp was replicated
 * onto all ~1k rows.)
 *
 * Purely a download cache and a name source: the facts inside `file.series`
 * still flow through `upsertFromSeriesFile` in `store.ts` (which is what applies
 * the factless rules), and nothing here is authoritative over local data. What
 * it holds that nothing else does is the FACTLESS, name-only entries — a series
 * this library knows nothing about, and the stamp of an unlink another device
 * published — which `buildCatalogFile` merges back as `existing`, so a republish
 * neither drops them nor rewrites a file that did not change.
 */
export interface CatalogIndexRecord {
  id: string;
  file: CatalogFile;
  /** The cloud file stamp this copy was fetched at. */
  source: { provider: string; path: string; size: number; modifiedTime: string };
  fetched_at: string;
}

export async function getCatalogIndex(): Promise<CatalogIndexRecord | undefined> {
  return db.catalog_index.get(CATALOG_INDEX_ID);
}

/**
 * Cache one fetched (or just-published) catalog.
 *
 * An empty catalog is refused outright: a truncated upload or a half-written
 * file is never grounds for forgetting what this device knows, and storing it
 * would park a stamp that says the cache is current.
 */
export async function putCatalogIndex(record: Omit<CatalogIndexRecord, 'id'>): Promise<void> {
  if (record.file.series.length === 0) return;
  await db.catalog_index.put({ ...record, id: CATALOG_INDEX_ID });
}

/**
 * Forget the cached entries for these series keys — their folders are gone.
 * When nothing survives the record goes too, so the next listing re-fetches
 * instead of trusting an empty copy.
 */
export async function dropCatalogEntries(seriesKeys: string[]): Promise<void> {
  if (seriesKeys.length === 0) return;
  const drop = new Set(seriesKeys);
  await db.transaction('rw', db.catalog_index, async () => {
    const rec = await db.catalog_index.get(CATALOG_INDEX_ID);
    if (!rec) return;
    const series = rec.file.series.filter((e) => !drop.has(normalizeSeriesKey(e.series_title)));
    if (series.length === rec.file.series.length) return;
    if (series.length === 0) await db.catalog_index.delete(CATALOG_INDEX_ID);
    else await db.catalog_index.put({ ...rec, file: { ...rec.file, series } });
  });
}

/**
 * After a series rename: re-title that entry in place. On a collision the moved
 * entry wins, which is what the per-row version did too (one file, one
 * `fetched_at`, so its newest-wins tiebreak never favoured the destination) and
 * is harmless either way — the loser is re-fetched on the next refresh.
 */
export async function moveCatalogIndexKey(oldTitle: string, newTitle: string): Promise<void> {
  const oldKey = normalizeSeriesKey(oldTitle);
  const newKey = normalizeSeriesKey(newTitle);
  if (!oldKey || !newKey) return;

  await db.transaction('rw', db.catalog_index, async () => {
    const rec = await db.catalog_index.get(CATALOG_INDEX_ID);
    const moved = rec?.file.series.find((e) => normalizeSeriesKey(e.series_title) === oldKey);
    if (!rec || !moved) return;
    const series = rec.file.series.filter((e) => {
      const key = normalizeSeriesKey(e.series_title);
      return key !== oldKey && key !== newKey;
    });
    series.push({ ...moved, series_title: newTitle });
    await db.catalog_index.put({ ...rec, file: { ...rec.file, series } });
  });
}

/**
 * Should the root `catalog.json` be re-downloaded? Nothing cached (never
 * fetched, or dropped as unusable) means yes, which is cheap to retry.
 *
 * Pure — no I/O, so it is cheap to call on every cloud listing.
 */
export function catalogNeedsRefresh(
  cached: CatalogIndexRecord | undefined,
  cloud: { size: number; modifiedTime: string },
  provider?: string
): boolean {
  return sourceStampChanged(cached?.source, cloud, provider);
}
