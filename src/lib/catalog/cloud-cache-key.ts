import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';

/**
 * Cloud paths as a cache key. Folded exactly as far as identity allows and no
 * further: leading/duplicate separators are noise from different providers'
 * listing shapes, and NFD vs NFC is the same filename on a decomposing
 * filesystem — but CASE is meaningful, because cloud storage is case-sensitive
 * and two files can legitimately differ only in case.
 */
export function normalizeCachePath(path: string): string {
  return path
    .normalize('NFC')
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
}

/**
 * Which account's cache the app should read and write right now, or null when
 * nothing is connected. Null means "do not touch the cache" — never a fallback
 * scope, which would blend two accounts' covers into one bucket.
 */
export function activeAccountScope(): string | null {
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider) return null;
  return provider.getStatus().accountScope ?? null;
}
