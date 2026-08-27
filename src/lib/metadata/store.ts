import { db } from '$lib/catalog/db';
import { type Readable } from 'svelte/store';
import { keyedTableMap, moveKeyedRecord } from './keyed-table';
import { ID_KEYS } from './sanitize';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from './series-key';
import { hasSeriesFacts, seriesFactsStamp, type SeriesFile } from './series-file';
import {
  createEmptySeriesMetadata,
  toStoredSeriesMetadata,
  type SeriesMetadata,
  type StoredSeriesMetadata
} from './types';

export type SeriesMetadataPatch = Partial<
  Omit<SeriesMetadata, 'series_key' | 'series_title' | 'updated_at'>
>;

/**
 * Either a plain patch, or a function that builds one from the record as it is
 * stored *at write time*. Several writers touch the same record from different
 * places — the series panel's unit correction, the catalog's shelf alignment,
 * a sidecar import — and all write whole objects, so a patch built from a record
 * read earlier would silently undo another's edit. A functional patch is
 * resolved inside the write transaction instead.
 */
export type SeriesMetadataPatchInput =
  | SeriesMetadataPatch
  | ((existing: SeriesMetadata) => SeriesMetadataPatch);

/** Drop `undefined` values so "cleared" fields disappear from IndexedDB and JSON. */
function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function hasAnyId(ids: SeriesMetadata['external_ids'] | undefined): boolean {
  return !!ids && Object.values(ids).some((v) => v != null);
}

function sameExternalIds(
  a: SeriesMetadata['external_ids'] | undefined,
  b: SeriesMetadata['external_ids'] | undefined
): boolean {
  return ID_KEYS.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
}

/**
 * A local edit must always supersede what is already stored, even when the
 * stored record carries a future timestamp (clock skew on another device, a
 * hand-edited cloud file). Plain `now` would lose the newest-wins comparison
 * for as long as that timestamp stays in the future, so step one millisecond
 * past it instead.
 */
function nextTimestamp(existing: string | undefined, now: number = Date.now()): string {
  const previous = existing ? Date.parse(existing) : NaN;
  const stamp = Number.isNaN(previous) ? now : Math.max(now, previous + 1);
  return new Date(stamp).toISOString();
}

/** The shareable facts — everything else on the record is this library's own state. */
const FACT_KEYS = ['external_ids', 'titles', 'synonyms', 'tag', 'unit'] as const;

/**
 * Merge key for the facts, or `undefined` when this library has never had an
 * opinion about the series.
 *
 * A record with no facts and no fact edit in its history carries no facts stamp
 * at all: its `updated_at` only ever tracked per-user state (spine offsets,
 * rereads, tracking), so treating it as a facts stamp would make an empty record
 * outrank a real sidecar. Legacy records that still carry facts fall back to
 * `updated_at`.
 */
export const factsStamp = seriesFactsStamp;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Structural equality, enough for the fact values (ids, titles, synonyms, tag). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => k in b && sameValue(a[k], b[k]));
  }
  return false;
}

/**
 * Does this patch actually change a shareable fact?
 *
 * Only a "yes" may move `facts_updated_at`. A spine-offset nudge, a finished
 * reread or a tracking push all bump `updated_at`, and publishing that stamp as
 * the facts stamp would let a library that never linked the series unlink it on
 * every other device (`buildSeriesFile` compares stamps).
 */
function changesFacts(existing: SeriesMetadata, patch: SeriesMetadataPatch): boolean {
  return FACT_KEYS.some((key) => key in patch && !sameValue(patch[key], existing[key]));
}

/**
 * The INDEX keys — data that rides `series.json`'s volume entries rather than
 * its facts. Changing one has to publish a new sidecar (a shelf alignment is
 * worth sharing) but must never move `facts_updated_at`, which is what decides
 * whose link wins.
 */
const INDEX_KEYS = ['spine_offset', 'volume_offsets'] as const;

function changesIndex(existing: SeriesMetadata, patch: SeriesMetadataPatch): boolean {
  return INDEX_KEYS.some((key) => key in patch && !sameValue(patch[key], existing[key]));
}

