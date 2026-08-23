import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The end of a backup run has to be strictly write-then-read: the listing
 * refresh feeds the `series.json` writes, and the index refresh reads those
 * writes back.
 */

const {
  calls,
  fetchAllCloudVolumes,
  writeSeriesFile,
  refreshSeriesIndexesInBackground,
  flushCatalogFileWrites,
  markListingFresh
} = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    fetchAllCloudVolumes: vi.fn(async (options?: { refreshIndexes?: boolean }) => {
      calls.push(`fetch:${options?.refreshIndexes === false ? 'no-index-refresh' : 'default'}`);
    }),
    writeSeriesFile: vi.fn(async (seriesTitle: string) => {
      // Stands in for the `putSeriesIndex` a successful write ends with.
      calls.push(`write:${seriesTitle}`);
      return 'written' as const;
    }),
    refreshSeriesIndexesInBackground: vi.fn(() => {
      calls.push('refresh');
    }),
    // The real module self-gates to a no-op without a provider, so the wiring
    // is only observable through a stand-in.
    flushCatalogFileWrites: vi.fn(async () => {
      calls.push('catalog');
    }),
    markListingFresh: vi.fn(() => {
      calls.push('stamp');
    })
  };
});

vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    fetchAllCloudVolumes,
    writeSeriesFile,
    refreshSeriesIndexesInBackground,
    getDefaultProvider: () => null,
    // Queueing a volume kicks off `processQueue` in the background. Without
    // this the drain throws asynchronously, which vitest reports as an
    // unhandled rejection and turns into a non-zero exit while every test
    // still "passes". Returning null makes the drain take its own
    // no-provider path and stop.
    getActiveProvider: () => null
  }
}));

vi.mock('$lib/metadata/catalog-file-sync', () => ({ flushCatalogFileWrites }));
vi.mock('$lib/metadata/series-file-sync', () => ({ markListingFresh }));

vi.mock('$lib/util/backup-ui', () => ({
  getBackupUiBridge: () => ({
    addProgress: vi.fn(),
    updateProgress: vi.fn(),
    removeProgress: vi.fn(),
    notify: vi.fn()
  })
}));

vi.mock('$lib/util/file-processing-pool', () => ({
  getFileProcessingPool: async () => ({ addTask: vi.fn() }),
  incrementPoolUsers: vi.fn(),
  decrementPoolUsers: vi.fn()
}));

vi.mock('$lib/util/volume-sidecars', () => ({ downloadFileBlob: vi.fn() }));

import type { VolumeMetadata } from '$lib/types';
import {
  backupQueue,
  finishBackupRun,
  noteSeriesNeedingIndexWrite,
  queueVolumeForBackup,
  queueVolumeForExport
} from './backup-queue';

describe('finishBackupRun', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
  });

  it('lists, writes the run’s indexes and the catalog, and only then refreshes', async () => {
    noteSeriesNeedingIndexWrite('One Piece');
    noteSeriesNeedingIndexWrite('Berserk');

    await finishBackupRun();

    // The listing must not start the index refresh itself: it would race the
    // writes below and could cache the pre-upload copy of a file we just wrote.
    expect(calls[0]).toBe('fetch:no-index-refresh');
    // That fetch IS the whole-account listing the metadata writers need, so it
    // is stamped as fresh — otherwise every run pays for a second one.
    expect(calls[1]).toBe('stamp');
    expect(calls.slice(2, 4).sort()).toEqual(['write:Berserk', 'write:One Piece']);
    // The catalog lists series FOLDERS, so it goes once per run and only after
    // the per-series files this run published…
    expect(calls[4]).toBe('catalog');
    // …and strictly before the read-back, which the whole ordering exists for.
    expect(calls[5]).toBe('refresh');
    expect(calls).toHaveLength(6);
  });

  it('writes no catalog for a run that uploaded nothing (export-to-disk drains)', async () => {
    // `finishBackupRun` also ends export-to-disk drains. Those touch no cloud
    // file at all, and must not end in a catalog.json UPLOAD.
    await finishBackupRun();

    expect(calls).not.toContain('catalog');
    expect(flushCatalogFileWrites).not.toHaveBeenCalled();
    // The read side still runs: the listing is worth refreshing either way.
    expect(calls).toEqual(['fetch:no-index-refresh', 'stamp', 'refresh']);
  });

  it('forgets the upload for the next run, so a later local drain stays local', async () => {
    noteSeriesNeedingIndexWrite('One Piece');
    await finishBackupRun();
    expect(flushCatalogFileWrites).toHaveBeenCalledTimes(1);

    await finishBackupRun();

    expect(flushCatalogFileWrites).toHaveBeenCalledTimes(1);
  });

  it('drains the run so the next one does not rewrite the same indexes', async () => {
    noteSeriesNeedingIndexWrite('One Piece');
    await finishBackupRun();
    writeSeriesFile.mockClear();

    await finishBackupRun();

    expect(writeSeriesFile).not.toHaveBeenCalled();
    expect(refreshSeriesIndexesInBackground).toHaveBeenCalledTimes(2);
  });

  it('still refreshes when an index write fails', async () => {
    writeSeriesFile.mockRejectedValueOnce(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteSeriesNeedingIndexWrite('One Piece');

    await finishBackupRun();

    expect(refreshSeriesIndexesInBackground).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('queueing a volume that is not installed', () => {
  function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
    return {
      volume_uuid: 'uuid-1',
      series_uuid: 'series-1',
      series_title: 'One Piece',
      volume_title: 'Volume 1',
      mokuro_version: '0.4.11',
      page_count: 200,
      character_count: 5000,
      page_char_counts: [],
      ...overrides
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A real provider, so the only thing that can reject the volume is its state.
  const provider = { type: 'webdav', uploadConcurrencyLimit: 2 } as never;

  it('does not back up a metadata-only volume — there are no pages to upload', () => {
    queueVolumeForBackup(volume({ metadata_only: true }), provider);

    expect(backupQueue.isVolumeInBackupQueue('uuid-1')).toBe(false);
  });

  it('does not back up a cloud placeholder either', () => {
    queueVolumeForBackup(volume({ isPlaceholder: true }), provider);

    expect(backupQueue.isVolumeInBackupQueue('uuid-1')).toBe(false);
  });

  it('does back up an installed volume (the guard is about state, not the provider)', () => {
    queueVolumeForBackup(volume({ volume_uuid: 'installed-uuid' }), provider);

    expect(backupQueue.isVolumeInBackupQueue('installed-uuid')).toBe(true);
  });

  it('does not export a metadata-only volume', () => {
    queueVolumeForExport(volume({ metadata_only: true }), 'One Piece - Volume 1.cbz');

    expect(backupQueue.isVolumeInBackupQueue('uuid-1')).toBe(false);
  });
});
