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

import { db } from '$lib/catalog/db';
import { _resetCoverPersistForTests } from './cover-persist';
import {
  _resetCoverServiceForTests,
  flushPendingCoverPersists,
  isCoverFetchTarget,
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

/** A real, installed-or-materialized row. */
function row(uuid: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
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
    ...overrides
  } as VolumeMetadata;
}

/** A bare placeholder: derived uuid, zero counts, no series-index entry anywhere. */
function barePlaceholder(uuid: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 's',
    series_title: 'One Piece',
    volume_title: 'Volume 01',
    mokuro_version: 'unknown',
    page_count: 0,
    character_count: 0,
    page_char_counts: [],
    isPlaceholder: true,
    cloudProvider: 'webdav',
    cloudFileId: 'archive-1',
    cloudPath: 'One Piece/Volume 01.cbz',
    cloudSize: 12345,
    cloudModifiedTime: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as VolumeMetadata;
}

/** Poll: keep flushing the persist queue until `uuid` has a thumbnail, or time out. */
async function waitForCover(uuid: string, timeout = 2000): Promise<VolumeMetadata> {
  let found: VolumeMetadata | undefined;
  await vi.waitFor(
    async () => {
      await flushPendingCoverPersists();
      found = (await db.volumes.get(uuid)) as VolumeMetadata | undefined;
      expect(found?.thumbnail).toBeDefined();
    },
    { timeout }
  );
  return found!;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetCoverServiceForTests();
  _resetCoverPersistForTests();
  status = {
    hasAnyAuthenticated: true,
    currentProviderType: 'webdav',
    providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } }
  };
  getActiveProvider.mockReturnValue({ type: 'webdav', downloadFile: vi.fn() });
  resolveCloudFolderTitle.mockImplementation((t: string) => t);
  getCloudVolumesBySeries.mockReturnValue([]);
  fetchCloudThumbnailMock.mockResolvedValue(coverResult());
  pullMokuroEntryMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  _resetCoverPersistForTests();
  await db.volumes.clear();
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
  it('materializes the row FROM THE ENTRY and installs the cover, skipping the mokuro pull entirely', async () => {
    const vol = indexedPlaceholder('idx-1', {
      cloudThumbnailFileId: 'c-1',
      cloudThumbnailPath: 'One Piece/v1.webp'
    });

    requestCover(vol);
    const persisted = await waitForCover('idx-1');

    expect(persisted.page_count).toBe(5);
    expect(persisted.character_count).toBe(50);
    expect(persisted.metadata_only).toBe(true);
    // The entry-present path never touches the network for the ENTRY —
    // `downloadFile`/`pullMokuroEntry` is reached only for the COVER, via
    // `fetchCloudThumbnail`.
    expect(pullMokuroEntryMock).not.toHaveBeenCalled();
    expect(fetchCloudThumbnailMock).toHaveBeenCalledTimes(1);
  });

  it('materializes even when there is no cover to fetch', async () => {
    const vol = indexedPlaceholder('idx-2'); // no cloudThumbnailFileId
    requestCover(vol);

    await vi.waitFor(async () => {
      const persisted = (await db.volumes.get('idx-2')) as VolumeMetadata | undefined;
      expect(persisted).toBeDefined();
    });
    expect(fetchCloudThumbnailMock).not.toHaveBeenCalled();
  });
});

describe('decision tree case 3: a bare placeholder with a sidecar', () => {
  it('pulls the mokuro sidecar (through the backfill semaphore), materializes under the REAL uuid, installs the cover, and schedules the series.json write', async () => {
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

    const persisted = await waitForCover('real-mokuro-uuid');
    expect(persisted.page_count).toBe(12);
    expect(persisted.character_count).toBe(300);
    expect(persisted.archive_size).toBe(12345);

    // The uuid handoff: no row was ever created under the placeholder's own
    // derived uuid — only under the mokuro's real one. A duplicate card would
    // mean a row existing at BOTH uuids.
    expect(await db.volumes.get(derivedUuid)).toBeUndefined();

    expect(scheduleSeriesFileWriteMock).toHaveBeenCalledWith('One Piece');
  });
});

describe('decision tree case 4: a bare placeholder with no mokuro sidecar (image-only)', () => {
  it('uses the image-only zero-count convention, never calls pullMokuroEntry, and still installs a cover if the listing has one', async () => {
    getCloudVolumesBySeries.mockReturnValue([cloudFile('One Piece/Volume 02.webp', 900)]);

    requestCover(barePlaceholder('bare-2', { volume_title: 'Volume 02' }));

    // Deterministic uuid: the SAME convention `buildImageOnlyEntry` in
    // series-backfill.ts uses for a whole-series sweep.
    const { generateDeterministicUUID } = await import('$lib/util/series-extraction');
    const expectedUuid = generateDeterministicUUID('One Piece/Volume 02');

    const persisted = await waitForCover(expectedUuid);
    expect(persisted.page_count).toBe(0);
    expect(persisted.character_count).toBe(0);
    expect(pullMokuroEntryMock).not.toHaveBeenCalled();
    expect(scheduleSeriesFileWriteMock).toHaveBeenCalledWith('One Piece');
  });
});

describe('read-only providers: local materialization is never skipped, only the publish gate applies', () => {
  it('still resolves/materializes/installs a cover for a bare placeholder, and still hands the entry to the (separately-gated) writer', async () => {
    status.providers.webdav!.isReadOnly = true;
    getActiveProvider.mockReturnValue({ type: 'webdav', downloadFile: vi.fn() });
    getCloudVolumesBySeries.mockReturnValue([cloudFile('One Piece/Volume 03.webp', 900)]);

    requestCover(barePlaceholder('bare-3', { volume_title: 'Volume 03' }));

    const { generateDeterministicUUID } = await import('$lib/util/series-extraction');
    const expectedUuid = generateDeterministicUUID('One Piece/Volume 03');
    const persisted = await waitForCover(expectedUuid);

    expect(persisted.page_count).toBe(0);
    // cover-service.ts never gates on read-only itself (no such check exists
    // in it) — it always DELEGATES the publish decision to
    // `scheduleSeriesFileWrite`, whose own internal `hasWritableProvider()`
    // gate (covered by series-file-sync's own tests) is what actually skips
    // the PUT for a read-only share. This pins that cover-service.ts keeps
    // calling it unconditionally rather than special-casing read-only itself.
    expect(scheduleSeriesFileWriteMock).toHaveBeenCalledWith('One Piece');
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
        await flushPendingCoverPersists();
        for (const t of titles) {
          const r = (await db.volumes.get(`real-${t}`)) as VolumeMetadata | undefined;
          expect(r?.thumbnail).toBeDefined();
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
