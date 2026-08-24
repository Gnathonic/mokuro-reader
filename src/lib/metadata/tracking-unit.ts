import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata, SeriesTotals, TrackingUnit } from './types';
import { detectTrackingUnit } from './volume-number';

/**
 * The unit this series' archives are numbered in, and where the answer came from.
 *
 * `meta.unit` is a shared fact (`series.json`), written only when someone
 * corrects the guess — so a stored value always wins. Everything else is
 * detected from the volume titles. `totals` are AniList's, and nothing stores
 * them: only the push path has them (it fetches them alongside the list entry),
 * so everywhere else detection is marker-based and the overshoot tie-break
 * simply does not apply. Cloud placeholders count: they carry titles, which is
 * all the detector reads.
 */
export function resolveTrackingUnit(
  meta: Pick<SeriesMetadata, 'unit'> | undefined,
  seriesVolumes: Pick<VolumeMetadata, 'volume_title'>[],
  totals?: SeriesTotals
): { unit: TrackingUnit; source: 'set' | 'detected' } {
  if (meta?.unit === 'volumes' || meta?.unit === 'chapters') {
    return { unit: meta.unit, source: 'set' };
  }
  return {
    unit: detectTrackingUnit(
      seriesVolumes.map((v) => v.volume_title),
      { total_volumes: totals?.volumes, total_chapters: totals?.chapters }
    ),
    source: 'detected'
  };
}
