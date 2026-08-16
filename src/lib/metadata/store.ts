import { db } from '$lib/catalog/db';
import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { normalizeSeriesKey } from './series-key';
import {
  createEmptySeriesMetadata,
  type EmbeddedSeriesMetadata,
  type SeriesMetadata
} from './types';

export type SeriesMetadataPatch = Partial<
  Omit<SeriesMetadata, 'series_key' | 'series_title' | 'updated_at'>
>;

/** Drop `undefined` values so "cleared" fields disappear from IndexedDB and JSON. */
function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function hasAnyId(ids: SeriesMetadata['external_ids'] | undefined): boolean {
  return !!ids && Object.values(ids).some((v) => v != null);
}

export async function getSeriesMetadata(seriesKey: string): Promise<SeriesMetadata | undefined> {
  return db.series_metadata.get(seriesKey);
}

export async function getSeriesMetadataForTitle(
  seriesTitle: string
): Promise<SeriesMetadata | undefined> {
  return getSeriesMetadata(normalizeSeriesKey(seriesTitle));
}

/** Upsert: merges `patch` into the existing record (or a fresh one) and stamps updated_at. */
export async function updateSeriesMetadata(
  seriesTitle: string,
  patch: SeriesMetadataPatch
): Promise<SeriesMetadata> {
  const key = normalizeSeriesKey(seriesTitle);
  const now = new Date().toISOString();
  const existing =
    (await db.series_metadata.get(key)) ?? createEmptySeriesMetadata(seriesTitle, now);
  const next = stripUndefined<SeriesMetadata>({
    ...existing,
    ...patch,
    series_key: key,
    series_title: seriesTitle,
    updated_at: now
  });
  await db.series_metadata.put(next);
  return next;
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
 * Apply facts read from a .mokuro `series_metadata` block. Newest wins: only
 * writes when there is no local record or the embed is strictly newer.
 */
export async function upsertFromEmbedded(
  seriesTitle: string,
  embedded: EmbeddedSeriesMetadata
): Promise<void> {
  const key = normalizeSeriesKey(seriesTitle);
  const existing = await db.series_metadata.get(key);
  if (existing && existing.updated_at >= embedded.updated_at) return;

  const base = existing ?? createEmptySeriesMetadata(seriesTitle, embedded.updated_at);
  const linked = hasAnyId(embedded.external_ids);
  const next = stripUndefined<SeriesMetadata>({
    ...base,
    series_key: key,
    series_title: seriesTitle,
    external_ids: { ...embedded.external_ids },
    titles: { ...embedded.titles },
    synonyms: [...embedded.synonyms],
    tag: embedded.tag,
    updated_at: embedded.updated_at,
    linked_at: linked ? (base.linked_at ?? embedded.updated_at) : undefined
  });
  await db.series_metadata.put(next);
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
