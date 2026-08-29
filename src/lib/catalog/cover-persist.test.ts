import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { liveQuery } from 'dexie';

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_cover_persist_test') };
});

// The Worker-backed decode cache is orthogonal to persistence; stubbed so
// this file only has to assert on the ONE call this module makes into it
// (invalidate on an 'overwrite'), not load the real Worker plumbing.
const { thumbnailCacheInvalidate } = vi.hoisted(() => ({
  thumbnailCacheInvalidate: vi.fn()
}));
vi.mock('$lib/catalog/thumbnail-cache', () => ({
  thumbnailCache: {
    invalidate: (...a: Parameters<typeof thumbnailCacheInvalidate>) =>
      thumbnailCacheInvalidate(...a)
  }
}));

// `flushPendingCoverPersists` now consults `activeAccountScope()` (routing a
// cover with no row to `cloud_covers`), which reads the active provider off
// this module. Stubbed to one authenticated account so the routing tests
// below have a scope to attribute a cache write to, without pulling in the
// real module's heavy dependency graph (Dexie, compress-volume, every
// provider implementation).
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: () => ({
      getStatus: () => ({ isAuthenticated: true, accountScope: 'mega:a@b.com' })
    })
  }
}));

// The flush now consults the reading-state store (`$lib/settings/volume-data`)
// to decide whether an existing row is a real relationship or just catalog
// knowledge minted by browsing. Hand-rolled rather than the real module (same
// pattern as reread.test.ts / progress-tracker.test.ts) so this file can set
// exactly which volumes have "read" an entry without touching localStorage.
const h = vi.hoisted(() => {
  let value: Record<string, unknown> = {};
  const subs = new Set<(v: Record<string, unknown>) => void>();
  function notify() {
    subs.forEach((fn) => fn(value));
  }
  return {
    readingHistoryStore: {
      subscribe(fn: (v: Record<string, unknown>) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      }
    },
    patchReadingHistory(partial: Record<string, unknown>) {
      value = { ...value, ...partial };
      notify();
    },
    resetReadingHistory() {
      value = {};
      notify();
    }
  };
});

vi.mock('$lib/settings/volume-data', () => ({
  volumes: h.readingHistoryStore
}));

import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import {
  _resetCoverPersistForTests,
  COVER_PERSIST_MAX_BATCH,
  COVER_PERSIST_MAX_PENDING,
  flushPendingCoverPersists,
  installCover
} from './cover-persist';
import { _getCloudCoversForTests } from './cloud-covers';
import { countIdbOps } from './__tests__/idb-op-counter';
import type { CloudThumbnailResult } from './cloud-thumbnails';

/** Gives the volume an entry with real reading activity — a "relationship". */
function setReadingHistory(entries: Record<string, unknown>) {
  h.patchReadingHistory(entries);
}

function metadataOnlyRow(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'v-1',
    series_uuid: 's',
    series_title: 'One Piece',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 5,
    character_count: 50,
    page_char_counts: [50],
    metadata_only: true,
    ...overrides
  } as VolumeMetadata;
}

function coverResult(name = 'cover.webp'): CloudThumbnailResult {
  return {
    file: new File(['img'], name, { type: 'image/webp' }),
    width: 210,
    height: 297
  };
}

// Most of this file's tests exercise the row-write mechanics (dedup guards,
// stamp fields, write coalescing) rather than relationship routing itself —
// so a row minted through this helper is given a reading-history entry by
// default, standing in for "a metadata-only row kept for its history", which
// is the real-world reason such a row exists (see `volume-state.ts`). The
// no-relationship routing tests below deliberately bypass this helper and
// `db.volumes.put` a bare metadata-only row instead.
async function addRow(overrides: Partial<VolumeMetadata> = {}) {
  const row = metadataOnlyRow(overrides);
  await db.volumes.put(row);
  setReadingHistory({ [row.volume_uuid]: { progress: 1 } });
}

beforeEach(() => {
  _resetCoverPersistForTests();
  thumbnailCacheInvalidate.mockClear();
  h.resetReadingHistory();
});

afterEach(async () => {
  _resetCoverPersistForTests(); // cancel any pending timer before it can fire against a cleared table
  await db.volumes.clear();
  await db.cloud_covers.clear();
  h.resetReadingHistory();
});

