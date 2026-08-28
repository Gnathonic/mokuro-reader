import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

/**
 * THE STORE THAT MUST NOT READ BLOBS.
 *
 * `cloudCoverMap` used to be a `liveQuery` over a blob-returning row read (the
 * shape `_getCloudCoversForTests` keeps for tests) for every listed `.cbz` path, so every commit to `cloud_covers`
 * re-materialised every cover row INCLUDING the blob — 3,886 MB deserialized
 * in a 59-second cold start on a 1,027-series library — and handed the result
 * to `volumesWithPlaceholders`, which is what turned a cover landing into a
 * whole-catalog re-derive and a 1,784 ms main-thread long task.
 *
 * The three properties this file pins are the three that make that impossible
 * to come back:
 *
 * 1. The subscription reads KEYS. Not "few bytes" — zero value-reading ops
 *    reach `cloud_covers`, with the keys-only cursor anchored non-zero so the
 *    assertion cannot pass by simply not running.
 * 2. Its identity moves only when the KEY SET moves. A blob rewritten under an
 *    existing key emits nothing.
 * 3. It drives `refreshCoverKeys`, which is the ONLY way a card that resolved a
 *    miss mid-ingest ever sees its cover without remounting.
 *
 * A real Dexie over `fake-indexeddb` on purpose: a mocked liveQuery would pin
 * this file's own idea of Dexie rather than Dexie's actual keys-only branch,
 * which is precisely the thing being claimed.
 */

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_cover_key_store_test') };
});

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
    account: { scope: 'webdav:cover-keys' as string | null }
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

// Two of `cover-persist.ts`'s dependencies, stubbed only so the end-to-end
// `installCover` test below can drive the REAL persist queue: the decode
// cache would try to spawn Workers jsdom does not have, and the
// reading-history store is irrelevant here (no cover in this file ever has a
// row, so routing always lands in `cloud_covers`).
vi.mock('$lib/catalog/thumbnail-cache', () => ({
  thumbnailCache: { invalidate: vi.fn() }
}));
vi.mock('$lib/settings/volume-data', () => ({
  volumes: {
    subscribe(fn: (v: Record<string, unknown>) => void) {
      fn({});
      return () => {};
    }
  }
}));

import { db } from '$lib/catalog/db';
import { cachedCoverPathSet, initCoverKeyWatch } from './cloud-covers-store';
import { putCloudCovers } from './cloud-covers';
import { _resetCoverPersistForTests, installCover } from './cover-persist';
import {
  _heldCoverCountForTests,
  _resetCoverResolverForTests,
  acquireCover
} from './cover-resolver';
import { countIdbOps } from './__tests__/idb-op-counter';

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

function cover(n: number, bytes = 1024) {
  return {
    account_scope: account.scope as string,
    path: archivePath(n),
    thumbnail: new File([new Uint8Array(bytes)], `v${n}.webp`, { type: 'image/webp' }),
    width: 250,
    height: 350,
    cached_at: 1000 + n
  };
}

const pendingCleanups: Array<() => void> = [];
const track = (unsubscribe: () => void) => {
  pendingCleanups.push(unsubscribe);
  return unsubscribe;
};

beforeEach(() => {
  account.scope = 'webdav:cover-keys';
});

afterEach(async () => {
  while (pendingCleanups.length) pendingCleanups.pop()?.();
  _resetCoverResolverForTests();
  _resetCoverPersistForTests();
  cloudFiles.set(new Map());
  await db.cloud_covers.clear();
});

/**
 * The set is published asynchronously (a Dexie liveQuery behind a cloud
 * listing), so every assertion about it has to wait for the query rather than
 * for a fixed number of ticks.
 */
