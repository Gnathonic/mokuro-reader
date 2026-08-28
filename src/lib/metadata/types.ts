import { normalizeSeriesKey, normalizeVolumeTitleKey } from './series-key';

export type DisplayTitleLanguage = 'imported' | 'native' | 'english';
export type TrackingUnit = 'volumes' | 'chapters';

export interface SeriesTitles {
  native?: string;
  romaji?: string;
  english?: string;
}

export interface SeriesExternalIds {
  anilist?: number;
  mal?: number;
}

/**
 * Per-series push bookkeeping. Stored in the reading-state store
 * (`$lib/settings/series-data`), never on the shared record: it is per-user
 * state, and it travels in `volume-data.json`'s `series` section.
 *
 * Neither a switch nor a unit lives here any more: pushing is one global setting
 * (`catalogSettings.pushProgressToAniList`) and the unit is an objective fact
 * about the archives (`SeriesMetadata.unit`).
 */
export interface SeriesTracking {
  /** volume_uuid -> volume/chapter number override */
  number_overrides?: Record<string, number>;
  last_pushed?: { n: number; status: string; at: string };
}

/**
 * Per-series metadata record. PK = normalizeSeriesKey(series_title).
 * LOCAL storage only — this table is never uploaded as a whole.
 *
 * Two kinds of field are shared publicly through the per-series `series.json`
 * sidecar (`series-file.ts`, compiled into the root `catalog.json`): the "facts"
 * (external_ids/titles/synonyms/tag/unit), which carry a facts clock and decide
 * merges, and the shelf alignment (spine_offset/volume_offsets), which rides the
 * same file as INDEX data — shared, but never a fact. Everything else on this
 * record is this library's own state.
 *
 * The READING state (read count, re-read suppression, AniList push bookkeeping)
 * is deliberately not here at all: it is per-user, and it lives in the
 * reading-state store (`$lib/settings/series-data`), which syncs through the
 * `series` section of `volume-data.json`.
 *
 * AniList's DISPLAY data (format, status, volume/chapter totals, cover art) is
 * not here either: it belongs to AniList and it goes stale. The two places that
 * want it have it already — the link picker reads it straight off the search
 * result, and the tracker fetches the totals (`SeriesTotals`) in the request it
 * makes anyway.
 */
export interface SeriesMetadata {
  series_key: string;
  series_title: string;
  external_ids: SeriesExternalIds;
  titles: SeriesTitles;
  synonyms: string[];
  /** Free text appended to the display name; shared in `series.json` for mokuro-bunko */
  tag?: string;
  /**
   * Objective unit of the archives — are the files in this series folder volumes
   * or chapters? Not a preference: it is a property of the items themselves, so
   * it is shared in `series.json` alongside the other facts. `undefined` = no one
   * has corrected it, auto-detect from the volume titles (`tracking-unit.ts`).
   */
  unit?: TrackingUnit;
  /**
   * Catalog spine stack: adjustment to the global horizontal step, in percent.
   * Added to `catalogSettings.horizontalStep` for this series only.
   *
   * User-visible catalog layout AND a property of the archives themselves — the
   * same covers have the same geometry — so it IS published, as INDEX data, in
   * the shared `series.json` sidecar (top-level `spine_offset`). Never a fact:
   * it must never move `facts_updated_at`. An explicit `0` is a deliberate reset
   * and is stored as such; absent means "no opinion", which inherits whatever
   * another library published. See `spine-offsets.ts`.
   */
  spine_offset?: number;
  /**
   * Catalog spine stack: per-volume horizontal nudge in px, keyed by `volume_uuid`.
   * Published as INDEX data too — as each volume entry's `offset` in
   * `series.json` — under exactly the same rules as `spine_offset` above.
   */
  volume_offsets?: Record<string, number>;
  /** ISO timestamp — merge key for the record as a whole (local rename collisions) */
  updated_at: string;
  /**
   * ISO timestamp of the last change to the shareable *facts*
   * (`external_ids`/`titles`/`synonyms`/`tag`) — the merge key for `series.json`.
   *
   * Split from `updated_at` because every non-fact write (the shelf alignment,
   * link bookkeeping) bumps `updated_at`: publishing that stamp with the facts
   * would let a device that has never linked the series present its empty facts
   * as "newer" and unlink it everywhere. Absent on legacy records — readers fall
   * back to `updated_at`.
   */
  facts_updated_at?: string;
  linked_at?: string;
}

/**
 * Series totals as AniList reports them. FETCHED, never stored: they belong to
 * the external record, they go stale, and the one place that needs them (the
 * push) already makes the request that carries them.
 */
export interface SeriesTotals {
  volumes?: number;
  chapters?: number;
}

/**
 * A `SeriesMetadata` as it is actually STORED: the record plus the secondary
 * key IndexedDB indexes it under.
 *
 * WHY A SECOND KEY AT ALL. The primary key is `normalizeSeriesKey`, which folds
 * case and whitespace but not unicode FORM — and half the lookups in the app
 * arrive holding a name that came off a filesystem, so they must match on
 * `normalizeVolumeTitleKey` (the same fold plus NFC) instead. Every one of those
 * sites used to answer by reading the WHOLE table and folding each row in JS;
 * with this key they are `.where('folded_key').equals(k)` index reads. The one
 * that hurt most ran per series published (`hasPublishableFacts`).
 *
 * WHY IT IS A SEPARATE TYPE rather than a field on `SeriesMetadata`. A derived
 * key that some writer forgets is worse than no key: the row is simply absent
 * from every keyed read, silently. Making it a distinct type means Dexie's table
 * is `Table<StoredSeriesMetadata>`, so `put`/`bulkPut` will not TYPE-CHECK
 * against a plain `SeriesMetadata` — the compiler is the thing that stops a new
 * writer forgetting, and {@link toStoredSeriesMetadata} is the only way past it.
 * Readers keep using `SeriesMetadata`, which this widens, so nothing downstream
 * has to know the key exists.
 */
export interface StoredSeriesMetadata extends SeriesMetadata {
  /** `normalizeVolumeTitleKey(series_title)`. Derived — never set by hand. */
  folded_key: string;
}

/**
 * Stamp the derived secondary key onto a record on its way into the table. THE
 * one place `folded_key` is computed; see {@link StoredSeriesMetadata}.
 *
 * Always recomputed from `series_title`, never carried through: a rename writes
 * a new title onto an existing row, and a carried-over key would index the row
 * under the name it no longer has.
 */
export function toStoredSeriesMetadata(record: SeriesMetadata): StoredSeriesMetadata {
  return { ...record, folded_key: normalizeVolumeTitleKey(record.series_title) };
}

export function createEmptySeriesMetadata(
  seriesTitle: string,
  now: string = new Date().toISOString()
): SeriesMetadata {
  return {
    series_key: normalizeSeriesKey(seriesTitle),
    series_title: seriesTitle,
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at: now
  };
}
