import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readable } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import type { CloudThumbnailResult } from './cloud-thumbnails';

/**
 * `cover-service.ts` end to end against the decision tree Round 8 specified:
 * a real Dexie (fake-indexeddb) so `materializeSeriesVolumes`/`installCover`
 * run for real and the resulting rows can be inspected directly, with the
 * network/provider edges mocked. `series-backfill.ts` is PARTIALLY mocked —
 * `acquireBackfillSlot`/`releaseBackfillSlot` keep their real semaphore logic
 * (the concurrency-bounding test below needs the actual cap, not a stub);
 * only `pullMokuroEntry` (the network call) is replaced.
 */

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_cover_service_test') };
});

let status = {
  hasAnyAuthenticated: true,
  currentProviderType: 'webdav' as string | null,
  providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } } as Record<
    string,
    { isReadOnly?: boolean; serverCompilesMetadata?: boolean } | null
  >
};
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: {
    get status() {
      return readable(status);
    }
  }
}));

vi.mock('$lib/catalog/cover-install', () => ({
  installCoversForSeries: vi.fn(async () => 0)
}));

const { getActiveProvider, resolveCloudFolderTitle, getCloudVolumesBySeries } = vi.hoisted(() => ({
  getActiveProvider: vi.fn(),
  resolveCloudFolderTitle: vi.fn((t: string) => t),
  getCloudVolumesBySeries: vi.fn((_t: string) => [] as unknown[])
}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: (...a: Parameters<typeof getActiveProvider>) => getActiveProvider(...a),
    resolveCloudFolderTitle: (...a: Parameters<typeof resolveCloudFolderTitle>) =>
      resolveCloudFolderTitle(...a),
    getCloudVolumesBySeries: (...a: Parameters<typeof getCloudVolumesBySeries>) =>
      getCloudVolumesBySeries(...a)
  }
}));

const { fetchCloudThumbnailMock } = vi.hoisted(() => ({
  fetchCloudThumbnailMock: vi.fn(async (_v: unknown) => null as CloudThumbnailResult | null)
}));
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: (...a: Parameters<typeof fetchCloudThumbnailMock>) =>
    fetchCloudThumbnailMock(...a),
  getCachedCloudThumbnail: vi.fn(() => undefined)
}));

const { pullMokuroEntryMock } = vi.hoisted(() => ({
  pullMokuroEntryMock: vi.fn(
    async (_provider: unknown, _archiveStem: string, _sidecarFile: unknown) =>
      undefined as
        | {
            volume_uuid: string;
            volume_title: string;
            page_count: number;
            character_count: number;
            mokuro_version: string;
          }
        | undefined
  )
}));
vi.mock('$lib/metadata/series-backfill', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/metadata/series-backfill')>();
  return {
    ...actual,
    pullMokuroEntry: (...a: Parameters<typeof pullMokuroEntryMock>) => pullMokuroEntryMock(...a)
  };
});

const { scheduleSeriesFileWriteMock } = vi.hoisted(() => ({
  scheduleSeriesFileWriteMock: vi.fn()
}));
vi.mock('$lib/metadata/series-file-sync', () => ({
  scheduleSeriesFileWrite: (...a: Parameters<typeof scheduleSeriesFileWriteMock>) =>
    scheduleSeriesFileWriteMock(...a)
}));

// `flushPendingCoverPersists` (cover-persist.ts) consults `activeAccountScope()`
// to decide where a row-less cover belongs — it reads
// `unifiedCloudManager.getActiveProvider().getStatus().accountScope`, a
// DIFFERENT call than the `getActiveProvider()` above (same mocked function,
// but the returned provider now also needs a `getStatus` method). Defaults to
// one authenticated account so case-2 tests below have a scope to attribute a
// `cloud_covers` write to; individual tests override it to exercise the
// no-scope-drop path.
const { putCloudCoversMock } = vi.hoisted(() => ({ putCloudCoversMock: vi.fn() }));
vi.mock('$lib/catalog/cloud-covers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/catalog/cloud-covers')>();
  return {
    ...actual,
    putCloudCovers: (...a: Parameters<typeof actual.putCloudCovers>) => {
      putCloudCoversMock(...a);
      return actual.putCloudCovers(...a);
    }
  };
});

// Case-3/4 materialization is BATCHED (`cover-service.ts`'s
// `queueMaterialization`): the real implementation still runs — these tests
// inspect the rows it writes — but every call is counted, so a burst that
// costs one `volumes` mutation can be told apart from one that costs N.
const { materializeMock } = vi.hoisted(() => ({ materializeMock: vi.fn() }));
vi.mock('$lib/catalog/materialize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/catalog/materialize')>();
  return {
    ...actual,
    materializeSeriesVolumes: (...a: Parameters<typeof actual.materializeSeriesVolumes>) => {
      materializeMock(...a);
      return actual.materializeSeriesVolumes(...a);
    }
  };
});