function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('cachedCoverPathSet reads keys, never blobs', () => {
  it('deserializes no cover row while a cover lands under it', async () => {
    const N = 40;
    for (let i = 0; i < N; i++) await putCloudCovers([cover(i)]);
    cloudFiles.set(listing(N + 1));

    let latest: ReadonlySet<string> = new Set();
    track(cachedCoverPathSet.subscribe((paths) => (latest = paths)));
    await vi.waitFor(() => expect(latest.size).toBe(N), { timeout: 3000 });

    // The measured event: one more cover commits, and the live subscription
    // re-runs its querier over all N+1 paths.
    const counts = await countIdbOps(async () => {
      await putCloudCovers([cover(N)]);
      await vi.waitFor(() => expect(latest.size).toBe(N + 1), { timeout: 3000 });
    });

    // Not one value-reading op reached the blob table. `openCursor` is the one
    // the old blob-returning store used, and it is what deserialized
    // 437 MB per re-read on the real library.
    expect(counts['cloud_covers.openCursor'] ?? 0).toBe(0);
    expect(counts['cloud_covers.getAll'] ?? 0).toBe(0);
    expect(counts['cloud_covers.get'] ?? 0).toBe(0);
    expect(counts['cloud_covers.idx.openCursor'] ?? 0).toBe(0);
    expect(counts['cloud_covers.idx.getAll'] ?? 0).toBe(0);
    // ANCHOR: the zeroes above would also hold for a query that never ran.
    // Dexie's `primaryKeys()` over an `anyOf` takes the keys-only branch, which
    // is an `openKeyCursor` — so this is positive proof the read happened AND
    // that it was the keys-only shape.
    expect(counts['cloud_covers.openKeyCursor'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('publishes the normalized cached paths, and only the cached ones', async () => {
    await putCloudCovers([cover(1)]);
    cloudFiles.set(listing(4));

    let latest: ReadonlySet<string> = new Set();
    track(cachedCoverPathSet.subscribe((paths) => (latest = paths)));

    await vi.waitFor(() => expect(latest.size).toBe(1), { timeout: 3000 });
    expect([...latest]).toEqual([archivePath(1)]);
  });
});

describe('cachedCoverPathSet identity', () => {
  it('re-emits when a KEY arrives and never when only a blob changes', async () => {
    await putCloudCovers([cover(0)]);
    cloudFiles.set(listing(3));

    const emissions: ReadonlySet<string>[] = [];
    // A Svelte `readable` replays its retained value to a new subscriber
    // before this generation's first publish, so the baseline is taken after
    // the real key set has landed AND the queue has drained — not on the first
    // emission, whatever that happens to be.
    track(cachedCoverPathSet.subscribe((paths) => emissions.push(paths)));
    await vi.waitFor(() => expect(emissions.at(-1)?.has(archivePath(0))).toBe(true), {
      timeout: 3000
    });
    await settle();
    const afterFirstKey = emissions.length;

    // A rewrite of an existing key: different bytes, different `cached_at`,
    // same key set. The liveQuery re-runs (Dexie re-fires on any commit) and
    // must produce no emission at all — this is the case the old
    // `cloudCoverSignature` hashed blob sizes to try to catch, and paid an
    // O(N log N) sort per commit to get wrong during ingest anyway.
    await putCloudCovers([{ ...cover(0, 4096), cached_at: 99999 }]);
    await settle();
    expect(emissions.length).toBe(afterFirstKey);

    // A genuinely new key does emit.
    await putCloudCovers([cover(1)]);
    await vi.waitFor(() => expect(emissions.length).toBe(afterFirstKey + 1), { timeout: 3000 });
    expect([...emissions[emissions.length - 1]].sort()).toEqual([archivePath(0), archivePath(1)]);
  });

  it('re-emits on an account switch even when the key strings are identical', async () => {
    await putCloudCovers([cover(0)]);
    cloudFiles.set(listing(2));

    const emissions: ReadonlySet<string>[] = [];
    track(cachedCoverPathSet.subscribe((paths) => emissions.push(paths)));
    await vi.waitFor(() => expect(emissions.at(-1)?.has(archivePath(0))).toBe(true), {
      timeout: 3000
    });
    await settle();
    const before = emissions.length;

    // The same path, cached under a DIFFERENT account. Key strings are path
    // strings, so a set-content comparison alone would call this unchanged and
    // never tell the resolver to look again under the new scope.
    account.scope = 'webdav:other-account';
    await putCloudCovers([{ ...cover(0), account_scope: 'webdav:other-account' }]);
    cloudFiles.set(listing(2));

    await vi.waitFor(() => expect(emissions.length).toBeGreaterThan(before), { timeout: 3000 });
    expect([...emissions[emissions.length - 1]]).toEqual([archivePath(0)]);
  });

  it('publishes nothing but the shared empty set with no account connected', async () => {
    account.scope = null;
    cloudFiles.set(listing(2));

    const emissions: ReadonlySet<string>[] = [];
    track(cachedCoverPathSet.subscribe((paths) => emissions.push(paths)));
    await settle();

    // The forced first publish of the generation clears whatever the readable
    // retained from the last one, so a disconnected account can never leave
    // another account's key set on display.
    expect(emissions.at(-1)?.size).toBe(0);
  });
});

describe('initCoverKeyWatch drives the resolver', () => {
  it('fills a handle that resolved a miss before its cover landed', async () => {
    cloudFiles.set(listing(2));
    track(initCoverKeyWatch());

    // The ingest sequence: the card mounts and resolves BEFORE the cover
    // exists, which is exactly what leaves a card blank until it remounts.
    const handle = acquireCover(archivePath(0));
    track(() => handle.release());
    await handle.ready;
    expect(handle.current).toBeUndefined();

    await putCloudCovers([cover(0)]);

    await vi.waitFor(() => expect(handle.current?.width).toBe(250), { timeout: 3000 });
    expect(handle.current?.file.size).toBe(1024);
    expect(_heldCoverCountForTests()).toBe(1);
  });

  it('fills a handle straight from installCover — the WHOLE chain, promptly, with no flush call', async () => {
    // The production paint chain end-to-end, at the cadence production runs
    // it: download → `installCover` → (microtask drain) → `cloud_covers`
    // commit → keys-only liveQuery → key diff → `refreshCoverKeys` → held
    // handle. Nothing here calls `flushPendingCoverPersists` — the persist
    // queue must land the cover BY ITSELF — and the `waitFor` bound is
    // deliberately far below the removed 750ms batch window, so
    // reintroducing a fixed wait anywhere in the chain fails this test.
    cloudFiles.set(listing(2));
    track(initCoverKeyWatch());

    const handle = acquireCover(archivePath(0));
    track(() => handle.release());
    await handle.ready;
    expect(handle.current).toBeUndefined();

    // No `volumes` row exists for this uuid, so routing sends the blob to
    // `cloud_covers` under the mocked account's scope — the exact ingest
    // path a browsed card's cover takes.
    installCover(
      { volume_uuid: 'chain-1', cloudPath: archivePath(0) },
      {
        file: new File([new Uint8Array(1024)], 'chain.webp', { type: 'image/webp' }),
        width: 250,
        height: 350
      }
    );

    await vi.waitFor(() => expect(handle.current?.width).toBe(250), { timeout: 500 });
    expect(handle.current?.file.size).toBe(1024);
  });

  it('leaves a path nobody is holding alone', async () => {
    cloudFiles.set(listing(2));
    track(initCoverKeyWatch());
    await settle();

    await putCloudCovers([cover(1)]);
    await settle();

    // `refreshCoverKeys` is self-limiting: an unheld path is a Map miss and
    // issues no read, so handing it the whole key set stays cheap at catalog
    // scale.
    expect(_heldCoverCountForTests()).toBe(0);
  });
});

/**
 * THE DRIVER MUST NOT BE ORPHANABLE.
 *
 * `initCoverKeyWatch` is the only production subscriber to `cachedCoverPathSet`, so it
 * is both what keeps the keys-only liveQuery alive AND the only thing that ever calls
 * `refreshCoverKeys`. While it was one `init*` line among many in `+layout.svelte`, deleting
 * that line silently stopped every late-arriving cover from reaching a mounted card —
 * and left the whole suite green, because every test above starts the watch itself.
 *
 * So this one deliberately NEVER calls it. `acquireCover` is the only thing here that
 * touches the watch, which is the wiring under test: claiming a cover is what starts it.
 */
describe('the cover key watch starts itself on the first claim', () => {
  it('fills a handle that resolved a miss, with nobody having called initCoverKeyWatch', async () => {
    cloudFiles.set(listing(2));

    // The ingest sequence, minus the layout hook: a card mounts and resolves BEFORE the
    // cover exists. Nothing else in this test subscribes to the key set.
    const handle = acquireCover(archivePath(0));
    track(() => handle.release());
    await handle.ready;
    expect(handle.current).toBeUndefined();

    await putCloudCovers([cover(0)]);

    await vi.waitFor(() => expect(handle.current?.width).toBe(250), { timeout: 3000 });
    expect(handle.current?.file.size).toBe(1024);
  });
});
