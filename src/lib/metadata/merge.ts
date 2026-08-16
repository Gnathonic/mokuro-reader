import {
  isRecord,
  normalizeUpdatedAt,
  sanitizeExternalIds,
  sanitizeSynonyms,
  sanitizeTag,
  sanitizeTitlePreference,
  sanitizeTitles
} from './sanitize';
import type { SeriesMetadata } from './types';

function isRecordLike(value: unknown): value is SeriesMetadata {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as SeriesMetadata).series_key === 'string' &&
    typeof (value as SeriesMetadata).updated_at === 'string'
  );
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validates untrusted `series-metadata.json` cloud JSON before it reaches
 * `mergeSeriesMetadata`. Untrusted-input validation belongs at the boundary
 * where the JSON enters the app (cloud download), not inside the pure merge.
 *
 * An entry is dropped when it is not an object, when `series_key` is missing or
 * disagrees with its map key, or when `updated_at` is not a parsable date.
 * Otherwise the entry is kept and its values are validated field by field with
 * the same rules the .mokuro embed uses (`sanitize.ts`): positive-integer
 * external ids, non-empty string titles/synonyms/tag, a `title_preference` that is
 * one of the four known languages, `read_count` coerced to a finite number >= 0,
 * `updated_at` normalized to ISO and clamped when far in the future. Bad values are dropped, not the whole entry. Other fields pass through
 * as-is. A non-object root is dropped; any drop is logged once via `console.warn`.
 */
export function sanitizeCloudSeriesMetadata(raw: unknown): Record<string, SeriesMetadata> {
  if (!isRecord(raw)) return {};

  const out: Record<string, SeriesMetadata> = {};
  let droppedAny = false;
  const now = Date.now();

  for (const [key, value] of Object.entries(raw)) {
    // A key/series_key mismatch means the record would be written under a key it
    // does not describe (and would resurrect under its own key on the next sync).
    if (!isRecord(value) || value.series_key !== key) {
      droppedAny = true;
      continue;
    }
    const updated_at = normalizeUpdatedAt(value.updated_at, now);
    if (!updated_at) {
      droppedAny = true;
      continue;
    }

    const entry: SeriesMetadata = {
      ...(value as unknown as SeriesMetadata),
      series_key: key,
      series_title: typeof value.series_title === 'string' ? value.series_title : key,
      external_ids: sanitizeExternalIds(value.external_ids),
      titles: sanitizeTitles(value.titles),
      synonyms: sanitizeSynonyms(value.synonyms),
      read_count: isNonNegativeFinite(value.read_count) ? value.read_count : 0,
      updated_at
    };
    const tag = sanitizeTag(value.tag);
    if (tag === undefined) delete entry.tag;
    else entry.tag = tag;
    // An unknown language would not equal 'imported', so it would silently push the
    // series onto the english → romaji → native fallback chain. Drop it back to
    // "no per-series override" instead.
    const titlePreference = sanitizeTitlePreference(value.title_preference);
    if (titlePreference === undefined) delete entry.title_preference;
    else entry.title_preference = titlePreference;
    out[key] = entry;
  }

  if (droppedAny) {
    console.warn('sanitizeCloudSeriesMetadata: dropped malformed series-metadata.json entries');
  }

  return out;
}

/** Newest `updated_at` wins per key; tie keeps local; malformed cloud rows are ignored. */
export function mergeSeriesMetadata(
  local: Record<string, SeriesMetadata>,
  cloud: Record<string, SeriesMetadata>
): Record<string, SeriesMetadata> {
  const merged: Record<string, SeriesMetadata> = { ...local };
  for (const [key, cloudRec] of Object.entries(cloud)) {
    if (!isRecordLike(cloudRec)) continue;
    const localRec = merged[key];
    if (!localRec || cloudRec.updated_at > localRec.updated_at) {
      merged[key] = cloudRec;
    }
  }
  return merged;
}
