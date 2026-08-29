import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata, SeriesTotals, TrackingUnit } from './types';
import { detectTrackingUnitDetailed } from './volume-number';

/**
 * The unit this series' archives are numbered in, where the answer came from,
 * and whether it is solid enough to show.
 *
 * `meta.unit` is a shared fact (`series.json`), written only when someone
 * corrects the guess — so a stored value always wins. Everything else is
 * detected from the volume titles. `totals` are AniList's, and nothing stores
 * them: only the push path has them (it fetches them alongside the list entry),
 * so everywhere else detection is marker-based and the overshoot tie-break
 * simply does not apply. Cloud placeholders count: they carry titles, which is
 * all the detector reads.
 *
 * `confident` says the answer rests on something real — a stated fact, or a
 * title that names its unit outright. It is false when only the bare-number
 * overshoot rule (or the plain default) could decide: that path is a guess until
 * the totals are in hand, so the push resolves it properly at push time and the
 * UI, which never has totals, must not present the guess as an answer.
 */
export function resolveTrackingUnit(
  meta: Pick<SeriesMetadata, 'unit'> | undefined,
  seriesVolumes: Pick<VolumeMetadata, 'volume_title'>[],
  totals?: SeriesTotals
): { unit: TrackingUnit; source: 'set' | 'detected'; confident: boolean } {
  if (meta?.unit === 'volumes' || meta?.unit === 'chapters') {
    return { unit: meta.unit, source: 'set', confident: true };
  }
  const detected = detectTrackingUnitDetailed(
    seriesVolumes.map((v) => v.volume_title),
    { total_volumes: totals?.volumes, total_chapters: totals?.chapters }
  );
  return { unit: detected.unit, source: 'detected', confident: detected.markerDecided };
}
