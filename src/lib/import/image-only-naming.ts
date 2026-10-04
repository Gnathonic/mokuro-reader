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
 * which ignores the pick shape).
 *
 * Only keys that name a SERIES: a bare number ("01") loose, in a generic
 * container, or as an archive's inside path says nothing about which series
 * it is — the pre-review formula even reads "01" as series "0" — so such a
 * key would match another series' volume. A volume with nothing but a bare
 * name is looked up under nothing (it is new).
 */
export function identityUuids(pairing: Located): string[] {
  const { parent, literalParent, own, identity } = locateVolume(pairing);
  const bare = isBareVolumeName(own);
  const keys: string[] = [];
  if (parent || !bare) keys.push(identity);
  if (literalParent && (parent || !bare)) keys.push(`${literalParent}/${own}`);
  if (!bare) keys.push(own, `${extractSeriesName(own)}/${own}`);
  if (legacyNamesSeries(pairing.basePath)) {
    const legacy = extractTitlesFromPath(pairing.basePath);
    keys.push(`${extractSeriesName(pairing.basePath)}/${legacy.volumeTitle}`);
  }
  return [...new Set(keys.map(generateDeterministicUUID))];
}

/** Does the pre-review formula read a series from `basePath`, not just a number? */
function legacyNamesSeries(basePath: string): boolean {
  const parts = basePath
    .replace(/\.(cbz|zip)$/i, '')
    .split('/')
    .filter((p) => p.length > 0);
  const leaf = parts[parts.length - 1];
  if (!leaf) return false;
  if (!isBareVolumeName(leaf)) return true;
  const holder = parts[parts.length - 2];
  return holder !== undefined && !isSuspectParentFolder(holder);
}
