/**
 * The library's series, for the image-only review (#285): what the series
 * field autocompletes to, and where a series' numbering continues.
 *
 * Keys only — the `series_title` index and primary keys. Rows carry
 * thumbnails; reading them to count would cost a blob read per volume.
 */

import { db } from '$lib/catalog/db';
import { seriesVolumeUuids } from './database';
import { storedTitle } from './image-only-naming';
import type { LibrarySeries } from './image-only-review';

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
 * How many volumes `series` (as it would be stored) already has, not counting
 * `exclude` — the group's own uuids, so re-importing a series keeps its numbers.
 */
export async function existingVolumeCount(
  series: string,
  exclude: Iterable<string> = []
): Promise<number> {
  const skip = new Set(exclude);
  const uuids = await seriesVolumeUuids(storedTitle(series));
  return uuids.filter((uuid) => !skip.has(uuid)).length;
}
