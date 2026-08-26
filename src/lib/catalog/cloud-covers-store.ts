import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { activeAccountScope, normalizeCachePath } from './cloud-cache-key';
import { getCloudCovers, type CloudCover } from './cloud-covers';
import {
  unifiedCloudManager,
  type CloudVolumeWithProvider
} from '$lib/util/sync/unified-cloud-manager';
import { isCbzFile } from '$lib/util/sync/syncable-file';

/**
 * The active account's cached covers for exactly the paths currently listed.
 *
 * `cloud_covers` can hold thousands of blobs across a large catalog, so this
 * never reads the whole table for one account — only the on-screen path set,
 * rebuilt from the cloud listing each time it changes. Still backed by a
 * Dexie `liveQuery` per path set, so a cover finishing its download (Task 4's
 * write) is picked up without a manual refresh.
 *
 * Only archive entries can ever have a `cloud_covers` row keyed to them (see
 * `CloudCover`'s PK doc) — cover sidecars, `.mokuro`/`.mokuro.gz` and
 * everything else the provider lists cannot match, so they are filtered out
 * of the key set with the same `isCbzFile` predicate the rest of the sync
 * code uses to identify an archive, rather than handing every listed path to
 * `anyOf` and letting Dexie discard the misses (measured ~3x more keys than
 * can ever match at catalog scale).
 */
export const cloudCoverMap: Readable<Map<string, CloudCover>> = readable(
  new Map<string, CloudCover>(),
  (set) => {
    let inner: { unsubscribe: () => void } | null = null;

    const outer = unifiedCloudManager.cloudFiles.subscribe((listing) => {
      inner?.unsubscribe();
      inner = null;

      const scope = activeAccountScope();
      const paths = Array.from(listing.values()).flatMap((files) =>
        files.filter((f) => isCbzFile(f.path)).map((f) => normalizeCachePath(f.path))
      );
      if (!scope || paths.length === 0) {
        set(new Map());
        return;
      }

      inner = liveQuery(() => getCloudCovers(scope, paths)).subscribe({
        next: (covers) => set(covers),
        error: (err) => console.debug('[cloud-covers] live query failed:', err)
      });
    });

    return () => {
      inner?.unsubscribe();
      outer();
    };
  }
);
