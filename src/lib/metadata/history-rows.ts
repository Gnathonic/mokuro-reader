import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { materializeSeriesVolumes } from '$lib/catalog/materialize';
import { volumes as progressStore } from '$lib/settings/volume-data';
import { hasReadingActivity, type ReadingHistoryEntry } from '$lib/settings/reading-activity';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { listSeriesIndexes, type SeriesIndexRecord } from './series-index';
import { normalizeSeriesKey } from './series-key';
import type { SeriesFileVolume } from './series-file';

/**
 * Volumes given a row per run.
 *
 * The set this sweep works from is bounded by the user's own reading history,
 * not by the size of their library: a 12,520-file cloud account with 2,075
 * progress entries yields at most 2,075 candidates, and the ~726 of those with
 * genuine activity is the number that matters. So the cap is generous enough
 * that a real library drains in ONE run — a sweep that needed twenty page
 * loads to finish would leave the stats views wrong for most of them — while
 * still refusing to be unbounded: a pathological store drains over successive
 * runs instead of building one enormous transaction.
 */
export const MAX_HISTORY_ROWS_PER_RUN = 1000;

/**
 * Series touched per run.
 *
 * A SECOND cap, because the two costs are not the same shape. Rows are cheap
 * and local; each series costs a `cloudVolumeTitlesFor` lookup, and that is
 * the one genuinely superlinear thing this sweep does — only the Google Drive
 * cache answers it from a Map (`currentCache.get(seriesTitle)`); the MEGA,
 * OneDrive and local-folder caches all walk the WHOLE listing per call, twice
 * (`resolveCloudFolderTitle` then `cloudVolumeTitles`). On a 12,520-file
 * account that is ~25k string comparisons per series. 200 series bounds the
 * first sweep at ~5M comparisons — tens of milliseconds, once, off the render
 * path — where the row cap alone would have allowed five times that. A real
 * library is nowhere near it (726 read volumes spread over well under 200
 * series), so this only ever bites the pathological case, and even then it
 * drains over successive runs.
 */
export const MAX_HISTORY_SERIES_PER_RUN = 200;

/** The fields this module reads off a reading-state entry, structurally. */
type ProgressRecord = ReadingHistoryEntry & {
  deletedOn?: string;
  series_title?: string;
};

/**
 * Uuids a run PLANNED and still failed to give a row.
 *
 * WHY THIS EXISTS. Both caps are spent at PLAN time, but a planned uuid is not
 * a written row: `materializeSeriesVolumes` skips an entry whose uuid belongs
 * to another series (rule 0) or whose title a local row already owns (rule 2),
 * and a whole batch is dropped before the transaction when
 * `cloudVolumeTitlesFor` reports an empty listing for its series — the state of
 * every index cached from a provider that is no longer the connected one, which
 * `runRefresh` deliberately never cleans. Iteration order over the progress
 * store is stable, so without this set those uuids are re-planned in the same
 * order on every run, spend the same slots, and everything behind them is
 * starved FOREVER: 200 such series is all it takes to make the series cap
 * unreachable for a series that WOULD materialize.
 *
 * SESSION-SCOPED, cleared only by a page load, matching the same contract
 * `hole-patch.ts` uses for its own attempt memory. The trade-off is deliberate:
 * a uuid that only becomes materializable later in the SAME session (a provider
 * switch bringing a different listing) waits for the next load rather than
 * re-entering the plan on every sweep. A uuid that gains a row by any other
 * route is not affected at all — step 2 drops it before this set is ever
 * consulted.
 */
const unmaterializableThisSession = new Set<string>();

/** Test-only: clears the session memory so cases don't leak into each other. */
export function resetHistoryRowsSessionForTests(): void {
  unmaterializableThisSession.clear();
}

