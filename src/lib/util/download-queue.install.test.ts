import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

/**
 * The install step of a download: what lands on the row once the archive is
 * here. Everything around it — the worker pool, the providers, the queue — is
 * plumbing and is stubbed.
 */
const {
  volumesGet,
  volumesUpdate,
  saveVolume,
  processVolume,
  deleteVolumeCompletely,
  ocrGet,
  filesGet
} = vi.hoisted(() => ({
  volumesGet: vi.fn(async () => undefined as VolumeMetadata | undefined),
  volumesUpdate: vi.fn(async () => 1),
  saveVolume: vi.fn(async () => {}),
  processVolume: vi.fn(),
  deleteVolumeCompletely: vi.fn(async () => {}),
  ocrGet: vi.fn(async () => undefined as unknown),
  filesGet: vi.fn(async () => undefined as unknown)
}));

vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: volumesGet, update: volumesUpdate },
    volume_ocr: { get: ocrGet },
    volume_files: { get: filesGet }
  }
}));
vi.mock('./progress-tracker', () => ({
  progressTrackerStore: {
    subscribe: (fn: (v: { processes: unknown[] }) => void) => (fn({ processes: [] }), () => {}),
    addProcess: vi.fn(),
    updateProcess: vi.fn(),
    removeProcess: vi.fn()
  }
}));
vi.mock('./worker-pool', () => ({}));
vi.mock('./file-processing-pool', () => ({
  getFileProcessingPool: vi.fn(),
  incrementPoolUsers: vi.fn(),
  decrementPoolUsers: vi.fn()
}));
vi.mock('./sync/providers/google-drive/api-client', () => ({ driveApiClient: {} }));
vi.mock('./sync/providers/google-drive/drive-files-cache', () => ({ driveFilesCache: {} }));
vi.mock('./sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getCloudVolume: vi.fn(), refreshCloudFiles: vi.fn() }
}));
vi.mock('$lib/import', () => ({
  processVolume,
  saveVolume,
  deleteVolumeCompletely,
  isSystemFile: () => false,
  isImageExtension: () => true,
  getImageMimeType: () => 'image/jpeg'
}));
vi.mock('$lib/catalog/stranded-rows', () => ({
  dropStrandedMetadataOnlyRow: vi.fn(async () => {})
}));

// The install trigger's collaborators: the writable/non-server gate and the
// debounced series.json scheduler. Gate defaults CLOSED so every pre-existing
// test keeps its exact surface; the trigger tests open it explicitly.
const { hasWritableNonServerProvider, scheduleSeriesFileWrite } = vi.hoisted(() => ({
  hasWritableNonServerProvider: vi.fn(() => false),
  scheduleSeriesFileWrite: vi.fn((_title: string) => {})
}));
vi.mock('$lib/metadata/series-backfill', () => ({ hasWritableNonServerProvider }));
vi.mock('$lib/metadata/series-file-sync', () => ({ scheduleSeriesFileWrite }));

import { processVolumeData } from './download-queue';

/** The queued placeholder, carrying the size the LISTING claimed. */
function placeholder(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    mokuro_version: 'unknown',
    page_count: 0,
    character_count: 0,
    page_char_counts: [],
    isPlaceholder: true,
    cloudProvider: 'webdav',
    cloudFileId: 'file-1',
    cloudPath: 'One Piece/Vol 1.cbz',
    cloudSize: 999,
    ...overrides
  } as VolumeMetadata;
}

function processed() {
  return {
    metadata: {
      volumeUuid: 'uuid-1',
      series: 'One Piece',
      seriesUuid: 'series-uuid',
      volume: 'Vol 1',
      mokuroVersion: '0.4.11',
      pageCount: 2,
      chars: 10
    },
    ocrData: { volume_uuid: 'uuid-1', pages: [] },
    fileData: { volume_uuid: 'uuid-1', files: {} }
  };
}

afterEach(async () => {
  vi.mocked(volumesUpdate).mockClear();
  vi.mocked(volumesGet).mockReset();
  vi.mocked(volumesGet).mockResolvedValue(undefined);
  vi.mocked(saveVolume).mockClear();
  vi.mocked(deleteVolumeCompletely).mockClear();
  // The OCR/file rows are what `shouldReplaceDownloadedVolume` reads: a test that seeds
  // them must not decide the next test's install path.
  const { db } = await import('$lib/catalog/db');
  vi.mocked(db.volume_ocr.get).mockReset();
  vi.mocked(db.volume_ocr.get).mockResolvedValue(undefined as never);
  vi.mocked(db.volume_files.get).mockReset();
  vi.mocked(db.volume_files.get).mockResolvedValue(undefined as never);
  hasWritableNonServerProvider.mockReset();
  hasWritableNonServerProvider.mockReturnValue(false);
  scheduleSeriesFileWrite.mockClear();
});

