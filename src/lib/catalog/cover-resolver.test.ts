import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
// Imported before the Dexie singleton below opens its database: the op counter
// installs a permanent `IDBDatabase.transaction` wrapper at module load, and
// Dexie binds that method once at open time (see idb-op-counter.ts).
import { countIdbOps } from './__tests__/idb-op-counter';

const { getActiveProvider } = vi.hoisted(() => ({ getActiveProvider: vi.fn() }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider }
}));

import { db } from './db';
import { putCloudCovers, type CloudCover } from './cloud-covers';
import {
  acquireCover,
  refreshCoverKeys,
  _heldCoverCountForTests,
  _resetCoverResolverForTests,
  type ResolvedCover
} from './cover-resolver';

const SCOPE = 'webdav:https://host/dav|nathan';
const OTHER_SCOPE = 'webdav:https://host/dav|someone-else';
const PATH = 'Dr Stone/Volume 01.cbz';

function cover(over: Partial<CloudCover> = {}): CloudCover {
  return {
    account_scope: SCOPE,
    path: PATH,
    thumbnail: new File([new Uint8Array([1, 2, 3])], 'c.webp', { type: 'image/webp' }),
    width: 250,
    height: 350,
    cached_at: 1756000000000,
    ...over
  };
}

/** N distinct cached covers for `SCOPE`, so a scan has something to scale with. */
function manyCovers(n: number): CloudCover[] {
  return Array.from({ length: n }, (_, i) =>
    cover({
      path: `Series ${i}/Volume 01.cbz`,
      thumbnail: new File([new Uint8Array(64).fill(i % 256)], `c${i}.webp`, { type: 'image/webp' }),
      width: i
    })
  );
}

// jsdom implements neither of these (verified: both `undefined`), so they are
// installed rather than merely spied on, and the originals restored regardless.
const originalCreate = globalThis.URL.createObjectURL;
const originalRevoke = globalThis.URL.revokeObjectURL;
let created: string[] = [];
let revoked: string[] = [];

beforeEach(async () => {
  created = [];
  revoked = [];
  let n = 0;
  globalThis.URL.createObjectURL = vi.fn(() => {
    const url = `blob:cover-${++n}`;
    created.push(url);
    return url;
  }) as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  }) as unknown as typeof URL.revokeObjectURL;

  getActiveProvider.mockReturnValue({ getStatus: () => ({ accountScope: SCOPE }) });
  _resetCoverResolverForTests();
  await db.cloud_covers.clear();
});

afterEach(() => {
  _resetCoverResolverForTests();
  globalThis.URL.createObjectURL = originalCreate;
  globalThis.URL.revokeObjectURL = originalRevoke;
});

/** Let queued microtasks AND the fake-indexeddb round trip they wait on run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Hold the next keyed read open until the returned `land` is called.
 *
 * The read that a card issues at mount takes its readonly snapshot THEN, and
 * a cover can commit between that snapshot and the read coming back. Nothing
 * about a real IndexedDB read is controllable enough to sit in that window on
 * purpose, so the first read is gated here and answered with the miss the
 * pre-write snapshot would have produced; every later read hits the database
 * for real.
 */
function gateFirstRead(): { land: () => void; reads: () => number; restore: () => void } {
  const realGet = db.cloud_covers.get.bind(db.cloud_covers);
  let land!: () => void;
  const gate = new Promise<void>((resolve) => {
    land = resolve;
  });
  let reads = 0;
  const spy = vi.spyOn(db.cloud_covers, 'get').mockImplementation((async (
    key: [string, string]
  ) => {
    reads += 1;
    if (reads > 1) return realGet(key);
    await gate;
    return undefined;
  }) as unknown as typeof db.cloud_covers.get);
  return { land, reads: () => reads, restore: () => spy.mockRestore() };
}

/** Only the counts for the table under test — other stores are noise here. */
function coverOps(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).filter(([key]) => key.startsWith('cloud_covers.'))
  );
}

