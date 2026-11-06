/**
 * Which mokuro-bunko releases keep reading history per user.
 *
 * Before 0.7.8 bunko maps every path under `/mokuro-reader/` that is not one
 * of its fixed per-user files into the SHARED library, so `history/<device>/`
 * would be one tree for every account. 0.7.8 (backported from 0.8.0) maps
 * `history/` per user, lists it in `per_user_files`, and is the first release
 * to report its `version` in `/login/api/me` (mokuro-bunko issue #27). No
 * version reported = older.
 *
 * Both must hold: the version, and `history/` in `per_user_files` — a build
 * that leaves history out of its per-user set would still share the tree.
 */
export const BUNKO_HISTORY_MIN_VERSION = [0, 7, 8] as const;

/** The `per_user_files` entry that says `history/` is kept per account. */
export const BUNKO_HISTORY_PER_USER_ENTRY = 'history/';

/**
 * Only the numeric core is compared: a `0.8.0-beta.N` counts as 0.8.0.
 * Missing, two-part or unparseable versions are never at least anything.
 */
export function bunkoVersionAtLeast(
  version: string | undefined,
  min: readonly [number, number, number]
): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== min[i]) return parts[i] > min[i];
  }
  return true;
}

export function bunkoSupportsHistory(
  version: string | undefined,
  perUserFiles: readonly string[] | undefined
): boolean {
  return (
    bunkoVersionAtLeast(version, BUNKO_HISTORY_MIN_VERSION) &&
    (perUserFiles?.includes(BUNKO_HISTORY_PER_USER_ENTRY) ?? false)
  );
}
