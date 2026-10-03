/**
 * Names for image-only volumes (#285), decided once per import batch.
 *
 * Two modes, both read from where each volume sits on disk and never from
 * numbers parsed out of its name — real folder and archive names are too
 * varied for that:
 *
 * - `cleaned` (default): the series is the parent folder's name; volumes are
 *   that name plus a GENERATED number, counting in natural folder order —
 *   "Chained Soldier (Semi-Color)/01" → "Chained Soldier (Semi-Color) 01".
 *   Numbering continues after the volumes the series already has, so a later
 *   batch of the same series does not restart at 01.
 * - `folder`: the series is the parent folder's name and the volume its own
 *   folder or archive name, exactly as written.
 *
 * A volume with no parent folder (a root-level folder or archive) takes its
 * series from the cleaned-up path extraction in `cleaned` mode and from its
 * own name in `folder` mode.
 *
 * The volume's uuid comes from its literal location (`identity`), not from a
 * generated title, so it is the same in both modes: re-importing a folder
 * under the other mode finds the volume already there instead of adding a
 * duplicate, and two batches that number differently can never overwrite
 * each other.
 *
 * The prompt previews these names, sanitized as `saveVolume` stores them;
 * `processVolume` saves exactly them (`DecompressedVolume.importNames`).
 */

import { extractFolderTitlesFromPath, extractSeriesName } from '$lib/util/series-extraction';
import { naturalSort } from '$lib/util/natural-sort';
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';
import type { PairedSource } from './types';

/** The names one image-only volume is saved under. */
export interface ImportNames {
  series: string;
  volume: string;
  /** Its literal location ("Series folder/Volume folder"), the uuid source. */
  identity: string;
}

export interface SeriesNamePreview {
  seriesName: string;
  volumeCount: number;
  /** Volume titles as stored, natural order. */
  volumeNames: string[];
}

export interface ImageOnlyNamingPlan {
  cleaned: Map<string, ImportNames>;
  folder: Map<string, ImportNames>;
  preview: { cleaned: SeriesNamePreview[]; folder: SeriesNamePreview[] };
}

type NamingInput = Pick<PairedSource, 'id' | 'basePath' | 'titlePath'>;

/** Stored form of a title segment, as `saveVolume` writes it. */
export function storedTitle(title: string): string {
  return sanitizeTitleSegment(title) || 'Untitled';
}

function locate(pairing: NamingInput) {
  const { seriesTitle, volumeTitle, hasParent } = extractFolderTitlesFromPath(
    pairing.titlePath ?? pairing.basePath
  );
  return {
    parent: hasParent ? seriesTitle : null,
    own: volumeTitle,
    identity: hasParent ? `${seriesTitle}/${volumeTitle}` : volumeTitle
  };
}

function previewOf(names: Iterable<ImportNames>): SeriesNamePreview[] {
  const groups = new Map<string, string[]>();
  for (const { series, volume } of names) {
    const key = storedTitle(series);
    groups.set(key, [...(groups.get(key) ?? []), storedTitle(volume)]);
  }
  return [...groups.entries()]
    .map(([seriesName, volumeNames]) => ({
      seriesName,
      volumeCount: volumeNames.length,
      volumeNames: volumeNames.sort(naturalSort)
    }))
    .sort((a, b) => a.seriesName.localeCompare(b.seriesName));
}

/** The series each pairing lands in under `cleaned`, keyed as stored. */
export function cleanedSeriesTitles(pairings: NamingInput[]): Set<string> {
  return new Set(
    pairings.map((p) => storedTitle(locate(p).parent ?? extractSeriesName(p.basePath)))
  );
}

/** The uuid-bearing identities of a batch (the same in both modes). */
export function importIdentities(pairings: NamingInput[]): string[] {
  return pairings.map((p) => locate(p).identity);
}

/**
 * Both modes' names for a batch. `existingCounts` maps a stored series title
 * to how many volumes that series already has OUTSIDE this batch; `cleaned`
 * numbering starts after them.
 */
export function planImageOnlyNames(
  pairings: NamingInput[],
  existingCounts: ReadonlyMap<string, number> = new Map()
): ImageOnlyNamingPlan {
  const folder = new Map<string, ImportNames>();
  const bySeries = new Map<string, { id: string; own: string; identity: string }[]>();

  for (const pairing of pairings) {
    const { parent, own, identity } = locate(pairing);
    folder.set(pairing.id, { series: parent ?? own, volume: own, identity });
    const series = parent ?? extractSeriesName(pairing.basePath);
    bySeries.set(series, [...(bySeries.get(series) ?? []), { id: pairing.id, own, identity }]);
  }

  const cleaned = new Map<string, ImportNames>();
  for (const [series, members] of bySeries) {
    const before = existingCounts.get(storedTitle(series)) ?? 0;
    const width = Math.max(2, String(before + members.length).length);
    members
      .sort((a, b) => naturalSort(a.own, b.own))
      .forEach((m, i) => {
        const number = String(before + i + 1).padStart(width, '0');
        cleaned.set(m.id, { series, volume: `${series} ${number}`, identity: m.identity });
      });
  }

  return {
    cleaned,
    folder,
    preview: { cleaned: previewOf(cleaned.values()), folder: previewOf(folder.values()) }
  };
}
