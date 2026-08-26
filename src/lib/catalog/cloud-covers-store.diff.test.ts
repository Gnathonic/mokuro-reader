import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

/**
 * THE WATCH MUST NOT DO LIBRARY-SIZED WORK PER COVER WRITE.
 *
 * `cachedCoverPathSet` publishes the WHOLE cached key set — ~4,347 paths on the
 * reference library — and republishes it on every commit to `cloud_covers`.
 * `initCoverKeyWatch` used to hand all of it to the resolver every time, so one
 * cover landing cost a Map lookup, a key concatenation and (before
 * `refreshCoverKeys`) an NFC normalise + split + filter + join for every cached
 * path in the account, to find the handful that had actually changed.
 *
 * NO EXISTING CONTRACT COULD SEE THAT. The byte bound in
 * `cloud-covers-store.test.ts` is satisfied by a keys-only cursor over all
 * 4,347 keys — it deserializes nothing, which is exactly what that contract
 * asks. And the op counter cannot see it either: this walk issues no
 * IndexedDB operation at all, because `refreshCoverKeys` skips every path nobody
 * is holding. It got ~11x worse for free when a sibling task capped write
 * batches at `COVER_PERSIST_MAX_BATCH`, taking a reference cold start from ~4
 * commits to ~44 — roughly 190,000 redundant normalisations, from two changes
 * that were each correct on their own.
 *
 * So the bound is stated in the only unit that shows it: HOW MANY KEYS the
 * watch hands over per publish. It must track what LANDED, never what is
 * cached.
 *
 * SEPARATE FILE, deliberately. `cloud-covers-store.test.ts` calls
 * `acquireCover`, which starts a second, permanent watch of its own
 * (`ensureCoverKeyWatch`) that nothing can unsubscribe — fine there, fatal to a
 * measurement of "how many keys did the watch hand over". Here the resolver is
 * mocked outright and nothing ever claims a cover, so the only watch running is
 * the one under test.
 */

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_cover_key_diff_test') };
});

const { refreshedBatches } = vi.hoisted(() => ({ refreshedBatches: [] as string[][] }));
vi.mock('./cover-resolver', () => ({
  refreshCoverKeys: (keys: Iterable<string>) => {
    refreshedBatches.push([...keys]);
  }
}));

const { cloudFiles, account } = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      },
      set(v: T) {
        value = v;
        subs.forEach((fn) => fn(value));
      }
    };
  }
  return {
    cloudFiles: createStore(new Map<string, unknown>()),
    account: { scope: 'webdav:cover-diff' as string | null }
  };
});

vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    cloudFiles,
    getActiveProvider: () => ({
      type: 'webdav',
      getStatus: () => ({ isAuthenticated: true, accountScope: account.scope })
    })
  }
}));

import { db } from '$lib/catalog/db';
import { cachedCoverPathSet, initCoverKeyWatch } from './cloud-covers-store';
import { putCloudCovers, type CloudCover } from './cloud-covers';

const SERIES = 'One Piece';
const archivePath = (n: number) => `${SERIES}/Volume ${n}.cbz`;

function listing(count: number) {
  const files = Array.from({ length: count }, (_, i) => ({
    provider: 'webdav',
    fileId: `f${i}`,
    path: archivePath(i),
    size: 10,
    modifiedTime: '2026-01-01T00:00:00.000Z'
  }));
  return new Map<string, unknown>([[SERIES, files]]);
}

function cover(n: number, over: Partial<CloudCover> = {}): CloudCover {
  return {
    account_scope: account.scope as string,
    path: archivePath(n),
    thumbnail: new File([new Uint8Array(64)], `v${n}.webp`, { type: 'image/webp' }),
    width: 250,
    height: 350,
    cached_at: 1000 + n,
    ...over
  };
}

const pendingCleanups: Array<() => void> = [];
const track = (unsubscribe: () => void) => {
  pendingCleanups.push(unsubscribe);
  return unsubscribe;
};

