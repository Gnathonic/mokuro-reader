import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_cover_install_test') };
});

const defaultListing = [
  {
    provider: 'webdav',
    fileId: 'cover-1',
    path: 'Dr Stone/Volume 1.webp',
    modifiedTime: '2026-01-02T00:00:00.000Z',
    size: 1
  },
  { provider: 'webdav', fileId: 'cbz-1', path: 'Dr Stone/Volume 1.cbz', modifiedTime: '', size: 1 }
];
const getAllCloudVolumes = vi.fn(() => defaultListing);
const getActiveProvider = vi.fn(() => ({
  type: 'webdav',
  // `cover-persist.ts`'s routing reads the account scope off the provider to
  // decide which account's `cloud_covers` bucket an unrowed cover belongs to;
  // without one it drops the cover rather than blending accounts.
  getStatus: () => ({ isAuthenticated: true, accountScope: 'webdav:a@b.com' })
}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getAllCloudVolumes: () => getAllCloudVolumes(),
    getActiveProvider: () => getActiveProvider()
  }
}));

// The Worker-backed decode cache is orthogonal to what this file asserts.
vi.mock('$lib/catalog/thumbnail-cache', () => ({
  thumbnailCache: { invalidate: vi.fn() }
}));

// `cover-persist.ts`'s relationship gate reads the reading-state store.
// Hand-rolled (same pattern as `cover-persist.test.ts`) so a test can say
// exactly which volumes this device has actually read, without localStorage.
const history = vi.hoisted(() => {
  let value: Record<string, unknown> = {};
  const subs = new Set<(v: Record<string, unknown>) => void>();
  return {
    store: {
      subscribe(fn: (v: Record<string, unknown>) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      }
    },
    set(next: Record<string, unknown>) {
      value = next;
      subs.forEach((fn) => fn(value));
    }
  };
});
vi.mock('$lib/settings/volume-data', () => ({ volumes: history.store }));

const fetchCloudThumbnail = vi.fn(async (_volume: unknown) => ({
  file: new File(['img'], 'Volume 1.webp', { type: 'image/webp' }),
  width: 210,
  height: 297
}));
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: (v: unknown) => fetchCloudThumbnail(v as never)
}));

import { db } from '$lib/catalog/db';
import { _getCloudCoversForTests } from './cloud-covers';
import { _resetCoverPersistForTests } from './cover-persist';
import { MAX_CONCURRENT_COVER_INSTALLS, installCoversForSeries } from './cover-install';

const activeProvider = {
  type: 'webdav',
  getStatus: () => ({ isAuthenticated: true, accountScope: 'webdav:a@b.com' })
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetCoverPersistForTests();
  history.set({});
  // `clearAllMocks` clears call history, not implementations: re-pin the
  // per-test defaults so a `mockReturnValue` in one test cannot leak into the next.
  getAllCloudVolumes.mockReturnValue(defaultListing);
  getActiveProvider.mockReturnValue(activeProvider);
  fetchCloudThumbnail.mockImplementation(async () => ({
    file: new File(['img'], 'Volume 1.webp', { type: 'image/webp' }),
    width: 210,
    height: 297
  }));
});

/** Hold the next cover download open, so a test can act mid-pass. */
function deferFetch() {
  let release!: () => void;
  fetchCloudThumbnail.mockReturnValueOnce(
    new Promise((resolve) => {
      release = () =>
        resolve({ file: new File(['img'], 'Volume 1.webp'), width: 210, height: 297 });
    })
  );
  return { release: () => release() };
}

afterEach(async () => {
  _resetCoverPersistForTests(); // cancel a pending timer before it can fire against a cleared table
  await db.volumes.clear();
  await db.cloud_covers.clear();
});

async function addRow(overrides: Record<string, unknown> = {}) {
  await db.volumes.put({
    volume_uuid: 'uuid-1',
    series_uuid: 's',
    series_title: 'Dr Stone',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 200,
    character_count: 5000,
    page_char_counts: [],
    metadata_only: true,
    ...overrides
  } as never);
}