describe('acquireCover', () => {
  it('resolves the cached cover for its path', async () => {
    await putCloudCovers([cover()]);

    const handle = acquireCover(PATH);
    const resolved = await handle.ready;

    expect(resolved?.width).toBe(250);
    expect(resolved?.height).toBe(350);
    expect(resolved?.file).toBeInstanceOf(File);
    expect(resolved?.file.size).toBe(3);
    expect(handle.current).toBe(resolved);
    handle.release();
  });

  it('returns undefined for a path with no cached cover, without throwing', async () => {
    await putCloudCovers([cover({ path: 'Naruto/Volume 01.cbz' })]);

    const handle = acquireCover(PATH);
    await expect(handle.ready).resolves.toBeUndefined();
    expect(handle.current).toBeUndefined();
    handle.release();
  });

  it('is a clean miss with no account connected, and never touches the database', async () => {
    await putCloudCovers([cover()]);
    getActiveProvider.mockReturnValue(null);

    const counts = await countIdbOps(async () => {
      const handle = acquireCover(PATH);
      await expect(handle.ready).resolves.toBeUndefined();
      handle.release();
    });

    expect(coverOps(counts)).toEqual({});
  });

  it('is a clean miss for a blank path', async () => {
    const handle = acquireCover('');
    await expect(handle.ready).resolves.toBeUndefined();
    handle.release();

    const nullish = acquireCover(undefined);
    await expect(nullish.ready).resolves.toBeUndefined();
    nullish.release();
  });

  it('normalizes the path, so a listing with stray separators hits the same row', async () => {
    await putCloudCovers([cover()]);

    const handle = acquireCover('//Dr Stone//Volume 01.cbz');
    await expect(handle.ready).resolves.toMatchObject({ width: 250 });
    handle.release();
  });

  it('keeps two accounts apart even for the identical path', async () => {
    await putCloudCovers([
      cover({ account_scope: SCOPE, width: 111 }),
      cover({ account_scope: OTHER_SCOPE, width: 222 })
    ]);

    const mine = acquireCover(PATH);
    await expect(mine.ready).resolves.toMatchObject({ width: 111 });
    mine.release();

    getActiveProvider.mockReturnValue({ getStatus: () => ({ accountScope: OTHER_SCOPE }) });
    const theirs = acquireCover(PATH);
    await expect(theirs.ready).resolves.toMatchObject({ width: 222 });
    theirs.release();
  });

  it('surfaces a read failure as a miss rather than a rejection', async () => {
    const get = vi.spyOn(db.cloud_covers, 'get').mockRejectedValue(new Error('idb exploded'));
    try {
      const handle = acquireCover(PATH);
      await expect(handle.ready).resolves.toBeUndefined();
      handle.release();
    } finally {
      get.mockRestore();
    }
  });
});

describe('shared reads', () => {
  it('serves two subscribers of the same path from ONE underlying read', async () => {
    await putCloudCovers([cover()]);

    let a: ResolvedCover | undefined;
    let b: ResolvedCover | undefined;

    const counts = await countIdbOps(async () => {
      const first = acquireCover(PATH);
      const second = acquireCover(PATH);
      first.subscribe((v) => (a = v));
      second.subscribe((v) => (b = v));
      await Promise.all([first.ready, second.ready]);
      first.release();
      second.release();
    });

    expect(counts['cloud_covers.get']).toBe(1);
    expect(a).toBeDefined();
    expect(a).toBe(b); // the same resolved value object, not two decodes of one row
  });

  it('serves a claim made after the read settled with no read at all', async () => {
    await putCloudCovers([cover()]);

    const first = acquireCover(PATH);
    await first.ready;

    const counts = await countIdbOps(async () => {
      const second = acquireCover(PATH);
      await expect(second.ready).resolves.toMatchObject({ width: 250 });
      second.release();
    });

    expect(coverOps(counts)).toEqual({});
    first.release();
  });

  it('re-reads for a fresh claim once every earlier holder let go', async () => {
    const early = acquireCover(PATH);
    await expect(early.ready).resolves.toBeUndefined(); // nothing cached yet
    early.release();
    expect(_heldCoverCountForTests()).toBe(0);

    await putCloudCovers([cover()]); // the download lands while no card holds the path

    const late = acquireCover(PATH);
    await expect(late.ready).resolves.toMatchObject({ width: 250 });
    late.release();
  });
});