// `cover-persist.ts`'s flush now consults the reading-state store
// (`$lib/settings/volume-data`) to tell a genuine relationship apart from a
// row minted purely by browsing. Hand-rolled (same pattern as
// `cover-persist.test.ts`) so `row()` below can mark itself as a
// relationship without touching real localStorage; `indexedPlaceholder()`/
// `barePlaceholder()` deliberately never do.
const readingHistory = vi.hoisted(() => {
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
vi.mock('$lib/settings/volume-data', () => ({
  volumes: readingHistory.store
}));

import { db } from '$lib/catalog/db';
import { _resetCoverPersistForTests } from './cover-persist';
import { _getCloudCoversForTests, putCloudCovers } from './cloud-covers';
import {
  _resetCoverServiceForTests,
  flushPendingCoverPersists,
  flushPendingMaterializations,
  isCoverFetchTarget,
  MATERIALIZE_BATCH_MAX_ENTRIES,
  requestCover
} from './cover-service';

function coverResult(name = 'cover.webp'): CloudThumbnailResult {
  return { file: new File(['img'], name, { type: 'image/webp' }), width: 210, height: 297 };
}

function cloudFile(
  path: string,
  size: number,
  modifiedTime = '2026-01-01T00:00:00.000Z'
): CloudFileMetadata {
  return { provider: 'webdav', fileId: path, path, size, modifiedTime } as CloudFileMetadata;
}

/**
 * A real, installed-or-materialized row — i.e. a row this device has a
 * RELATIONSHIP with, as opposed to `indexedPlaceholder`/`barePlaceholder`
 * below (no row at all). Registers a reading-history entry for the uuid as a
 * side effect so `cover-persist.ts`'s relationship gate treats it the same
 * way: a row that already exists independent of this render is never the
 * "minted purely by browsing" case the gate exists to route away.
 */
function row(uuid: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  readingHistory.set({ [uuid]: { progress: 1 } });
  return {
    volume_uuid: uuid,
    series_uuid: 's',
    series_title: 'One Piece',
    volume_title: 'Volume 01',
    mokuro_version: '0.4.11',
    page_count: 5,
    character_count: 50,
    page_char_counts: [50],
    metadata_only: true,
    ...overrides
  } as VolumeMetadata;
}

/** An index-adopted placeholder: real uuid/counts, no DB row yet. */
function indexedPlaceholder(uuid: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 's',
    series_title: 'One Piece',
    volume_title: 'Volume 01',
    mokuro_version: '0.4.11',
    page_count: 5,
    character_count: 50,
    page_char_counts: [],
    isPlaceholder: true,
    // Every real placeholder carries this (see `createPlaceholder` in
    // placeholders.ts) — it is the identity a row-less cover is cached
    // under in `cloud_covers`.
    cloudPath: 'One Piece/Volume 01.cbz',
    ...overrides
  } as VolumeMetadata;
}

/**
 * A bare placeholder: derived uuid, zero counts, no series-index entry
 * anywhere. `cloudPath` tracks `volume_title` (the way a real placeholder's
 * does — it is derived from the archive the listing showed), so a test that
 * overrides the title still names a distinct archive.
 */
function barePlaceholder(uuid: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  const volumeTitle = overrides.volume_title ?? 'Volume 01';
  return {
    volume_uuid: uuid,
    series_uuid: 's',
    series_title: 'One Piece',
    volume_title: volumeTitle,
    mokuro_version: 'unknown',
    page_count: 0,
    character_count: 0,
    page_char_counts: [],
    isPlaceholder: true,
    cloudProvider: 'webdav',
    cloudFileId: 'archive-1',
    cloudPath: `One Piece/${volumeTitle}.cbz`,
    cloudSize: 12345,
    cloudModifiedTime: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as VolumeMetadata;
}

/** Drain both debounced queues the resolution path goes through, in order. */
async function drainQueues(): Promise<void> {
  await flushPendingMaterializations();
  await flushPendingCoverPersists();
}

/** Poll: keep draining until `uuid` has a thumbnail ON ITS ROW, or time out. */
async function waitForCover(uuid: string, timeout = 2000): Promise<VolumeMetadata> {
  let found: VolumeMetadata | undefined;
  await vi.waitFor(
    async () => {
      await drainQueues();
      found = (await db.volumes.get(uuid)) as VolumeMetadata | undefined;
      expect(found?.thumbnail).toBeDefined();
    },
    { timeout }
  );
  return found!;
}

/**
 * Poll: keep draining until the row for `uuid` exists AND its cover has been
 * cached under `archivePath`.
 *
 * The two-places-a-cover-can-land split is `cover-persist.ts`'s ROUTING rule,
 * not this file's: a row minted purely by browsing (cases 3/4 — nothing
 * installed, nothing read) has no relationship, so its blob belongs in
 * `cloud_covers` keyed by the archive path, and the catalog paints the card
 * from there (see `catalog/index.ts`'s metadata-only cover decoration). The
 * ROW still has to exist and carry the materialized metadata.
 */
async function waitForCachedCover(
  uuid: string,
  archivePath: string,
  timeout = 2000
): Promise<VolumeMetadata> {
  let found: VolumeMetadata | undefined;
  await vi.waitFor(
    async () => {
      await drainQueues();
      found = (await db.volumes.get(uuid)) as VolumeMetadata | undefined;
      expect(found).toBeDefined();
      const cached = await _getCloudCoversForTests('mega:a@b.com', [archivePath]);
      expect(cached.get(archivePath)?.thumbnail).toBeInstanceOf(File);
    },
    { timeout }
  );
  return found!;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCoverServiceForTests();
  _resetCoverPersistForTests();
  readingHistory.set({});
  status = {
    hasAnyAuthenticated: true,
    currentProviderType: 'webdav',
    providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } }
  };
  getActiveProvider.mockReturnValue({
    type: 'webdav',
    downloadFile: vi.fn(),
    getStatus: () => ({ isAuthenticated: true, accountScope: 'mega:a@b.com' })
  });
  resolveCloudFolderTitle.mockImplementation((t: string) => t);
  getCloudVolumesBySeries.mockReturnValue([]);
  fetchCloudThumbnailMock.mockResolvedValue(coverResult());
  pullMokuroEntryMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  _resetCoverPersistForTests();
  await db.volumes.clear();
  await db.cloud_covers.clear();
  vi.restoreAllMocks();
});

