import { db } from '$lib/catalog/db';
import { type Readable } from 'svelte/store';
import { keyedTableMap, moveKeyedRecord } from './keyed-table';
import type { SeriesFile } from './series-file';

/**
 * The cached copy of one series' `series.json` sidecar, plus the cloud file
 * stamp (`size`/`modifiedTime`) it was fetched at. PK = `normalizeSeriesKey(series_title)`,
 * same key space as `series_metadata` — this table is purely a download cache
 * (avoids re-fetching the file when nothing changed), never a source of truth:
 * the facts inside `file` still flow through `upsertFromSeriesFile` in `store.ts`,
 * and the volume entries are unauthoritative (see `series-file.ts`).
 */
export interface SeriesIndexRecord {
  series_key: string;
  series_title: string;
  file: SeriesFile;
  source: { provider: string; path: string; size: number; modifiedTime: string };
  fetched_at: string;
  /**
   * The RAW cloud bytes this record was parsed from carried doubled volume
   * entries that read-time healing collapsed (`parseSeriesFileWithReport`).
   * `file` above is the HEALED shape — this flag is the only survivor of the
   * fact that the published file itself is still damaged, and it is what lets
   * the heal seam (`series-backfill.ts`'s `maybeScheduleSeriesHealWrite`)
   * schedule the overwrite that repairs it in the cloud. Set by the two
   * cloud-download sites (`readCloudSeriesFile`, `series-index-sync.ts`);
   * absent on records our own `writeSeriesFile` stamps, since our serializer
   * cannot produce doubles — which is exactly how one heal-write converges:
   * the write's own record replaces this one without the flag.
   */
  raw_entry_collapse?: boolean;
}

export async function getSeriesIndex(seriesKey: string): Promise<SeriesIndexRecord | undefined> {
  return db.series_index.get(seriesKey);
}

/**
 * Every cached record. One read for the whole table: the listing refresh needs
 * the cached stamp of each series AND the keys that no longer have a folder, so
 * a per-series `get` would be N round trips for the same data.
 */
export async function listSeriesIndexes(): Promise<SeriesIndexRecord[]> {
  return db.series_index.toArray();
}

export async function putSeriesIndex(rec: SeriesIndexRecord): Promise<void> {
  await db.series_index.put(rec);
}

/**
 * Cache several records at once. The table backs a liveQuery the catalog joins,
 * so a listing refresh that touched N series must emit ONE change, not N — each
 * emission re-derives the placeholder set for the whole library.
 */
export async function putSeriesIndexes(records: SeriesIndexRecord[]): Promise<void> {
  if (records.length === 0) return;
  await db.series_index.bulkPut(records);
}

export async function deleteSeriesIndex(seriesKey: string): Promise<void> {
  await db.series_index.delete(seriesKey);
}

/**
 * After a series rename: carry the cached index to the new key. The same
 * `moveKeyedRecord` `moveSeriesMetadataKey` uses, with THIS table's tiebreak —
 * on a collision the newer `fetched_at` wins rather than the record being
 * merged, since the index is a disposable cache: the loser is simply re-fetched
 * later if it was actually the fresher cloud copy.
 */
export async function moveSeriesIndexKey(oldTitle: string, newTitle: string): Promise<void> {
  await moveKeyedRecord(db.series_index, oldTitle, newTitle, {
    tiebreak: (record) => record.fetched_at,
    rekey: (record, series_key, series_title) => ({ ...record, series_key, series_title })
  });
}

/** Reactive view of the whole table, keyed by series_key. Empty Map before first emission. */
export const seriesIndexMap: Readable<Map<string, SeriesIndexRecord>> = keyedTableMap(
  () => db.series_index,
  'series_key'
);

/** Epoch ms for a timestamp, or `undefined` when it does not parse. */
function toEpoch(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Has the cloud file changed since a cache record was fetched from `source`?
 *
 * Shared by every stamp-versioned download cache (`series_index`,
 * `catalog_index`) so the comparison rules live in exactly one place:
 *
 * - no cached source → changed (nothing to compare against);
 * - a source from ANOTHER provider says nothing about THIS provider's copy,
 *   whose size/mtime it never saw → changed;
 * - size differs → changed;
 * - `modifiedTime` is compared as parsed instants (epoch ms), not strings, so
 *   `2026-08-17T00:00:00.000Z` and `2026-08-17T00:00:00+00:00` — the same
 *   instant in the different ISO forms providers report — count as unchanged;
 * - an unparseable stamp on either side fails open (treated as changed) rather
 *   than pinning a stale cache forever.
 */
export function sourceStampChanged(
  source: { provider: string; size: number; modifiedTime: string } | undefined,
  cloud: { size: number; modifiedTime: string },
  provider?: string
): boolean {
  if (!source) return true;
  if (provider !== undefined && source.provider !== provider) return true;
  if (source.size !== cloud.size) return true;

  const cachedEpoch = toEpoch(source.modifiedTime);
  const cloudEpoch = toEpoch(cloud.modifiedTime);
  if (cloudEpoch === undefined) return true;
  if (cachedEpoch === undefined) return true;
  return cachedEpoch !== cloudEpoch;
}

/**
 * Should this series' `series.json` be re-downloaded? See `sourceStampChanged`
 * for the rules. Pure — no I/O, so it is cheap to call for every series on every
 * cloud listing.
 */
export function indexNeedsRefresh(
  rec: SeriesIndexRecord | undefined,
  cloud: { size: number; modifiedTime: string },
  provider?: string
): boolean {
  return sourceStampChanged(rec?.source, cloud, provider);
}