describe('installCover', () => {
  it('is a no-op for a volume with no DB row (a placeholder never reaches this queue)', async () => {
    installCover('p-1', coverResult());
    await flushPendingCoverPersists();

    // Nothing to assert against a row that was never created — the point is
    // this must not throw and must not create one. Materializing a row for a
    // placeholder is `cover-service.ts`'s job, done BEFORE calling this.
    expect(await db.volumes.get('p-1')).toBeUndefined();
  });

  it('persists the round trip: fetch once, next-session-equivalent read serves from the row', async () => {
    await addRow();

    // fake-indexeddb under jsdom cannot structured-clone a File (it reads
    // back as `{}`), so the File itself is asserted on the WRITE call, not a
    // subsequent read — same workaround `cover-install.test.ts` documents.
    const update = vi.spyOn(db.volumes, 'update');

    installCover('v-1', coverResult(), {
      size: 4096,
      modifiedTime: '2026-06-01T00:00:00.000Z'
    });
    await flushPendingCoverPersists();

    expect(update).toHaveBeenCalledWith('v-1', {
      thumbnail: expect.any(File),
      thumbnail_width: 210,
      thumbnail_height: 297,
      cover_size: 4096,
      cover_modified: Math.floor(Date.parse('2026-06-01T00:00:00.000Z') / 1000)
    });
    update.mockRestore();

    const persisted = (await db.volumes.get('v-1')) as VolumeMetadata;
    expect(persisted.thumbnail).toBeDefined();
    expect(persisted.thumbnail_width).toBe(210);
    expect(persisted.thumbnail_height).toBe(297);
    expect(persisted.cover_size).toBe(4096);
    expect(persisted.cover_modified).toBe(
      Math.floor(Date.parse('2026-06-01T00:00:00.000Z') / 1000)
    );

    // "New session" equivalent: a downloadFile spy would never be reached
    // because the row now HAS a thumbnail — see CatalogItem.test.ts's own
    // pin that `cloudCoverTargets` excludes any row with one. This test's
    // job stops at "the row carries what a next session would read".
  });

  it('never overwrites a row that installed for real mid-flight, even in overwrite mode', async () => {
    await addRow();

    installCover('v-1', coverResult(), {}, 'overwrite');

    // The user downloaded the volume before the flush ran: it is INSTALLED
    // now, with a thumbnail measured from its own pages.
    await db.volumes.update('v-1', {
      metadata_only: undefined,
      thumbnail: new File(['pages'], 'page.webp'),
      thumbnail_width: 999,
      thumbnail_height: 999
    });

    await flushPendingCoverPersists();

    const fresh = (await db.volumes.get('v-1')) as VolumeMetadata;
    expect(fresh.thumbnail_width).toBe(999); // untouched
    expect(fresh.metadata_only).toBeUndefined();
    expect(fresh.cover_size).toBeUndefined(); // never stamped either
  });

  it('in fill mode (default), never touches a row that already has a thumbnail', async () => {
    await addRow({
      thumbnail: new File(['existing'], 'existing.webp'),
      thumbnail_width: 111,
      thumbnail_height: 111
    });

    installCover('v-1', coverResult());
    await flushPendingCoverPersists();

    const fresh = (await db.volumes.get('v-1')) as VolumeMetadata;
    expect(fresh.thumbnail_width).toBe(111);
    expect(fresh.cover_size).toBeUndefined();
  });

  it('in overwrite mode, replaces an existing thumbnail (the stale-row self-heal case)', async () => {
    await addRow({
      thumbnail: new File(['stale'], 'stale.webp'),
      thumbnail_width: 50,
      thumbnail_height: 50,
      cover_size: 10,
      cover_modified: 1
    });

    installCover(
      'v-1',
      coverResult(),
      { size: 4096, modifiedTime: '2026-06-01T00:00:00.000Z' },
      'overwrite'
    );
    await flushPendingCoverPersists();

    const fresh = (await db.volumes.get('v-1')) as VolumeMetadata;
    expect(fresh.thumbnail_width).toBe(210);
    expect(fresh.cover_size).toBe(4096);
    // The canvas-side decode cache is keyed by uuid and never told about a
    // row-level update on its own — without this, a card that already
    // decoded the STALE bitmap under this uuid would keep painting it.
    expect(thumbnailCacheInvalidate).toHaveBeenCalledWith('v-1');
  });

  it('in fill mode, never invalidates the decode cache — there was nothing stale to begin with', async () => {
    await addRow();

    installCover('v-1', coverResult());
    await flushPendingCoverPersists();

    expect(thumbnailCacheInvalidate).not.toHaveBeenCalled();
  });

  it('never touches a fully-installed volume at all', async () => {
    // Neither placeholder nor metadata_only: a real installed row.
    await addRow({ metadata_only: undefined });

    installCover('v-1', coverResult());
    await flushPendingCoverPersists();

    const fresh = (await db.volumes.get('v-1')) as VolumeMetadata;
    expect(fresh.thumbnail).toBeUndefined();
  });

  it('omits the stamp fields when the caller has no listing size/mtime', async () => {
    await addRow();
    const update = vi.spyOn(db.volumes, 'update');

    installCover('v-1', coverResult());
    await flushPendingCoverPersists();

    expect(update).toHaveBeenCalledWith('v-1', {
      thumbnail: expect.any(File),
      thumbnail_width: 210,
      thumbnail_height: 297
    });
    update.mockRestore();

    const fresh = (await db.volumes.get('v-1')) as VolumeMetadata;
    expect('cover_size' in fresh).toBe(false);
    expect('cover_modified' in fresh).toBe(false);
  });
});

