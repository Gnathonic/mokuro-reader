import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readable } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import type { CloudThumbnailResult } from './cloud-thumbnails';

/**
 * The END-TO-END publish path for decision-tree case 3 (a bare placeholder
 * with a sidecar): `requestCover` → `scheduleSeriesFileWrite` → the REAL
 * `series-file-sync.ts` (NOT mocked, unlike `cover-service.test.ts`) →
 * `unifiedCloudManager.writeSeriesFile`.
 *
 * `cover-service.test.ts`'s own case-3 test only proves `cover-service.ts`
 * calls `scheduleSeriesFileWrite` with the right SECOND argument — it does
 * not prove the entry actually SURVIVES the debounced writer's own plumbing
 * (`ScheduleOptions.cloudMeasuredVolumes` → `performWrite` →
 * `unifiedCloudManager.writeSeriesFile`'s own `cloudMeasuredVolumes`
 * parameter). A bug in THAT plumbing — the exact class of bug this whole
 * test file exists to catch — would pass a schedule-mock assertion while
 * still silently dropping the stamps at publish time. So here
 * `series-file-sync.ts` is real, and the observation point is
 * `unifiedCloudManager.writeSeriesFile` itself.
 */

vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_cover_service_publish_test') };
});

let status = {
  hasAnyAuthenticated: true,
  needsAttention: false,
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

const {
  getActiveProvider,
  resolveCloudFolderTitle,
  getCloudVolumesBySeries,
  cloudVolumeTitlesFor,
  fetchAllCloudVolumes,
  writeSeriesFileMock
} = vi.hoisted(() => ({
  getActiveProvider: vi.fn(),
  resolveCloudFolderTitle: vi.fn((t: string) => t),
  getCloudVolumesBySeries: vi.fn((_t: string) => [] as unknown[]),
  // The debounced writer's OWN gate: at least one archive must be listed for
  // this series or `hasBackedUpVolume` never even reaches the row this test
  // just materialized.
  cloudVolumeTitlesFor: vi.fn((_t: string) => new Set<string>(['Volume 01'])),
  fetchAllCloudVolumes: vi.fn(async (_options?: unknown) => {}),
  writeSeriesFileMock: vi.fn(
    async (_title: string, _options?: { cloudMeasuredVolumes?: Record<string, unknown>[] }) =>
      'written' as const
  )
}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: (...a: Parameters<typeof getActiveProvider>) => getActiveProvider(...a),
    resolveCloudFolderTitle: (...a: Parameters<typeof resolveCloudFolderTitle>) =>
      resolveCloudFolderTitle(...a),
    getCloudVolumesBySeries: (...a: Parameters<typeof getCloudVolumesBySeries>) =>
      getCloudVolumesBySeries(...a),
    cloudVolumeTitlesFor: (...a: Parameters<typeof cloudVolumeTitlesFor>) =>
      cloudVolumeTitlesFor(...a),
    fetchAllCloudVolumes: (...a: Parameters<typeof fetchAllCloudVolumes>) =>
      fetchAllCloudVolumes(...a),
    writeSeriesFile: (...a: Parameters<typeof writeSeriesFileMock>) => writeSeriesFileMock(...a)
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

// `$lib/metadata/series-file-sync` is DELIBERATELY NOT mocked here — that is
// the whole point of this file.

import { db } from '$lib/catalog/db';
import {
  _resetListingRefreshForTests,
  _resetWriteSlotsForTests,
  flushSeriesFileWrites
} from '$lib/metadata/series-file-sync';
import { _resetCoverPersistForTests } from './cover-persist';
import {
  _resetCoverServiceForTests,
  flushPendingMaterializations,
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

beforeEach(() => {
  vi.clearAllMocks();
  _resetCoverServiceForTests();
  _resetCoverPersistForTests();
  _resetListingRefreshForTests();
  _resetWriteSlotsForTests();
  status = {
    hasAnyAuthenticated: true,
    needsAttention: false,
    currentProviderType: 'webdav',
    providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } }
  };
  // `getStatus` because `requestCover` keys its dedupe ledger by ACCOUNT SCOPE (see
  // `cover-service.ts`'s `ledgerKey`), which every real provider answers.
  getActiveProvider.mockReturnValue({
    type: 'webdav',
    downloadFile: vi.fn(),
    getStatus: () => ({ isAuthenticated: true, accountScope: 'webdav:publish-test' })
  });
  resolveCloudFolderTitle.mockImplementation((t: string) => t);
  cloudVolumeTitlesFor.mockReturnValue(new Set(['Volume 01']));
  fetchAllCloudVolumes.mockResolvedValue(undefined);
  writeSeriesFileMock.mockResolvedValue('written');
  getCloudVolumesBySeries.mockReturnValue([]);
  fetchCloudThumbnailMock.mockResolvedValue(coverResult());
  pullMokuroEntryMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  _resetCoverPersistForTests();
  await db.volumes.clear();
  // Covers now persist IMMEDIATELY (no batch window), so a delivered cover
  // really is in `cloud_covers` by the time a test ends — under the same
  // scope and path every test here uses. Left behind, it makes the next
  // test's `isCachedCoverPath` gate settle the request before it ever
  // materializes. The old 750ms debounce merely masked this leak: the reset
  // above dropped the queue before it could flush.
  await db.cloud_covers.clear();
});

describe('case-3 publish threading, end to end through the REAL series-file-sync', () => {
  it('the entry cover-service.ts built survives all the way to writeSeriesFile’s own cloudMeasuredVolumes parameter, stamps included', async () => {
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

    requestCover(barePlaceholder('derived-bare-uuid'));

    // Let the row materialize and the write get scheduled. Materialization
    // is BATCHED (`cover-service.ts`'s `queueMaterialization`), so drain that
    // queue rather than waiting out its window — the drain resolves only once
    // the batch has both written its rows and scheduled its publish.
    await vi.waitFor(async () => {
      await flushPendingMaterializations();
      expect(await db.volumes.get('real-mokuro-uuid')).toBeDefined();
    });

    // Force the debounced write NOW instead of waiting out its real 2s
    // timer — the same call a teardown/test would make.
    await flushSeriesFileWrites();

    expect(writeSeriesFileMock).toHaveBeenCalledTimes(1);
    const [title, options = {}] = writeSeriesFileMock.mock.calls[0];
    expect(title).toBe('One Piece');
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

  it('publishes without going back for a whole-account listing', async () => {
    // `_resetListingRefreshForTests()` in `beforeEach` leaves the listing
    // stamp at zero, so a write that consults `ensureFreshCloudListing()`
    // WILL fetch — there is no TTL reuse to hide behind here. A cover-driven
    // write must not, because the entries it carries were resolved from the
    // listing that minted the placeholder in the first place, and fetching
    // again re-mints every placeholder and schedules the next write: the loop
    // the user saw as a status badge that never settled.
    getCloudVolumesBySeries.mockReturnValue([cloudFile('One Piece/Volume 01.mokuro', 500)]);
    pullMokuroEntryMock.mockResolvedValue({
      volume_uuid: 'real-mokuro-uuid',
      volume_title: 'Volume 01',
      page_count: 12,
      character_count: 300,
      mokuro_version: '0.4.12'
    });

    requestCover(barePlaceholder('derived-1', { volume_title: 'Volume 01' }));

    await vi.waitFor(async () => {
      await flushPendingMaterializations();
      expect(await db.volumes.get('real-mokuro-uuid')).toBeDefined();
    });

    await flushSeriesFileWrites();

    // It really did publish — an assertion about a write that never happened
    // would be satisfied by any broken pipeline.
    expect(writeSeriesFileMock).toHaveBeenCalledTimes(1);
    expect(fetchAllCloudVolumes).not.toHaveBeenCalled();
  });

  it('two different bare placeholders resolving in the same series both survive into the SAME publish', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.mokuro', 500),
      cloudFile('One Piece/Volume 02.mokuro', 700)
    ]);
    cloudVolumeTitlesFor.mockReturnValue(new Set(['Volume 01', 'Volume 02']));
    pullMokuroEntryMock.mockImplementation(async (_provider, archiveStem: string) => ({
      volume_uuid: `real-${archiveStem}`,
      volume_title: archiveStem,
      page_count: 1,
      character_count: 1,
      mokuro_version: '0.4.11'
    }));

    requestCover(barePlaceholder('derived-1', { volume_title: 'Volume 01' }));
    requestCover(barePlaceholder('derived-2', { volume_title: 'Volume 02' }));

    await vi.waitFor(async () => {
      await flushPendingMaterializations();
      expect(await db.volumes.get('real-Volume 01')).toBeDefined();
      expect(await db.volumes.get('real-Volume 02')).toBeDefined();
    });

    await flushSeriesFileWrites();

    expect(writeSeriesFileMock).toHaveBeenCalledTimes(1);
    const [, options = {}] = writeSeriesFileMock.mock.calls[0];
    const uuids = (options.cloudMeasuredVolumes as { volume_uuid: string }[])
      .map((e) => e.volume_uuid)
      .sort();
    expect(uuids).toEqual(['real-Volume 01', 'real-Volume 02']);
  });
});