type FactsChangeListener = (seriesTitle: string) => void;
const factsChangeListeners = new Set<FactsChangeListener>();

/**
 * Called after a *local fact edit* commits — a link, an unlink, a title,
 * synonyms, the tag or the tracking unit actually changing value. Never for per-user writes
 * (spine offsets, rereads, tracking) and never for `upsertFromSeriesFile`,
 * which applies what a sidecar already says: re-publishing that would be a
 * write loop between devices.
 *
 * A registration hook rather than a direct call so this module stays free of
 * the cloud layer (`series-file-sync` → `unified-cloud-manager` → this store
 * would be a cycle). Returns an unregister function.
 */
export function registerFactsChangeListener(fn: FactsChangeListener): () => void {
  factsChangeListeners.add(fn);
  return () => {
    factsChangeListeners.delete(fn);
  };
}

function notifyFactsChanged(seriesTitle: string): void {
  for (const fn of factsChangeListeners) {
    try {
      fn(seriesTitle);
    } catch (error) {
      console.warn('[series-metadata] facts-change listener failed:', error);
    }
  }
}

type IndexChangeListener = (seriesTitle: string) => void;
const indexChangeListeners = new Set<IndexChangeListener>();

/**
 * Called after a local write that actually changed the shelf alignment
 * (`spine_offset`, `volume_offsets`). The NON-FACTS trigger for the debounced
 * `series.json` writer: the file has to be republished, but nothing about the
 * facts changed, so `facts_updated_at` stays where it was.
 *
 * Never fires for `upsertFromSeriesFile` — that applies what a sidecar already
 * says, and republishing it would be a write loop between devices. Same
 * registration-hook shape as `registerFactsChangeListener`, for the same reason
 * (this module must not import the cloud layer). Returns an unregister function.
 */
export function registerIndexChangeListener(fn: IndexChangeListener): () => void {
  indexChangeListeners.add(fn);
  return () => {
    indexChangeListeners.delete(fn);
  };
}

function notifyIndexChanged(seriesTitle: string): void {
  for (const fn of indexChangeListeners) {
    try {
      fn(seriesTitle);
    } catch (error) {
      console.warn('[series-metadata] index-change listener failed:', error);
    }
  }
}

export async function getSeriesMetadata(seriesKey: string): Promise<SeriesMetadata | undefined> {
  return db.series_metadata.get(seriesKey);
}

export async function getSeriesMetadataForTitle(
  seriesTitle: string
): Promise<SeriesMetadata | undefined> {
  return getSeriesMetadata(normalizeSeriesKey(seriesTitle));
}

/**
 * Every record whose title FOLDS to `seriesTitle`'s fold — the lookup a caller
 * holding a cloud folder name needs, answered off the `folded_key` index.
 *
 * The primary key absorbs case and whitespace but not unicode FORM, so a folder
 * that came back decomposed (NFD) from a filesystem does not `get` the record
 * written from the composed local title. Before this index every such site read
 * the WHOLE table and folded each row in JS; the hottest of them
 * (`hasPublishableFacts`) did it once per series published.
 *
 * Returns an ARRAY, not one record: two records CAN fold alike ("café" stored
 * NFC beside "café" stored NFD are two primary keys, one fold), and which of
 * them wins is the caller's question — `resolveSeriesMetadata` picks by link and
 * recency, `hasPublishableFacts` only asks whether ANY of them has facts.
 */
export async function getSeriesMetadataByFoldedTitle(
  seriesTitle: string
): Promise<StoredSeriesMetadata[]> {
  const key = normalizeVolumeTitleKey(seriesTitle);
  if (!key) return [];
  return db.series_metadata.where('folded_key').equals(key).toArray();
}

/**
 * {@link getSeriesMetadataByFoldedTitle} for MANY titles at once: one index walk
 * covering every fold in `seriesTitles`, rather than one query each or — as
 * before — the whole table.
 *
 * Dexie lowers `anyOf` to a single cursor that SEEKS from key to key, so the
 * cost tracks the number of matching rows, not the size of the table: a library
 * of 1,000 series publishing a catalog for 20 cloud folders deserializes 20
 * records. The upper bound (every record matches) is what the full scan cost
 * unconditionally.
 */
