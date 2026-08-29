import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { activeAccountScope, normalizeCachePath } from './cloud-cache-key';
import { cachedCoverPaths } from './cloud-covers';
import { refreshCoverKeys } from './cover-resolver';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { isCbzFile } from '$lib/util/sync/syncable-file';

/** The one shared empty set, so "nothing cached" never mints a new identity. */
const EMPTY_PATHS: ReadonlySet<string> = new Set<string>();

/**
 * KEYS, NEVER BLOBS.
 *
 * This store used to be `cloudCoverMap`: a `liveQuery` over the blob-returning
 * row read (the shape `_getCloudCoversForTests` still has, for tests) for
 * EVERY listed `.cbz` path (~4,347 tuples through `anyOf`). Dexie re-runs a
 * liveQuery querier on every commit to the table, so each cover finishing its
 * download re-materialised every cover row
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
 * finish downloading would stay blank until it remounted. `refreshCoverKeys` is
 * the repair, and this is what drives it: the key set is exactly the signal
 * "the cover for this path is now on disk".
 *
 * IT HANDS OVER THE DIFF, NOT THE SET. The published set is the whole cached
 * library — ~4,347 keys on the reference one — and it is published again on
 * every commit to `cloud_covers`, which during ingest means once per write
 * batch. Handing the resolver all of it made the per-write cost O(LIBRARY):
 * a Map lookup, a template-string key and (before `refreshCoverKeys`) a
 * re-normalisation for every cached path in the account, to find the handful
 * that just landed. Nothing bounded that, and the byte contract cannot see it
 * — a keys-only cursor over 4,347 keys satisfies its anchor while
 * deserializing nothing. It got ~11x worse for free when write batches were
 * capped at `COVER_PERSIST_MAX_BATCH`: a reference cold start went from ~4
 * commits to ~44, so the same walk ran ~44 times (~190,000 redundant
 * normalisations). Two tasks of one plan, each right on its own. And now
 * that `cover-persist.ts` flushes immediately (batching removed by user
 * ruling — covers paint asap), a cold start commits once per co-arrival
 * group, potentially once per COVER — which is exactly why per-commit work
 * here must stay O(what landed), never O(library).
 *
 * So this keeps the last published set and passes on only the keys that are
 * NEW — which is precisely "these covers just landed", the only thing
 * `refreshCoverKeys` can act on. Per-write work is now O(covers in that
 * write); `cloud-covers-store.diff.test.ts` bounds it.
 *
 * REMOVALS ARE NOT NEWS. A key leaving the set means its row was pruned (the
 * 14-day TTL) or its account went away; a handle still holding that blob is
 * showing the same picture it was, and re-reading would only replace it with a
 * miss.
 *
 * THE SCOPE IS PART OF THE DIFF. Resolver entries are keyed by account scope
 * as well as path, so after an account switch every key is new to the resolver
 * even when the strings are identical — the store re-emits for exactly that
 * reason. A switch therefore hands over the whole set, once, rather than an
 * empty diff. Same for the first publish of a watch, where "new since last
 * time" means all of it.
 *
 * WHO CALLS IT. `cover-resolver.ts`'s `acquireCover`, lazily, on the first
 * claim of the session (`ensureCoverKeyWatch`). It used to be one more
 * `init*` line in `+layout.svelte`, which made it deletable by an edit to a
 * file that says nothing about covers — with every test still green, because
 * the tests below call it themselves. Hanging it off the claim path makes it
 * structural instead: the only way to hold a cover is to acquire one.
 *
 * Returns the unsubscriber for tests; production never calls it.
 */
/*
 * COST NOTE, and the boundary on how to fix it if it ever shows in a profile:
 * write-through cover persistence commits per co-arrival group, and every
 * commit re-runs the keys-only querier here (~one key per listed archive,
 * ZERO blob bytes — pinned by contract). If that duty cycle ever matters,
 * the fix is a cheaper announce channel (e.g. publishing changed keys
 * directly instead of re-scanning) — NEVER a reintroduced write delay:
 * pacing the writes was the old design, it only delayed paint, and the
 * user ruled it out explicitly ("the only remedy for ui jank is to
 * background the downloads, not to pace them").
 */
export function initCoverKeyWatch(): () => void {
  // The scope and key set this watch last handed to the resolver. Read back
  // from `activeAccountScope()` rather than carried on the emission: it is the
  // same source of truth `refreshCoverKeys` itself resolves against, so the
  // two can never disagree about which account a key belongs to.
  let watchedScope: string | null = null;
  let watched: ReadonlySet<string> = EMPTY_PATHS;

  return cachedCoverPathSet.subscribe((paths) => {
    const scope = activeAccountScope();
    if (scope !== watchedScope) {
      watchedScope = scope;
      watched = paths;
      if (paths.size > 0) refreshCoverKeys(paths);
      return;
    }
    const landed: string[] = [];
    for (const path of paths) if (!watched.has(path)) landed.push(path);
    watched = paths;
    if (landed.length > 0) refreshCoverKeys(landed);
  });
}
