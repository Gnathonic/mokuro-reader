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
  markListingFresh,
  scheduleSeriesFileWrite,
  cancelScheduledSeriesFileWrite,
  getActiveProvider,
  capturedTasks,
  addTaskMock
} = vi.hoisted(() => {
  const calls: string[] = [];
  const capturedTasks: Array<Record<string, any>> = [];
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
    }),
    // The per-completion write this module now schedules on every upload
    // success — a stand-in, so tests can assert IT was called (and with
    // what) without exercising the real 2s debounce.
    scheduleSeriesFileWrite: vi.fn(),
    // The drain pass cancels whatever that schedule left pending before it
    // writes the same series itself.
    cancelScheduledSeriesFileWrite: vi.fn(),
    // A vi.fn() (not a plain arrow function) so individual tests can swap its
    // return value: most tests want the no-provider bail-out described
    // below, but the live-scheduling tests need a real provider to reach
    // `processBackup`'s upload-success path.
    getActiveProvider: vi.fn(() => null as unknown),
    capturedTasks,
    addTaskMock: vi.fn((task: Record<string, any>) => {
      capturedTasks.push(task);
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
    // no-provider path and stop — tests that need to reach the upload-success
    // path override this per-test.
    getActiveProvider
  }
}));

vi.mock('$lib/metadata/catalog-file-sync', () => ({ flushCatalogFileWrites }));
vi.mock('$lib/metadata/series-file-sync', () => ({
  markListingFresh,
  scheduleSeriesFileWrite,
  cancelScheduledSeriesFileWrite
}));

// Best-effort and DB-backed in the real module; irrelevant to the scheduling
// behavior under test here, so stubbed out rather than wired to a fake DB.
vi.mock('$lib/catalog/archive-size', () => ({ recordArchiveSize: vi.fn(async () => {}) }));

vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: { getCache: () => ({ add: vi.fn() }) }
}));

vi.mock('$lib/util/backup-ui', () => ({
  getBackupUiBridge: () => ({
    addProgress: vi.fn(),
    updateProgress: vi.fn(),
    removeProgress: vi.fn(),
    notify: vi.fn()
  })
}));

