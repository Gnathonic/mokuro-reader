import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { volumes as progressStore, enrichAllOrphanedVolumes } from '$lib/settings';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { cacheManager } from '$lib/util/sync/cache-manager';
import { listSeriesIndexes, type SeriesIndexRecord } from './series-index';
import { openSeries } from './series-open';
import { materializeHistoryRows } from './history-rows';
import { normalizeSeriesKey } from './series-key';

/**
 * Series pulled per run. Each pull is a `series.json` download, so a device
 * whose progress file references a hundred long-gone series must not turn a
 * catalog open into a hundred requests — the rest are patched on the next run.
 *
 * This caps the NETWORK phase only, and that phase is now the rare one: a
 * series whose `series.json` is already cached is served by
 * `materializeHistoryRows` with no request at all, and the listing-wide index
 * refresh (`series-index-sync.ts`) caches one for every folder in the account.
 * What is left here is the window before that refresh has caught up — where
 * five downloads per run is exactly the right budget.
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
 *
 * It can no longer hide a hole for a whole session, which it used to be able
 * to: a series memoized here before its `series.json` had been cached is still
 * picked up by `materializeHistoryRows`, which consults nothing in this set —
 * it reads the index cache, so it heals the moment the background refresh
 * lands the file.
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
 * Patch the holes synced progress leaves behind, in two phases.
 *
 * `catalog.json` carries names only, so a device that has read a volume on
 * another machine can hold progress for a series it has no rows and no cached
 * index for — the stats views would show a dangling entry with no title, no
 * counts and no cover.
 *
 * PHASE 1 — `materializeHistoryRows`, local and unmetered. Every volume with
 * genuine reading activity that has no row gets one, resolved by `volume_uuid`
 * against the already-cached `series.json` indexes. Zero network, one write
 * transaction for the whole sweep, and no dependence on the progress record
 * carrying a `series_title` — see that function for why that last part is the
 * whole point.
 *
 * WHAT NEITHER PHASE REACHES. An entry with no `series_title` AND no cached
 * `series.json` for its series falls between them: phase 1 cannot find its
 * uuid in any index, and phase 2 skips it outright below because it has no name
 * to pull by. So "legacy entries are now reachable" holds only once the
 * listing-wide index refresh has cached an index for that series — which for a
 * connected account arrives on its own, and for a series long gone from the
 * cloud never does.
 *
 * PHASE 2 — the network fallback, capped. A series that phase 1 could not
 * serve because this device has NO cached index for it gets its `series.json`
 * pulled and its volumes materialized (`openSeries`), which is exactly the
 * state the series would have been in had the user opened it. Phase 1 runs
 * first so the rows it creates take those series out of phase 2's reckoning.
 *
 * Cheap in the normal case: one pass over the progress records, one INDEX-KEY
 * read of the local rows (never a full scan — `volumes` rows carry thumbnail
 * blobs), one over the cached indexes, and zero network when nothing dangles.
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

  // ONE `series_index` read for the whole run, shared by both phases — they
  // each used to issue their own, which on the runs that matter (the ones with
  // work to do) was two `series_index.getAll` for one unchanging answer: phase
  // 1 writes only to `volumes`, so the index list it read cannot have gone
  // stale by the time phase 2 wants it. LAZY, not fetched up front: a run that
  // bails before either phase asks — no provider, no listing, or every
  // dangling title already attempted this session — must still issue no read
  // at all, and this caller re-runs on every mount.
  let indexesOnce: Promise<SeriesIndexRecord[]> | null = null;
  const readIndexes = () => (indexesOnce ??= listSeriesIndexes());

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

    // Phase 1. Local, network-free, and NOT capped at five: it is the phase
    // that actually closes the gap the user reported (726 volumes with
    // history, 36 of them tracked), and it can only act on data already on
    // the device. Awaited before phase 2 plans anything so the rows it writes
    // are visible to the "does this series already have a row" check below.
    await materializeHistoryRows({ readIndexes });

    const progress = get(progressStore);
    const wanted = new Map<string, string>();
    for (const record of Object.values(progress ?? {})) {
      if (!record || record.deletedOn) continue;
      // Phase 2 pulls a `series.json` BY NAME, so a record with no
      // `series_title` gives it nothing to ask for and is skipped here — but
      // it is no longer lost: phase 1 identifies exactly those records by
      // `volume_uuid` against the cached indexes, which is where the legacy
      // entries this used to strand permanently are now served.
      const title = record.series_title;
      if (typeof title !== 'string') continue;
      const key = normalizeSeriesKey(title);
      if (!key || wanted.has(key) || attemptedThisSession.has(key)) continue;
      wanted.set(key, title);
    }
    if (wanted.size === 0) return pulled;

    // The DISTINCT series titles the local rows carry, read off the
    // `series_title` INDEX rather than by scanning the table: this question is
    // about keys, and a `db.volumes.toArray()` would deserialize every
    // installed volume's thumbnail blob to answer it (measured: one
    // `openKeyCursor` and 0 bytes, versus one `getAll` and the whole table's
    // blob payload). Rows with no `series_title` are simply absent from the
    // index, which is also what the old scan wanted — it would have thrown on
    // them.
    for (const title of await db.volumes.orderBy('series_title').uniqueKeys()) {
      if (typeof title === 'string') wanted.delete(normalizeSeriesKey(title));
    }
    for (const index of await readIndexes()) {
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

/**
 * Patch the holes AND fold the result back into the reading records.
 *
 * THE BUG THIS EXISTS TO PREVENT. `patchProgressHoles` mints `volumes` rows;
 * `enrichAllOrphanedVolumes` is what copies a row's series/volume titles ONTO
 * the reading record, and only the record drives what the stats views show —
 * including `ReadingSpeedView`'s `[Missing Series Info]` bucket and the trash
 * button on it. Running the enrichment first and firing the sweep off
 * un-awaited (which is what both callers used to do) means the rows the sweep
 * writes reach nothing for the rest of the visit: the bucket keeps every
 * volume the sweep just resolved, and the destructive control keeps offering
 * them. The second enrichment closes exactly that window.
 *
 * The FIRST enrichment is kept because it is the fast path — it needs only rows
 * already on the device, and the page should not wait on a cloud listing to
 * show titles it can resolve immediately. It is also nearly free when there is
 * nothing to do: `enrichAllOrphanedVolumes` reads IndexedDB only when the store
 * actually holds an orphan, and then only those rows.
 *
 * Best-effort, like everything else here: never rejects.
 */