describe('installing a downloaded volume', () => {
  it('records the size of the archive that arrived, not the size the listing claimed', async () => {
    vi.mocked(processVolume).mockResolvedValue(processed());

    await processVolumeData([], placeholder(), 193_000_000);

    expect(saveVolume).toHaveBeenCalledTimes(1);
    expect(volumesUpdate).toHaveBeenCalledWith('uuid-1', { archive_size: 193_000_000 });
  });

  it('records nothing when the download never measured the archive', async () => {
    vi.mocked(processVolume).mockResolvedValue(processed());

    await processVolumeData([], placeholder(), undefined);

    expect(volumesUpdate).not.toHaveBeenCalled();
  });

  it('never stamps a size onto a row this download did not write', async () => {
    // An installed row with OCR already there: the download is redundant and
    // `shouldReplaceDownloadedVolume` says leave it alone. Whatever we just
    // fetched is not what that row holds, so its size is not this size.
    vi.mocked(processVolume).mockResolvedValue(processed());
    vi.mocked(volumesGet).mockResolvedValue({
      ...placeholder({ isPlaceholder: undefined, mokuro_version: '0.4.11' })
    } as VolumeMetadata);
    const { db } = await import('$lib/catalog/db');
    vi.mocked(db.volume_ocr.get).mockResolvedValue({ volume_uuid: 'uuid-1', pages: [] } as never);
    vi.mocked(db.volume_files.get).mockResolvedValue({ volume_uuid: 'uuid-1', files: {} } as never);

    await processVolumeData([], placeholder(), 193_000_000);

    expect(saveVolume).not.toHaveBeenCalled();
    expect(volumesUpdate).not.toHaveBeenCalled();
  });
});

describe('downloading a volume whose files were removed from this device', () => {
  /** The row that survived the removal: history and cover, no pages. */
  function metadataOnlyRow(): VolumeMetadata {
    return {
      volume_uuid: 'uuid-1',
      series_uuid: 'series-uuid',
      series_title: 'One Piece',
      volume_title: 'Vol 1',
      mokuro_version: '0.4.11',
      page_count: 2,
      character_count: 10,
      page_char_counts: [10],
      metadata_only: true
    } as VolumeMetadata;
  }

  it('refills the row in place instead of treating it as already installed', async () => {
    vi.mocked(volumesGet).mockResolvedValue(metadataOnlyRow());
    vi.mocked(processVolume).mockResolvedValue(processed());

    await processVolumeData(
      [],
      // The queued item is the metadata-only row itself, decorated with its cloud file.
      placeholder({ isPlaceholder: false, metadata_only: true, volume_uuid: 'uuid-1' }),
      123
    );

    // The pages arrive: saved onto the SAME uuid, and the row it is filling is never
    // deleted first — that row is the read history and the cover.
    expect(saveVolume).toHaveBeenCalledTimes(1);
    expect(deleteVolumeCompletely).not.toHaveBeenCalled();
  });
});

describe('the install trigger — a finished install schedules its series.json write', () => {
  it('schedules ONE write for the cloud FOLDER when the provider is writable and not server-compiled', async () => {
    // The user's bug: the measured page/char counts land in Dexie right here,
    // and before this trigger existed NOTHING scheduled a series.json write —
    // the published 0/0 no-metadata entries persisted indefinitely.
    hasWritableNonServerProvider.mockReturnValue(true);
    vi.mocked(processVolume).mockResolvedValue(processed());

    await processVolumeData([], placeholder(), 193_000_000);

    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(1);
    // The FOLDER title (the placeholder's series_title comes from the cloud
    // path), and no options: no fromCloudListing, no cloudMeasuredVolumes.
    expect(scheduleSeriesFileWrite).toHaveBeenCalledWith('One Piece');
  });

  it('a batch install of one series coalesces through the per-series debounce: N completions, N same-key schedules', async () => {
    // The write-side coalescing itself (N same-key schedules -> one PUT) is
    // series-file-sync's own debounce, pinned in its tests; this pins the
    // input shape: every completion schedules under the SAME folder key.
    hasWritableNonServerProvider.mockReturnValue(true);
    for (let i = 1; i <= 20; i++) {
      vi.mocked(processVolume).mockResolvedValue({
        ...processed(),
        metadata: { ...processed().metadata, volumeUuid: `uuid-${i}`, volume: `Vol ${i}` }
      });
      await processVolumeData(
        [],
        placeholder({ volume_uuid: `uuid-${i}`, volume_title: `Vol ${i}` }),
        1000
      );
    }

    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(20);
    for (const call of scheduleSeriesFileWrite.mock.calls) {
      expect(call).toEqual(['One Piece']);
    }
  });

  it('schedules even when the download kept the existing install — the volume is installed either way', async () => {
    hasWritableNonServerProvider.mockReturnValue(true);
    vi.mocked(processVolume).mockResolvedValue(processed());
    vi.mocked(volumesGet).mockResolvedValue({
      ...placeholder({ isPlaceholder: undefined, mokuro_version: '0.4.11' })
    } as VolumeMetadata);
    const { db } = await import('$lib/catalog/db');
    vi.mocked(db.volume_ocr.get).mockResolvedValue({ volume_uuid: 'uuid-1', pages: [] } as never);
    vi.mocked(db.volume_files.get).mockResolvedValue({ volume_uuid: 'uuid-1', files: {} } as never);

    await processVolumeData([], placeholder(), 193_000_000);

    expect(saveVolume).not.toHaveBeenCalled();
    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(1);
  });

  it('read-only and server-compiled providers schedule NOTHING — a browser without write rights never fires heal writes', async () => {
    hasWritableNonServerProvider.mockReturnValue(false);
    vi.mocked(processVolume).mockResolvedValue(processed());

    await processVolumeData([], placeholder(), 193_000_000);

    expect(saveVolume).toHaveBeenCalledTimes(1); // the install itself still happened
    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
  });
});
