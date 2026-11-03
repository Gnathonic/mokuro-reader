import type { ProviderStatus } from '$lib/util/sync/provider-interface';

/**
 * Can this provider carry reading history at all? An explicit `historySync`
 * decides (the WebDAV provider sets it from the bunko version); otherwise a
 * server that compiles its own metadata (bunko, version unknown) cannot, and
 * plain storage can.
 *
 * Its own module, free of Dexie, so the sync service and the remote-read
 * bookkeeping can ask without loading the history database.
 */
export function historySyncAllowed(
  status: Pick<ProviderStatus, 'historySync' | 'serverCompilesMetadata'>
): boolean {
  return status.historySync ?? !status.serverCompilesMetadata;
}