describe('isCoverFetchTarget (staleness approach)', () => {
  it('a thumbnail-less placeholder is always a target', () => {
    expect(isCoverFetchTarget(barePlaceholder('p-1'))).toBe(true);
    expect(isCoverFetchTarget(indexedPlaceholder('p-2'))).toBe(true);
  });

  it('a thumbnail-less real row is a target only when the catalog already decorated a cover id', () => {
    expect(
      isCoverFetchTarget(row('v-1', { thumbnail: undefined, cloudThumbnailFileId: undefined }))
    ).toBe(false);
    expect(
      isCoverFetchTarget(row('v-1', { thumbnail: undefined, cloudThumbnailFileId: 'c-1' }))
    ).toBe(true);
  });

  it('a thumbnailed placeholder is never a target (nothing to compare)', () => {
    expect(
      isCoverFetchTarget(indexedPlaceholder('p-1', { thumbnail: new File([], 'x.webp') }))
    ).toBe(false);
  });

  it('a thumbnailed row with no recorded stamp is never treated as stale (migration-safety inversion)', () => {
    const vol = row('v-1', {
      thumbnail: new File([], 'x.webp'),
      cloudThumbnailFileId: 'c-1',
      cloudThumbnailSize: 999,
      cloudThumbnailModifiedTime: '2026-06-01T00:00:00.000Z'
      // no cover_size / cover_modified recorded on the row itself
    });
    expect(isCoverFetchTarget(vol)).toBe(false);
  });

  it('a thumbnailed row is a target when its recorded stamp mismatches the listing', () => {
    const vol = row('v-1', {
      thumbnail: new File([], 'x.webp'),
      cloudThumbnailFileId: 'c-1',
      cover_size: 100,
      cloudThumbnailSize: 999,
      cloudThumbnailModifiedTime: '2026-06-01T00:00:00.000Z'
    });
    expect(isCoverFetchTarget(vol)).toBe(true);
  });

  it('a thumbnailed row is NOT a target when its recorded stamp matches the listing', () => {
    const vol = row('v-1', {
      thumbnail: new File([], 'x.webp'),
      cloudThumbnailFileId: 'c-1',
      cover_size: 999,
      cover_modified: Math.floor(Date.parse('2026-06-01T00:00:00.000Z') / 1000),
      cloudThumbnailSize: 999,
      cloudThumbnailModifiedTime: '2026-06-01T00:00:00.000Z'
    });
    expect(isCoverFetchTarget(vol)).toBe(false);
  });
});