/**
 * THE LOAD-BEARING CONTRACT.
 *
 * The defect this module exists to remove was not "too many reads" — it was
 * one read whose COST scaled with the table (4,347 rows, 437 MB, per insert).
 * Op counts alone cannot see that: a whole-table `toArray()` is a single
 * `getAll`, which counts as 1 the same as a point read does. So this asserts
 * the read's SHAPE (`.get` on the primary key; no `getAll`, no cursor, no
 * index read — the ops whose cost is proportional to what they walk), the
 * BYTES it deserialized, and that both are identical at two table sizes two
 * orders of magnitude apart.
 */
describe('keyed read contract', () => {
  it('resolves one cover with a point read whose ops do not scale with the table', async () => {
    await putCloudCovers(manyCovers(4));
    const small = coverOps(
      await countIdbOps(async () => {
        const handle = acquireCover('Series 2/Volume 01.cbz');
        await expect(handle.ready).resolves.toMatchObject({ width: 2 });
        handle.release();
      })
    );

    _resetCoverResolverForTests();
    await db.cloud_covers.clear();
    await putCloudCovers(manyCovers(400));
    const large = coverOps(
      await countIdbOps(async () => {
        const handle = acquireCover('Series 2/Volume 01.cbz');
        await expect(handle.ready).resolves.toMatchObject({ width: 2 });
        handle.release();
      })
    );

    // One point read on the composite primary key, and nothing else — and,
    // now that `countIdbOps` meters bytes, exactly ONE cover's blob
    // deserialized with it (`manyCovers` writes 64-byte thumbnails). That
    // second number is the unit the defect was measured in, so the exact
    // shape asserts it rather than filtering it out.
    expect(large).toEqual({ 'cloud_covers.get': 1, 'cloud_covers.bytes': 64 });
    // None of the ops that walk rows: any of these is a scan wearing a
    // constant op count.
    expect(large['cloud_covers.getAll'] ?? 0).toBe(0);
    expect(large['cloud_covers.getAllKeys'] ?? 0).toBe(0);
    expect(large['cloud_covers.openCursor'] ?? 0).toBe(0);
    expect(large['cloud_covers.idx.getAll'] ?? 0).toBe(0);
    expect(large['cloud_covers.idx.openCursor'] ?? 0).toBe(0);
    // 4 rows and 400 rows cost exactly the same.
    expect(large).toEqual(small);
  });
});