/** The set is published behind a Dexie liveQuery; nothing about it is synchronous. */
function settle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  account.scope = 'webdav:cover-diff';
  // A Svelte `readable` RETAINS its last value across a full
  // unsubscribe/resubscribe cycle, and `cachedCoverPathSet` is module-level —
  // so without this a watch started below is handed the PREVIOUS test's key
  // set as its first emission, and every batch count here would be measuring
  // that. Subscribing with an empty listing publishes the shared empty set
  // synchronously, which is what makes this a reset rather than a wait.
  cloudFiles.set(new Map());
  cachedCoverPathSet.subscribe(() => {})();
  refreshedBatches.length = 0;
});

afterEach(async () => {
  while (pendingCleanups.length) pendingCleanups.pop()?.();
  cloudFiles.set(new Map());
  await db.cloud_covers.clear();
});

describe('initCoverKeyWatch hands the resolver the DIFF, not the library', () => {
  it('passes only the keys that landed, however many are already cached', async () => {
    const N = 60;
    await putCloudCovers(Array.from({ length: N }, (_, i) => cover(i)));
    cloudFiles.set(listing(N + 4));

    track(initCoverKeyWatch());

    // Everything already cached IS new to a resolver that has never been told
    // anything, so the FIRST publish of a watch legitimately carries the set.
    await vi.waitFor(() => expect(refreshedBatches.length).toBe(1), { timeout: 3000 });
    expect(refreshedBatches[0]).toHaveLength(N);
    refreshedBatches.length = 0;

    // One cover commits — what one capped write batch looks like from here.
    // THE BOUND: one key handed over, not N + 1.
    await putCloudCovers([cover(N)]);
    await vi.waitFor(() => expect(refreshedBatches.length).toBe(1), { timeout: 3000 });
    await settle();
    expect(refreshedBatches).toEqual([[archivePath(N)]]);

    // Three at once costs three: the work tracks what LANDED, which is the
    // property that makes it independent of how big the library is.
    refreshedBatches.length = 0;
    await putCloudCovers([cover(N + 1), cover(N + 2), cover(N + 3)]);
    await vi.waitFor(() => expect(refreshedBatches.flat().length).toBe(3), { timeout: 3000 });
    await settle();
    expect(refreshedBatches.flat().sort()).toEqual(
      [archivePath(N + 1), archivePath(N + 2), archivePath(N + 3)].sort()
    );
  });

  it('says nothing at all when a commit changes no key', async () => {
    await putCloudCovers([cover(0)]);
    cloudFiles.set(listing(3));

    track(initCoverKeyWatch());
    await vi.waitFor(() => expect(refreshedBatches.length).toBe(1), { timeout: 3000 });
    refreshedBatches.length = 0;

    // A rewrite under an existing key. The store dedupes the emission, so the
    // watch has nothing to diff and the resolver is never called at all.
    await putCloudCovers([cover(0, { cached_at: 99999 })]);
    await settle();

    expect(refreshedBatches).toEqual([]);
  });

  /**
   * Resolver entries are keyed by account scope as well as path, so after a
   * switch EVERY key is new to the resolver even though not one key STRING
   * changed — which is exactly why the store re-emits on a switch. A diff that
   * compared path strings alone would hand over nothing here and leave every
   * card on the newly connected account blank.
   */
  it('hands over the whole set again after an account switch', async () => {
    await putCloudCovers([cover(0), cover(1)]);
    cloudFiles.set(listing(3));

    track(initCoverKeyWatch());
    await vi.waitFor(() => expect(refreshedBatches.length).toBe(1), { timeout: 3000 });
    expect(refreshedBatches[0]).toHaveLength(2);
    refreshedBatches.length = 0;

    account.scope = 'webdav:other-account';
    await putCloudCovers([
      { ...cover(0), account_scope: 'webdav:other-account' },
      { ...cover(1), account_scope: 'webdav:other-account' }
    ]);
    cloudFiles.set(listing(3));

    await vi.waitFor(() => expect(refreshedBatches.flat().length).toBe(2), { timeout: 3000 });
    await settle();
    expect(refreshedBatches.flat().sort()).toEqual([archivePath(0), archivePath(1)].sort());
  });
});