describe('decision tree case 1: a DB row already exists', () => {
  it('installs the cover directly onto the row, no materialize/pull involved', async () => {
    await db.volumes.put(row('v-1'));
    const vol = row('v-1', {
      cloudThumbnailFileId: 'c-1',
      cloudThumbnailPath: 'One Piece/v1.webp'
    });

    requestCover(vol);
    const persisted = await waitForCover('v-1');

    expect(persisted.thumbnail_width).toBe(210);
    expect(pullMokuroEntryMock).not.toHaveBeenCalled();
    expect(scheduleSeriesFileWriteMock).not.toHaveBeenCalled();
  });

  it('does nothing when the row has no cover id to fetch', async () => {
    await db.volumes.put(row('v-1'));
    requestCover(row('v-1'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchCloudThumbnailMock).not.toHaveBeenCalled();
    expect((await db.volumes.get('v-1')) as VolumeMetadata).not.toHaveProperty('thumbnail');
  });
});

describe('decision tree case 2: an index-adopted placeholder', () => {
  it('fetches and caches the cover in cloud_covers WITHOUT materializing a row — the regression fix', async () => {
    const before = await db.volumes.count();
    const vol = indexedPlaceholder('idx-1', {
      cloudThumbnailFileId: 'c-1',
      cloudThumbnailPath: 'One Piece/v1.webp'
    });

    requestCover(vol);
    await vi.waitFor(async () => {
      await flushPendingCoverPersists();
      const cached = await _getCloudCoversForTests('mega:a@b.com', ['One Piece/Volume 01.cbz']);
      expect(cached.has('One Piece/Volume 01.cbz')).toBe(true);
    });

    // The whole point: browsing this placeholder never minted a `volumes` row.
    expect(await db.volumes.count()).toBe(before);
    expect(await db.volumes.get('idx-1')).toBeUndefined();
    // The entry-present path never touches the network for the ENTRY —
    // `downloadFile`/`pullMokuroEntry` is reached only for the COVER, via
    // `fetchCloudThumbnail`.
    expect(pullMokuroEntryMock).not.toHaveBeenCalled();
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all — no row, no cache entry — when there is no cover to fetch', async () => {
    const before = await db.volumes.count();
    const vol = indexedPlaceholder('idx-2'); // no cloudThumbnailFileId
    requestCover(vol);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await flushPendingCoverPersists();

    expect(fetchCloudThumbnailMock).not.toHaveBeenCalled();
    expect(await db.volumes.get('idx-2')).toBeUndefined();
    expect(await db.volumes.count()).toBe(before);
  });

  it('installs onto the row instead, when one already exists for this uuid (e.g. materialized by a concurrent case-1/3/4 request)', async () => {
    await db.volumes.put(row('idx-3'));
    const vol = indexedPlaceholder('idx-3', {
      cloudThumbnailFileId: 'c-1',
      cloudThumbnailPath: 'One Piece/v1.webp'
    });

    requestCover(vol);
    const persisted = await waitForCover('idx-3');

    expect(persisted.thumbnail_width).toBe(210);
    const cached = await _getCloudCoversForTests('mega:a@b.com', ['One Piece/Volume 01.cbz']);
    expect(cached.has('One Piece/Volume 01.cbz')).toBe(false);
  });
});

// A case-3/4 row is minted purely by browsing — nothing installed, nothing read —
// so `cover-persist.ts`'s relationship gate routes its cover to the `cloud_covers`
// cache (keyed by the ARCHIVE's cloud path), never onto the row itself; the catalog
// paints such a card from there (see `catalog/index.ts`'s metadata-only cover
// decoration). What the ROW must carry is unchanged: the materialized metadata,
// under the mokuro's real uuid. These tests therefore wait on
// `waitForCachedCover`, and pin BOTH halves.
describe('decision tree case 3: a bare placeholder with a sidecar', () => {
  it('pulls the mokuro sidecar (through the backfill semaphore), materializes under the REAL uuid, caches the cover, and schedules the series.json write', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.mokuro', 500),
      cloudFile('One Piece/Volume 01.webp', 900)
    ]);
    pullMokuroEntryMock.mockResolvedValue({
      volume_uuid: 'real-mokuro-uuid',
      volume_title: 'Volume 01',
      page_count: 12,
      character_count: 300,
      mokuro_version: '0.4.12'
    });

    const derivedUuid = 'derived-bare-uuid';
    requestCover(barePlaceholder(derivedUuid));

    const persisted = await waitForCachedCover('real-mokuro-uuid', 'One Piece/Volume 01.cbz');
    expect(persisted.page_count).toBe(12);
    expect(persisted.character_count).toBe(300);
    expect(persisted.archive_size).toBe(12345);
    // Cached, not carried: a browsed row never takes the blob (that is what
    // makes a full `volumes` scan expensive), it only points at the archive
    // path the blob is cached under.
    expect(persisted.thumbnail).toBeUndefined();

    // The uuid handoff: no row was ever created under the placeholder's own
    // derived uuid — only under the mokuro's real one. A duplicate card would
    // mean a row existing at BOTH uuids.
    expect(await db.volumes.get(derivedUuid)).toBeUndefined();

    // Not just "was the write scheduled" — the FULLY-STAMPED entry itself
    // must be threaded through as `cloudMeasuredVolumes`. Without this, the
    // eventual publish falls back to the installed-row fill path and the
    // entry lands stampless forever (see `ScheduleOptions.cloudMeasuredVolumes`'s
    // doc in `series-file-sync.ts`) — this is the exact regression a shallow
    // "was the mock called" assertion would miss. The end-to-end threading
    // all the way to `unifiedCloudManager.writeSeriesFile` is covered
    // separately in `cover-service.publish.test.ts`, which does not mock
    // `series-file-sync.ts` at all.
    expect(scheduleSeriesFileWriteMock).toHaveBeenCalledTimes(1);
    const [folderTitle, options] = scheduleSeriesFileWriteMock.mock.calls[0];
    expect(folderTitle).toBe('One Piece');
    expect(options.cloudMeasuredVolumes).toEqual([
      {
        volume_uuid: 'real-mokuro-uuid',
        volume_title: 'Volume 01',
        page_count: 12,
        character_count: 300,
        mokuro_version: '0.4.12',
        archive_size: 12345,
        mokuro_size: 500,
        mokuro_modified: Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000),
        cover_size: 900,
        cover_modified: Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000)
      }
    ]);
  });
});