export async function patchProgressHolesAndEnrich(options?: { limit?: number }): Promise<string[]> {
  await enrichQuietly();
  const pulled = await patchProgressHoles(options);
  // Awaited AFTER the sweep, not alongside it: this is the pass that sees the
  // rows the sweep just wrote.
  await enrichQuietly();
  return pulled;
}

/**
 * Run `patchProgressHolesAndEnrich` now, and — if the listing was not loaded
 * yet at that moment — exactly once more when it arrives.
 *
 * THE RACE THIS CLOSES. `patchProgressHoles` bails with ZERO work done,
 * including the local, network-free phase (`materializeHistoryRows`) that
 * needs no cloud round trip and is the one that actually closes a gap like
 * "726 volumes with history, 36 tracked" — whenever `listingIsLoaded()` is
 * false. Both callers (`CatalogView`, `ReadingSpeedView`) run the sweep from
 * `onMount`, which on a cold app start can fire before `initializeProviders()`
 * `fetchAllCloudVolumes()` has resolved. A mount that loses that race used to
 * get nothing for the rest of that visit — the exact symptom reported: a
 * stats page opened straight after launch, before the listing was in, showed
 * untracked history forever.
 *
 * `unifiedCloudManager.cloudFiles` is used as the "the listing just arrived"
 * signal rather than a bespoke one, matching how `SeriesView` already treats
 * that store's transition-to-non-empty as "cache is now loaded". It is not a
 * perfect proxy — an account with a genuinely empty cloud never re-triggers —
 * but `patchProgressHoles`'s own internal `listingIsLoaded()` check is the
 * actual authority in that case too, and a truly empty listing has nothing
 * for either phase to resolve regardless.
 *
 * AT MOST ONE RETRY. `cloudFiles` re-emits on every fetch, dedup pass and
 * cache mutation for the rest of the app's life — reacting to all of them
 * would re-sweep on every unrelated cache change. The `retried` flag caps it
 * at one. The delivery `.subscribe()` makes SYNCHRONOUSLY the moment this
 * subscribes (Svelte stores replay their current value to a new subscriber)
 * is treated as a snapshot, not a trigger: if the listing was already loaded
 * at mount, the unconditional call above already covered it, and firing the
 * retry on that same initial value would double the sweep on every ordinary
 * visit instead of only the cold-start one this exists for.
 *
 * NO LEAK. Returns the store's unsubscribe function; callers MUST invoke it
 * on unmount (e.g. from `onMount`'s cleanup return) or the subscription — and
 * the closure it holds — outlives the component.
 */
export function patchProgressHolesWhenListingReady(): () => void {
  void patchProgressHolesAndEnrich();

  let sawInitialSnapshot = false;
  let retried = false;
  return unifiedCloudManager.cloudFiles.subscribe((files) => {
    if (!sawInitialSnapshot) {
      // The replay-on-subscribe delivery: not a change, so not a trigger.
      sawInitialSnapshot = true;
      return;
    }
    if (retried || files.size === 0) return;
    retried = true;
    void patchProgressHolesAndEnrich();
  });
}

/**
 * Guarded PER PASS, not around the sequence: a failing enrichment must not take
 * the sweep down with it, and a failure in the first pass must not cost the
 * second — that one is the whole reason this function exists.
 */
async function enrichQuietly(): Promise<void> {
  try {
    await enrichAllOrphanedVolumes();
  } catch (error) {
    console.debug('[hole-patch] enrichment failed:', error);
  }
}
