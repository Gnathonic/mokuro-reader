/**
 * Name previews for the image-only import prompt (#285).
 *
 * The prompt shows, for each naming mode, the series and volume names an
 * image-only import WILL be saved under, so the user picks the mode by what it
 * produces rather than by its description. Built from the same functions
 * `processVolume` names volumes with, and sanitized the way `saveVolume`
 * stores them, so the preview cannot drift from the result.
 */

import { extractFolderTitlesFromPath, imageOnlySeriesName } from '$lib/util/series-extraction';
import { naturalSort } from '$lib/util/natural-sort';
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';
import { extractVolumeInfo } from './processing';
import type { PairedSource } from './types';

export interface SeriesNamePreview {
  seriesName: string;
  volumeCount: number;
  /** Volume titles, natural order. */
  volumeNames: string[];
}

export interface ImageOnlyNamingPreview {
  /** The cleaned-up extraction (the default): "Volume 01". */
  cleaned: SeriesNamePreview[];
  /** Folder names, the series folder in front: "Chained Soldier 01". */
  folder: SeriesNamePreview[];
}

/** What `processVolume` names an image-only pairing, in one mode. */
function namesFor(
  pairing: Pick<PairedSource, 'basePath' | 'titlePath'>,
  keepFolderNames: boolean
): { series: string; volume: string } {
  if (keepFolderNames) {
    const path = pairing.titlePath ?? pairing.basePath;
    const { seriesTitle, volumeTitle } = extractFolderTitlesFromPath(path);
    return { series: seriesTitle, volume: volumeTitle };
  }
  return {
    series: imageOnlySeriesName(pairing.basePath, false),
    volume: extractVolumeInfo(pairing.basePath).volume
  };
}

/** Stored form of a title segment, as `saveVolume` writes it. */
function stored(title: string): string {
  return sanitizeTitleSegment(title) || 'Untitled';
}

function previewFor(
  pairings: Pick<PairedSource, 'basePath' | 'titlePath'>[],
  keepFolderNames: boolean
): SeriesNamePreview[] {
  const groups = new Map<string, string[]>();
  for (const pairing of pairings) {
    const { series, volume } = namesFor(pairing, keepFolderNames);
    const key = stored(series);
    const volumes = groups.get(key) ?? [];
    volumes.push(stored(volume));
    groups.set(key, volumes);
  }
  return [...groups.entries()]
    .map(([seriesName, volumeNames]) => ({
      seriesName,
      volumeCount: volumeNames.length,
      volumeNames: volumeNames.sort(naturalSort)
    }))
    .sort((a, b) => a.seriesName.localeCompare(b.seriesName));
}

/** Both modes' names for a batch of image-only pairings. */
export function imageOnlyNamingPreview(
  pairings: Pick<PairedSource, 'basePath' | 'titlePath'>[]
): ImageOnlyNamingPreview {
  return { cleaned: previewFor(pairings, false), folder: previewFor(pairings, true) };
}