/**
 * Give every volume the user has actually read a `volumes` row.
 *
 * WHY THIS EXISTS. Synced progress is keyed by `volume_uuid` and travels
 * without the catalog. A device that has read 726 volumes across other
 * machines — or that has had its database rebuilt — holds 726 reading records
 * and, until it happens to OPEN each of those series, no rows at all. Every
 * stats and history surface joins progress against the `volumes` table, so
 * those volumes show up with no title, no series and no counts; in
 * `reading-speed-history.ts` they collapse into a single fake
 * `[Missing Series Info]` series, and `ReadingSpeedView` then offers that
 * series' whole bucket for deletion. Real reading history is one click from
 * being tombstoned. The row is what prevents all of it.
 *
 * WHAT IT DOES NOT DO. It writes METADATA-ONLY rows and never a thumbnail:
 * covers are resolved per surface by cloud path through `acquireCover`
 * (`cover-resolver.ts`) out of the `cloud_covers` table, and blobs on
 * `volumes` rows are exactly the cost a whole plan just removed. It also does
 * not materialize a series wholesale the way `openSeries` does — only the
 * volumes with activity earn a row, so the table stays near the ~726 the
 * history justifies rather than ballooning to every sibling volume of every
 * series the user ever touched. The catalog scans this table whole, so row
 * count is a running cost, not a one-off.
 *
 * HOW A VOLUME IS IDENTIFIED. Purely by `volume_uuid`, resolved against the
 * cached `series.json` indexes (`series_index`). This is the answer to the
 * legacy case: `series_title` is OPTIONAL on a reading-state entry and is only
 * backfilled lazily on write, so an entry written before that existed carries
 * a uuid and nothing else — invisible forever to anything that keys off the
 * title. The uuid, though, is exactly what a `series.json` entry is keyed by,
 * and the listing-wide index refresh (`series-index-sync.ts`) caches a
 * `series.json` for EVERY folder in the account. A stored `series_title` is
 * therefore not needed at all; it survives only as a tie-breaker for the rare
 * uuid two series both claim (a re-OCR, or the same archive uploaded twice).
 *
 * THE LIMIT OF THAT. It is the CACHED INDEX that makes a legacy entry
 * reachable, not the uuid on its own — so an entry with no `series_title` whose
 * series has no cached `series.json` is served by neither this sweep (nothing
 * lists its uuid) nor `patchProgressHoles`' network phase (which pulls by name
 * and has no name to pull). That is not a regression — such an entry was
 * unreachable before too — but "legacy entries are now reachable" is true only
 * once the index refresh has cached a `series.json` for that series' folder,
 * which for an account still connected happens on its own and for a series long
 * gone from the cloud never does.
 *
 * WORST-CASE WORK. One `getAllKeys` on `volumes` (primary keys only — no row,
 * and above all no thumbnail blob, is deserialized), one `series_index` read
 * (SHARED with `patchProgressHoles`' second phase when it supplies
 * `readIndexes`, so a full sweep reads `series_index` once, not twice), one
 * in-memory pass over its entries, and — only when there is something to
 * write — ONE `volumes` readwrite transaction for the whole sweep, inside which
 * a second keys-only read (bounded by what the run planned, not by the table)
 * settles which planned uuids actually got a row. The
 * per-series `materializeSeriesVolumes` calls nest inside it, which Dexie
 * collapses into a single commit, so N series cost ONE `storagemutated`
 * broadcast and therefore ONE catalog re-derive rather than N. Zero network:
 * everything it reads is already on the device. A run with nothing to do opens
 * no write transaction at all, and a readwrite transaction that writes nothing
 * broadcasts nothing (both verified).
 *
 * Best-effort throughout: never rejects, never surfaces UI. Returns the number
 * of rows created or filled.
 */
