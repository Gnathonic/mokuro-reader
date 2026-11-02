import { derived, type Readable } from 'svelte/store';
import { volumes as catalogVolumes } from '$lib/catalog';
import type { ReadingSpeedResult } from '$lib/util/reading-speed';
import { DEFAULT_SPEED, readingStats, seriesReadingSpeed } from './stats-store';

/**
 * Each series' own reading speed, for series that have an hour of reading
 * (`seriesReadingSpeed`); absent ones use the recent speed. Computed once per
 * stats change for the whole catalog, so a series' volume cards look it up
 * instead of each grouping the catalog themselves.
 */
export const seriesSpeeds: Readable<Map<string, ReadingSpeedResult>> = derived(
  [readingStats, catalogVolumes],
  ([$stats, $catalog]) => {
    const bySeries = new Map<string, string[]>();
    for (const volume of Object.values($catalog ?? {})) {
      const ids = bySeries.get(volume.series_uuid);
      if (ids) ids.push(volume.volume_uuid);
      else bySeries.set(volume.series_uuid, [volume.volume_uuid]);
    }
    const out = new Map<string, ReadingSpeedResult>();
    for (const [series, ids] of bySeries) {
      const speed = seriesReadingSpeed($stats, ids, DEFAULT_SPEED);
      if (speed !== DEFAULT_SPEED) out.set(series, speed);
    }
    return out;
  }
);
