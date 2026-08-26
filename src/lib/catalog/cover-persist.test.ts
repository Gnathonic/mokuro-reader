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

import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import {
  _resetCoverPersistForTests,
  COVER_PERSIST_BASE_DELAY_MS,
  flushPendingCoverPersists,
  installCover
} from './cover-persist';
import { getCloudCovers } from './cloud-covers';
import type { CloudThumbnailResult } from './cloud-thumbnails';

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

async function addRow(overrides: Partial<VolumeMetadata> = {}) {
  await db.volumes.put(metadataOnlyRow(overrides));
}

beforeEach(() => {
  _resetCoverPersistForTests();
  thumbnailCacheInvalidate.mockClear();
});

afterEach(async () => {
  _resetCoverPersistForTests(); // cancel any pending timer before it can fire against a cleared table
  await db.volumes.clear();
  await db.cloud_covers.clear();
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

    // Nothing has flushed yet — N queued results collapse into ONE flush,
    // which is exactly what the single explicit `flushPendingCoverPersists`
    // below exercises (the same call the real debounce timer makes).
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

  it('the debounce timer itself coalesces a real-time burst into one flush', async () => {
    // Unlike the test above (which flushes explicitly to avoid a slow real
    // wait), this one lets the actual timer fire, proving `installCover`
    // only ever arms ONE timer no matter how many times it is called while
    // one is already pending.
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

    await new Promise((resolve) => setTimeout(resolve, COVER_PERSIST_BASE_DELAY_MS + 200));
    sub.unsubscribe();

    expect(emissions).toBe(1);
    expect(((await db.volumes.get('v-a')) as VolumeMetadata).thumbnail_width).toBe(210);
    expect(((await db.volumes.get('v-b')) as VolumeMetadata).thumbnail_width).toBe(210);
  }, 10000);

  it('installCover never blocks — persistence is background', async () => {
    // installCover is synchronous (no returned promise to await), matching
    // the requirement that the card paints immediately and persistence
    // happens as a pure background side effect.
    const result = installCover('v-1', coverResult());
    expect(result).toBeUndefined();
    await flushPendingCoverPersists(); // drain the timer this call armed
  });
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
    const cached = await getCloudCovers('mega:a@b.com', ['Dr Stone/Volume 01.cbz']);
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
});
