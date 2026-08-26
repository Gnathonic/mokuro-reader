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
   * see `pruneExpiredCloudCovers`. Written once, at flush
   * (`cover-persist.ts`), and never refreshed afterward: the placeholder a
   * cached cover belongs to already carries its `thumbnail`, so
   * `isCoverFetchTarget` never asks for it again, and there is no other read
   * path that touches this row. So `CLOUD_COVER_MAX_AGE_MS` is "14 days after
   * caching", not "14 days since last viewed" — there is deliberately no
   * `touchCloudCovers`; see that constant's doc comment for why one was
   * removed rather than wired up. Staleness of the cover ITSELF is decided
   * elsewhere, by comparing `series_index`'s `cover_size`/`cover_modified`
   * for this volume against the current listing; nothing stored on this row
   * participates in that comparison.
   */
  cached_at: number;
}

/** Write covers, normalizing paths so every caller lands on the same key. */
export async function putCloudCovers(covers: CloudCover[]): Promise<void> {
  if (covers.length === 0) return;
  await db.cloud_covers.bulkPut(covers.map((c) => ({ ...c, path: normalizeCachePath(c.path) })));
}

/**
 * The requested paths' cached covers for one account, via the primary key —
 * an indexed point read per path, never a table scan. Callers already know
 * which paths are on screen (from the listing joined with `series_index`), so
 * this never needs to discover paths itself, and an empty request short-
 * circuits before touching the db.
 */
export async function getCloudCovers(
  scope: string,
  paths: string[]
): Promise<Map<string, CloudCover>> {
  if (paths.length === 0) return new Map();
  const keys = paths.map((p) => [scope, normalizeCachePath(p)] as [string, string]);
  const rows = await db.cloud_covers.where('[account_scope+path]').anyOf(keys).toArray();
  return new Map(rows.map((r) => [r.path, r]));
}

/**
 * Covers untouched for this long are discarded. Age only — no size quota, and
 * measured from when the cover was CACHED, not last viewed: see
 * `CloudCover.cached_at`'s doc comment for why there is no "last access" to
 * measure from (a `touchCloudCovers` that wrote to `cloud_covers` from the
 * read path would re-fire `cloudCoverMap`'s liveQuery, which would touch
 * again — an unbounded write/read feedback loop).
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
