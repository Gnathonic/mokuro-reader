import type { VolumeMetadata } from '$lib/types';
import { sortVolumes } from './sort-volumes';

export interface Series {
  title: string;
  series_uuid: string;
  volumes: VolumeMetadata[];
}

function sortTitles(a: Series, b: Series) {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
}

function normalizeSeriesTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function deriveSeriesFromVolumes(volumeEntries: Array<VolumeMetadata>) {
  // Group volumes by normalized series title (user-visible identity)
  const titleMap = new Map<string, Series>();

  for (const entry of volumeEntries) {
    const key = normalizeSeriesTitle(entry.series_title);
    let volumes = titleMap.get(key);
    if (volumes === undefined) {
      volumes = {
        title: entry.series_title,
        series_uuid: entry.series_uuid,
        volumes: []
      };
      titleMap.set(key, volumes);
    }
    volumes.volumes.push(entry);
  }

  // Convert map to array and sort everything
  const titles = Array.from(titleMap.values());

  // Sort series by title, and volumes within each series
  titles.sort(sortTitles);
  for (const series of titles) {
    series.volumes.sort(sortVolumes);
  }

  return titles;
}
