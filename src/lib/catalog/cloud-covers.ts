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
   * Epoch ms. Drives expiry only — see `pruneExpiredCloudCovers`. Staleness
   * of the cover ITSELF is decided elsewhere, by comparing `series_index`'s
   * `cover_size`/`cover_modified` for this volume against the current
   * listing; nothing stored on this row participates in that comparison.
   */
  last_accessed: number;
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
 * Mark covers as used, so browsing keeps them alive and neglect expires them.
 * Modifies only the timestamp: the thumbnail blob is left in place rather than
 * rewritten, which would cost a fresh blob write per view.
 */
export async function touchCloudCovers(
  scope: string,
  paths: string[],
  nowMs: number = Date.now()
): Promise<void> {
  if (paths.length === 0) return;
  const keys = paths.map((p) => [scope, normalizeCachePath(p)] as [string, string]);
  await db.cloud_covers.where('[account_scope+path]').anyOf(keys).modify({ last_accessed: nowMs });
}
