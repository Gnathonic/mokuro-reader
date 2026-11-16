import { unifiedCloudManager } from '#lib/util/sync/unified-cloud-manager.js';

/**
 * Cloud paths as a cache key for PROVIDER OBJECTS (the cover bytes a listed
 * file had), not for library entries: leading/duplicate separators are noise
 * from different providers' listing shapes, and NFD vs NFC is the same file on
 * a decomposing filesystem. Case stays: on a case-sensitive store two spellings
 * of one entry (a fold group, sidecar names rule 2 R6) are still two objects
 * with their own bytes, and this cache must not hand one the other's. Which
 * names are one ENTRY is `foldName`'s question (`listed-spelling.ts`), never
 * this key's.
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
