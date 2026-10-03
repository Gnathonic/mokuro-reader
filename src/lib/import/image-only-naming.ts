/**
 * Names for image-only volumes (#285): what a reviewed volume is saved under,
 * and where on disk it sits.
 *
 * A NEW volume's uuid comes from its literal location (`identity`), not from
 * the names the review chose, so it is the same whatever the series field,
 * mode, start number or rename, and two batches that number differently can
 * never overwrite each other. A volume the library ALREADY has — under the
 * uuid an earlier pick shape gave it, or the one every import before the
 * review gave it — keeps that uuid (`identityUuids`, matched in
 * `library-series.ts`), so its read history stays attached. `processVolume`
 * saves exactly these names (`DecompressedVolume.importNames`). Grouping and
 * naming live in `image-only-review.ts`.
 */

import {
  extractFolderTitlesFromPath,
  extractSeriesName,
  extractTitlesFromPath,
  generateDeterministicUUID,
  isBareVolumeName,
  isSuspectParentFolder
} from '$lib/util/series-extraction';
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';
import type { PairedSource } from './types';

/** The names one image-only volume is saved under. */
export interface ImportNames {
  series: string;
  volume: string;
  /** The uuid it is saved under: its literal location's, or the library row it already is. */
  uuid: string;
  /**
   * It is a volume the library kept after "Remove from device": the save
   * fills that row and keeps the row's own titles (`series`/`volume` are only
   * a fallback should the row be gone by then).
   */
  restore?: true;
}

/** Stored form of a title segment, as `saveVolume` writes it. */
export function storedTitle(title: string): string {
  return sanitizeTitleSegment(title) || 'Untitled';
}

type Located = Pick<PairedSource, 'basePath' | 'titlePath'>;

/**
 * Where a volume sits: its parent folder (if any), its own name, its uuid
 * source. A generic container ("Downloads", "Manga" — `isSuspectParentFolder`)
 * is no parent: a volume picked from it is the same volume as one picked
 * loose. `literalParent` is the folder it sat in, container or not.
 */
export function locateVolume(pairing: Located) {
  const { seriesTitle, volumeTitle, hasParent } = extractFolderTitlesFromPath(
    pairing.titlePath ?? pairing.basePath
  );
  const literalParent = hasParent ? seriesTitle : null;
  const parent = literalParent && !isSuspectParentFolder(literalParent) ? literalParent : null;
  return {
    parent,
    literalParent,
    own: volumeTitle,
    identity: parent ? `${parent}/${volumeTitle}` : volumeTitle
  };
}

/**
 * Every uuid this volume may already be stored under, most specific first:
 * its literal location; inside the folder it sat in; loose; inside a series
 * folder named after the series its name carries; and the formula every
 * import used before the review (`series/volume` of the cleaned-up guess,
 * which ignores the pick shape). A bare number ("01") alone names no volume,
 * so it is never looked up loose.
 */
export function identityUuids(pairing: Located): string[] {
  const { literalParent, own, identity } = locateVolume(pairing);
  const keys = [identity];
  if (literalParent) keys.push(`${literalParent}/${own}`);
  if (!isBareVolumeName(own)) keys.push(own, `${extractSeriesName(own)}/${own}`);
  const legacy = extractTitlesFromPath(pairing.basePath);
  keys.push(`${extractSeriesName(pairing.basePath)}/${legacy.volumeTitle}`);
  return [...new Set(keys.map(generateDeterministicUUID))];
}
