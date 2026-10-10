/**
 * Which mokuro-bunko releases keep reading history per user.
 *
 * Before 0.7.1 bunko maps every path under `/mokuro-reader/` that is not one
 * of its fixed per-user files into the SHARED library, so `history/<device>/`
 * would be one tree for every account. From 0.7.1 it maps `history/` per user
 * and reports its version in `/login/api/me` (mokuro-bunko issue #27). No
 * version reported = older than that.
 *
 * Only the numeric core is compared: a `0.7.1-beta.N` counts as 0.7.1.
 */
export const BUNKO_HISTORY_MIN_VERSION = [0, 7, 1] as const;

export function bunkoSupportsHistory(version: string | undefined): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== BUNKO_HISTORY_MIN_VERSION[i]) return parts[i] > BUNKO_HISTORY_MIN_VERSION[i];
  }
  return true;
}
