import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { volumes as progressStore } from '$lib/settings';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { cacheManager } from '$lib/util/sync/cache-manager';
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
 * Is there a COMPLETE cloud listing to check `openSeries` against right now?
 *
 * A non-null `getActiveProvider()` is not enough: `initializeCurrentProvider()`
 * flips the provider non-null before `fetchAllCloudVolumes()` has resolved, and
 * in that window `refreshSeriesIndexForSeries`'s OWN early return —
 * `cloudVolumeTitlesFor(seriesTitle).size === 0` — makes `openSeries` a silent,
 * zero-I/O no-op for every title, same as the no-provider case. Only the cache
 * itself knows whether it has been filled (same discipline `writeCatalogFile` /
 * `writeSeriesFile` use before pruning against a listing).
 */
function listingIsLoaded(): boolean {
  const provider = unifiedCloudManager.getActiveProvider();
  return !!provider && !!cacheManager.getCache(provider.type)?.isLoaded();
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
 * Returns the series titles actually ATTEMPTED (via `openSeries`) while a
 * provider was connected. `openSeries` resolving without throwing says
 * nothing about network success on its own — a series can genuinely not
 * exist in the cloud, in which case nothing is downloaded but nothing throws
 * either — so this is "attempted", not "confirmed fetched". Never rejects.
 */
export async function patchProgressHoles(options?: { limit?: number }): Promise<string[]> {
  const limit = options?.limit ?? MAX_HOLE_PATCHES_PER_RUN;
  const pulled: string[] = [];

  try {
    // `openSeries` no-ops with zero I/O both when no provider is connected
    // (`refreshSeriesIndexForSeries`: `if (!provider) return cached?.file`) AND
    // when a provider is connected but its listing hasn't finished loading yet
    // (the SAME function's next early return: `cloudVolumeTitlesFor(seriesTitle)
    // .size === 0 → cached?.file` — an unloaded cache reports every series as
    // having zero cloud volumes). CatalogView's onMount fires before
    // `initializeProviders()` (fire-and-forget from +layout) has finished
    // `initializeCurrentProvider()` AND `fetchAllCloudVolumes()`, so a run that
    // started here can land in EITHER window and memoize every dangling title
    // as "attempted" despite nothing having actually been tried — silently
    // hiding the hole for the rest of the session. Bail before touching the
    // session memory or doing any work; the hole is still there next time this
    // runs once the listing has loaded. See `listingIsLoaded`.
    if (!listingIsLoaded()) return pulled;

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
      // Re-checked per attempt, not just once at entry: the provider or its
      // listing can drop between awaits (e.g. a logout, or a provider switch
      // clearing the cache). A title skipped here was never actually
      // attempted, so it is left un-memoized for the next run.
      if (!listingIsLoaded()) break;
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
