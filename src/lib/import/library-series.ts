/**
 * The library's series, for the image-only review (#285): what the series
 * field autocompletes to, where a series' numbering continues, and which
 * reviewed volumes the library already has.
 *
 * Keys only — the `series_title` index and primary keys. Rows carry
 * thumbnails; reading them to count would cost a blob read per volume.
 */

import { db } from '$lib/catalog/db';
import { seriesVolumeUuids } from './database';
import { identityUuids, storedTitle } from './image-only-naming';
import type { LibraryMatch, LibrarySeries, ReviewGroup } from './image-only-review';

/** Every series title the library has, once, with its volume count (index order). */
export async function listLibrarySeries(): Promise<LibrarySeries[]> {
  // One keys-only read of the index: duplicates included, so it carries the counts.
  const keys = await db.volumes.orderBy('series_title').keys();
  const counts = new Map<string, number>();
  for (const key of keys) {
    const title = String(key);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return [...counts].map(([title, count]) => ({ title, count }));
}

/**
 * Volumes approved in the review but not saved yet: uuid → the stored series
 * title they will be saved under. They count toward their series like saved
 * ones, so a series picked again while its first batch still imports (the
 * phone flow: pick, approve, pick the next volumes) numbers after that batch
 * instead of colliding with it. Each leaves once it is saved, fails or is
 * cancelled (`settleVolumesInFlight`).
 */
const inFlight = new Map<string, string>();

export function noteVolumesInFlight(volumes: Iterable<{ uuid: string; series: string }>): void {
  for (const { uuid, series } of volumes) inFlight.set(uuid, storedTitle(series));
}

export function settleVolumesInFlight(uuids: Iterable<string>): void {
  for (const uuid of uuids) inFlight.delete(uuid);
}

/**
 * How many volumes `series` (as it would be stored) already has — saved, or
 * approved and on their way — not counting `exclude`, the volumes the group
 * being reviewed would add.
 */
export async function existingVolumeCount(
  series: string,
  exclude: Iterable<string> = []
): Promise<number> {
  const stored = storedTitle(series);
  const uuids = new Set(await seriesVolumeUuids(stored));
  for (const [uuid, title] of inFlight) if (title === stored) uuids.add(uuid);
  for (const uuid of exclude) uuids.delete(uuid);
  return uuids.size;
}

/**
 * Which candidates of `groups` the library already has, under any uuid the
 * volume may have been stored under (`identityUuids`: another pick shape, or
 * the formula every import used before the review). Two keys-only reads for
 * the whole batch: the `volumes` primary keys, then the `volume_ocr` primary
 * keys of the hits — a row with its OCR row is installed, one without was
 * removed from the device and keeps only its metadata.
 *
 * Fills each group's `matches` and drops matched volumes from its `ownUuids`.
 */
export async function matchLibraryVolumes(groups: ReviewGroup[]): Promise<void> {
  const lookups = groups.flatMap((group) =>
    group.candidates.map((candidate) => ({ group, candidate, uuids: identityUuids(candidate) }))
  );
  const wanted = [...new Set(lookups.flatMap((l) => l.uuids))];
  if (wanted.length === 0) return;
  const present = new Set((await db.volumes.where(':id').anyOf(wanted).primaryKeys()).map(String));
  if (present.size === 0) return;

  const hits = new Map<{ group: ReviewGroup; candidateId: string }, string>();
  for (const { group, candidate, uuids } of lookups) {
    const uuid = uuids.find((u) => present.has(u));
    if (uuid) hits.set({ group, candidateId: candidate.id }, uuid);
  }
  const installed = new Set(
    (
      await db.volume_ocr
        .where(':id')
        .anyOf([...new Set(hits.values())])
        .primaryKeys()
    ).map(String)
  );
  for (const [{ group, candidateId }, uuid] of hits) {
    const match: LibraryMatch = { uuid, installed: installed.has(uuid) };
    group.matches.set(candidateId, match);
  }
  for (const group of groups) {
    group.ownUuids = group.candidates
      .filter((c) => !group.matches.has(c.id))
      .map((c) => identityUuids(c)[0]);
  }
}
