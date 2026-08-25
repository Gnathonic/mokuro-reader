import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { liveQuery } from 'dexie';

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_cover_persist_test') };
});

import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import {
  _resetCoverPersistForTests,
  COVER_PERSIST_DEBOUNCE_MS,
  flushPendingCoverPersists,
  scheduleCatalogCoverPersist
} from './cover-persist';
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
});

afterEach(async () => {
  _resetCoverPersistForTests(); // cancel any pending timer before it can fire against a cleared table
  await db.volumes.clear();
});

describe('scheduleCatalogCoverPersist', () => {
  it('is a no-op for a volume with no DB row (a placeholder)', async () => {
    const placeholder = {
      volume_uuid: 'p-1',
      series_uuid: 's',
      series_title: 'One Piece',
      volume_title: 'Volume 1',
      mokuro_version: 'unknown',
      page_count: 0,
      character_count: 0,
      page_char_counts: [],
      isPlaceholder: true
    } as VolumeMetadata;

    scheduleCatalogCoverPersist(placeholder, coverResult());
    await flushPendingCoverPersists();

    // Nothing to assert against a row that was never created — the point is
    // this must not throw and must not create one.
    expect(await db.volumes.get('p-1')).toBeUndefined();
  });

  it('persists the round trip: fetch once, next-session-equivalent read serves from the row', async () => {
    await addRow({
      cloudThumbnailFileId: 'thumb-1',
      cloudThumbnailPath: 'One Piece/Volume 1.webp',
      cloudThumbnailSize: 4096,
      cloudThumbnailModifiedTime: '2026-06-01T00:00:00.000Z'
    });
    const row = (await db.volumes.get('v-1')) as VolumeMetadata;

    // fake-indexeddb under jsdom cannot structured-clone a File (it reads
    // back as `{}`), so the File itself is asserted on the WRITE call, not a
    // subsequent read — same workaround `cover-install.test.ts` documents.
    const update = vi.spyOn(db.volumes, 'update');

    scheduleCatalogCoverPersist(row, coverResult());
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

  it('never overwrites a row that installed for real mid-flight', async () => {
    await addRow();
    const row = (await db.volumes.get('v-1')) as VolumeMetadata;

    scheduleCatalogCoverPersist(row, coverResult());

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

  it('never touches a row that already has a thumbnail (an earlier commit, or cover-install)', async () => {
    await addRow({
      thumbnail: new File(['existing'], 'existing.webp'),
      thumbnail_width: 111,
      thumbnail_height: 111
    });
    const row = (await db.volumes.get('v-1')) as VolumeMetadata;

    scheduleCatalogCoverPersist(row, coverResult());
    await flushPendingCoverPersists();

    const fresh = (await db.volumes.get('v-1')) as VolumeMetadata;
    expect(fresh.thumbnail_width).toBe(111);
    expect(fresh.cover_size).toBeUndefined();
  });

  it('never touches a fully-installed volume at all', async () => {
    // Neither placeholder nor metadata_only: a real installed row.
    await addRow({ metadata_only: undefined });
    const row = (await db.volumes.get('v-1')) as VolumeMetadata;

    scheduleCatalogCoverPersist(row, coverResult());
    await flushPendingCoverPersists();

    const fresh = (await db.volumes.get('v-1')) as VolumeMetadata;
    expect(fresh.thumbnail).toBeUndefined();
  });

  it('omits the stamp fields when the volume carries no listing size/mtime', async () => {
    await addRow({ cloudThumbnailFileId: 'thumb-1' }); // no size/modifiedTime
    const row = (await db.volumes.get('v-1')) as VolumeMetadata;
    const update = vi.spyOn(db.volumes, 'update');

    scheduleCatalogCoverPersist(row, coverResult());
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
  it('N schedule() calls flush as exactly ONE transaction (one liveQuery emission), never N', async () => {
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
      const row = (await db.volumes.get(`v-${i}`)) as VolumeMetadata;
      scheduleCatalogCoverPersist(row, coverResult(`v-${i}.webp`));
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
    // wait), this one lets the actual timer fire, proving `scheduleCatalog-
    // CoverPersist` only ever arms ONE timer no matter how many times it is
    // called while one is already pending.
    await addRow({ volume_uuid: 'v-a' });
    await addRow({ volume_uuid: 'v-b' });
    const rowA = (await db.volumes.get('v-a')) as VolumeMetadata;
    const rowB = (await db.volumes.get('v-b')) as VolumeMetadata;

    let emissions = 0;
    const sub = liveQuery(() => db.volumes.toArray()).subscribe({
      next: () => {
        emissions += 1;
      }
    });
    await vi.waitFor(() => expect(emissions).toBeGreaterThanOrEqual(1));
    emissions = 0;

    scheduleCatalogCoverPersist(rowA, coverResult('a.webp'));
    scheduleCatalogCoverPersist(rowB, coverResult('b.webp'));

    await new Promise((resolve) => setTimeout(resolve, COVER_PERSIST_DEBOUNCE_MS + 200));
    sub.unsubscribe();

    expect(emissions).toBe(1);
    expect(((await db.volumes.get('v-a')) as VolumeMetadata).thumbnail_width).toBe(210);
    expect(((await db.volumes.get('v-b')) as VolumeMetadata).thumbnail_width).toBe(210);
  }, 10000);

  it('commitCover-equivalent scheduling never blocks — persistence is background', async () => {
    // scheduleCatalogCoverPersist is synchronous (no returned promise to
    // await), matching CatalogItem's requirement that the card paints
    // immediately and persistence happens as a pure background side effect.
    const result = scheduleCatalogCoverPersist(metadataOnlyRow(), coverResult());
    expect(result).toBeUndefined();
    await flushPendingCoverPersists(); // drain the timer this schedule armed
  });
});
