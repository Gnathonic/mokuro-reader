import type { SeriesMetadata } from './types';

function isRecordLike(value: unknown): value is SeriesMetadata {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as SeriesMetadata).series_key === 'string' &&
    typeof (value as SeriesMetadata).updated_at === 'string'
  );
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