describe('write-storm avoidance: coalescing a burst into a bounded number of transactions', () => {
  it('N installCover() calls flush as exactly ONE transaction (one liveQuery emission), never N', async () => {
    const N = 25;
    for (let i = 0; i < N; i++) {
      await addRow({ volume_uuid: `v-${i}`, volume_title: `Volume ${i}` });
    }

    let emissions = 0;
    const sub = liveQuery(() => db.volumes.toArray()).subscribe({
      next: () => {
        emissions += 1;
      }
    });
    // The subscribe call itself emits once with the current table state —
    // that is not a WRITE emission. Wait for it specifically, then reset,
    // so only writes are counted below.
    await vi.waitFor(() => expect(emissions).toBeGreaterThanOrEqual(1));
    emissions = 0;

    for (let i = 0; i < N; i++) {
      installCover(`v-${i}`, coverResult(`v-${i}.webp`));
    }

    // Nothing has flushed SYNCHRONOUSLY — the drain arms on a microtask, so
    // all N synchronous arrivals are already queued together by the time it
    // fires, and the explicit `flushPendingCoverPersists` below takes them
    // as the single batch the microtask would have.
    expect(emissions).toBe(0);

    await flushPendingCoverPersists();
    await vi.waitFor(() => expect(emissions).toBeGreaterThanOrEqual(1));
    sub.unsubscribe();

    // Bounded — 1, not N: one transaction covered the whole burst.
    expect(emissions).toBe(1);

    for (let i = 0; i < N; i++) {
      const row = (await db.volumes.get(`v-${i}`)) as VolumeMetadata;
      expect(row.thumbnail_width).toBe(210);
    }
  });

  it('a real-time burst lands ON ITS OWN, promptly, in one transaction — no flush call, no window', async () => {
    // The immediacy pin against REAL Dexie (the fake-timer half lives in
    // cover-persist.immediacy.test.ts). Nothing here calls
    // `flushPendingCoverPersists`: the microtask-armed drain must land the
    // covers by itself, and the tight `waitFor` bound is what fails a
    // reintroduced fixed window — the removed 750ms one, or anything close.
    await addRow({ volume_uuid: 'v-a' });
    await addRow({ volume_uuid: 'v-b' });

    let emissions = 0;
    const sub = liveQuery(() => db.volumes.toArray()).subscribe({
      next: () => {
        emissions += 1;
      }
    });
    await vi.waitFor(() => expect(emissions).toBeGreaterThanOrEqual(1));
    emissions = 0;

    installCover('v-a', coverResult('a.webp'));
    installCover('v-b', coverResult('b.webp'));

    await vi.waitFor(
      async () => {
        expect(((await db.volumes.get('v-a')) as VolumeMetadata).thumbnail_width).toBe(210);
        expect(((await db.volumes.get('v-b')) as VolumeMetadata).thumbnail_width).toBe(210);
      },
      { timeout: 500 }
    );

    // The synchronous co-arrival still cost ONE transaction (one emission),
    // not one per cover — immediacy did not un-group what genuinely arrived
    // together.
    await vi.waitFor(() => expect(emissions).toBe(1));
    sub.unsubscribe();
  });

  it('an unrowed cover reaches cloud_covers on its own, promptly — no flush call, no window', async () => {
    installCover(
      { volume_uuid: 'prompt-1', cloudPath: 'Dr Stone/Volume 09.cbz' } as never,
      coverResult('nine.webp')
    );

    await vi.waitFor(
      async () => {
        const cached = await _getCloudCoversForTests('mega:a@b.com', ['Dr Stone/Volume 09.cbz']);
        expect(cached.get('Dr Stone/Volume 09.cbz')?.thumbnail).toBeInstanceOf(File);
      },
      { timeout: 500 }
    );
  });

  it('installCover never blocks — persistence is background', async () => {
    // installCover is synchronous (no returned promise to await), matching
    // the requirement that the card paints immediately and persistence
    // happens as a pure background side effect.
    const result = installCover('v-1', coverResult());
    expect(result).toBeUndefined();
    await flushPendingCoverPersists(); // drain the timer this call armed
  });
});