export async function getSeriesMetadataByFoldedTitles(
  seriesTitles: Iterable<string>
): Promise<StoredSeriesMetadata[]> {
  const keys = [...new Set([...seriesTitles].map(normalizeVolumeTitleKey))].filter(Boolean);
  if (keys.length === 0) return [];
  return db.series_metadata.where('folded_key').anyOf(keys).toArray();
}

/**
 * Upsert: merges `patch` into the existing record (or a fresh one) and stamps
 * updated_at.
 *
 * Read and write happen inside one `rw` transaction, so a concurrent writer
 * cannot slip a `put` between them (IndexedDB runs overlapping `readwrite`
 * transactions one after another). Pass a function for `patch` to build it from
 * the record as it is at that moment — see `SeriesMetadataPatchInput`.
 */
export async function updateSeriesMetadata(
  seriesTitle: string,
  patch: SeriesMetadataPatchInput
): Promise<SeriesMetadata> {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) {
    // A blur-triggered save (title/synonyms/tag fields) can fire after its owning modal
    // has already cleared the series it was editing — e.g. Escape closing the series
    // editor while a text field still has focus. Writing here would create a junk
    // `series_metadata` row keyed `""` and silently discard the edit. No-op + warn
    // instead of throwing: the callers are fire-and-forget blur handlers, and throwing
    // would surface as an unhandled promise rejection there.
    console.warn('updateSeriesMetadata: ignoring a write with a blank series title');
    return createEmptySeriesMetadata(seriesTitle);
  }
  let factsChanged = false;
  let indexChanged = false;
  const next = await db.transaction('rw', db.series_metadata, async () => {
    const stored = await db.series_metadata.get(key);
    const updated_at = nextTimestamp(stored?.updated_at);
    const existing = stored ?? createEmptySeriesMetadata(seriesTitle, updated_at);
    const resolved = typeof patch === 'function' ? patch(existing) : patch;
    factsChanged = changesFacts(existing, resolved);
    indexChanged = changesIndex(existing, resolved);
    const written = toStoredSeriesMetadata(
      stripUndefined<SeriesMetadata>({
        ...existing,
        ...resolved,
        series_key: key,
        series_title: seriesTitle,
        updated_at,
        // A fact edit — including an unlink, which empties the facts deliberately —
        // is the only thing that may move this clock.
        facts_updated_at: factsChanged ? updated_at : stored ? factsStamp(stored) : undefined
      })
    );
    await db.series_metadata.put(written);
    return written;
  });

  // After the commit, so a listener that reads the record back sees this write.
  // A patch that touches both a fact and an index key fires both listeners here —
  // downstream, both resolve to the same per-series debounced write, so that
  // still costs one PUT, not two (see `registerIndexChangeListener`).
  if (factsChanged) notifyFactsChanged(seriesTitle);
  if (indexChanged) notifyIndexChanged(seriesTitle);
  return next;
}

/**
 * Remove the external link and the facts it brought; keep everything this
 * library owns — `tag`, the shelf alignment, `unit` (it describes the archives
 * in the folder, not the link that was just removed). (The reading state was
 * never on this record — it lives in `$lib/settings/series-data` — so unlinking
 * cannot touch it.)
 */
export async function unlinkSeries(seriesTitle: string): Promise<SeriesMetadata> {
  return updateSeriesMetadata(seriesTitle, {
    external_ids: {},
    titles: {},
    synonyms: [],
    linked_at: undefined
  });
}

