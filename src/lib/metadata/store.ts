import { db } from '$lib/catalog/db';
import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { ID_KEYS } from './sanitize';
import { normalizeSeriesKey } from './series-key';
import { seriesFactsStamp, type SeriesFile } from './series-file';
import { createEmptySeriesMetadata, type SeriesMetadata } from './types';

export type SeriesMetadataPatch = Partial<
  Omit<SeriesMetadata, 'series_key' | 'series_title' | 'updated_at'>
>;

/**
 * Either a plain patch, or a function that builds one from the record as it is
 * stored *at write time*. Two writers touch the same record from different
 * places — the progress tracker (`tracking.last_pushed`) and the series panel
 * (`tracking.enabled` / `unit` / `read_count`) — and both write whole objects,
 * so a patch built from a record read earlier would silently undo the other's
 * edit. A functional patch is resolved inside the write transaction instead.
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
const FACT_KEYS = ['external_ids', 'titles', 'synonyms', 'tag'] as const;

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
 * reread, a tracking push or a title-preference toggle all bump `updated_at`, and
 * publishing that stamp as the facts stamp would let a library that never linked
 * the series unlink it on every other device (`buildSeriesFile` compares stamps).
 */
function changesFacts(existing: SeriesMetadata, patch: SeriesMetadataPatch): boolean {
  return FACT_KEYS.some((key) => key in patch && !sameValue(patch[key], existing[key]));
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
  return db.transaction('rw', db.series_metadata, async () => {
    const stored = await db.series_metadata.get(key);
    const updated_at = nextTimestamp(stored?.updated_at);
    const existing = stored ?? createEmptySeriesMetadata(seriesTitle, updated_at);
    const resolved = typeof patch === 'function' ? patch(existing) : patch;
    const next = stripUndefined<SeriesMetadata>({
      ...existing,
      ...resolved,
      series_key: key,
      series_title: seriesTitle,
      updated_at,
      // A fact edit — including an unlink, which empties the facts deliberately —
      // is the only thing that may move this clock.
      facts_updated_at: changesFacts(existing, resolved)
        ? updated_at
        : stored
          ? factsStamp(stored)
          : undefined
    });
    await db.series_metadata.put(next);
    return next;
  });
}

/** Remove the external link + fetched facts; keep user preferences/tag/read_count/tracking. */
export async function unlinkSeries(seriesTitle: string): Promise<SeriesMetadata> {
  return updateSeriesMetadata(seriesTitle, {
    external_ids: {},
    titles: {},
    synonyms: [],
    format: undefined,
    status: undefined,
    total_volumes: undefined,
    total_chapters: undefined,
    cover_url: undefined,
    linked_at: undefined
  });
}

/**
 * Apply the metadata facts from a `series.json` sidecar. Newest wins: only
 * writes when there is no local record or the file's stamp is strictly newer
 * than the local *facts* stamp — not the record's `updated_at`, which every
 * per-user write bumps. The volume index is not touched here: it is cached
 * separately and never overrides local volumes.
 *
 * The file carries no fetched facts (`format`/`status`/totals/`cover_url`), so
 * when it points at a *different* external link than the local record those
 * facts describe the old link and are cleared — otherwise a re-link would keep
 * e.g. the previous series' `total_volumes` forever.
 *
 * Read and write share one `rw` transaction so a concurrent writer cannot slip
 * a `put` between them, same as `updateSeriesMetadata`.
 */
export async function upsertFromSeriesFile(seriesTitle: string, file: SeriesFile): Promise<void> {
  const key = normalizeSeriesKey(seriesTitle);
  await db.transaction('rw', db.series_metadata, async () => {
    const existing = await db.series_metadata.get(key);
    // No local facts stamp = no local opinion, so any sidecar with facts applies.
    const localStamp = existing ? factsStamp(existing) : undefined;
    if (localStamp !== undefined && localStamp >= file.updated_at) return;

    const base = existing ?? createEmptySeriesMetadata(seriesTitle, file.updated_at);
    const linked = hasAnyId(file.external_ids);
    const linkChanged = !sameExternalIds(base.external_ids, file.external_ids);
    const next = stripUndefined<SeriesMetadata>({
      ...base,
      series_key: key,
      series_title: seriesTitle,
      external_ids: { ...file.external_ids },
      titles: { ...file.titles },
      synonyms: [...file.synonyms],
      tag: file.tag,
      ...(linkChanged
        ? {
            format: undefined,
            status: undefined,
            total_volumes: undefined,
            total_chapters: undefined,
            cover_url: undefined
          }
        : {}),
      // The record's own stamp never moves backwards: the root series-metadata.json
      // merge is "newest updated_at wins", so lowering it to an older file stamp
      // would let another device's pre-link copy of this record win and undo the
      // facts we just applied (with the per-user state riding along).
      updated_at: file.updated_at > base.updated_at ? file.updated_at : base.updated_at,
      facts_updated_at: file.updated_at,
      linked_at: linked
        ? linkChanged
          ? file.updated_at
          : (base.linked_at ?? file.updated_at)
        : undefined
    });
    await db.series_metadata.put(next);
  });
}

/** After a series rename: carry the record to the new key (newer record wins on collision). */
export async function moveSeriesMetadataKey(oldTitle: string, newTitle: string): Promise<void> {
  const oldKey = normalizeSeriesKey(oldTitle);
  const newKey = normalizeSeriesKey(newTitle);

  await db.transaction('rw', db.series_metadata, async () => {
    const oldRec = await db.series_metadata.get(oldKey);
    if (!oldRec) return;

    if (oldKey === newKey) {
      await db.series_metadata.put({ ...oldRec, series_title: newTitle });
      return;
    }

    const newRec = await db.series_metadata.get(newKey);
    const winner: SeriesMetadata =
      newRec && newRec.updated_at > oldRec.updated_at
        ? newRec
        : { ...oldRec, series_key: newKey, series_title: newTitle };
    await db.series_metadata.put(winner);
    await db.series_metadata.delete(oldKey);
  });
}

export async function getAllSeriesMetadata(): Promise<Record<string, SeriesMetadata>> {
  const rows = await db.series_metadata.toArray();
  return Object.fromEntries(rows.map((r) => [r.series_key, r]));
}

export async function replaceAllSeriesMetadata(
  records: Record<string, SeriesMetadata>
): Promise<void> {
  await db.series_metadata.bulkPut(Object.values(records));
}

/** Reactive view of the whole table, keyed by series_key. Empty Map before first emission. */
export const seriesMetadataMap: Readable<Map<string, SeriesMetadata>> = readable(
  new Map<string, SeriesMetadata>(),
  (set) => {
    const subscription = liveQuery(() => db.series_metadata.toArray()).subscribe({
      next: (rows) => set(new Map(rows.map((r) => [r.series_key, r]))),
      error: (err) => console.error('series_metadata liveQuery failed:', err)
    });
    return () => subscription.unsubscribe();
  }
);