describe('installCoversForSeries', () => {
  it("caches a relationship-less row's cover instead of writing it onto the row", async () => {
    // A row a mere series OPEN materialized: nothing installed, nothing read.
    // Blobs on rows like this are exactly what grew `volumes` to 11,354 rows /
    // 417MB and made every catalog scan expensive, so the cover belongs in
    // `cloud_covers` — and this module must NOT bypass that routing with a raw
    // `db.volumes.update` of its own.
    await addRow();
    const update = vi.spyOn(db.volumes, 'update');

    expect(await installCoversForSeries('Dr Stone')).toBe(1);

    expect(update).not.toHaveBeenCalled();
    update.mockRestore();

    const row = await db.volumes.get('uuid-1');
    expect(row?.thumbnail).toBeUndefined();

    // Keyed by the ARCHIVE path from the LISTING — the identity
    // `catalog/index.ts` reads a cached cover back under. The stored row
    // carries no `cloudPath` of its own (see `addRow`: `materializeSeriesVolumes`
    // writes no cloud fields), which is exactly why the path has to come from
    // the listing rather than from the row.
    expect(row?.cloudPath).toBeUndefined();
    const cached = await _getCloudCoversForTests('webdav:a@b.com', ['Dr Stone/Volume 1.cbz']);
    expect(cached.get('Dr Stone/Volume 1.cbz')).toMatchObject({ width: 210, height: 297 });

    // Decorated with the listing's cloud fields, which are NEVER stored on the row.
    expect(fetchCloudThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudProvider: 'webdav',
        cloudThumbnailFileId: 'cover-1',
        cloudThumbnailPath: 'Dr Stone/Volume 1.webp'
      })
    );
    expect(row?.cloudThumbnailFileId).toBeUndefined();
  });

  it('inlines the cover sidecar on a metadata-only row the device has READ', async () => {
    await addRow();
    // Reading activity is a relationship: the stats and history pages read
    // thumbnails from rows, so this one's cover does belong on the row.
    history.set({ 'uuid-1': { progress: 3 } });
    // The cover and its dimensions are one write: a row must never be left
    // claiming a size for a picture it does not have. Asserted on the update
    // itself because fake-indexeddb under jsdom cannot structured-clone a File
    // (it reads back as `{}`), so only the write shows the real value.
    const update = vi.spyOn(db.volumes, 'update');

    expect(await installCoversForSeries('Dr Stone')).toBe(1);

    expect(update).toHaveBeenCalledWith('uuid-1', {
      thumbnail: expect.any(File),
      thumbnail_width: 210,
      thumbnail_height: 297,
      // Stamped from the listing record the fetch was made against, so a later
      // pass can decide staleness from the row alone.
      cover_size: 1,
      cover_modified: Math.floor(Date.parse('2026-01-02T00:00:00.000Z') / 1000)
    });
    update.mockRestore();

    const row = await db.volumes.get('uuid-1');
    expect(row?.thumbnail).toBeDefined();
    expect(row?.thumbnail_width).toBe(210);
    expect(row?.thumbnail_height).toBe(297);
    expect(await db.cloud_covers.count()).toBe(0);
  });

  it('skips rows that already have a cover', async () => {
    await addRow({
      thumbnail: new File(['old'], 'old.webp'),
      thumbnail_width: 1,
      thumbnail_height: 1
    });
    expect(await installCoversForSeries('Dr Stone')).toBe(0);
    expect(fetchCloudThumbnail).not.toHaveBeenCalled();
  });

  it('skips installed rows (their cover comes from their own pages)', async () => {
    await addRow({ metadata_only: undefined });
    expect(await installCoversForSeries('Dr Stone')).toBe(0);
    expect(fetchCloudThumbnail).not.toHaveBeenCalled();
  });

  it('matches the sidecar case-insensitively', async () => {
    await addRow({ series_title: 'dr stone', volume_title: 'volume 1' });
    expect(await installCoversForSeries('dr stone')).toBe(1);
  });

  it('matches a title the cloud spells with different whitespace or unicode form', async () => {
    // Decomposed (NFD) with a doubled space: the shape a filename can come back
    // in after a round trip through a filesystem, while the row's title — read
    // from the JSON beside it — stays composed.
    const decomposedCover = 'Dr Stone/Volume  ジュ 1.webp'.normalize('NFD');
    getAllCloudVolumes.mockReturnValueOnce([
      { provider: 'webdav', fileId: 'cover-nfd', path: decomposedCover, modifiedTime: '', size: 1 }
    ]);
    await addRow({ volume_title: 'Volume ジュ 1'.normalize('NFC') });

    expect(await installCoversForSeries('Dr Stone')).toBe(1);
    expect(fetchCloudThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ cloudThumbnailFileId: 'cover-nfd' })
    );
  });

  it('does nothing without a cover sidecar or a provider', async () => {
    await addRow();
    getAllCloudVolumes.mockReturnValueOnce([]);
    expect(await installCoversForSeries('Dr Stone')).toBe(0);

    getActiveProvider.mockReturnValueOnce(null as never);
    expect(await installCoversForSeries('Dr Stone')).toBe(0);
  });

  it('never rejects when a download fails', async () => {
    await addRow();
    fetchCloudThumbnail.mockRejectedValueOnce(new Error('timeout'));
    await expect(installCoversForSeries('Dr Stone')).resolves.toBe(0);
  });

  it('coalesces concurrent passes over the same series', async () => {
    await addRow();
    const pending = deferFetch();

    // `openSeries` releases its own dedupe at materialization, so a second open
    // during a slow cover phase reaches this function again: it must join the
    // running pass instead of downloading the same sidecar twice.
    const first = installCoversForSeries('Dr Stone');
    const second = installCoversForSeries('  DR  STONE ');
    pending.release();

    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1);
  });

  it('matches a series folder the provider spells decomposed', async () => {
    // A provider that hands back NFD decomposes the WHOLE path, not just the
    // filename: a Japanese series folder must still find its covers.
    getAllCloudVolumes.mockReturnValueOnce([
      {
        provider: 'webdav',
        fileId: 'cover-jp',
        path: 'ドクターストーン/Volume 1.webp'.normalize('NFD'),
        modifiedTime: '',
        size: 1
      }
    ]);
    await addRow({ series_title: 'ドクターストーン'.normalize('NFC') });

    expect(await installCoversForSeries('ドクターストーン')).toBe(1);
    expect(fetchCloudThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ cloudThumbnailFileId: 'cover-jp' })
    );
  });

  it('leaves a row that was downloaded while the pass was in flight', async () => {
    await addRow();
    const pending = deferFetch();

    const pass = installCoversForSeries('Dr Stone');
    await vi.waitFor(() => expect(fetchCloudThumbnail).toHaveBeenCalled());

    // The user downloaded the volume mid-pass: it is INSTALLED now, and its
    // thumbnail was measured from its own pages. The snapshot this pass took is
    // stale, and a blind write would clobber a real cover onto a real volume.
    await addRow({
      metadata_only: undefined,
      thumbnail: new File(['pages'], 'page.webp'),
      thumbnail_width: 999,
      thumbnail_height: 999
    });
    pending.release();

    expect(await pass).toBe(0);
    const row = await db.volumes.get('uuid-1');
    expect(row?.thumbnail_width).toBe(999);
    expect(row?.metadata_only).toBeUndefined();
  });

  it('picks up rows materialized after the pass took its snapshot', async () => {
    getAllCloudVolumes.mockReturnValue([
      {
        provider: 'webdav',
        fileId: 'cover-1',
        path: 'Dr Stone/Volume 1.webp',
        modifiedTime: '',
        size: 1
      },
      {
        provider: 'webdav',
        fileId: 'cover-2',
        path: 'Dr Stone/Volume 2.webp',
        modifiedTime: '',
        size: 1
      },
      {
        provider: 'webdav',
        fileId: 'cbz-1',
        path: 'Dr Stone/Volume 1.cbz',
        modifiedTime: '',
        size: 1
      },
      {
        provider: 'webdav',
        fileId: 'cbz-2',
        path: 'Dr Stone/Volume 2.cbz',
        modifiedTime: '',
        size: 1
      }
    ]);
    await addRow();
    const pending = deferFetch();

    const pass = installCoversForSeries('Dr Stone');
    await vi.waitFor(() => expect(fetchCloudThumbnail).toHaveBeenCalled());

    // A second open materialized Volume 2 while this pass was downloading: the
    // joiner is served the running pass, so that pass has to look again or the
    // new card stays blank until the series is opened a third time.
    await addRow({ volume_uuid: 'uuid-2', volume_title: 'Volume 2' });
    const joiner = installCoversForSeries('Dr Stone');
    pending.release();

    expect(await pass).toBe(2);
    expect(await joiner).toBe(2);
    const cached = await _getCloudCoversForTests('webdav:a@b.com', ['Dr Stone/Volume 2.cbz']);
    expect(cached.get('Dr Stone/Volume 2.cbz')).toMatchObject({ width: 210, height: 297 });
  });

  it('runs again once the previous pass has settled', async () => {
    await addRow();
    expect(await installCoversForSeries('Dr Stone')).toBe(1);
    await addRow(); // back to a coverless row
    await db.cloud_covers.clear(); // ...and its cached cover aged out (see below)

    expect(await installCoversForSeries('Dr Stone')).toBe(1);
    expect(fetchCloudThumbnail).toHaveBeenCalledTimes(2);
  });

  it('never re-downloads a cover this account already has cached', async () => {
    // A relationship-less row NEVER carries its cover on the row, so
    // `!row.thumbnail` is no longer an "already done" test: without consulting
    // `cloud_covers`, every series open and every backfill sweep would
    // re-download every cover it already holds.
    await addRow();
    expect(await installCoversForSeries('Dr Stone')).toBe(1);
    expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1);

    expect(await installCoversForSeries('Dr Stone')).toBe(0);
    expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1);
  });
});

describe('concurrency pinning', () => {
  it('pins the install pass width at 8 — matched to MAX_CONCURRENT_FETCHES, change both together', () => {
    // The fetch-pool constant has its own pin in cloud-thumbnails' suite
    // (this file mocks that module, so cross-module equality cannot be
    // asserted here); the pairing lives in both constants' doc comments.
    expect(MAX_CONCURRENT_COVER_INSTALLS).toBe(8);
  });
});
