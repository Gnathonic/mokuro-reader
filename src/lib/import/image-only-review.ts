/**
 * Image-only import review (#285): the volumes an import found without a
 * `.mokuro`, grouped into series, and the names one series step gives them.
 *
 * A CANDIDATE is one image-only volume — an image folder, or a volume inside a
 * picked archive found by the pre-import listing — with its literal location.
 * The review shows ONE series at a time, so candidates are grouped:
 *
 * - with a parent folder (a series folder, or the archive holding volume
 *   folders): by that parent's literal name;
 * - loose (a bare archive, or a picked folder holding images directly): by the
 *   series the cleaned-up extraction reads from its name, so
 *   `Killing Bites v01.cbz` … `v10.cbz` dropped together are one step.
 *
 * Candidates whose series is stored under the same title are one group.
 * Groups are ordered by series name, volumes by their literal names (natural).
 *
 * `nameGroup` turns one step's choices into the names each volume is saved
 * under. The uuid source (`identity`) is always the literal location and never
 * depends on the series field, the mode, the start number or a rename.
 */

import { extractSeriesName, generateDeterministicUUID } from '$lib/util/series-extraction';
import { naturalSort } from '$lib/util/natural-sort';
import { generateUUID } from '$lib/util/uuid';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { locateVolume, storedTitle, type ImportNames } from './image-only-naming';

export type NamingMode = 'cleaned' | 'folder';

/** One image-only volume offered for review. Strings only — never bytes. */
export interface ReviewCandidate {
  /** Unique within the import session. */
  id: string;
  basePath: string;
  /** Its literal location when `basePath` alone loses it (archive volumes). */
  titlePath?: string;
  /** What the user picked, shown in grey beside the name. */
  source: string;
}

/** One series step of the review. */
export interface ReviewGroup {
  id: string;
  /** Default series name: the parent's literal name, or extracted from a loose name. */
  series: string;
  /** Natural order of each candidate's own literal name. */
  candidates: ReviewCandidate[];
  /** The uuids these volumes are saved under (from their literal locations). */
  ownUuids: string[];
  /** Volumes `series` already has outside this group; set by the import service. */
  existingCount: number;
}

/** What the user chose for one step. */
export interface GroupNaming {
  series: string;
  mode: NamingMode;
  /** First generated number (`cleaned` only). */
  start: number;
  /** Candidate id → name the user typed. Blank = not renamed. */
  overrides: Record<string, string>;
}

export function groupCandidates(candidates: ReviewCandidate[]): ReviewGroup[] {
  const groups = new Map<
    string,
    { series: string; members: { candidate: ReviewCandidate; own: string }[] }
  >();
  for (const candidate of candidates) {
    const { parent, own } = locateVolume(candidate);
    const series = parent ?? extractSeriesName(candidate.basePath);
    const key = storedTitle(series);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { series, members: [] }));
    group.members.push({ candidate, own });
  }

  return [...groups.values()]
    .sort((a, b) => naturalSort(a.series, b.series))
    .map(({ series, members }) => {
      const ordered = members
        .sort((a, b) => naturalSort(a.own, b.own))
        .map((member) => member.candidate);
      return {
        id: generateUUID(),
        series,
        candidates: ordered,
        ownUuids: ordered.map((c) => generateDeterministicUUID(locateVolume(c).identity)),
        existingCount: 0
      };
    });
}

/** The step as it first appears: the group's series, numbering after its volumes. */
export function defaultNaming(group: ReviewGroup, mode: NamingMode): GroupNaming {
  return { series: group.series, mode, start: group.existingCount + 1, overrides: {} };
}

/** The names each of the group's volumes is saved under, keyed by candidate id. */
export function nameGroup(group: ReviewGroup, naming: GroupNaming): Map<string, ImportNames> {
  const series = naming.series.trim() || group.series;
  const start = Number.isInteger(naming.start) && naming.start >= 1 ? naming.start : 1;
  const width = Math.max(2, String(start + group.candidates.length - 1).length);
  const names = new Map<string, ImportNames>();
  group.candidates.forEach((candidate, i) => {
    const { own, identity } = locateVolume(candidate);
    const generated =
      naming.mode === 'folder' ? own : `${series} ${String(start + i).padStart(width, '0')}`;
    const typed = naming.overrides[candidate.id]?.trim();
    names.set(candidate.id, { series, volume: typed || generated, identity });
  });
  return names;
}

/** A series the library already has (keys only: title + how many volumes). */
export interface LibrarySeries {
  title: string;
  count: number;
}

/**
 * The library's own spelling of the series `typed` names — case, spacing and
 * reserved characters aside, the way the catalog groups series — so a typed
 * "killing bites" joins "Killing Bites" (and continues its numbering) instead
 * of starting a near-duplicate series.
 */
export function canonicalSeriesTitle(
  library: readonly LibrarySeries[],
  typed: string
): string | undefined {
  if (!typed.trim()) return undefined;
  const key = normalizeSeriesKey(storedTitle(typed.trim()));
  return library.find((s) => normalizeSeriesKey(s.title) === key)?.title;
}