describe('object URL lifecycle', () => {
  it('mints no object URL for a cover nobody displayed', async () => {
    await putCloudCovers([cover()]);

    const handle = acquireCover(PATH);
    await handle.ready;
    handle.release();

    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('shares one object URL across holders and revokes it exactly once on the last release', async () => {
    await putCloudCovers([cover()]);

    const first = acquireCover(PATH);
    const second = acquireCover(PATH);
    await Promise.all([first.ready, second.ready]);

    expect(first.current?.url).toBe('blob:cover-1');
    expect(second.current?.url).toBe('blob:cover-1');
    expect(created).toEqual(['blob:cover-1']);

    first.release();
    expect(revoked).toEqual([]); // second holder is still showing it

    second.release();
    expect(revoked).toEqual(['blob:cover-1']);

    second.release(); // double release must not revoke twice
    first.release();
    expect(revoked).toEqual(['blob:cover-1']);
    expect(_heldCoverCountForTests()).toBe(0);
  });

  it('does not let one holder releasing twice revoke a URL another is still showing', async () => {
    await putCloudCovers([cover()]);

    const first = acquireCover(PATH);
    const second = acquireCover(PATH);
    await Promise.all([first.ready, second.ready]);
    expect(second.current?.url).toBe('blob:cover-1');

    first.release();
    first.release(); // a sloppy caller — must not spend `second`'s refcount

    expect(revoked).toEqual([]);
    expect(second.current?.url).toBe('blob:cover-1');
    expect(_heldCoverCountForTests()).toBe(1);

    second.release();
    expect(revoked).toEqual(['blob:cover-1']);
    expect(_heldCoverCountForTests()).toBe(0);
  });

  it('stops delivering to a released handle and reports it as empty', async () => {
    // Both handles resolve a MISS, so the refresh below really does re-read —
    // a refresh of a handle that already has its cover is a no-op for reasons
    // that have nothing to do with releasing, and would prove nothing here.
    const first = acquireCover(PATH);
    const second = acquireCover(PATH);
    const seen: (ResolvedCover | undefined)[] = [];
    first.subscribe((v) => seen.push(v));
    await Promise.all([first.ready, second.ready]);

    const afterResolve = seen.length;
    first.release();
    expect(first.current).toBeUndefined();

    // The entry is still alive for `second`; the cover it was waiting for
    // lands, and the refresh that delivers it must not reach `first`.
    await putCloudCovers([cover()]);
    refreshCoverKeys([PATH]);
    await expect(second.ready).resolves.toMatchObject({ width: 250 });
    expect(seen.length).toBe(afterResolve);
    second.release();
  });

  /**
   * A holder can outlive the value it holds: an async decode continuation, a
   * reactive read that runs one frame late. Reading `.url` then must NOT mint
   * a fresh object URL — the entry is gone from `entries`, so nothing would
   * ever revoke it, and at 1,027 churning cards that is one permanent leak per
   * card.
   */
  it('mints nothing for a value whose URL is first read after its holder released', async () => {
    await putCloudCovers([cover()]);

    const handle = acquireCover(PATH);
    const resolved = await handle.ready;
    handle.release();

    expect(resolved?.url).toBe('');
    expect(created).toEqual([]);
    expect(_heldCoverCountForTests()).toBe(0);
  });

  it('gives a released holder back the URL it already had, and no second one', async () => {
    await putCloudCovers([cover()]);

    const handle = acquireCover(PATH);
    const resolved = await handle.ready;
    expect(resolved?.url).toBe('blob:cover-1');

    handle.release();
    expect(revoked).toEqual(['blob:cover-1']);

    expect(resolved?.url).toBe('blob:cover-1');
    expect(created).toEqual(['blob:cover-1']);
    expect(revoked).toEqual(['blob:cover-1']);
  });
});

describe('subscriber fan-out', () => {
  /**
   * A subscriber is free to release from inside its own callback (a card that
   * unmounts the moment its cover arrives). That release runs mid-broadcast
   * and clears the subscriber set, so a broadcast that walked the set itself
   * would deliver to that subscriber and silently skip every one after it.
   */
  it('finishes the broadcast when a subscriber releases from inside its callback', async () => {
    await putCloudCovers([cover()]);

    const handle = acquireCover(PATH);
    const delivered: string[] = [];
    handle.subscribe((v) => {
      if (!v) return;
      delivered.push('first');
      handle.release();
    });
    handle.subscribe((v) => {
      if (v) delivered.push('second');
    });
    handle.subscribe((v) => {
      if (v) delivered.push('third');
    });

    await handle.ready;

    expect(delivered).toEqual(['first', 'second', 'third']);
    expect(_heldCoverCountForTests()).toBe(0);
  });
});

/**
 * An entry that has been dropped is DEAD, and a read issued before the drop
 * can still land afterwards. Neither the landing read nor the dead entry's own
 * bookkeeping may touch whatever has since claimed its key.
 */
describe('dropped-entry guards', () => {
  it('does not resurrect an entry whose read landed after it was dropped', async () => {
    await putCloudCovers([cover()]);

    const handle = acquireCover(PATH);
    // Every holder lets go while the read is in flight. (The reset hook is the
    // same drop path as the last `release()`, but leaves a handle behind to
    // observe the dead entry through — a released handle reports `undefined`
    // on its own account and would hide the resurrection.)
    _resetCoverResolverForTests();
    expect(_heldCoverCountForTests()).toBe(0);

    await flush(); // the read lands on the entry nobody holds any more

    expect(handle.current).toBeUndefined();
    expect(created).toEqual([]);
    expect(_heldCoverCountForTests()).toBe(0);
  });

  it('does not evict the live entry when a stale one under the same key is dropped', async () => {
    const stale = acquireCover(PATH);
    await stale.ready;
    _resetCoverResolverForTests(); // what `stale` holds is no longer the entry at its key

    const live = acquireCover(PATH); // a fresh entry claims that key
    await expect(live.ready).resolves.toBeUndefined();
    expect(_heldCoverCountForTests()).toBe(1);

    stale.release(); // the last holder of the DEAD entry lets go

    expect(_heldCoverCountForTests()).toBe(1);
    // and the live handle is still reachable by path, which is the whole point:
    // its cover lands, and the refresh has to find IT rather than the corpse.
    await putCloudCovers([cover()]);
    refreshCoverKeys([PATH]);
    await expect(live.ready).resolves.toMatchObject({ width: 250 });
    live.release();
  });
});

describe('refreshCoverKeys', () => {
  it('picks up a cover that landed after a held handle already missed', async () => {
    const handle = acquireCover(PATH);
    const seen: (ResolvedCover | undefined)[] = [];
    handle.subscribe((v) => seen.push(v));
    await expect(handle.ready).resolves.toBeUndefined();

    await putCloudCovers([cover()]);
    refreshCoverKeys([PATH]);
    await expect(handle.ready).resolves.toMatchObject({ width: 250 });

    expect(seen.at(-1)).toMatchObject({ width: 250 });
    handle.release();
  });

  it('re-reads only the still-missing handles, and never a path nobody holds', async () => {
    await putCloudCovers([cover({ path: 'Hit/Volume 01.cbz', width: 10 })]);

    const hit = acquireCover('Hit/Volume 01.cbz');
    const miss = acquireCover('Miss/Volume 01.cbz');
    await Promise.all([hit.ready, miss.ready]);

    const counts = await countIdbOps(async () => {
      refreshCoverKeys(['Hit/Volume 01.cbz', 'Miss/Volume 01.cbz', 'Nobody/Holds This.cbz', '']);
      await Promise.all([hit.ready, miss.ready]);
    });

    // Only the missing one is re-read: the resolved handle and the unheld
    // paths cost nothing.
    expect(counts['cloud_covers.get']).toBe(1);
    hit.release();
    miss.release();
  });

  /**
   * THE INGEST SEQUENCE, and the reason this whole module exists.
   *
   * A card mounts and issues its read; the cover commits; the keys-only
   * liveQuery announces the path; and only THEN does the read — whose
   * readonly snapshot pre-dates the commit — come back a miss. Nothing else
   * will ever announce that path again, so a refresh dropped in this window
   * leaves the card blank for the rest of its mount. During bulk ingest that
   * window is open on hundreds of cards at once.
   */
  it('honours a refresh that lands while the first read is still in flight', async () => {
    const read = gateFirstRead();
    try {
      const handle = acquireCover(PATH);
      const seen: (ResolvedCover | undefined)[] = [];
      handle.subscribe((v) => seen.push(v));
      const awaited = handle.ready; // the caller is already waiting on this one

      await putCloudCovers([cover()]); // the cover commits...
      refreshCoverKeys([PATH]); // ...and the liveQuery announces it, mid-read

      read.land(); // the pre-write snapshot finally comes back: a miss
      await expect(awaited).resolves.toMatchObject({ width: 250 });

      expect(handle.current).toMatchObject({ width: 250 });
      expect(seen.at(-1)).toMatchObject({ width: 250 });
      expect(read.reads()).toBe(2); // the miss, then the refresh's re-read
      handle.release();
    } finally {
      read.restore();
    }
  });

  it('re-reads once for a burst of refreshes that all land during one read', async () => {
    const read = gateFirstRead();
    try {
      const handle = acquireCover(PATH);
      await putCloudCovers([cover()]);
      refreshCoverKeys([PATH]);
      refreshCoverKeys([PATH]);
      refreshCoverKeys([PATH]);

      read.land();
      await expect(handle.ready).resolves.toMatchObject({ width: 250 });
      expect(read.reads()).toBe(2);
      handle.release();
    } finally {
      read.restore();
    }
  });

  it('does nothing when no account is connected', async () => {
    // A handle that resolved a MISS with its cover now on disk: with a scope
    // this refresh re-reads (the test above), so the empty op ledger below is
    // the disconnect doing the work and not the self-limiting rule.
    const handle = acquireCover(PATH);
    await expect(handle.ready).resolves.toBeUndefined();
    await putCloudCovers([cover()]);

    getActiveProvider.mockReturnValue(null);
    const counts = await countIdbOps(async () => {
      refreshCoverKeys([PATH]);
      await Promise.resolve();
    });

    expect(coverOps(counts)).toEqual({});
    handle.release();
  });
});
