import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { volumes as progressStore } from '$lib/settings';
import { listSeriesIndexes } from './series-index';
import { openSeries } from './series-open';
import { normalizeSeriesKey } from './series-key';

/**
 * Series pulled per run. Each pull is a `series.json` download, so a device
 * whose progress file references a hundred long-gone series must not turn a
 * catalog open into a hundred requests — the rest are patched on the next run.
 */
export const MAX_HOLE_PATCHES_PER_RUN = 5;

/**
 * Series keys this page load has already tried to pull. A series that still
 * has no local row and no cached index after `openSeries` settles is either
 * genuinely absent from the cloud or unreachable right now — either way,
 * retrying it on every catalog open (the caller re-runs this on EVERY mount)
 * would turn a permanent gap into a permanent request. Cleared only by a
 * fresh page load, matching the "session-scoped" contract; a series that was
 * only deferred by the run cap is never added here, so it is still picked up
 * next run.
 */
const attemptedThisSession = new Set<string>();

/** Test-only: clears the session memory so cases don't leak into each other. */
export function resetHolePatchSessionForTests(): void {
  attemptedThisSession.clear();
}

/**
 * Patch the holes synced progress leaves behind.
 *
 * `catalog.json` carries names only, so a device that has read a volume on
 * another machine can hold progress for a series it has no rows and no cached
 * index for — the stats views would show a dangling entry with no title, no
 * counts and no cover. Each such series gets its `series.json` pulled and its
 * volumes materialized (`openSeries`), which is exactly the state the series
 * would have been in had the user opened it.
 *
 * Cheap in the normal case: one pass over the progress records, one over the
 * local rows, one over the cached indexes, and zero network when nothing dangles.
 * Tombstones (`deletedOn`) are skipped — the user deleted those on purpose.
 *
 * Returns the series titles it actually pulled. Never rejects.
 */
export async function patchProgressHoles(options?: { limit?: number }): Promise<string[]> {
  const limit = options?.limit ?? MAX_HOLE_PATCHES_PER_RUN;
  const pulled: string[] = [];

  try {
    const progress = get(progressStore);
    const wanted = new Map<string, string>();
    for (const record of Object.values(progress ?? {})) {
      if (!record || record.deletedOn) continue;
      const title = record.series_title;
      if (typeof title !== 'string') continue;
      const key = normalizeSeriesKey(title);
      if (!key || wanted.has(key) || attemptedThisSession.has(key)) continue;
      wanted.set(key, title);
    }
    if (wanted.size === 0) return pulled;

    for (const row of await db.volumes.toArray()) {
      wanted.delete(normalizeSeriesKey(row.series_title));
    }
    for (const index of await listSeriesIndexes()) {
      wanted.delete(index.series_key);
    }
    if (wanted.size === 0) return pulled;

    for (const [key, title] of [...wanted.entries()].slice(0, limit)) {
      attemptedThisSession.add(key);
      try {
        await openSeries(title);
        pulled.push(title);
      } catch (error) {
        console.debug(`[hole-patch] could not pull '${title}':`, error);
      }
    }
  } catch (error) {
    console.debug('[hole-patch] pass failed:', error);
  }
  return pulled;
}
