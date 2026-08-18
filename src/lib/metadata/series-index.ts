import { db } from '$lib/catalog/db';
import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { normalizeSeriesKey } from './series-key';
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
 * After a series rename: carry the cached index to the new key. Mirrors
 * `moveSeriesMetadataKey` (`store.ts`) — on a collision the newer `fetched_at`
 * wins rather than the record being merged, since the index is a disposable
 * cache: the loser is simply re-fetched later if it was actually the fresher
 * cloud copy.
 */
export async function moveSeriesIndexKey(oldTitle: string, newTitle: string): Promise<void> {
  const oldKey = normalizeSeriesKey(oldTitle);
  const newKey = normalizeSeriesKey(newTitle);

  await db.transaction('rw', db.series_index, async () => {
    const oldRec = await db.series_index.get(oldKey);
    if (!oldRec) return;

    if (oldKey === newKey) {
      await db.series_index.put({ ...oldRec, series_title: newTitle });
      return;
    }

    const newRec = await db.series_index.get(newKey);
    const winner: SeriesIndexRecord =
      newRec && newRec.fetched_at > oldRec.fetched_at
        ? newRec
        : { ...oldRec, series_key: newKey, series_title: newTitle };
    await db.series_index.put(winner);
    await db.series_index.delete(oldKey);
  });
}

/** Reactive view of the whole table, keyed by series_key. Empty Map before first emission. */
export const seriesIndexMap: Readable<Map<string, SeriesIndexRecord>> = readable(
  new Map<string, SeriesIndexRecord>(),
  (set) => {
    const subscription = liveQuery(() => db.series_index.toArray()).subscribe({
      next: (rows) => set(new Map(rows.map((r) => [r.series_key, r]))),
      error: (err) => console.error('series_index liveQuery failed:', err)
    });
    return () => subscription.unsubscribe();
  }
);

/** Epoch ms for a timestamp, or `undefined` when it does not parse. */
function toEpoch(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Should this series' `series.json` be re-downloaded?
 *
 * True when there is no cached record, when the record was cached from another
 * source than `provider` (see below), or when the cloud file's `size` or
 * `modifiedTime` differs from what the cached record was fetched at.
 * `modifiedTime` is compared as parsed instants (epoch ms), not strings, so
 * e.g. `2026-08-17T00:00:00.000Z` and `2026-08-17T00:00:00+00:00` — the same
 * instant in different ISO representations, which different providers may
 * report — count as unchanged rather than triggering a spurious refetch. An
 * unparseable cloud `modifiedTime` fails open (treated as changed) since a
 * provider bug there shouldn't permanently pin a stale cache.
 *
 * Pure — no I/O, so it is cheap to call for every series on every cloud listing.
 */
export function indexNeedsRefresh(
  rec: SeriesIndexRecord | undefined,
  cloud: { size: number; modifiedTime: string },
  provider?: string
): boolean {
  if (!rec) return true;
  // A record cached from somewhere else — a local import, or another provider's
  // account — says nothing about THIS provider's copy, whose size/mtime it never
  // saw. Treat it as stale so the cloud file is actually fetched.
  if (provider !== undefined && rec.source.provider !== provider) return true;
  if (rec.source.size !== cloud.size) return true;

  const cachedEpoch = toEpoch(rec.source.modifiedTime);
  const cloudEpoch = toEpoch(cloud.modifiedTime);
  if (cloudEpoch === undefined) return true;
  if (cachedEpoch === undefined) return true;
  return cachedEpoch !== cloudEpoch;
}
