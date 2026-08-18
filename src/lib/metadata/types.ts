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

export interface SeriesTracking {
  enabled: boolean;
  unit: TrackingUnit;
  /** volume_uuid -> volume/chapter number override */
  number_overrides?: Record<string, number>;
  last_pushed?: { n: number; status: string; at: string };
}

/**
 * Per-series metadata record. PK = normalizeSeriesKey(series_title).
 * Synced as series-metadata.json (newest updated_at wins per key).
 * Only the "facts" (external_ids/titles/synonyms/tag) are shared publicly, via
 * the per-series `series.json` sidecar (`series-file.ts`).
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
  title_preference?: DisplayTitleLanguage;
  /**
   * Catalog spine stack: adjustment to the global horizontal step, in percent.
   * Added to `catalogSettings.horizontalStep` for this series only. Never shared
   * in `series.json` — it describes this library's shelf, not the series.
   */
  spine_offset?: number;
  /** Catalog spine stack: per-volume horizontal nudge in px, keyed by `volume_uuid`. */
  volume_offsets?: Record<string, number>;
  /** Archived completed passes; timesRead = read_count + (all volumes completed now ? 1 : 0) */
  read_count: number;
  reread_prompt_suppressed?: boolean;
  tracking?: SeriesTracking;
  /** ISO timestamp — merge key */
  updated_at: string;
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