describe('bounded write batches: a burst gets MORE, SMALLER transactions — never one enormous one', () => {
  /** Seed `n` relationship-carrying rows in one write, so the burst below is the only thing under measurement. */
  async function seedRelationshipRows(prefix: string, n: number) {
    const rows: VolumeMetadata[] = [];
    const history: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      rows.push(metadataOnlyRow({ volume_uuid: `${prefix}-${i}`, volume_title: `Volume ${i}` }));
      history[`${prefix}-${i}`] = { progress: 1 };
    }
    await db.volumes.bulkPut(rows);
    setReadingHistory(history);
  }

  it('splits a burst larger than the cap into batches no larger than the cap', async () => {
    // The defect this replaces: the flush delay DOUBLED (750ms → 8,000ms)
    // whenever a batch started collecting right after the last one flushed,
    // so on the reference library the four flushes of a cold start carried
    // ~270 / 535 / 1,070 / 2,140 covers — the last ~66MB in ONE transaction.
    const N = COVER_PERSIST_MAX_BATCH * 2 + 50;
    await seedRelationshipRows('burst', N);

    // Each flush re-reads its whole batch with ONE `bulkGet`, so the key
    // counts handed to it ARE the batch sizes — the most direct measurement
    // of "how many covers went into one transaction" available from outside.
    const bulkGet = vi.spyOn(db.volumes, 'bulkGet');

    const counts = await countIdbOps(async () => {
      for (let i = 0; i < N; i++) installCover(`burst-${i}`, coverResult(`burst-${i}.webp`));
      await flushPendingCoverPersists();
    });

    const batchSizes = bulkGet.mock.calls.map((call) => (call[0] as string[]).length);
    bulkGet.mockRestore();

    // THE contract: no transaction ever carries more than the cap.
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(COVER_PERSIST_MAX_BATCH);
    // Anchor: it really did split, rather than the burst quietly vanishing.
    expect(batchSizes.length).toBe(Math.ceil(N / COVER_PERSIST_MAX_BATCH));
    // Nothing was dropped to achieve it.
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(N);
    // One batch, one write transaction — and Dexie broadcasts
    // `storagemutated` once per readwrite COMMIT, so this is also the number
    // of change signals the burst costs.
    expect(counts['tx.volumes.readwrite'] ?? 0).toBe(batchSizes.length);

    // Anchor: every cover in the burst actually landed on its row, so the
    // bounds above describe the real write path and not a no-op.
    expect(await db.volumes.where('series_title').equals('One Piece').count()).toBe(N);
    for (const i of [0, COVER_PERSIST_MAX_BATCH, N - 1]) {
      expect(((await db.volumes.get(`burst-${i}`)) as VolumeMetadata).thumbnail_width).toBe(210);
    }
  }, 30000);

  it('re-checks a whole batch with ONE bulk read, not one serialized round trip per cover', async () => {
    // The other half of the defect: the flush opened its `rw` transaction and
    // then did `await db.volumes.get(uuid)` PER ENTRY — ~2,140 serialized
    // IndexedDB round trips against a table holding ~14 rows.
    //
    // NOTE on what an op count cannot see here, and why this asserts on the
    // Dexie call shape instead: Dexie's `bulkGet` lowers to `core.getMany`,
    // which issues one `IDBObjectStore.get` request PER KEY (verified in
    // dexie 4.2.1's `dbcore-indexeddb` `getMany`) — it just issues them all
    // before awaiting any of them. So `countIdbOps` reports the SAME
    // `volumes.get` total either way: measured at N = 40, it is 80 for both
    // shapes (40 for this re-check, plus the read Dexie's own `Table.update`
    // does per row). The difference is round TRIPS, not requests, and the
    // only honest external witness to it is that the flush makes one keyed
    // read call for the batch rather than N.
    const N = COVER_PERSIST_MAX_BATCH - 60; // one batch, so "one read" is unambiguous
    await seedRelationshipRows('bulk', N);

    const get = vi.spyOn(db.volumes, 'get');
    const bulkGet = vi.spyOn(db.volumes, 'bulkGet');

    for (let i = 0; i < N; i++) installCover(`bulk-${i}`, coverResult(`bulk-${i}.webp`));
    await flushPendingCoverPersists();

    expect(bulkGet).toHaveBeenCalledTimes(1);
    expect(bulkGet.mock.calls[0][0]).toEqual(
      Array.from({ length: N }, (_, i) => `bulk-${i}`) // the whole batch, in queue order
    );
    expect(get).not.toHaveBeenCalled();
    // Restored BEFORE the anchor below, so the anchor's own read cannot be
    // mistaken for the flush's.
    get.mockRestore();
    bulkGet.mockRestore();

    // Anchor: the re-check really ran against these rows and really wrote —
    // a burst that routed everything to `cloud_covers` would satisfy
    // "no per-entry get" vacuously.
    expect(((await db.volumes.get('bulk-0')) as VolumeMetadata).thumbnail_width).toBe(210);
    expect(((await db.volumes.get(`bulk-${N - 1}`)) as VolumeMetadata).thumbnail_width).toBe(210);
  }, 30000);

  it('bounds the QUEUE too: past COVER_PERSIST_MAX_PENDING the OLDEST waiting covers are dropped', async () => {
    // Drains start a microtask behind the first arrival, so a queue this deep
    // now takes a single synchronous burst (or IndexedDB falling that far
    // behind). Left unbounded it would retain every fetched blob until the
    // backlog cleared (134MB on the reference library). The policy is stated
    // on `COVER_PERSIST_MAX_PENDING`: keep the newest (they are the
    // viewport-gated requests), drop the oldest. This whole burst is
    // synchronous — no flush can snapshot any of it early — so the survivors
    // are exactly the newest `COVER_PERSIST_MAX_PENDING`.
    //
    // No `volumes` rows are seeded on purpose: every cover here carries a
    // cloudPath and no row, so it routes to `cloud_covers`, and which
    // *paths* survive is a direct readout of what the queue kept.
    const OVERFLOW = 50;
    const TOTAL = COVER_PERSIST_MAX_PENDING + OVERFLOW;

    for (let i = 0; i < TOTAL; i++) {
      installCover({ volume_uuid: `ov-${i}`, cloudPath: `Ov/${i}.cbz` } as never, coverResult());
    }
    await flushPendingCoverPersists();

    // Exactly the covers the queue had room for, and not one more.
    expect(await db.cloud_covers.count()).toBe(TOTAL - OVERFLOW);

    const survived = async (i: number) =>
      (await _getCloudCoversForTests('mega:a@b.com', [`Ov/${i}.cbz`])).size === 1;

    // The OLDEST covers are the ones evicted.
    expect(await survived(0)).toBe(false);
    expect(await survived(OVERFLOW - 1)).toBe(false);
    // Everything newer than the evicted window survives, including the very
    // last arrival — the one most likely to be for a card on screen.
    expect(await survived(OVERFLOW)).toBe(true);
    expect(await survived(TOTAL - 1)).toBe(true);
  }, 30000);
});

