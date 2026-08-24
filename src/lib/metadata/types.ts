import { normalizeSeriesKey } from './series-key';

export type DisplayTitleLanguage = 'imported' | 'native' | 'romaji' | 'english';
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
 * Per-series push bookkeeping. Neither a switch nor a unit lives here any more:
 * pushing is one global setting (`catalogSettings.pushProgressToAniList`) and
 * the unit is an objective fact about the archives (`SeriesMetadata.unit`).
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
 * record is this library's own state; the reading half of it syncs through the
 * `series` section of `volume-data.json`.
 */
export interface SeriesMetadata {
  series_key: string;
  series_title: string;
  external_ids: SeriesExternalIds;
  titles: SeriesTitles;
  synonyms: string[];
  /** Free text appended to the display name; shared in `series.json` for mokuro-bunko */
  tag?: string;
  format?: string;
  status?: string;
  total_volumes?: number;
  total_chapters?: number;
  cover_url?: string;
  /**
   * Objective unit of the archives — are the files in this series folder volumes
   * or chapters? Not a preference: it is a property of the items themselves, so
   * it is shared in `series.json` alongside the other facts. `undefined` = no one
   * has corrected it, auto-detect from the volume titles (`tracking-unit.ts`).
   */
  unit?: TrackingUnit;
  title_preference?: DisplayTitleLanguage;
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
  /** Archived completed passes; timesRead = read_count + (all volumes completed now ? 1 : 0) */
  read_count: number;
  reread_prompt_suppressed?: boolean;
  tracking?: SeriesTracking;
  /** ISO timestamp — merge key for the record as a whole (local rename collisions) */
  updated_at: string;
  /**
   * ISO timestamp of the last change to the shareable *facts*
   * (`external_ids`/`titles`/`synonyms`/`tag`) — the merge key for `series.json`.
   *
   * Split from `updated_at` because every per-user write (spine offsets, read_count,
   * tracking, title_preference) bumps `updated_at`: publishing that stamp with the
   * facts would let a device that has never linked the series present its empty
   * facts as "newer" and unlink it everywhere. Absent on legacy records — readers
   * fall back to `updated_at`.
   */
  facts_updated_at?: string;
  linked_at?: string;
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
    read_count: 0,
    updated_at: now
  };
}