describe('decision tree case 4: a bare placeholder with no mokuro sidecar (image-only)', () => {
  it('uses the image-only zero-count convention, never calls pullMokuroEntry, and still caches a cover if the listing has one', async () => {
    getCloudVolumesBySeries.mockReturnValue([cloudFile('One Piece/Volume 02.webp', 900)]);

    requestCover(barePlaceholder('bare-2', { volume_title: 'Volume 02' }));

    // Deterministic uuid: the SAME convention `buildNoMetadataEntry` in
    // series-backfill.ts uses for a whole-series sweep.
    const { generateDeterministicUUID } = await import('$lib/util/series-extraction');
    const expectedUuid = generateDeterministicUUID('One Piece/Volume 02');

    const persisted = await waitForCachedCover(expectedUuid, 'One Piece/Volume 02.cbz');
    expect(persisted.page_count).toBe(0);
    expect(persisted.character_count).toBe(0);
    expect(pullMokuroEntryMock).not.toHaveBeenCalled();
    expect(scheduleSeriesFileWriteMock).toHaveBeenCalledTimes(1);
    expect(scheduleSeriesFileWriteMock.mock.calls[0][0]).toBe('One Piece');
    expect(scheduleSeriesFileWriteMock.mock.calls[0][1].cloudMeasuredVolumes).toEqual([
      expect.objectContaining({ volume_uuid: expectedUuid, volume_title: 'Volume 02' })
    ]);
  });
});

describe('read-only providers: local materialization is never skipped, only the publish gate applies', () => {
  it('still resolves/materializes/caches a cover for a bare placeholder, and still hands the entry to the (separately-gated) writer', async () => {
    status.providers.webdav!.isReadOnly = true;
    getActiveProvider.mockReturnValue({
      type: 'webdav',
      downloadFile: vi.fn(),
      getStatus: () => ({ isAuthenticated: true, accountScope: 'mega:a@b.com' })
    });
    getCloudVolumesBySeries.mockReturnValue([cloudFile('One Piece/Volume 03.webp', 900)]);

    requestCover(barePlaceholder('bare-3', { volume_title: 'Volume 03' }));

    const { generateDeterministicUUID } = await import('$lib/util/series-extraction');
    const expectedUuid = generateDeterministicUUID('One Piece/Volume 03');
    const persisted = await waitForCachedCover(expectedUuid, 'One Piece/Volume 03.cbz');

    expect(persisted.page_count).toBe(0);
    // cover-service.ts never gates on read-only itself (no such check exists
    // in it) — it always DELEGATES the publish decision to
    // `scheduleSeriesFileWrite`, whose own internal `hasWritableProvider()`
    // gate (covered by series-file-sync's own tests) is what actually skips
    // the PUT for a read-only share. This pins that cover-service.ts keeps
    // calling it unconditionally, WITH the stamped entry, rather than
    // special-casing read-only itself.
    expect(scheduleSeriesFileWriteMock).toHaveBeenCalledTimes(1);
    expect(scheduleSeriesFileWriteMock.mock.calls[0][0]).toBe('One Piece');
    expect(scheduleSeriesFileWriteMock.mock.calls[0][1].cloudMeasuredVolumes).toEqual([
      expect.objectContaining({ volume_uuid: expectedUuid, volume_title: 'Volume 03' })
    ]);
  });
});

