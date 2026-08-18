import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata, TrackingUnit } from './types';
import { detectTrackingUnit } from './volume-number';

/**
 * The unit this series' archives are numbered in, and where the answer came from.
 *
 * `meta.unit` is a shared fact (`series.json`), written only when someone
 * corrects the guess — so a stored value always wins. Everything else is
 * detected from the volume titles, with the series totals as a tie-breaker.
 * Cloud placeholders count: they carry titles, which is all the detector reads.
 */
export function resolveTrackingUnit(
  meta: SeriesMetadata | undefined,
  seriesVolumes: Pick<VolumeMetadata, 'volume_title'>[]
): { unit: TrackingUnit; source: 'set' | 'detected' } {
  if (meta?.unit === 'volumes' || meta?.unit === 'chapters') {
    return { unit: meta.unit, source: 'set' };
  }
  return {
    unit: detectTrackingUnit(
      seriesVolumes.map((v) => v.volume_title),
      { total_volumes: meta?.total_volumes, total_chapters: meta?.total_chapters }
    ),
    source: 'detected'
  };
}