/**
 * Apply the metadata facts from a `series.json` sidecar. Newest wins: only
 * writes when there is no local record or the file's stamp is strictly newer
 * than the local *facts* stamp — not the record's `updated_at`, which every
 * per-user write bumps. The volume index is not touched here at all: it is
 * cached separately (`series_index`) and never overrides local volumes. Returns
 * whether the record was actually written.
 *
 * A file with no facts at all and no local record to update is ignored
 * outright: an index-only sidecar (written by a device that never linked the
 * series) says nothing about the facts, so creating an empty record from it
 * would publish that emptiness through the root metadata merge and unlink the
 * series on the devices that DID link it. Against an existing record the same
 * file still has to win on a strictly-newer facts stamp, which is what makes a
 * deliberate unlink — a factless file carrying a real stamp — propagate.
 *
 * Read and write share one `rw` transaction so a concurrent writer cannot slip
 * a `put` between them, same as `updateSeriesMetadata`.
 *
 * **Shelf alignment is not applied here.** `spine_offset` and the per-entry
 * `offset` ride the file as INDEX data, and this record stores only what THIS
 * user edited. A published alignment reaches the shelf as a JOIN at display
 * time — `getSpineOffsets` reads `record value ?? cached-index value` against
 * the `series_index` copy of this same file — and rides back out through
 * `buildSeriesFile`, which carries the existing file's offsets through wherever
 * the record has none. Copying them in here instead would convert inheritance
 * into ownership: this device would republish another's measurement as its own
 * forever, so their later correction (or reset) could never win — the two
 * devices would just flip-flop.
 *
 * Applying facts is gated on either side actually HAVING facts, not merely on
 * the record existing: without that gate the upsert of a factless offsets-only
 * file would stamp `facts_updated_at` with the file's epoch — a facts clock this
 * library never earned, which would then be published as a real "no opinion"
 * claim. With the gate the record keeps no facts clock at all, so
 * `buildSeriesFile` still treats this library as having no opinion.
 *
 * A record that DOES already carry a clock is the opposite case: it has had an
 * opinion, so it must relay a newer factless stamp even though it has no facts
 * to apply. Skipping that would strand an unlink behind a factless device (see
 * `adoptFactlessStamp`).
 *
 * That is also what makes the exchange converge: an offsets-only file changes
 * nothing and returns `false` on every read — so an importer that schedules a
 * `series.json` write on `true` never writes for one.
 */
export async function upsertFromSeriesFile(
  seriesTitle: string,
  file: SeriesFile
): Promise<boolean> {
  const key = normalizeSeriesKey(seriesTitle);
  return db.transaction('rw', db.series_metadata, async () => {
    const existing = await db.series_metadata.get(key);
    const next = mergeSeriesFileInto(seriesTitle, file, existing);
    if (!next) return false;
    await db.series_metadata.put(toStoredSeriesMetadata(next));
    return true;
  });
}

/**
 * The merge behind `upsertFromSeriesFile`, as a PURE function: given the record
 * as stored (or `undefined`), what the record becomes — or `undefined` when the
 * file changes nothing and no write is owed.
 *
 * Split out from the write so a caller holding MANY files can resolve all of
 * them against one read and write them in one batch (`upsertManyFromSeriesFiles`)
 * instead of one transaction per file. Every rule the doc comment on
 * `upsertFromSeriesFile` describes lives here; that function is now just the
 * one-record read/merge/write around it.
 *
 * Throws for a malformed `file` (a non-array `synonyms`, a missing stamp) rather
 * than guessing — the batch caller catches per entry, which is what keeps one
 * junk entry from costing the others.
 */
