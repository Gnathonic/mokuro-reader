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
  refreshCovers,
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
 * index read — the ops whose cost is proportional to what they walk) AND that
 * the shape is identical at two table sizes two orders of magnitude apart.
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

    // One point read on the composite primary key, and nothing else.
    expect(large).toEqual({ 'cloud_covers.get': 1 });
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
    await putCloudCovers([cover()]);

    const first = acquireCover(PATH);
    const second = acquireCover(PATH);
    const seen: (ResolvedCover | undefined)[] = [];
    first.subscribe((v) => seen.push(v));
    await Promise.all([first.ready, second.ready]);

    const afterResolve = seen.length;
    first.release();
    expect(first.current).toBeUndefined();

    // The entry is still alive for `second`; a refresh must not reach `first`.
    refreshCovers([PATH], { force: true });
    await second.ready;
    expect(seen.length).toBe(afterResolve);
    second.release();
  });

  it('revokes a superseded URL when a forced refresh replaces the cover', async () => {
    await putCloudCovers([cover()]);

    const handle = acquireCover(PATH);
    await handle.ready;
    expect(handle.current?.url).toBe('blob:cover-1');

    await putCloudCovers([cover({ width: 260 })]);
    refreshCovers([PATH], { force: true });
    await expect(handle.ready).resolves.toMatchObject({ width: 260 });

    expect(revoked).toEqual(['blob:cover-1']);
    expect(handle.current?.url).toBe('blob:cover-2');

    handle.release();
    expect(revoked).toEqual(['blob:cover-1', 'blob:cover-2']);
  });
});

describe('refreshCovers', () => {
  it('picks up a cover that landed after a held handle already missed', async () => {
    const handle = acquireCover(PATH);
    const seen: (ResolvedCover | undefined)[] = [];
    handle.subscribe((v) => seen.push(v));
    await expect(handle.ready).resolves.toBeUndefined();

    await putCloudCovers([cover()]);
    refreshCovers([PATH]);
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
      refreshCovers(['Hit/Volume 01.cbz', 'Miss/Volume 01.cbz', 'Nobody/Holds This.cbz', '']);
      await Promise.all([hit.ready, miss.ready]);
    });

    // Only the missing one is re-read: the resolved handle and the unheld
    // paths cost nothing.
    expect(counts['cloud_covers.get']).toBe(1);
    hit.release();
    miss.release();
  });

  it('does nothing when no account is connected', async () => {
    await putCloudCovers([cover()]);
    const handle = acquireCover(PATH);
    await handle.ready;

    getActiveProvider.mockReturnValue(null);
    const counts = await countIdbOps(async () => {
      refreshCovers([PATH], { force: true });
      await Promise.resolve();
    });

    expect(coverOps(counts)).toEqual({});
    handle.release();
  });
});
