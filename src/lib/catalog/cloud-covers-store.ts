import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { activeAccountScope, normalizeCachePath } from './cloud-cache-key';
import { cachedCoverPaths } from './cloud-covers';
import { refreshCovers } from './cover-resolver';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { isCbzFile } from '$lib/util/sync/syncable-file';

/** The one shared empty set, so "nothing cached" never mints a new identity. */
const EMPTY_PATHS: ReadonlySet<string> = new Set<string>();

/**
 * KEYS, NEVER BLOBS.
 *
 * This store used to be `cloudCoverMap`: a `liveQuery` over
 * `getCloudCovers(scope, paths)` for EVERY listed `.cbz` path (~4,347 tuples
 * through `anyOf`). Dexie re-runs a liveQuery querier on every commit to the
 * table, so each cover finishing its download re-materialised every cover row
 * — blobs included — and handed the result to `volumesWithPlaceholders`.
 * Measured on a 1,027-series library: 3,886 MB deserialized in 59 s, 23
 * full-table re-reads, and (because that Map fed placeholder generation) a
 * worst main-thread long task of 1,784 ms.
 *
 * It now carries the PRIMARY KEYS of the same query and nothing else, via
 * `cachedCoverPaths` — verified against Dexie 4.2.1 as genuinely keys-only:
 * `anyOf` installs an algorithm that reads `cursor.key`, so `primaryKeys()`
 * takes the `keysOnly` branch and values are never deserialized.
 *
 * IDENTITY IS PART OF THE CONTRACT. Dexie hands back a fresh array on every
 * re-run, so the raw query emits a new Set per commit even when nothing about
 * the cached key set changed. Every such emission would be work for whoever
 * consumes it, so this store publishes ONLY when the key set (or the account
 * scope it was read under) actually changed — never when a blob changed, and
 * never for a re-run that found the same keys. `cloud-covers-store.test.ts`
 * pins that.
 *
 * WHAT IT IS FOR. It is deliberately NOT an input to `volumesWithPlaceholders`
 * any more (see `$lib/catalog/index.ts`): a cover landing must not be able to
 * reach `generatePlaceholders`, mint fresh placeholder objects, or re-render
 * 1,027 mounted cards. Its one job is to tell `cover-resolver.ts` that a path
 * it is holding has acquired a cover — see {@link initCoverKeyWatch}.
 *
 * Only archive entries can ever have a `cloud_covers` row keyed to them (see
 * `CloudCover`'s PK doc) — cover sidecars, `.mokuro`/`.mokuro.gz` and
 * everything else the provider lists cannot match, so they are filtered out of
 * the key set with the same `isCbzFile` predicate the rest of the sync code
 * uses to identify an archive, rather than handing every listed path to
 * `anyOf` and letting Dexie discard the misses (measured ~3x more keys than
 * can ever match at catalog scale).
 */
export const cachedCoverPathSet: Readable<ReadonlySet<string>> = readable(EMPTY_PATHS, (set) => {
  let inner: { unsubscribe: () => void } | null = null;

  // The last thing published IN THIS GENERATION, so a re-run that found the
  // same keys is inert. The SCOPE is part of it: two accounts can hold the
  // same paths, and after a switch a consumer must be told to look again even
  // though the key strings are identical.
  //
  // `null` means "nothing published yet since this start callback ran", which
  // is not the same as "the empty set was published": a Svelte `readable`
  // retains its last value across a full unsubscribe/resubscribe cycle, so a
  // generation that deduped its own first publish would hand the new
  // subscriber the PREVIOUS generation's stale key set forever. The first
  // publish of every generation therefore always goes through.
  let publishedScope: string | null = null;
  let published: ReadonlySet<string> | null = null;

  const publish = (scope: string | null, next: ReadonlySet<string>) => {
    if (published !== null && scope === publishedScope && sameKeys(published, next)) return;
    publishedScope = scope;
    published = next;
    set(next);
  };

  const outer = unifiedCloudManager.cloudFiles.subscribe((listing) => {
    inner?.unsubscribe();
    inner = null;

    const scope = activeAccountScope();
    const paths = Array.from(listing.values()).flatMap((files) =>
      files.filter((f) => isCbzFile(f.path)).map((f) => normalizeCachePath(f.path))
    );
    if (!scope || paths.length === 0) {
      publish(null, EMPTY_PATHS);
      return;
    }

    inner = liveQuery(() => cachedCoverPaths(scope, paths)).subscribe({
      next: (found) => publish(scope, found),
      error: (err) => console.debug('[cloud-covers] live key query failed:', err)
    });
  });

  return () => {
    inner?.unsubscribe();
    outer();
  };
});

/** Same members? Cheap enough at catalog scale (a size check, then a lookup each). */
function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const path of b) if (!a.has(path)) return false;
  return true;
}

/**
 * Keep the cover key set live for the app's lifetime, and tell the resolver
 * when a held path acquires a cover.
 *
 * WHY THIS EXISTS AT ALL. `acquireCover` reads once and then never again on
 * its own — that is what makes "two subscribers, one read" unconditional. So a
 * card that mounts during ingest, resolves a MISS, and only then has its cover
 * finish downloading would stay blank until it remounted. `refreshCovers` is
 * the repair, and this is what drives it: the key set is exactly the signal
 * "the cover for this path is now on disk".
 *
 * SELF-LIMITING, so handing it the whole set is cheap: `refreshCovers` skips
 * every path nobody is holding (a Map lookup each) and, without `force`,
 * re-reads only handles that are still a miss. At ~4,347 paths and a handful
 * of key-set changes that is nothing, and it needs no added/removed
 * bookkeeping of its own — which matters, because the store deliberately
 * re-emits on an account switch whose key strings did not change.
 *
 * NOT `force`. A `cloud_covers` row is written once and never rewritten (see
 * `CloudCover.cached_at`), so a path already resolved by a holder cannot have
 * different bytes behind it; forcing would revoke and re-mint object URLs for
 * every held cover on every key-set change.
 *
 * Called once from `+layout.svelte`, alongside the app's other `init*` hooks.
 * Returns the unsubscriber for tests; production never calls it.
 */
export function initCoverKeyWatch(): () => void {
  return cachedCoverPathSet.subscribe((paths) => {
    if (paths.size > 0) refreshCovers(paths);
  });
}