describe('concurrency: render-demand mokuro pulls share the backfill semaphore', () => {
  it('never runs more than the backfill pool width of pullMokuroEntry calls at once, across a burst of requests', async () => {
    const titles = Array.from({ length: 6 }, (_, i) => `Volume 0${i + 1}`);
    getCloudVolumesBySeries.mockReturnValue(
      titles.flatMap((t) => [
        cloudFile(`One Piece/${t}.mokuro`, 500),
        cloudFile(`One Piece/${t}.webp`, 900)
      ])
    );

    let active = 0;
    let maxActive = 0;
    pullMokuroEntryMock.mockImplementation(async (_provider: unknown, archiveStem: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        volume_uuid: `real-${archiveStem}`,
        volume_title: archiveStem,
        page_count: 1,
        character_count: 1,
        mokuro_version: '0.4.11'
      };
    });

    for (const t of titles) {
      requestCover(barePlaceholder(`bare-${t}`, { volume_title: t }));
    }

    await vi.waitFor(
      async () => {
        await drainQueues();
        const cached = await _getCloudCoversForTests(
          'mega:a@b.com',
          titles.map((t) => `One Piece/${t}.cbz`)
        );
        for (const t of titles) {
          expect(await db.volumes.get(`real-${t}`)).toBeDefined();
          expect(cached.get(`One Piece/${t}.cbz`)?.thumbnail).toBeInstanceOf(File);
        }
      },
      { timeout: 5000 }
    );

    expect(pullMokuroEntryMock).toHaveBeenCalledTimes(6);
    // BACKFILL_PASS_CONCURRENCY in series-backfill.ts is 2 — this is the SAME
    // pool a reconcile sweep uses, so fast browsing cannot stampede a
    // provider any more than a sweep can.
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

// Retry-schedule timing (fake timers) needs a `db` that resolves purely on
// microtasks — real Dexie/fake-indexeddb's own internal scheduling hangs
// under `vi.useFakeTimers()`. See `cover-service.retry.test.ts`, which mocks
// `db` as a plain in-memory stub for exactly that reason.

describe('dedupe: one in-flight/settled request per uuid, whichever surface asks', () => {
  it('two requestCover calls before settling share ONE fetch, and a call after settling asks nothing further', async () => {
    await db.volumes.put(row('v-1'));
    const vol = row('v-1', { cloudThumbnailFileId: 'c-1' });

    requestCover(vol);
    requestCover(vol); // a second surface's effect, same render pass

    await waitForCover('v-1');
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(1);

    requestCover(vol); // settled: must not ask again
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The regression this task fixes: browsing a large cloud catalog wrote a
 * `volumes` row per rendered card (434 → 11,354 rows measured on a
 * ~1,000-series library), and each row write costs a full catalog re-derive.
 * These pin the two ends of the fix — a browsed placeholder never mints a
 * row, and a volume that actually has a local relationship (reading history)
 * still gets one.
 */
describe('browsing does not mint volumes rows', () => {
  it('an indexed placeholder is cached, not materialized', async () => {
    const before = await db.volumes.count();

    requestCover(
      indexedPlaceholder('idx-dr-stone-3', {
        series_title: 'Dr Stone',
        volume_title: 'Volume 03',
        cloudPath: 'Dr Stone/Volume 03.cbz',
        cloudThumbnailFileId: 'c-ds-3',
        cloudThumbnailPath: 'Dr Stone/Volume 03.webp'
      })
    );

    await vi.waitFor(async () => {
      await flushPendingCoverPersists();
      const cached = await _getCloudCoversForTests('mega:a@b.com', ['Dr Stone/Volume 03.cbz']);
      expect(cached.has('Dr Stone/Volume 03.cbz')).toBe(true);
    });

    expect(await db.volumes.count()).toBe(before);
  });

  it('a volume with reading history still gets its row', async () => {
    // History rows are created by the download/read path, not by browsing:
    // requesting a cover for one must fill the row, not the cover table.
    await db.volumes.put(row('hist-1', { volume_title: 'Volume 04' }));

    requestCover(
      row('hist-1', {
        volume_title: 'Volume 04',
        cloudThumbnailFileId: 'c-hist-1',
        cloudThumbnailPath: 'One Piece/Volume 04.webp'
      })
    );

    const persisted = await waitForCover('hist-1');
    expect(persisted.thumbnail).toBeInstanceOf(File);
  });
});

describe('no active account scope: a row-less cover is dropped, never written unscoped', () => {
  it('drops the cover for an indexed placeholder instead of caching it unscoped', async () => {
    getActiveProvider.mockReturnValue({
      type: 'webdav',
      downloadFile: vi.fn(),
      getStatus: () => ({ isAuthenticated: true, accountScope: null })
    });

    const before = await db.volumes.count();
    requestCover(
      indexedPlaceholder('idx-noscope', {
        series_title: 'Dr Stone',
        volume_title: 'Volume 05',
        cloudPath: 'Dr Stone/Volume 05.cbz',
        cloudThumbnailFileId: 'c-ds-5',
        cloudThumbnailPath: 'Dr Stone/Volume 05.webp'
      })
    );

    // The fetch still happens — a missing account scope only affects WHERE
    // the result can land, decided later inside the flush — so wait for the
    // fetch itself rather than for any DB effect (there should be none).
    await vi.waitFor(() => expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(1));
    await flushPendingCoverPersists();

    // Dropped, not written anywhere: no row, and nothing queued for
    // `cloud_covers` either (a real write-unscoped bug would still pass a
    // `cached.has(...)` check keyed to the WRONG scope string, but would
    // never show up in `putCloudCoversMock`'s payload at all — this is the
    // stronger assertion the null-scope path needs).
    expect(putCloudCoversMock).toHaveBeenCalledTimes(1);
    expect(putCloudCoversMock.mock.calls[0][0]).toEqual([]);
    expect(await db.volumes.count()).toBe(before);
    const cached = await _getCloudCoversForTests('mega:a@b.com', ['Dr Stone/Volume 05.cbz']);
    expect(cached.size).toBe(0);
  });
});

/**
 * The OTHER half of the same regression: even with browsing no longer minting
 * a row per rendered card, a bare placeholder (cases 3/4) still materializes
 * one — and doing that one volume at a time cost one `volumes` mutation, and
 * therefore one whole-catalog re-derive, per resolved cover.
 */
describe('write-storm avoidance for case-3 materialization: a burst is ONE volumes write', () => {
  const bareSeries = (titles: string[]) => {
    getCloudVolumesBySeries.mockReturnValue(
      titles.flatMap((t) => [
        cloudFile(`One Piece/${t}.mokuro`, 500),
        cloudFile(`One Piece/${t}.webp`, 900)
      ])
    );
    pullMokuroEntryMock.mockImplementation(async (_provider: unknown, archiveStem: string) => ({
      volume_uuid: `real-${archiveStem}`,
      volume_title: archiveStem,
      page_count: 1,
      character_count: 1,
      mokuro_version: '0.4.11'
    }));
    for (const t of titles) requestCover(barePlaceholder(`bare-${t}`, { volume_title: t }));
  };

  it('N resolutions in one window produce exactly one materializeSeriesVolumes call, carrying all N entries', async () => {
    const N = 5;
    const titles = Array.from({ length: N }, (_, i) => `Volume ${String(i + 1).padStart(2, '0')}`);
    bareSeries(titles);

    // The window is a real timer: let it close on its own rather than forcing
    // a drain, so this pins the production cadence and not just the test hook.
    // Waited on the LAST thing a batch does (its publish), so the batch is
    // fully landed — rows included — by the time the counts are read.
    await vi.waitFor(() => expect(scheduleSeriesFileWriteMock).toHaveBeenCalledTimes(1), {
      timeout: 4000
    });

    expect(materializeMock).toHaveBeenCalledTimes(1);
    expect(materializeMock.mock.calls[0][0].seriesTitle).toBe('One Piece');
    expect(materializeMock.mock.calls[0][0].entries).toHaveLength(N);
    // One publish for the whole burst too — `cloudMeasuredVolumes` accumulates
    // across coalesced calls, so N entries in one call and N calls of one
    // entry publish the same file; only the call count differs.
    expect(scheduleSeriesFileWriteMock.mock.calls[0][0]).toBe('One Piece');
    expect(scheduleSeriesFileWriteMock.mock.calls[0][1].cloudMeasuredVolumes).toHaveLength(N);
    // ...and every row still landed, exactly as the per-volume calls left them.
    for (const t of titles) {
      expect(await db.volumes.get(`real-${t}`)).toMatchObject({
        volume_title: t,
        page_count: 1,
        metadata_only: true
      });
    }
  });

  it('flushes early at the queue cap instead of buffering a whole library', async () => {
    // A window that only ever closes on a timer is an unbounded buffer on a
    // library with thousands of cloud files; the cap is what bounds it.
    const N = MATERIALIZE_BATCH_MAX_ENTRIES + 5;
    const titles = Array.from({ length: N }, (_, i) => `Volume ${String(i + 1).padStart(3, '0')}`);
    bareSeries(titles);

    await vi.waitFor(() => expect(materializeMock.mock.calls.length).toBeGreaterThanOrEqual(1), {
      timeout: 4000
    });
    expect(materializeMock.mock.calls[0][0].entries).toHaveLength(MATERIALIZE_BATCH_MAX_ENTRIES);

    // Nothing is dropped by flushing early — the rest ride the next batch.
    await vi.waitFor(
      async () => {
        await drainQueues();
        expect(await db.volumes.count()).toBe(N);
      },
      { timeout: 4000 }
    );
  });
});

describe('write-storm avoidance for row-less covers: a burst still coalesces to ONE putCloudCovers call', () => {
  it('N browsed (no-row) covers requested in one burst produce exactly one putCloudCovers call', async () => {
    const N = 8;
    const titles = Array.from({ length: N }, (_, i) => `Volume ${String(i + 1).padStart(2, '0')}`);

    // Gate every fetch behind one shared promise so all N requests reach
    // (and park on) `fetchCloudThumbnail` before any of them resolves —
    // otherwise an early arrival could flush before a late one has even
    // queued its `installCover` call, and the whole point of this test is
    // that a real burst still costs exactly ONE write, not N.
    let releaseGate: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    fetchCloudThumbnailMock.mockImplementation(async () => {
      await gate;
      return coverResult();
    });

    for (const t of titles) {
      requestCover(
        indexedPlaceholder(`idx-burst-${t}`, {
          series_title: 'Dr Stone',
          volume_title: t,
          cloudPath: `Dr Stone/${t}.cbz`,
          cloudThumbnailFileId: `c-${t}`,
          cloudThumbnailPath: `Dr Stone/${t}.webp`
        })
      );
    }

    await vi.waitFor(() => expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(N));
    releaseGate!();
    // Let every unblocked continuation (each one's `installCover` call) land
    // in the SAME pending batch before this test ever calls
    // `flushPendingCoverPersists` — a real macrotask tick, not a microtask
    // one, so it runs strictly after all N continuations have settled.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await flushPendingCoverPersists();

    const cached = await _getCloudCoversForTests(
      'mega:a@b.com',
      titles.map((t) => `Dr Stone/${t}.cbz`)
    );
    expect(cached.size).toBe(N);
    expect(await db.volumes.count()).toBe(0);
    expect(putCloudCoversMock).toHaveBeenCalledTimes(1);
    expect(putCloudCoversMock.mock.calls[0][0]).toHaveLength(N);
  });
});

/**
 * `volume_uuid` is the whole `volumes` table's primary key and is
 * title-independent, so a mokuro re-OCR'd elsewhere can hand two DIFFERENT
 * series the same uuid. `materializeSeriesVolumes`'s rule 0 refuses to write
 * such an entry and leaves the other series' row standing — which is
 * indistinguishable from a successful materialization if the batch only asks
 * "does a row exist at this uuid?". Delivering the cover on that answer paints
 * this series' art onto that row.
 */
describe("rule 0: a uuid owned by ANOTHER series never receives this series' cover", () => {
  it('leaves a foreign history-bearing row untouched instead of covering it', async () => {
    // A row the user actually reads from, in a different series, already
    // sitting on the uuid the One Piece sidecar is about to claim.
    await db.volumes.put(row('dup-uuid', { series_title: 'Dr Stone', volume_title: 'Volume 07' }));

    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.mokuro', 500),
      cloudFile('One Piece/Volume 01.webp', 900)
    ]);
    pullMokuroEntryMock.mockResolvedValue({
      volume_uuid: 'dup-uuid',
      volume_title: 'Volume 01',
      page_count: 1,
      character_count: 1,
      mokuro_version: '0.4.11'
    });

    requestCover(barePlaceholder('bare-dup', { volume_title: 'Volume 01' }));

    await vi.waitFor(async () => {
      await drainQueues();
      expect(materializeMock).toHaveBeenCalled();
    });
    // Two further full drains: had the cover been delivered, its fetch and the
    // write it queues would both have landed inside these.
    await drainQueues();
    await drainQueues();

    const foreign = (await db.volumes.get('dup-uuid')) as VolumeMetadata;
    expect(foreign.series_title).toBe('Dr Stone');
    expect(foreign.volume_title).toBe('Volume 07');
    expect(foreign.thumbnail).toBeUndefined();
    // The refusal is reached BEFORE the network, so a colliding uuid costs no
    // download at all.
    expect(fetchCloudThumbnailMock).not.toHaveBeenCalled();
    const cached = await _getCloudCoversForTests('mega:a@b.com', ['One Piece/Volume 01.cbz']);
    expect(cached.size).toBe(0);
  });
});

/**
 * `cloud_covers` is keyed by the LISTING's own archive path — the only key
 * `catalog/index.ts` ever reads a cached cover back under. A synthesized
 * `<series_title>/<volume_title>.cbz` fallback is not that key whenever the
 * cloud folder is not spelled like the series, so writing under it would bury
 * the blob where nothing looks while `requestCover` marks the uuid `settled`.
 */
describe('a placeholder with no cloudPath is never cached under a guessed key', () => {
  it('skips the cloud_covers write rather than inventing an archive path', async () => {
    resolveCloudFolderTitle.mockReturnValue('OP Folder');
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('OP Folder/Volume 01.mokuro', 500),
      cloudFile('OP Folder/Volume 01.webp', 900)
    ]);
    pullMokuroEntryMock.mockResolvedValue({
      volume_uuid: 'real-nopath',
      volume_title: 'Volume 01',
      page_count: 1,
      character_count: 1,
      mokuro_version: '0.4.11'
    });

    // An older placeholder, minted before archive paths were recorded.
    requestCover(barePlaceholder('bare-nopath', { cloudPath: undefined }));

    await vi.waitFor(async () => {
      await drainQueues();
      // The row still materializes; only the CACHE write is skipped.
      expect(await db.volumes.get('real-nopath')).toBeDefined();
      // A flush ran and had something queued to route (the fetch did happen).
      expect(putCloudCoversMock).toHaveBeenCalled();
    });

    const written = putCloudCoversMock.mock.calls.flatMap((call) => call[0]);
    expect(written).toEqual([]);
    const cached = await _getCloudCoversForTests('mega:a@b.com', [
      'One Piece/Volume 01.cbz',
      'OP Folder/Volume 01.cbz'
    ]);
    expect(cached.size).toBe(0);
  });
});

/**
 * THE DEDUPE LEDGER IS PER ACCOUNT.
 *
 * A placeholder's uuid is a deterministic function of its path, so the same volume
 * browsed under two accounts is the SAME uuid — while "settled" now includes the
 * `isCachedCoverPath` fast path, which is a fact about one account's `cloud_covers`
 * bucket and nothing else. Keyed by uuid alone, a cache hit under the first account
 * silently refused to ever fetch that cover under the second one, for the rest of the
 * session.
 */
describe('settled is scoped to the account it settled under', () => {
  it('asks again under a second account for a uuid a cache HIT settled under the first', async () => {
    const path = 'One Piece/Volume 09.cbz';
    const placeholder = indexedPlaceholder('idx-scoped-9', {
      volume_title: 'Volume 09',
      cloudPath: path,
      cloudThumbnailFileId: 'c-9',
      cloudThumbnailPath: 'One Piece/Volume 09.webp'
    });

    // Already cached under the FIRST account (`beforeEach`'s scope).
    await putCloudCovers([
      {
        account_scope: 'mega:a@b.com',
        path,
        thumbnail: new File([new Uint8Array(64)], 'cached.webp', { type: 'image/webp' }),
        width: 250,
        height: 350,
        cached_at: 1000
      }
    ]);

    requestCover(placeholder);
    // The cache hit settles the uuid without a network call — and past the 100ms
    // materialize window (cover persistence itself is now immediate), so this is the
    // settled state and not a snapshot taken before the batch that would have carried
    // a fetch.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await drainQueues();
    expect(fetchCloudThumbnailMock).not.toHaveBeenCalled();

    // Same volume, same uuid, DIFFERENT account: this one has never seen the cover.
    getActiveProvider.mockReturnValue({
      type: 'webdav',
      downloadFile: vi.fn(),
      getStatus: () => ({ isAuthenticated: true, accountScope: 'mega:second@b.com' })
    });

    requestCover(placeholder);

    await vi.waitFor(
      async () => {
        await drainQueues();
        const cached = await _getCloudCoversForTests('mega:second@b.com', [path]);
        expect(cached.get(path)?.thumbnail).toBeInstanceOf(File);
      },
      { timeout: 3000 }
    );
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(1);
  });
});
