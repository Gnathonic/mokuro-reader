import { db } from './db';
import { normalizeCachePath } from './cloud-cache-key';

/**
 * One cloud volume's thumbnail, cached because the user browsed past it.
 *
 * Deliberately narrow: everything else a cloud card needs — title, counts,
 * archive size, the cover sidecar's own size/modified stamps — already lives
 * in the cached `series_index` row for that series. Duplicating those fields
 * here would just be a second invalidation path to get wrong. This table
 * exists only for the one thing nothing else holds: the blob.
 *
 * NOT a `volumes` row: nothing here is a relationship with the volume, it is
 * catalog knowledge that may be discarded at any time (see
 * `pruneExpiredCloudCovers`). A volume the user installs or reads graduates
 * to a real `volumes` row and its cover entry becomes redundant.
 *
 * PK is `[account_scope+path]` because providers do not expose volume uuids
 * for files the client has not opened, and the same path under a different
 * account is a different file.
 */
export interface CloudCover {
  account_scope: string;
  /** Library-relative path, normalized by `normalizeCachePath`. */
  path: string;
  thumbnail: File;
  width: number;
  height: number;
  /**
   * Epoch ms when this cover was fetched and written. Drives expiry only —
   * see `pruneExpiredCloudCovers`. Normally set once, at flush
   * (`cover-persist.ts`), and never TOUCHED afterward just because something
   * read the row — see below for why. It is not write-ONCE, though: a
   * `metadata_only` row's stale cover self-heals back through this same
   * table (`putCloudCovers` is a `bulkPut`; see `cover-resolver.ts`'s `NO
   * force` paragraph for when that fires), which is a genuine second write
   * with a fresh `cached_at`, at the same `[account_scope+path]` key. That
   * overwrite changes no KEY, so nothing downstream that watches the key set
   * for arrivals (`cachedCoverPathSet`'s liveQuery) ever notices it — it is
   * invisible to that diff, not forbidden from happening.
   *
   * NOT BECAUSE NOTHING READS THE ROW. That used to be the reason, and it is
   * no longer true in either half: a cached cover's blob was stamped onto its
   * placeholder, so `isCoverFetchTarget` saw a `thumbnail` and never asked
   * again, and nothing else looked at the row at all. That decoration is gone
   * — it is what turned one cover landing into a whole-catalog re-derive — and
   * this row is now read constantly. `isCachedCoverPath` (`cover-service.ts`)
   * exists precisely because the fetch gate lost its accidental suppressor,
   * and `cover-resolver.ts` reads the row on EVERY claim.
   *
   * IT IS NOT REFRESHED, AND THE REASON IS NOT A FEEDBACK LOOP. An earlier
   * version of this comment claimed a touch would re-fire
   * `cachedCoverPathSet`, drive `refreshCoverKeys`, re-read held handles and
   * touch again. That loop does not exist: a touch changes only `cached_at`,
   * the KEY set is unchanged, and the store dedupes on the key set before
   * publishing — so nothing is published and nothing re-reads.
   *
   * The real cost is per-touch, not runaway. Every commit re-runs that
   * liveQuery's querier (a keys-only scan of the whole table) and broadcasts
   * `storagemutated` — a per-commit cost the ingest path pays deliberately
   * (immediacy over pacing, see `cover-persist.ts`) and that nothing should
   * add to gratuitously. A touch per claim would put one of each behind
   * ordinary scrolling, which is reason enough. So there is deliberately no `touchCloudCovers` — see
   * `CLOUD_COVER_MAX_AGE_MS`.
   *
   * THE PRICE, STATED PLAINLY: `CLOUD_COVER_MAX_AGE_MS` is "14 days after
   * caching", not "14 days since last viewed", so a cover the user looks at
   * every day is still discarded on schedule. What that costs is one re-fetch
   * the next time something asks for it — `isCachedCoverPath` answers false
   * once the row is gone, and the fetch pipeline caches it again exactly as it
   * did the first time. A cache miss, not a defect.
   *
   * Staleness of the cover ITSELF is decided elsewhere, by comparing
   * `series_index`'s `cover_size`/`cover_modified` for this volume against the
   * current listing; nothing stored on this row participates in that
   * comparison.
   */
  cached_at: number;
}

/** Write covers, normalizing paths so every caller lands on the same key. */
export async function putCloudCovers(covers: CloudCover[]): Promise<void> {
  if (covers.length === 0) return;
  await db.cloud_covers.bulkPut(covers.map((c) => ({ ...c, path: normalizeCachePath(c.path) })));
}

/**
 * TEST-ONLY. The requested paths' cached ROWS, blobs included, for one
 * account.
 *
 * Named for what it is so nobody mistakes it for a supported read path: it is
 * the shape this whole design removed. Production reads a cover ONE path at a
 * time through `cover-resolver.ts` (a single keyed `get` for the one surface
 * that draws it), and asks "is it cached?" through {@link cachedCoverPaths},
 * which never deserializes a blob at all. A production caller that wanted a
 * SET of rows would be re-materialising the table — `cloudCoverMap` did
 * exactly that on every commit, at 3,886 MB and a 1,784 ms long task on the
 * reference library.
 *
 * What it is for: asserting what a write actually left in the table. Indexed
 * point read per path, never a table scan; an empty request short-circuits
 * before touching the db.
 */
export async function _getCloudCoversForTests(
  scope: string,
  paths: string[]
): Promise<Map<string, CloudCover>> {
  if (paths.length === 0) return new Map();
  const keys = paths.map((p) => [scope, normalizeCachePath(p)] as [string, string]);
  const rows = await db.cloud_covers.where('[account_scope+path]').anyOf(keys).toArray();
  return new Map(rows.map((r) => [r.path, r]));
}

/**
 * Which of the requested paths this account already has a cached cover for.
 *
 * PRIMARY KEYS ONLY, never the rows: this is a presence check, and
 * deserializing the blobs it is checking for would reintroduce exactly the
 * cost that splitting this table out of `volumes` exists to remove. Same
 * indexed point-read-per-path shape as {@link _getCloudCoversForTests}, and the
 * returned paths are normalized, so callers must compare through
 * `normalizeCachePath`.
 */
export async function cachedCoverPaths(scope: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const keys = paths.map((p) => [scope, normalizeCachePath(p)] as [string, string]);
  const found = (await db.cloud_covers
    .where('[account_scope+path]')
    .anyOf(keys)
    .primaryKeys()) as unknown as Array<[string, string]>;
  return new Set(found.map(([, path]) => path));
}

/**
 * Covers cached this long ago are discarded. Age only — no size quota, and
 * measured from when the cover was CACHED, not last viewed: see
 * `CloudCover.cached_at`'s doc comment for why there is no "last access" to
 * measure from. Not a feedback loop — the store dedupes on the key set, and a
 * touch changes no key — but a keys-only rescan plus a `storagemutated`
 * broadcast per claim, behind ordinary scrolling.
 */
export const CLOUD_COVER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Drop covers cached more than `CLOUD_COVER_MAX_AGE_MS` ago. Returns how many
 * were deleted.
 *
 * Deletes through the `cached_at` index rather than scanning: this table
 * carries blobs, and a full scan here would reintroduce exactly the cost this
 * split exists to remove. Account-agnostic on purpose — an account the user
 * stopped using should age out, not linger because it is disconnected.
 */
export async function pruneExpiredCloudCovers(nowMs: number = Date.now()): Promise<number> {
  const cutoff = nowMs - CLOUD_COVER_MAX_AGE_MS;
  return db.cloud_covers.where('cached_at').below(cutoff).delete();
}