vi.mock('$lib/util/file-processing-pool', () => ({
  getFileProcessingPool: async () => ({ addTask: addTaskMock, maxConcurrentWorkers: 4 }),
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

  it('cancels each series’ pending live write before writing that series itself', async () => {
    // The live per-completion schedule (2 s debounce) and this drain pass both
    // target the same file. Left pending, the timer fires right after the drain
    // wrote the index directly: a second PUT of byte-identical content, which
    // moves the file's mtime and makes every other device re-download it — and
    // the two writes for one series are not serialized against each other.
    noteSeriesNeedingIndexWrite('One Piece');
    noteSeriesNeedingIndexWrite('Berserk');

    await finishBackupRun();

    expect(
      cancelScheduledSeriesFileWrite.mock.calls.map((args: unknown[]) => args[0]).sort()
    ).toEqual(['Berserk', 'One Piece']);
    // Cancelled BEFORE the direct write, not after: a timer that fires while the
    // write is in flight is exactly the unserialized race.
    expect(cancelScheduledSeriesFileWrite.mock.invocationCallOrder[0]).toBeLessThan(
      writeSeriesFile.mock.invocationCallOrder[0]
    );
  });

  it('waits for a live write that is already in flight before writing that series', async () => {
    // Cancelling only kills the TIMER. When the debounce has already fired — the
    // whole-account fetch above takes about that long — the live write is out on
    // its PUT, and starting the drain's own write for the same series then is two
    // concurrent writers on one file. The cancel hands back that write's promise,
    // and the drain has to await it.
    let release: (() => void) | undefined;
    cancelScheduledSeriesFileWrite.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = () => resolve();
      })
    );
    noteSeriesNeedingIndexWrite('One Piece');

    const run = finishBackupRun();
    await vi.waitFor(() => expect(cancelScheduledSeriesFileWrite).toHaveBeenCalled());
    expect(writeSeriesFile).not.toHaveBeenCalled();

    release!();
    await run;
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
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

  it('keeps the catalog pending when the listing fetch throws', async () => {
    // The run's series stay queued in `seriesNeedingIndexWrite` when the fetch
    // fails; the intent to publish the catalog has to survive the same way, or a
    // transient offline moment loses it for good.
    noteSeriesNeedingIndexWrite('One Piece');
    fetchAllCloudVolumes.mockRejectedValueOnce(new Error('offline'));

    await expect(finishBackupRun()).rejects.toThrow('offline');
    expect(flushCatalogFileWrites).not.toHaveBeenCalled();

    await finishBackupRun();

    expect(flushCatalogFileWrites).toHaveBeenCalledTimes(1);
    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
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

/**
 * The 2026-08-23 design amendment: every volume upload success now ALSO
 * schedules a debounced, per-series `series.json` write live — instead of a
 * bulk run's sidecars sitting unwritten until the whole queue drains. These
 * tests drive `processBackup` for real (through the worker pool's `onComplete`
 * contract) so the scheduling call is observed exactly where it happens, not
 * asserted against in isolation.
 */
describe('live per-completion series.json scheduling', () => {
  function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
    return {
      volume_uuid: 'live-write-uuid-1',
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
    calls.length = 0;
    capturedTasks.length = 0;
    vi.clearAllMocks();
    // Base default: a run cannot reach the upload-success path without an
    // active provider. Individual tests override this to the provider they
    // are exercising.
    getActiveProvider.mockReturnValue(null);
  });

  it('schedules a during-run debounced write when a worker-driven cloud upload completes, and the drain-time catch-all still runs for the same series', async () => {
    const provider = {
      type: 'webdav',
      uploadConcurrencyLimit: 2,
      supportsWorkerUpload: true
    } as never;
    getActiveProvider.mockReturnValue(provider);

    queueVolumeForBackup(volume(), provider, {
      includeSidecars: false,
      embedSidecarsInArchive: false
    });

    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    const task = capturedTasks[0];
    const releaseMemory = vi.fn();

    // The worker-driven cloud upload branch of `onComplete` — the fileId is
    // what a real worker reports back after a successful upload.
    await task.onComplete({ type: 'complete', fileId: 'remote-file-id', size: 123 }, releaseMemory);

    // Fires live, right where the upload succeeded — marked as during-run so
    // the writer skips its network reads (see `series-file-sync.ts`).
    expect(scheduleSeriesFileWrite).toHaveBeenCalledWith('One Piece', { duringBackupRun: true });
    // This was the only queued item, so the queue drained inside the SAME
    // `onComplete` call (awaited via its `finally`): the drain-time
    // catch-all (`writeSeriesIndexesForRun`, mocked as `unifiedCloudManager.
    // writeSeriesFile`) still runs too. Both writers targeting the same
    // series in one run is expected — `writeSeriesFile` is a cheap union,
    // not an error — so this only asserts it ran, not that it ran instead of
    // the live write.
    expect(calls).toContain('write:One Piece');
    expect(releaseMemory).toHaveBeenCalledTimes(1);
  });

  it('schedules a during-run debounced write when a main-thread (filesystem-style) upload completes', async () => {
    const provider = {
      type: 'filesystem',
      uploadConcurrencyLimit: 1,
      supportsWorkerUpload: false,
      uploadFile: vi.fn(async () => 'uploaded-file-id')
    } as never;
    getActiveProvider.mockReturnValue(provider);

    queueVolumeForBackup(
      volume({ volume_uuid: 'live-write-uuid-2', series_title: 'Berserk' }),
      provider,
      {
        includeSidecars: false,
        embedSidecarsInArchive: false
      }
    );

    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    const task = capturedTasks[0];
    const releaseMemory = vi.fn();

    // The main-thread-upload branch of `onComplete` (filesystem-style
    // providers): the worker only compresses, main-thread performs the
    // upload and reports the raw archive bytes back.
    await task.onComplete(
      { type: 'complete', data: new Uint8Array([1, 2, 3]), filename: 'Volume 1.cbz' },
      releaseMemory
    );

    expect(scheduleSeriesFileWrite).toHaveBeenCalledWith('Berserk', { duringBackupRun: true });
    expect(calls).toContain('write:Berserk');
  });
});
