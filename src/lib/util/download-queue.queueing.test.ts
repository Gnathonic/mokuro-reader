import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';

/**
 * What the queue accepts. The two absent states are both downloadable — a cloud-only
 * placeholder and a row whose files were removed from this device — and the only thing
 * the dedupe may drop is a volume the queue is already holding.
 *
 * Everything past the enqueue (the pool, the providers, the install) is stubbed; with no
 * active provider `processQueue` logs and returns, so nothing runs off the end of a test.
 */
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined), update: vi.fn(async () => 1) },
    volume_ocr: { get: vi.fn(async () => undefined) },
    volume_files: { get: vi.fn(async () => undefined) }
  }
}));
vi.mock('./upload', () => ({ requestPersistentStorage: vi.fn(async () => true) }));
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
  unifiedCloudManager: {
    getActiveProvider: () => null,
    getCloudVolume: vi.fn(),
    refreshCloudFiles: vi.fn()
  }
}));
vi.mock('$lib/import', () => ({
  processVolume: vi.fn(),
  saveVolume: vi.fn(),
  deleteVolumeCompletely: vi.fn(async () => {}),
  isSystemFile: () => false,
  isImageExtension: () => true,
  getImageMimeType: () => 'image/jpeg'
}));
vi.mock('$lib/catalog/stranded-rows', () => ({
  dropStrandedMetadataOnlyRow: vi.fn(async () => {})
}));

import { downloadQueue, queueVolume } from './download-queue';

function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    mokuro_version: '0.4.11',
    page_count: 10,
    character_count: 100,
    page_char_counts: [100],
    cloudProvider: 'webdav',
    cloudFileId: 'file-1',
    ...overrides
  } as VolumeMetadata;
}

/** How many queue entries carry this uuid. */
function queuedCount(volumeUuid: string): number {
  return get(downloadQueue).filter((item) => item.volumeUuid === volumeUuid).length;
}

describe('queueVolume', () => {
  it('accepts a row whose files were removed from this device', () => {
    queueVolume(
      volume({ volume_uuid: 'removed-1', cloudFileId: 'file-removed-1', metadata_only: true })
    );

    // The dedupe looks at the QUEUE, never at the local rows: a metadata-only row is a
    // volume waiting to be refilled, not a volume that is already here.
    expect(queuedCount('removed-1')).toBe(1);
  });

  it('accepts a cloud-only placeholder, as it always has', () => {
    queueVolume(
      volume({ volume_uuid: 'cloud-1', cloudFileId: 'file-cloud-1', isPlaceholder: true })
    );

    expect(queuedCount('cloud-1')).toBe(1);
  });

  it('drops a second copy of a volume already in the queue', () => {
    const removed = volume({
      volume_uuid: 'removed-2',
      cloudFileId: 'file-removed-2',
      metadata_only: true
    });
    queueVolume(removed);
    queueVolume(removed);
    // Same volume arriving under a different file id is still the same volume.
    queueVolume({ ...removed, cloudFileId: 'file-removed-2-copy' });

    expect(queuedCount('removed-2')).toBe(1);
  });

  it('drops a volume whose pages are already on this device', () => {
    queueVolume(volume({ volume_uuid: 'installed-1', cloudFileId: 'file-installed-1' }));

    expect(queuedCount('installed-1')).toBe(0);
  });

  it('drops a not-installed volume with nowhere to download from', () => {
    queueVolume(
      volume({
        volume_uuid: 'orphan-1',
        metadata_only: true,
        cloudFileId: undefined,
        cloudProvider: undefined
      })
    );

    expect(queuedCount('orphan-1')).toBe(0);
  });
});
