import {
  FACTLESS_UPDATED_AT,
  hasSeriesFacts,
  seriesFactsStamp,
  type SeriesFile
} from './series-file';
import { normalizeSeriesKey } from './series-key';
import {
  ID_KEYS,
  TITLE_KEYS,
  isRecord,
  normalizeUpdatedAt,
  sanitizeExternalIds,
  sanitizeSynonyms,
  sanitizeTag,
  sanitizeTitles,
  sanitizeTrackingUnit
} from './sanitize';
import type { SeriesExternalIds, SeriesMetadata, SeriesTitles, TrackingUnit } from './types';

/** Basename of the root catalog file, stored at the root of the library folder. */
export const CATALOG_FILE_NAME = 'catalog.json';

/**
 * One series in the root catalog: the FACTS subset of that series' `series.json`
 * — same keys, same meaning, same facts stamp — and nothing else. No counts, no
 * covers, no volume list: those live in `series.json`, which is fetched when the
 * series is opened.
 *
 * A series this library knows no facts about still gets an entry, carrying just
 * its `series_title` and `FACTLESS_UPDATED_AT`: the catalog must be able to list
 * every folder by name, and an epoch stamp loses every merge comparison, so it
 * can never unlink a series someone else linked.
 */
export interface CatalogFileEntry {
  series_title: string;
  external_ids: SeriesExternalIds;
  titles: SeriesTitles;
  synonyms: string[];
  tag?: string;
  unit?: TrackingUnit;
  updated_at: string;
}

/**
 * The root `catalog.json`: name/mapping/search data for the whole library.
 *
 * `updated_at` is the file's own build stamp (informational). The MERGE key is
 * per entry — `CatalogFileEntry.updated_at`, the same facts clock `series.json`
 * uses — so a catalog rebuilt for an unrelated series can never outrank another
 * device's facts.
 */
export interface CatalogFile {
  version: 1;
  updated_at: string;
  series: CatalogFileEntry[];
}

/** Facts only, in canonical key order, with empties omitted. */
function factsOf(source: {
  external_ids?: SeriesExternalIds;
  titles?: SeriesTitles;
  synonyms?: string[];
  tag?: string;
  unit?: TrackingUnit;
}): Omit<CatalogFileEntry, 'series_title' | 'updated_at'> {
  const external_ids: SeriesExternalIds = {};
  for (const k of ID_KEYS)
    if (source.external_ids?.[k] != null) external_ids[k] = source.external_ids[k];

  const titles: SeriesTitles = {};
  for (const k of TITLE_KEYS) if (source.titles?.[k]) titles[k] = source.titles[k];

  const facts: Omit<CatalogFileEntry, 'series_title' | 'updated_at'> = {
    external_ids,
    titles,
    synonyms: [...(source.synonyms ?? [])]
  };
  const tag = source.tag?.trim();
  if (tag) facts.tag = tag;
  const unit = sanitizeTrackingUnit(source.unit);
  if (unit) facts.unit = unit;
  return facts;
}

/**
 * Project a local `series_metadata` record onto its catalog entry.
 *
 * Stamped with the record's FACTS clock — never `updated_at`, which every
 * per-user write bumps — exactly like `buildSeriesFile`. A record that has never
 * had an opinion (or no record at all) yields a factless entry at the epoch.
 */
export function catalogEntryFromMeta(
  seriesTitle: string,
  meta: SeriesMetadata | undefined
): CatalogFileEntry {
  if (!meta) {
    return {
      series_title: seriesTitle,
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT
    };
  }
  const stamp = seriesFactsStamp(meta);
  return {
    series_title: seriesTitle,
    ...factsOf(meta),
    updated_at:
      stamp === undefined ? FACTLESS_UPDATED_AT : (normalizeUpdatedAt(stamp) ?? FACTLESS_UPDATED_AT)
  };
}

/** Project a `series.json` onto its catalog entry (facts subset, same stamp). */
export function catalogEntryFromSeriesFile(file: SeriesFile): CatalogFileEntry {
  return {
    series_title: file.series_title,
    ...factsOf(file),
    updated_at: file.updated_at
  };
}

/**
 * Lift a catalog entry into a facts-only `SeriesFile` so it can be applied
 * through `upsertFromSeriesFile` unchanged. That is the whole point: the
 * factless rules (never create a record from a factless file, never unlink
 * without a strictly newer stamp) are implemented once, in `store.ts`, and the
 * catalog gets them for free instead of re-deriving them.
 */
export function catalogEntryToSeriesFile(entry: CatalogFileEntry): SeriesFile {
  const file: SeriesFile = {
    version: 2,
    series_title: entry.series_title,
    external_ids: { ...entry.external_ids },
    titles: { ...entry.titles },
    synonyms: [...entry.synonyms],
    updated_at: entry.updated_at,
    volumes: []
  };
  if (entry.tag) file.tag = entry.tag;
  if (entry.unit) file.unit = entry.unit;
  return file;
}

/**
 * Which of the two copies of a series wins.
 *
 * `buildSeriesFile`'s rule for facts, adapted to the one thing a catalog entry
 * cannot express: "this library has no facts clock at all". A record like that
 * makes `buildSeriesFile` carry the published facts through untouched; an entry
 * has to carry SOME stamp, so it carries `FACTLESS_UPDATED_AT`, and the epoch
 * has to lose rather than replace. Hence:
 *
 * - local entry WITH facts → replaces a factless one outright, and wins ties
 *   against facts (that is the same link round-tripping back);
 * - local entry WITHOUT facts → needs a strictly newer stamp, whether the entry
 *   it faces carries facts (an unlink) or not (a published unlink somebody else
 *   already made — a factless epoch entry must not roll its stamp back to 1970,
 *   which would put the series back below every stale link still out there).
 */