export async function materializeHistoryRows(options?: {
  limit?: number;
  seriesLimit?: number;
  /**
   * How to read the cached `series.json` indexes. Defaults to
   * `listSeriesIndexes`; `patchProgressHoles` passes a lazy, memoized reader so
   * its two phases share ONE `series_index` read instead of issuing one each,
   * while a run that bails before either phase asks still issues none.
   */
  readIndexes?: () => Promise<SeriesIndexRecord[]>;
}): Promise<number> {
  const limit = options?.limit ?? MAX_HISTORY_ROWS_PER_RUN;
  const seriesLimit = options?.seriesLimit ?? MAX_HISTORY_SERIES_PER_RUN;
  const readIndexes = options?.readIndexes ?? listSeriesIndexes;

  try {
    // 1. Which volumes has the user actually read? ONE shared predicate,
    //    imported rather than re-implemented — see `reading-activity.ts`.
    const progress = get(progressStore) as Record<string, ProgressRecord> | undefined;
    const wanted = new Map<string, string | undefined>();
    for (const [uuid, record] of Object.entries(progress ?? {})) {
      if (!uuid || !record || record.deletedOn) continue;
      if (!hasReadingActivity(record)) continue;
      // Already proved unplannable this session — see
      // `unmaterializableThisSession`. Dropped here, before anything is read,
      // so it costs neither a cap slot nor a lookup.
      if (unmaterializableThisSession.has(uuid)) continue;
      wanted.set(uuid, typeof record.series_title === 'string' ? record.series_title : undefined);
    }
    if (wanted.size === 0) return 0;

    // 2. Drop the ones that already have a row. PRIMARY KEYS ONLY: a
    //    `db.volumes.toArray()` here would deserialize every installed
    //    volume's thumbnail blob to answer a question about keys (see
    //    `perf-contracts.test.ts` CONTRACT 2).
    for (const key of await db.volumes.toCollection().primaryKeys()) {
      wanted.delete(String(key));
    }
    // The steady state after one successful sweep: nothing left, and the
    // index cache is never even read.
    if (wanted.size === 0) return 0;

    // 3. Resolve uuid → the cached index that lists it. Built over the WANTED
    //    uuids only, so the map holds hundreds of keys on a library whose
    //    indexes hold tens of thousands of entries.
    const indexes = await readIndexes();
    if (indexes.length === 0) return 0;

    const candidates = new Map<string, SeriesIndexRecord[]>();
    for (const record of indexes) {
      for (const volume of record.file?.volumes ?? []) {
        const uuid = volume?.volume_uuid;
        if (!uuid || !wanted.has(uuid)) continue;
        const existing = candidates.get(uuid);
        if (existing) existing.push(record);
        else candidates.set(uuid, [record]);
      }
    }
    if (candidates.size === 0) return 0;

    // 4. Group the wanted uuids by the series that will materialize them.
    const plan = new Map<string, { record: SeriesIndexRecord; uuids: Set<string> }>();
    // Every uuid that SPENT a slot. Both caps are charged here, at plan time,
    // but a plan entry is not a row — so whatever is still row-less when this
    // run ends is remembered as unmaterializable and never charged again. See
    // `unmaterializableThisSession`.
    const plannedUuids = new Set<string>();
    for (const [uuid, storedTitle] of wanted) {
      if (plannedUuids.size >= limit) break;
      const record = pickSeriesFor(candidates.get(uuid), storedTitle);
      if (!record) continue;
      let slot = plan.get(record.series_key);
      if (!slot) {
        // A series already in the plan costs nothing more; a NEW one costs a
        // listing lookup, which is what `seriesLimit` bounds. Skipping the
        // uuid rather than breaking out lets the series already planned keep
        // filling, and the skipped ones are picked up by the next run.
        if (plan.size >= seriesLimit) continue;
        slot = { record, uuids: new Set() };
        plan.set(record.series_key, slot);
      }
      slot.uuids.add(uuid);
      plannedUuids.add(uuid);
    }
    if (plannedUuids.size === 0) return 0;

    // 5. Turn the plan into materialization batches, dropping the ones that
    //    would be no-ops, so a sweep with nothing to write never opens a
    //    readwrite transaction. The listing gate is
    //    `materializeSeriesVolumes`' own rule (a stale index must not
    //    resurrect a deleted volume); it is checked here as well only to
    //    decide whether the transaction is worth opening.
    const batches: Array<{
      seriesTitle: string;
      entries: SeriesFileVolume[];
      cloudVolumeTitles: Set<string>;
    }> = [];
    for (const { record, uuids } of plan.values()) {
      const entries = (record.file?.volumes ?? []).filter((volume) =>
        uuids.has(volume?.volume_uuid)
      );
      if (entries.length === 0) continue;
      // The index record's OWN title, not the reading record's: it is the
      // cloud folder's spelling, which is what `cloudVolumeTitlesFor`
      // resolves against and what every other index-driven write uses.
      const cloudVolumeTitles = unifiedCloudManager.cloudVolumeTitlesFor(record.series_title);
      if (cloudVolumeTitles.size === 0) continue;
      batches.push({ seriesTitle: record.series_title, entries, cloudVolumeTitles });
    }
    if (batches.length === 0) {
      // Not one planned series has a listing to check against, so nothing this
      // run planned can ever be written from what is on the device. Recording
      // it here is what stops those uuids re-spending both caps on every
      // subsequent sweep and starving the series behind them.
      for (const uuid of plannedUuids) unmaterializableThisSession.add(uuid);
      return 0;
    }

    // 6. ONE transaction for the whole sweep. `materializeSeriesVolumes` opens
    //    its own `rw` transaction over `volumes`; opened inside this one,
    //    Dexie reuses the parent instead of starting a new one, so the sweep
    //    commits once. That is the difference between one catalog re-derive
    //    and one per series — measured: 4 nested calls issue
    //    `tx.volumes.readwrite: 1`, the same 4 unnested issue 4.
    return await db.transaction('rw', db.volumes, async () => {
      let changed = 0;
      for (const batch of batches) changed += await materializeSeriesVolumes(batch);

      // Which planned uuids came out of this with a row? Step 2 established
      // that NONE of them had one going in, so "has a row now" is exactly "this
      // sweep wrote it". The rest were dropped by the listing gate above or by
      // `materializeSeriesVolumes`' own rules 0/2 (uuid owned by another
      // series; volume title already owned by a local row) and would be planned
      // again, identically, forever. KEYS ONLY, and bounded by what this run
      // planned rather than by the table: the question is about keys, and a
      // value read here would deserialize the thumbnail of every installed row
      // a rule-0 collision named.
      const resolved = new Set(
        (
          await db.volumes
            .where(':id')
            .anyOf([...plannedUuids].sort())
            .primaryKeys()
        ).map(String)
      );
      for (const uuid of plannedUuids) {
        if (!resolved.has(uuid)) unmaterializableThisSession.add(uuid);
      }
      return changed;
    });
  } catch (error) {
    console.debug('[history-rows] sweep failed:', error);
    return 0;
  }
}

/**
 * Which cached index should materialize this uuid?
 *
 * Almost always exactly one lists it. When two do — the same archive uploaded
 * under two series, or a volume re-OCR'd elsewhere keeping its uuid — the
 * reading record's own `series_title` breaks the tie if it names one of them;
 * otherwise the first in `series_index` primary-key order wins, which is at
 * least stable across runs so the row does not flip series on every sweep.
 */
function pickSeriesFor(
  records: SeriesIndexRecord[] | undefined,
  storedTitle: string | undefined
): SeriesIndexRecord | undefined {
  if (!records || records.length === 0) return undefined;
  if (records.length === 1) return records[0];
  const key = storedTitle ? normalizeSeriesKey(storedTitle) : '';
  if (key) {
    const preferred = records.find((record) => record.series_key === key);
    if (preferred) return preferred;
  }
  return records[0];
}
