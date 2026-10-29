import { get } from 'svelte/store';
import { cacheManager } from './cache-manager';
import { tokenManager } from './providers/google-drive/token-manager';
import { unifiedCloudManager } from './unified-cloud-manager';

/**
 * Pull synced progress when the app comes back to the foreground or a reader
 * opens. Progress otherwise syncs only at startup and 5 s after this device's
 * own page turns, so a laptop woken from sleep (or a tab left open) showed the
 * page it had before another device read on — and the first page turn there
 * made that stale page the newest position on every device.
 */
const MIN_INTERVAL_MS = 60_000;

interface ForegroundSyncDeps {
  /** A provider is connected, its listing has loaded and its token is usable. */
  isReady: () => boolean;
  isSyncing: () => boolean;
  /** Resolves true when the sync succeeded. */
  sync: () => Promise<boolean>;
}

export function createForegroundSync(deps: ForegroundSyncDeps) {
  let lastRun = -Infinity;

  function request(now: number = Date.now()) {
    if (now - lastRun < MIN_INTERVAL_MS) return;
    if (!deps.isReady() || deps.isSyncing()) return;
    lastRun = now;
    // A failed sync gives the slot back, so the next foreground can retry.
    const release = () => {
      if (lastRun === now) lastRun = -Infinity;
    };
    deps
      .sync()
      .then((ok) => {
        if (!ok) release();
      })
      .catch((error) => {
        release();
        console.warn('Foreground sync failed:', error);
      });
  }

  function listen(clock: () => number = () => Date.now()) {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') request(clock());
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }

  return { request, listen };
}

export const foregroundSync = createForegroundSync({
  isReady: () => {
    const provider = unifiedCloudManager.getActiveProvider();
    if (!provider) return false;
    // Before the listing has loaded, sync cannot see the cloud's
    // volume-data.json and would upload this device's copy over it.
    const cache = cacheManager.getCache(provider.type);
    if (!cache?.isLoaded() || cache.isFetching()) return false;
    // An expired Drive token waits for re-authentication, as at startup.
    if (provider.type === 'google-drive') {
      const msLeft = tokenManager.getTimeUntilExpiry();
      if (msLeft !== null && msLeft <= 0) return false;
    }
    return true;
  },
  isSyncing: () => get(unifiedCloudManager.isSyncing),
  sync: async () => (await unifiedCloudManager.syncProgress({ silent: true })).failed === 0
});
