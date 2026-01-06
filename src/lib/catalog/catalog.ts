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

export function deriveSeriesFromVolumes(volumeEntries: Array<VolumeMetadata>) {
  // Group volumes by series_uuid
  const titleMap = new Map<string, Series>();

  for (const entry of volumeEntries) {
    let volumes = titleMap.get(entry.series_uuid);
    if (volumes === undefined) {
      volumes = {
        title: entry.series_title,
        series_uuid: entry.series_uuid,
        volumes: []
      };
      titleMap.set(entry.series_uuid, volumes);
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