export function mergeSeriesFileInto(
  seriesTitle: string,
  file: SeriesFile,
  existing: SeriesMetadata | undefined
): SeriesMetadata | undefined {
  const key = normalizeSeriesKey(seriesTitle);
  // No local facts stamp = no local opinion, so any sidecar with facts applies.
  const localStamp = existing ? factsStamp(existing) : undefined;
  const stampWins = localStamp === undefined || localStamp < file.updated_at;
  // Neither side has facts = there are no facts to apply, so the facts branch
  // (and the `facts_updated_at` stamp it writes) is skipped entirely. This
  // covers both an index-only file for a series we hold no record for —
  // creating an empty record from it would publish that emptiness — and a
  // repeat visit to an offsets-only file, which must not mint a facts clock
  // out of the file's epoch stamp.
  const applyFacts =
    stampWins && (hasSeriesFacts(file) || (!!existing && hasSeriesFacts(existing)));
  // Neither side has facts, but this library HAS had an opinion before (it
  // unlinked at some point) and the file's is newer: adopt the newer clock.
  // Without this, a factless relay device strands somebody else's unlink —
  // A unlinks at T2, B is factless at T1 so it applies nothing and keeps
  // republishing T1, and C (linked at T1.5) compares `T1.5 < T1` → false and
  // never learns about the unlink. A record with NO clock still mints none:
  // it has never had an opinion, so there is nothing to relay.
  const adoptFactlessStamp =
    !applyFacts && localStamp !== undefined && localStamp < file.updated_at;
  if (!applyFacts && !adoptFactlessStamp) return undefined;

  const base = existing ?? createEmptySeriesMetadata(seriesTitle, file.updated_at);
  const linked = hasAnyId(file.external_ids);
  const linkChanged = !sameExternalIds(base.external_ids, file.external_ids);
  return stripUndefined<SeriesMetadata>({
    ...base,
    series_key: key,
    series_title: seriesTitle,
    ...(applyFacts
      ? {
          external_ids: { ...file.external_ids },
          titles: { ...file.titles },
          synonyms: [...file.synonyms],
          tag: file.tag,
          unit: file.unit,
          // The record's own stamp never moves backwards: `moveSeriesMetadataKey`
          // resolves a rename collision by it, and lowering it to an older file
          // stamp would let a pre-link copy of the record win that comparison.
          updated_at: file.updated_at > base.updated_at ? file.updated_at : base.updated_at,
          facts_updated_at: file.updated_at,
          linked_at: linked
            ? linkChanged
              ? file.updated_at
              : (base.linked_at ?? file.updated_at)
            : undefined
        }
      : {}),
    ...(adoptFactlessStamp ? { facts_updated_at: file.updated_at } : {})
  });
}

/** One `series.json`-shaped set of facts and the series it belongs to. */
export interface SeriesFileUpsert {
  seriesTitle: string;
  file: SeriesFile;
}

/**
 * `upsertFromSeriesFile` for a whole batch: ONE read, the merge for every entry
 * resolved in memory, ONE `bulkPut`. Returns how many records were written.
 *
 * WHY THIS EXISTS. `series_metadata` backs a `liveQuery` the catalog joins, and
 * Dexie broadcasts `storagemutated` once per readwrite COMMIT — so on this table
 * a commit is a change signal is a full catalog re-derive (an O(V) group over
 * every volume plus a per-series sort). A catalog refresh applies one entry per
 * series in the library; at ~1k series, a commit per entry is ~1k re-derives for
 * one sync. Batched it is one.
 *
 * ONE `bulkPut`, NOT CHUNKED. The rows are small fact records — ids, titles,
 * synonyms, a tag, three stamps; no blobs — so even a few thousand of them is a
 * fraction of a megabyte in a single transaction, and chunking would buy nothing
 * while costing exactly what this function exists to avoid: one commit, and so
 * one full re-derive, per chunk.
 *
 * PER-ENTRY ERROR ISOLATION, on both halves:
 *
 * - the MERGE runs per entry inside a `try`, so a malformed file is dropped from
 *   the batch (and reported to `onEntryError`) instead of throwing the run away;
 * - the WRITE cannot rely on `bulkPut` for that. Dexie recovers from a failed
 *   put REQUEST, but a value IndexedDB cannot structured-clone throws
 *   SYNCHRONOUSLY out of `IDBObjectStore.put`, before any request exists, and
 *   `bulkPut` does not survive that: measured on a 10-row bulk with junk at
 *   index 5, standalone it committed rows 0-4 and silently dropped 6-9, and
 *   inside an enclosing transaction (as here) letting that rejection escape
 *   aborts the transaction and loses ALL ten. So the `bulkPut` is caught, and
 *   falls back to a per-row pass THROUGH THE SAME, still-live transaction with
 *   each put caught on its own. The bad row is the only casualty, and the run
 *   still costs one commit.
 *
 * The read and the write share one `rw` transaction, same as
 * `upsertFromSeriesFile`, so a concurrent writer cannot slip a `put` between
 * them. Nothing here is nested in a sub-transaction — that is what makes
 * catching an error survivable (see `catalog-index-sync.ts`).
 *
 * Does NOT notify the facts/index listeners, for the same reason
 * `upsertFromSeriesFile` does not: these facts came FROM a sidecar, and
 * republishing them would be a write loop between devices.
 */
