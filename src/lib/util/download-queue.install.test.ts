import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

/**
 * The install step of a download: what lands on the row once the archive is
 * here. Everything around it — the worker pool, the providers, the queue — is
 * plumbing and is stubbed.
 */
const { volumesGet, volumesUpdate, saveVolume, processVolume } = vi.hoisted(() => ({
  volumesGet: vi.fn(async () => undefined as VolumeMetadata | undefined),
  volumesUpdate: vi.fn(async () => 1),
  saveVolume: vi.fn(async () => {}),
  processVolume: vi.fn()
}));

vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: volumesGet, update: volumesUpdate },
    volume_ocr: { get: vi.fn(async () => undefined) },
    volume_files: { get: vi.fn(async () => undefined) }
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
  deleteVolumeCompletely: vi.fn(async () => {}),
  isSystemFile: () => false,
  isImageExtension: () => true,
  getImageMimeType: () => 'image/jpeg'
}));
vi.mock('$lib/catalog/stranded-rows', () => ({
  dropStrandedMetadataOnlyRow: vi.fn(async () => {})
}));

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

afterEach(() => {
  vi.mocked(volumesUpdate).mockClear();
  vi.mocked(volumesGet).mockReset();
  vi.mocked(volumesGet).mockResolvedValue(undefined);
  vi.mocked(saveVolume).mockClear();
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