function pickEntry(local: CatalogFileEntry, existing: CatalogFileEntry | undefined) {
  if (!existing) return local;
  if (hasSeriesFacts(local)) {
    if (!hasSeriesFacts(existing)) return local;
    return local.updated_at >= existing.updated_at ? local : existing;
  }
  return local.updated_at > existing.updated_at ? local : existing;
}

/**
 * Build the root `catalog.json` to upload.
 *
 * Union-by-key with the copy already in the cloud (newest facts stamp wins per
 * series) so a device that only knows half the library cannot delete the other
 * half, then pruned against `cloudSeriesTitles` — the folders the current cloud
 * listing actually shows — so a deleted series eventually drops out. Entries are
 * sorted by normalized key so a rebuild that changed nothing produces the same
 * bytes and therefore the same size/mtime, which is what stops every other
 * device re-downloading it.
 *
 * Returns `undefined` when nothing survives: an empty catalog is never worth
 * publishing (and would blank the view for every other device).
 */
export function buildCatalogFile(args: {
  entries: CatalogFileEntry[];
  existing?: CatalogFile;
  cloudSeriesTitles?: Set<string>;
  now?: string;
}): CatalogFile | undefined {
  const { entries, existing, cloudSeriesTitles, now } = args;

  const byKey = new Map<string, CatalogFileEntry>();
  for (const entry of existing?.series ?? []) {
    const key = normalizeSeriesKey(entry.series_title);
    if (key) byKey.set(key, entry);
  }
  for (const entry of entries) {
    const key = normalizeSeriesKey(entry.series_title);
    if (!key) continue;
    byKey.set(key, pickEntry(entry, byKey.get(key)));
  }

  let keys = [...byKey.keys()];
  if (cloudSeriesTitles) {
    const allowed = new Set<string>();
    for (const title of cloudSeriesTitles) {
      const key = normalizeSeriesKey(title);
      if (key) allowed.add(key);
    }
    keys = keys.filter((key) => allowed.has(key));
  }
  keys.sort();

  if (keys.length === 0) return undefined;
  return {
    version: 1,
    updated_at: now ?? new Date().toISOString(),
    series: keys.map((key) => byKey.get(key)!)
  };
}

/** One entry as canonical text: fixed key order, empties omitted, facts only. */
function canonicalEntry(entry: CatalogFileEntry): string {
  return JSON.stringify({
    series_title: entry.series_title,
    ...factsOf(entry),
    updated_at: entry.updated_at
  });
}

/**
 * Do these two catalog bodies say exactly the same thing?
 *
 * Compares the `series` arrays only — NEVER the file's own `updated_at`, which
 * is a fresh build stamp on every rebuild and would make every no-op look like a
 * change. Order-insensitive on both axes: entry key order differs between a
 * parsed cloud copy and a locally built one, and a hand-written file need not be
 * sorted.
 *
 * The point is the upload: republishing an identical catalog changes its
 * size/mtime, which flips `catalogNeedsRefresh` on every other device and has
 * them all re-download a file that did not change.
 */
export function catalogSeriesEqual(
  a: CatalogFileEntry[],
  b: CatalogFileEntry[] | undefined
): boolean {
  if (!b || a.length !== b.length) return false;
  const left = a.map(canonicalEntry).sort();
  const right = b.map(canonicalEntry).sort();
  return left.every((entry, i) => entry === right[i]);
}

function parseEntry(value: unknown): CatalogFileEntry | undefined {
  if (!isRecord(value)) return undefined;
  const series_title = value.series_title;
  if (typeof series_title !== 'string' || !series_title.trim()) return undefined;

  const updated_at = normalizeUpdatedAt(value.updated_at);
  if (!updated_at) return undefined;

  const entry: CatalogFileEntry = {
    series_title,
    external_ids: sanitizeExternalIds(value.external_ids),
    titles: sanitizeTitles(value.titles),
    synonyms: sanitizeSynonyms(value.synonyms),
    updated_at
  };
  const tag = sanitizeTag(value.tag);
  if (tag) entry.tag = tag;
  const unit = sanitizeTrackingUnit(value.unit);
  if (unit) entry.unit = unit;
  return entry;
}

/**
 * Validate an untrusted `catalog.json`.
 *
 * Everything here is foreign data — anyone with write access to the folder can
 * change it — so every field goes through the same sanitizers `series.json`
 * uses, bad entries are dropped individually rather than
 * failing the file, unknown keys never survive (they would let per-user state
 * ride along), and every stamp is normalized/clamped because it decides merges
 * by lexicographic comparison.
 */
export function parseCatalogFile(value: unknown): CatalogFile | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1) return undefined;

  const updated_at = normalizeUpdatedAt(value.updated_at);
  if (!updated_at) return undefined;

  const series: CatalogFileEntry[] = [];
  if (Array.isArray(value.series)) {
    const seen = new Set<string>();
    for (const raw of value.series) {
      const entry = parseEntry(raw);
      if (!entry) continue;
      const key = normalizeSeriesKey(entry.series_title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      series.push(entry);
    }
  }

  return { version: 1, updated_at, series };
}

/**
 * The one serializer every writer uses. Compact on purpose, same as
 * `stringifySeriesFile`: the file is read by machines (this app, mokuro-bunko)
 * and pretty-printing costs bytes on a file that can list thousands of series.
 */
export function stringifyCatalogFile(file: CatalogFile): string {
  return JSON.stringify(file);
}

/**
 * True when `path` is the ROOT `catalog.json`. A nested
 * `<Series>/catalog.json` is somebody else's file, never ours.
 */
export function isCatalogFilePath(path: string): boolean {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (trimmed.includes('/')) return false;
  return trimmed.toLowerCase() === CATALOG_FILE_NAME;
}