describe('cover installs route by relationship', () => {
  it('writes a cloud volume’s cover to cloud_covers, never to volumes', async () => {
    const before = await db.volumes.count();
    installCover(
      {
        volume_uuid: 'cloud-1',
        series_title: 'Dr Stone',
        volume_title: 'Volume 01',
        isPlaceholder: true,
        cloudPath: 'Dr Stone/Volume 01.cbz'
      } as never,
      {
        file: new File([new Uint8Array([1])], 'c.webp', { type: 'image/webp' }),
        width: 250,
        height: 350
      }
    );
    await flushPendingCoverPersists();

    expect(await db.volumes.count()).toBe(before);
    const cached = await _getCloudCoversForTests('mega:a@b.com', ['Dr Stone/Volume 01.cbz']);
    expect(cached.get('Dr Stone/Volume 01.cbz')?.width).toBe(250);
    expect(cached.get('Dr Stone/Volume 01.cbz')?.thumbnail).toBeInstanceOf(File);
  });

  it('still writes onto a metadata-only row that has reading history', async () => {
    await db.volumes.put({
      volume_uuid: 'read-1',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'Volume 02',
      mokuro_version: '0.4.11',
      page_count: 180,
      character_count: 1,
      page_char_counts: [],
      metadata_only: true
    } as never);
    setReadingHistory({ 'read-1': { progress: 12, completed: false } });

    installCover(
      {
        volume_uuid: 'read-1',
        series_title: 'Dr Stone',
        volume_title: 'Volume 02',
        metadata_only: true
      } as never,
      {
        file: new File([new Uint8Array([2])], 'c.webp', { type: 'image/webp' }),
        width: 250,
        height: 350
      }
    );
    await flushPendingCoverPersists();

    const row = await db.volumes.get('read-1');
    expect(row?.thumbnail).toBeInstanceOf(File);
  });

  it('counts "marked as finished" alone as a relationship, exactly as the row sweep does', async () => {
    // Both this gate and `materializeHistoryRows` ask the SAME question —
    // "has the user actually read this?" — through the SAME imported
    // predicate (`$lib/settings/reading-activity`). They must not drift: a
    // volume that earns a row there and is called inert here is a row that
    // never gets a cover. The user's rule is that being marked finished
    // counts on its own, with no page turns and no recorded time.
    await db.volumes.put(metadataOnlyRow({ volume_uuid: 'finished-1' }) as never);
    setReadingHistory({
      'finished-1': {
        completed: true,
        progress: 0,
        chars: 0,
        timeReadInMinutes: 0,
        recentPageTurns: [],
        sessions: [],
        archivedReads: []
      }
    });

    installCover(
      { volume_uuid: 'finished-1', cloudPath: 'One Piece/Volume 1.cbz' } as never,
      coverResult()
    );
    await flushPendingCoverPersists();

    const row = await db.volumes.get('finished-1');
    expect(row?.thumbnail).toBeInstanceOf(File);
    // …and it did NOT fall through to the catalog-knowledge cache.
    expect((await _getCloudCoversForTests('mega:a@b.com', ['One Piece/Volume 1.cbz'])).size).toBe(
      0
    );
  });

  it('sends a browsed volume’s cover to cloud_covers even though a row exists', async () => {
    // A row minted by case-3 placeholder resolution: metadata-only, no
    // install, no reading history — pure catalog knowledge, not a
    // relationship. `addRow()` is deliberately NOT used here: it stands in
    // for a relationship by seeding reading history, which is exactly what
    // this test must NOT have.
    await db.volumes.put(metadataOnlyRow({ volume_uuid: 'browsed-1' }) as never);

    installCover({ volume_uuid: 'browsed-1', cloudPath: 'Dr Stone/Volume 01.cbz' } as never, {
      file: new File([new Uint8Array([1])], 'c.webp', { type: 'image/webp' }),
      width: 250,
      height: 350
    });
    await flushPendingCoverPersists();

    const row = (await db.volumes.get('browsed-1')) as VolumeMetadata | undefined;
    expect(row?.thumbnail).toBeUndefined();

    const cached = await _getCloudCoversForTests('mega:a@b.com', ['Dr Stone/Volume 01.cbz']);
    expect(cached.get('Dr Stone/Volume 01.cbz')?.width).toBe(250);
    expect(cached.get('Dr Stone/Volume 01.cbz')?.thumbnail).toBeInstanceOf(File);
  });
});
