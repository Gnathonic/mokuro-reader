/**
 * Other devices' reading history, mid-session, on a provider WITHOUT a change
 * feed (#288).
 *
 * The sync's history pass reads the listing cache, and on WebDAV (incl.
 * mokuro-bunko) and Local Folder that cache moves only when this device walks
 * the whole library — app start, a manual refresh, a backup, a rename. So a
 * second device's new month never arrived while the app stayed open. Drive and
 * OneDrive read their change feed at the start of every sync; MEGA's tree is
 * live. WebDAV offers no change token (a collection's `getetag` need not move
 * when something deeper does, and servers differ), so instead `history/` alone
 * is listed again — the folder the quick tier already lists this way — at most
 * once per {@link HISTORY_REFRESH_MS}: one `Depth: infinity` PROPFIND, or a
 * `1 + devices` walk where the server refuses infinity.
 *
 * History only. New series and volumes still wait for the next full listing,
 * and this never counts as one: it is no `refreshFromChanges`, and nothing
 * here touches `ensureFreshCloudListing`'s TTL — the series.json / catalog.json
 * writers prune against the listing and must never be told a history-only
 * refresh made it current.
 */

import { historySyncAllowed } from '$lib/reading-history/history-capability';
import { HISTORY_FOLDER, isHistoryFilePath } from '$lib/reading-history/paths';
import type { CloudCache } from './cloud-cache-interface';
import type { HistoryPatchResult } from './listing-mutations';
import type { SyncProvider } from './provider-interface';

/**
 * How stale `history/` may get between listings. Freshness against requests:
 * the activity tracker syncs after every reading burst, and every one of those
 * would otherwise cost a PROPFIND.
 */
export const HISTORY_REFRESH_MS = 5 * 60 * 1000;

let refreshIntervalMs = HISTORY_REFRESH_MS;
/** provider type → when `history/` was last listed for it (epoch ms). */
const lastListed = new Map<string, number>();

export type HistoryRefreshOutcome =
  | HistoryPatchResult
  /** no patchable cache, or no `listFolder` (Drive, OneDrive, MEGA) */
  | 'unsupported'
  /** the server cannot keep history per user — nothing there is ours */
  | 'off'
  /** a full listing or the last refresh is younger than the interval */
  | 'not-due'
  /** the listing failed; the cache is as it was */
  | 'failed';

/**
 * List `history/` and fold it into `cache` when due. Never throws: a failure
 * logs and leaves the cached listing — the behaviour before this existed. A
 * failed listing still counts as the refresh for the interval, so a server
 * that keeps refusing costs one request per interval, not one per sync.
 */
export async function refreshHistoryListing(
  provider: SyncProvider,
  cache: CloudCache,
  ownDevice: () => Promise<string>,
  now: number = Date.now()
): Promise<HistoryRefreshOutcome> {
  if (!cache.beginHistoryPatch || !provider.listFolder) return 'unsupported';
  if (!historySyncAllowed(provider.getStatus())) return 'off';
  // Begun before the request: a full listing installed (or a sign-out) while
  // it runs supersedes it.
  const patch = cache.beginHistoryPatch();
  const freshAt = Math.max(patch.listedAt, lastListed.get(provider.type) ?? 0);
  if (now - freshAt < refreshIntervalMs) return 'not-due';
  lastListed.set(provider.type, now);
  try {
    const listed = (await provider.listFolder(HISTORY_FOLDER)).filter((file) =>
      isHistoryFilePath(file.path)
    );
    return patch.apply(listed, await ownDevice());
  } catch (error) {
    console.warn('Reading history listing failed (the cached listing stands):', error);
    return 'failed';
  }
}

/**
 * Test hook (unit and e2e): the interval, and forget every refresh. `ms`
 * omitted restores {@link HISTORY_REFRESH_MS}.
 */
export function _setHistoryRefreshIntervalForTests(ms: number = HISTORY_REFRESH_MS): void {
  refreshIntervalMs = ms;
  lastListed.clear();
}