export async function upsertManyFromSeriesFiles(
  entries: readonly SeriesFileUpsert[],
  onEntryError?: (seriesTitle: string, error: unknown) => void
): Promise<number> {
  if (entries.length === 0) return 0;

  return db.transaction('rw', db.series_metadata, async () => {
    // One `getAll`, not one keyed `get` per entry: a refresh touches roughly
    // every series in the library, so the whole (small, blob-free) table is
    // cheaper than N round trips — and Dexie lowers `bulkGet` to one
    // `IDBObjectStore.get` PER KEY, which is the storm in a different costume.
    const stored = new Map<string, SeriesMetadata>(
      (await db.series_metadata.toArray()).map((row) => [row.series_key, row])
    );

    // Keyed, so two entries that normalize to the same series merge onto each
    // other in order rather than racing as two rows in one `bulkPut`.
    const pending = new Map<string, SeriesMetadata>();
    for (const entry of entries) {
      try {
        const key = normalizeSeriesKey(entry.seriesTitle);
        const next = mergeSeriesFileInto(entry.seriesTitle, entry.file, stored.get(key));
        if (!next) continue;
        stored.set(next.series_key, next);
        pending.set(next.series_key, next);
      } catch (error) {
        onEntryError?.(entry.seriesTitle, error);
      }
    }

    const rows = [...pending.values()].map(toStoredSeriesMetadata);
    if (rows.length === 0) return 0;

    try {
      await db.series_metadata.bulkPut(rows);
      return rows.length;
    } catch (bulkError) {
      // Catching it here is what keeps the transaction alive; letting it escape
      // would abort the whole thing (see the note above). The bulk stopped at
      // the bad row, so everything after it was never attempted — replay row by
      // row, idempotent for the ones that already landed.
      console.warn('[series-metadata] batch write failed, retrying row by row:', bulkError);
      let written = 0;
      for (const row of rows) {
        try {
          await db.series_metadata.put(row);
          written++;
        } catch (error) {
          onEntryError?.(row.series_title, error);
        }
      }
      return written;
    }
  });
}

/**
 * After a series rename: carry the record to the new key (newer record wins on
 * collision, by the record's own `updated_at`).
 *
 * The move itself is `moveKeyedRecord`, shared with `series_index` — the two
 * used to be byte-identical routines differing only in the tiebreak field.
 * `rekey` re-stamps `folded_key`, which is derived from the title the rename
 * just changed.
 */
export async function moveSeriesMetadataKey(oldTitle: string, newTitle: string): Promise<void> {
  await moveKeyedRecord(db.series_metadata, oldTitle, newTitle, {
    tiebreak: (record) => record.updated_at,
    rekey: (record, series_key, series_title) =>
      toStoredSeriesMetadata({ ...record, series_key, series_title })
  });
}

/**
 * The whole table, keyed by primary key.
 *
 * THE LAST WHOLE-TABLE READ, and deliberately so. The four sites that used to
 * scan here all wanted a lookup by folded title and are now index reads
 * ({@link getSeriesMetadataByFoldedTitle}). The one remaining caller —
 * `syncAllSeriesNow`, the "sync all linked series now" button — wants a
 * different question entirely ("which records carry an AniList id"), and it is
 * not worth a second index: it fires once per click, on the way into N
 * SEQUENTIAL network round trips with a deliberate rate-limit sleep between
 * them, so the scan is invisible next to what follows it. The rows are small and
 * blob-free, and a sparse index over the nested `external_ids.anilist` key path
 * would have to be maintained on every write of every record to save it.
 */
export async function getAllSeriesMetadata(): Promise<Record<string, SeriesMetadata>> {
  const rows = await db.series_metadata.toArray();
  return Object.fromEntries(rows.map((r) => [r.series_key, r]));
}

export async function replaceAllSeriesMetadata(
  records: Record<string, SeriesMetadata>
): Promise<void> {
  await db.series_metadata.bulkPut(Object.values(records).map(toStoredSeriesMetadata));
}

/** Reactive view of the whole table, keyed by series_key. Empty Map before first emission. */
export const seriesMetadataMap: Readable<Map<string, SeriesMetadata>> = keyedTableMap(
  () => db.series_metadata,
  'series_key'
);
