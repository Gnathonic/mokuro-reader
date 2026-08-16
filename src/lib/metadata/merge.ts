import type { SeriesMetadata } from './types';

function isRecordLike(value: unknown): value is SeriesMetadata {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as SeriesMetadata).series_key === 'string' &&
    typeof (value as SeriesMetadata).updated_at === 'string'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validates untrusted `series-metadata.json` cloud JSON before it reaches
 * `mergeSeriesMetadata`. Untrusted-input validation belongs at the boundary
 * where the JSON enters the app (cloud download), not inside the pure merge.
 *
 * An entry is kept only when `series_key`/`updated_at` are strings; on a kept
 * entry, `external_ids`/`titles` are coerced to `{}` unless already plain
 * objects, `synonyms` to `[]` unless already a string array, and `read_count`
 * to `0` unless already a finite number >= 0. Other fields pass through as-is.
 * A non-object root (or an entry with a bad key/timestamp) is dropped; any
 * drop is logged once via `console.warn`.
 */
export function sanitizeCloudSeriesMetadata(raw: unknown): Record<string, SeriesMetadata> {
  if (!isPlainObject(raw)) return {};

  const out: Record<string, SeriesMetadata> = {};
  let droppedAny = false;

  for (const [key, value] of Object.entries(raw)) {
    if (!isRecordLike(value)) {
      droppedAny = true;
      continue;
    }
    out[key] = {
      ...value,
      external_ids: isPlainObject(value.external_ids)
        ? (value.external_ids as SeriesMetadata['external_ids'])
        : {},
      titles: isPlainObject(value.titles) ? (value.titles as SeriesMetadata['titles']) : {},
      synonyms: isStringArray(value.synonyms) ? value.synonyms : [],
      read_count: isNonNegativeFinite(value.read_count) ? value.read_count : 0
    };
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
