/**
 * Names for image-only volumes (#285): what a reviewed volume is saved under,
 * and where on disk it sits.
 *
 * The volume's uuid comes from its literal location (`identity`), not from
 * the names the review chose, so it is the same whatever the series field,
 * mode, start number or rename: re-importing a folder finds the volume
 * already there instead of adding a duplicate, and two batches that number
 * differently can never overwrite each other. `processVolume` saves exactly
 * these names (`DecompressedVolume.importNames`). Grouping and naming live in
 * `image-only-review.ts`.
 */

import { extractFolderTitlesFromPath } from '$lib/util/series-extraction';
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';
import type { PairedSource } from './types';

/** The names one image-only volume is saved under. */
export interface ImportNames {
  series: string;
  volume: string;
  /** Its literal location ("Series folder/Volume folder"), the uuid source. */
  identity: string;
}

/** Stored form of a title segment, as `saveVolume` writes it. */
export function storedTitle(title: string): string {
  return sanitizeTitleSegment(title) || 'Untitled';
}

/** Where a volume sits: its parent folder (if any), its own name, its uuid source. */
export function locateVolume(pairing: Pick<PairedSource, 'basePath' | 'titlePath'>) {
  const { seriesTitle, volumeTitle, hasParent } = extractFolderTitlesFromPath(
    pairing.titlePath ?? pairing.basePath
  );
  return {
    parent: hasParent ? seriesTitle : null,
    own: volumeTitle,
    identity: hasParent ? `${seriesTitle}/${volumeTitle}` : volumeTitle
  };
}
