import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

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
  resolveCloudFolderTitle,
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
    resolveCloudFolderTitle: vi.fn((title: string) => title),
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
    // Identity, as the real one is for a series the cloud does not hold.
    resolveCloudFolderTitle: (title: string) => resolveCloudFolderTitle(title),
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

const bridge = vi.hoisted(() => ({
  addProgress: vi.fn(),
  updateProgress: vi.fn(),
  removeProgress: vi.fn(),
  notify: vi.fn(),
  notifyError: vi.fn()
}));
vi.mock('$lib/util/backup-ui', () => ({ getBackupUiBridge: () => bridge }));
const { recordUploadFailure, clearUploadFailure } = vi.hoisted(() => ({
  recordUploadFailure: vi.fn(),
  clearUploadFailure: vi.fn()
}));
vi.mock('$lib/util/upload-failures', () => ({ recordUploadFailure, clearUploadFailure }));

// Stands in for `WorkerPool.cancelTasks`: rejects the captured tasks it
// matches as cancelled, the way the real pool does.
const cancelPoolTasks = vi.hoisted(() =>
  vi.fn((matches: (task: Record<string, any>) => boolean, reason?: string) => {
    let count = 0;
    for (const task of capturedTasks.splice(0)) {
      if (!matches(task)) {
        capturedTasks.push(task);
        continue;
      }
      count++;
      void task.onError?.({ type: 'error', fileId: task.id, error: reason, kind: 'cancelled' });
    }
    return count;
  })
);
const decrementPoolUsers = vi.hoisted(() => vi.fn());
vi.mock('$lib/util/file-processing-pool', () => ({
  getFileProcessingPool: async () => ({ addTask: addTaskMock, maxConcurrentWorkers: 4 }),
  incrementPoolUsers: vi.fn(),
  decrementPoolUsers,
  cancelPoolTasks
}));

vi.mock('$lib/util/volume-sidecars', () => ({ downloadFileBlob: vi.fn() }));
// Only `prepareData` for a worker-driven upload reaches this; the real one
// talks to the provider.
vi.mock('$lib/util/upload-worker-credentials', () => ({
  getUploadWorkerCredentials: vi.fn(async () => ({})),
  prepareSeriesUploadTarget: vi.fn(async () => {})
}));
const stampLayersSynced = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/metadata/layer-sync', () => ({ stampLayersSynced }));
const uploadRecord = vi.hoisted(() => ({
  recordUploadedPrimarySidecar: vi.fn(async () => {}),
  recordUploadedPrimarySidecarBlob: vi.fn(async () => {})
}));
vi.mock('$lib/catalog/mokuro-upload-record', () => uploadRecord);
const watchUploadedVolume = vi.hoisted(() => vi.fn(async () => {}));
const watchCloudUpload = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/catalog/server-ocr-queue', () => ({ watchUploadedVolume, watchCloudUpload }));

import type { VolumeMetadata } from '$lib/types';
import { downloadFileBlob } from './volume-sidecars';
import { cancelProviderUploads } from './sync/upload-cancellation';
import {
  backupQueue,
  backupQueueSettled,
  cancelBackupsForProvider,
  finishBackupRun,
  noteSeriesNeedingIndexWrite,
  queueVolumeForBackup,
  queueVolumeForExport,
  type SidecarOptions
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

  it('skips quietly, with ONE notice, for an account that cannot add files (bunko registered)', () => {
    const progressOnly = {
      type: 'webdav',
      uploadConcurrencyLimit: 2,
      getStatus: () => ({ isReadOnly: false, canAddFiles: false })
    } as never;
    queueVolumeForBackup(volume({ volume_uuid: 'no-add-uuid' }), progressOnly);
    expect(backupQueue.isVolumeInBackupQueue('no-add-uuid')).toBe(false);
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(bridge.notify).toHaveBeenCalledWith("This account can't add files on this server");

    bridge.notify.mockClear();
    backupQueue.queueSeriesVolumesForBackup(
      [volume({ volume_uuid: 'a' }), volume({ volume_uuid: 'b', volume_title: 'Volume 2' })],
      progressOnly
    );
    expect(backupQueue.isVolumeInBackupQueue('a')).toBe(false);
    expect(backupQueue.isVolumeInBackupQueue('b')).toBe(false);
    expect(bridge.notify).toHaveBeenCalledTimes(1);
  });

  it("queues into the cloud's spelling of the series folder", () => {
    // A server that merged `one piece/` into `One Piece/`: uploading under the
    // local spelling would re-create the folder it just merged away.
    resolveCloudFolderTitle.mockImplementation((title: string) =>
      title === 'one piece' ? 'One Piece' : title
    );
    let items: Array<{ volumeUuid: string; seriesTitle: string }> = [];
    const unsubscribe = backupQueue.subscribe((q) => (items = q));

    queueVolumeForBackup(
      volume({ volume_uuid: 'spelled-uuid', series_title: 'one piece' }),
      provider
    );

    expect(items.find((item) => item.volumeUuid === 'spelled-uuid')?.seriesTitle).toBe('One Piece');
    unsubscribe();
    resolveCloudFolderTitle.mockImplementation((title: string) => title);
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

describe('backupQueueSettled', () => {
  const provider = {
    type: 'webdav',
    uploadConcurrencyLimit: 2,
    supportsWorkerUpload: true
  } as never;

  beforeEach(() => {
    calls.length = 0;
    capturedTasks.length = 0;
    vi.clearAllMocks();
    getActiveProvider.mockReturnValue(provider);
  });

  it('resolves at once when nothing is queued or running', async () => {
    await expect(backupQueueSettled()).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('waits for the queued upload AND the end of its run (listing, series.json, catalog.json)', async () => {
    queueVolumeForBackup(
      {
        volume_uuid: 'settle-uuid',
        series_uuid: 'series-1',
        series_title: 'One Piece',
        volume_title: 'Volume 3',
        mokuro_version: '',
        page_count: 2,
        character_count: 0,
        page_char_counts: []
      },
      provider,
      { includeSidecars: false, embedSidecarsInArchive: false }
    );
    let settled = false;
    const settling = backupQueueSettled().then(() => (settled = true));
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    // The run's listing hangs: the queue is empty once the upload is done, but
    // the run's metadata writes have not happened yet.
    let release: (() => void) | undefined;
    fetchAllCloudVolumes.mockImplementationOnce(async (options?: { refreshIndexes?: boolean }) => {
      calls.push(`fetch:${options?.refreshIndexes === false ? 'no-index-refresh' : 'default'}`);
      await new Promise<void>((resolve) => (release = resolve));
    });
    const done = capturedTasks[0].onComplete(
      { type: 'complete', fileId: 'remote-file-id', size: 123 },
      vi.fn()
    );
    await vi.waitFor(() => expect(calls).toContain('fetch:no-index-refresh'));
    expect(backupQueue.isVolumeInBackupQueue('settle-uuid')).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(settled).toBe(false);

    release!();
    await done;
    await settling;
    expect(calls).toEqual(expect.arrayContaining(['write:One Piece', 'catalog', 'refresh']));
  });
});

/*
 * Export-for-download with "embed sidecars in archive" ON used to download the
 * .mokuro and cover as separate files as well — the archive already carried
 * them, so the user got three downloads for one volume. The worker still
 * generates the sidecars (the same branch serves the Local Folder provider's
 * main-thread upload, which wants them beside the archive); the export branch
 * of `onComplete` is where they must not be downloaded.
 *
 * That only holds for the layer files because the export message asks the
 * worker to embed them too (`embedLayerFiles`, below): skipping their download
 * while the archive lacked them dropped the layers from the export entirely.
 */
describe('export-for-download sidecars', () => {
  function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
    return {
      volume_uuid: 'export-uuid-1',
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

  const originalCreate = globalThis.URL.createObjectURL;
  const originalRevoke = globalThis.URL.revokeObjectURL;

  beforeEach(() => {
    capturedTasks.length = 0;
    vi.clearAllMocks();
    getActiveProvider.mockReturnValue(null);
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:archive');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.URL.createObjectURL = originalCreate;
    globalThis.URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  const sidecars = {
    mokuro: { filename: 'One Piece - Volume 1.mokuro', blob: new Blob(['{}']) },
    thumbnail: { filename: 'One Piece - Volume 1.webp', blob: new Blob(['img']) },
    layers: [
      {
        layerId: 'gcv',
        filename: 'One Piece - Volume 1.gcv.mokuro',
        blob: new Blob(['{}']),
        updatedAt: '2026-09-16T09:00:00.000Z'
      }
    ]
  };

  async function completeExport(uuid: string, embedSidecarsInArchive: boolean) {
    queueVolumeForExport(volume({ volume_uuid: uuid }), 'One Piece - Volume 1.cbz', 'cbz', {
      includeSidecars: true,
      embedSidecarsInArchive
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    await capturedTasks[0].onComplete(
      {
        type: 'complete',
        data: new Uint8Array([1, 2, 3]),
        filename: 'One Piece - Volume 1.cbz',
        sidecars
      },
      vi.fn()
    );
  }

  it('downloads no separate sidecars when they are embedded in the archive', async () => {
    // Right for the layer files as well only because the archive really does
    // carry them: see the `embedLayerFiles` tests below.
    await completeExport('export-uuid-embed', true);
    expect(downloadFileBlob).not.toHaveBeenCalled();
  });

  describe('embedLayerFiles on the worker message', () => {
    async function exportMessage(uuid: string, options: SidecarOptions) {
      queueVolumeForExport(
        volume({ volume_uuid: uuid }),
        'One Piece - Volume 1.cbz',
        'cbz',
        options
      );
      await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
      return capturedTasks[0].prepareData();
    }

    async function backupMessage(uuid: string, provider: Record<string, unknown>) {
      getActiveProvider.mockReturnValue(provider as never);
      queueVolumeForBackup(volume({ volume_uuid: uuid }), provider as never, {
        includeSidecars: true,
        embedSidecarsInArchive: true
      });
      await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
      return capturedTasks[0].prepareData();
    }

    it('asks for embedded layers when an export embeds its sidecars', async () => {
      const message = await exportMessage('embed-flag-on', {
        includeSidecars: true,
        embedSidecarsInArchive: true
      });
      expect(message.provider).toBeNull();
      expect(message.embedLayerFiles).toBe(true);
    });

    it('does not when the export downloads its sidecars separately', async () => {
      const message = await exportMessage('embed-flag-separate', {
        includeSidecars: true,
        embedSidecarsInArchive: false
      });
      expect(message.embedLayerFiles).toBe(false);
    });

    it('does not when the export carries no sidecars at all', async () => {
      const message = await exportMessage('embed-flag-none', {
        includeSidecars: false,
        embedSidecarsInArchive: true
      });
      expect(message.embedLayerFiles).toBe(false);
    });

    // Cloud layers are separate files, stamped and refreshed one by one; an
    // archive-local copy would be a second, stale source of truth.
    it('never for a main-thread cloud upload, which shares the null-provider branch', async () => {
      const message = await backupMessage('embed-flag-filesystem', {
        type: 'filesystem',
        uploadConcurrencyLimit: 1,
        supportsWorkerUpload: false,
        uploadFile: vi.fn()
      });
      expect(message.provider).toBeNull();
      expect(message.embedLayerFiles).toBe(false);
    });

    it('never for a worker-driven cloud upload', async () => {
      const message = await backupMessage('embed-flag-webdav', {
        type: 'webdav',
        uploadConcurrencyLimit: 2,
        supportsWorkerUpload: true
      });
      expect(message.provider).toBe('webdav');
      expect(message).not.toHaveProperty('embedLayerFiles');
    });

    it('tells the worker when the server compiles its metadata (the original snapshot stays local)', async () => {
      const message = await backupMessage('server-compiled-webdav', {
        type: 'webdav',
        uploadConcurrencyLimit: 2,
        supportsWorkerUpload: true,
        getStatus: () => ({ isReadOnly: false, serverCompilesMetadata: true })
      });
      expect(message.serverCompilesMetadata).toBe(true);
    });

    it('passes the edit-layer gate, so a 0.7.x bunko gets no edit layer file', async () => {
      const message = await backupMessage('edit-local-webdav', {
        type: 'webdav',
        uploadConcurrencyLimit: 2,
        supportsWorkerUpload: true,
        getStatus: () => ({
          isReadOnly: false,
          serverCompilesMetadata: true,
          editLayerSync: 'local'
        })
      });
      expect(message.editLayerSync).toBe('local');
    });

    it('asks the identity again first, so a bunko rolled back to 0.7.x gets no edit layer', async () => {
      let editLayerSync: 'push' | 'local' = 'push';
      const refreshIdentity = vi.fn(async () => {
        editLayerSync = 'local';
      });
      const message = await backupMessage('edit-rollback-webdav', {
        type: 'webdav',
        uploadConcurrencyLimit: 2,
        supportsWorkerUpload: true,
        refreshIdentity,
        getStatus: () => ({
          isReadOnly: false,
          serverCompilesMetadata: true,
          editLayerSync,
          accountScope: 'webdav:https://host|alice'
        })
      });
      expect(refreshIdentity).toHaveBeenCalledWith({ maxAgeMs: 5 * 60_000 });
      expect(message.editLayerSync).toBe('local');
    });

    it('…and not for plain storage', async () => {
      const message = await backupMessage('plain-webdav', {
        type: 'webdav',
        uploadConcurrencyLimit: 2,
        supportsWorkerUpload: true,
        getStatus: () => ({ isReadOnly: false })
      });
      expect(message.serverCompilesMetadata).toBe(false);
    });
  });

  it('downloads the sidecars AND the layer files, named after the archive, when not embedded', async () => {
    await completeExport('export-uuid-separate', false);
    expect(downloadFileBlob).toHaveBeenCalledTimes(3);
    const names = vi.mocked(downloadFileBlob).mock.calls.map(([file]) => (file as File).name);
    expect(names).toEqual([
      'One Piece - Volume 1.mokuro',
      'One Piece - Volume 1.webp',
      'One Piece - Volume 1.gcv.mokuro'
    ]);
  });

  it('a main-thread upload writes the layer files beside the archive and stamps the rows', async () => {
    const uploadFile = vi.fn(async (_path: string, _blob: Blob) => 'uploaded-file-id');
    const provider = {
      type: 'filesystem',
      uploadConcurrencyLimit: 1,
      supportsWorkerUpload: false,
      uploadFile
    } as never;
    getActiveProvider.mockReturnValue(provider);
    queueVolumeForBackup(volume({ volume_uuid: 'layers-upload-uuid' }), provider, {
      includeSidecars: true,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    await capturedTasks[0].onComplete(
      { type: 'complete', data: new Uint8Array([1, 2, 3]), filename: 'Volume 1.cbz', sidecars },
      vi.fn()
    );
    const paths = uploadFile.mock.calls.map(([path]) => path);
    // The primary sidecar's exact bytes are what the volume's hash now names.
    expect(uploadRecord.recordUploadedPrimarySidecarBlob).toHaveBeenCalledWith(
      'layers-upload-uuid',
      'filesystem',
      sidecars.mokuro.blob,
      'uploaded-file-id'
    );
    expect(paths).toEqual([
      'One Piece/One Piece - Volume 1.mokuro',
      'One Piece/One Piece - Volume 1.gcv.mokuro',
      'One Piece/One Piece - Volume 1.webp',
      'One Piece/Volume 1.cbz'
    ]);
    // The stamp is handed what was SERIALIZED (id, the row's updated_at at
    // that moment, the uploaded byte count) — never left to re-read the row,
    // which may have been edited while the upload ran.
    expect(stampLayersSynced).toHaveBeenCalledWith(
      'layers-upload-uuid',
      'filesystem',
      [{ layerId: 'gcv', updatedAt: '2026-09-16T09:00:00.000Z', size: 2 }],
      undefined
    );
  });

  it('a main-thread upload sends the edit layer after its archive; a refusal is not stamped', async () => {
    const uploadFile = vi.fn(async (path: string, _blob: Blob) => {
      if (path.endsWith('.edit.mokuro')) throw new Error('409 no-volume');
      return 'uploaded-file-id';
    });
    const provider = {
      type: 'filesystem',
      uploadConcurrencyLimit: 1,
      supportsWorkerUpload: false,
      uploadFile
    } as never;
    getActiveProvider.mockReturnValue(provider);
    queueVolumeForBackup(volume({ volume_uuid: 'edit-upload-uuid' }), provider, {
      includeSidecars: true,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    const edit = {
      layerId: 'edit',
      filename: 'One Piece - Volume 1.edit.mokuro',
      blob: new Blob(['{}']),
      updatedAt: '2026-09-16T09:00:00.000Z'
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await capturedTasks[0].onComplete(
      {
        type: 'complete',
        data: new Uint8Array([1, 2, 3]),
        filename: 'Volume 1.cbz',
        sidecars: { ...sidecars, layers: [edit, ...sidecars.layers] }
      },
      vi.fn()
    );
    warn.mockRestore();
    expect(uploadFile.mock.calls.map(([path]) => path)).toEqual([
      'One Piece/One Piece - Volume 1.mokuro',
      'One Piece/One Piece - Volume 1.gcv.mokuro',
      'One Piece/One Piece - Volume 1.webp',
      'One Piece/Volume 1.cbz',
      'One Piece/One Piece - Volume 1.edit.mokuro'
    ]);
    expect(stampLayersSynced).toHaveBeenCalledWith(
      'edit-upload-uuid',
      'filesystem',
      [{ layerId: 'gcv', updatedAt: '2026-09-16T09:00:00.000Z', size: 2 }],
      undefined
    );
    expect(bridge.notify).toHaveBeenCalledWith('Backed up Volume 1 successfully');
  });

  it('a worker-driven upload stamps from the snapshot the worker sends back', async () => {
    const provider = {
      type: 'webdav',
      uploadConcurrencyLimit: 2,
      supportsWorkerUpload: true,
      // The account a personal layer's file belongs to (bunko keeps one per account).
      getStatus: () => ({
        isReadOnly: false,
        serverCompilesMetadata: true,
        editLayerSync: 'push',
        accountScope: 'webdav:https://host|alice'
      })
    } as never;
    getActiveProvider.mockReturnValue(provider);
    queueVolumeForBackup(volume({ volume_uuid: 'layers-worker-uuid' }), provider, {
      includeSidecars: true,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    const layerSnapshots = [{ layerId: 'gcv', updatedAt: '2026-09-16T09:00:00.000Z', size: 41 }];
    await capturedTasks[0].onComplete(
      { type: 'complete', fileId: 'remote-file-id', size: 123, layerSnapshots },
      vi.fn()
    );
    expect(stampLayersSynced).toHaveBeenCalledWith(
      'layers-worker-uuid',
      'webdav',
      layerSnapshots,
      'webdav:https://host|alice'
    );
  });

  // Drive's scope is `default` until its reader folder resolves, then the
  // folder's id: a stamp would read as another account's within one account.
  it('a backup to plain storage stamps no account on its layers', async () => {
    const provider = {
      type: 'google-drive',
      uploadConcurrencyLimit: 2,
      supportsWorkerUpload: true,
      getStatus: () => ({ isReadOnly: false, accountScope: 'google-drive:default' })
    } as never;
    getActiveProvider.mockReturnValue(provider);
    queueVolumeForBackup(volume({ volume_uuid: 'layers-drive-uuid' }), provider, {
      includeSidecars: true,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    const message = await capturedTasks[0].prepareData();
    expect(message.accountScope).toBeUndefined();
    const layerSnapshots = [{ layerId: 'edit', updatedAt: '2026-09-16T09:00:00.000Z', size: 41 }];
    await capturedTasks[0].onComplete(
      { type: 'complete', fileId: 'remote-file-id', size: 123, layerSnapshots },
      vi.fn()
    );
    expect(stampLayersSynced).toHaveBeenCalledWith(
      'layers-drive-uuid',
      'google-drive',
      layerSnapshots,
      undefined
    );
  });

  // The primary `.mokuro` the worker uploaded: its hash becomes the volume's,
  // vouched for on this provider (what lets series.json publish it).
  it('a worker-driven upload records the hash of the primary sidecar it sent', async () => {
    const provider = {
      type: 'webdav',
      uploadConcurrencyLimit: 2,
      supportsWorkerUpload: true
    } as never;
    getActiveProvider.mockReturnValue(provider);
    queueVolumeForBackup(volume({ volume_uuid: 'hash-worker-uuid' }), provider, {
      includeSidecars: true,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    const mokuroSidecar = {
      sha256: 'a'.repeat(64),
      size: 321,
      modifiedTime: '2026-09-30T10:00:00.000Z'
    };
    await capturedTasks[0].onComplete(
      { type: 'complete', fileId: 'remote-file-id', size: 123, mokuroSidecar },
      vi.fn()
    );
    expect(uploadRecord.recordUploadedPrimarySidecar).toHaveBeenCalledWith('hash-worker-uuid', {
      provider: 'webdav',
      ...mokuroSidecar
    });
  });

  it('watches the volume on the server’s OCR queue when the server queued the upload', async () => {
    const provider = {
      type: 'webdav',
      uploadConcurrencyLimit: 2,
      supportsWorkerUpload: true
    } as never;
    getActiveProvider.mockReturnValue(provider);
    queueVolumeForBackup(volume({ volume_uuid: 'ocr-queued-uuid' }), provider, {
      includeSidecars: false,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    await capturedTasks[0].onComplete(
      {
        type: 'complete',
        fileId: 'remote-file-id',
        size: 123,
        serverOcr: { manifestUrl: 'https://bunko.example/m?v=1', recheckAfter: 95 }
      },
      vi.fn()
    );
    // Under its SERVER-side names, as the queue file spells them.
    expect(watchUploadedVolume).toHaveBeenCalledWith({
      volumeUuid: 'ocr-queued-uuid',
      series: 'One Piece',
      volume: 'Volume 1',
      manifestUrl: 'https://bunko.example/m?v=1'
    });
  });

  it('remembers nothing for an upload the server did not queue', async () => {
    const provider = {
      type: 'webdav',
      uploadConcurrencyLimit: 2,
      supportsWorkerUpload: true
    } as never;
    getActiveProvider.mockReturnValue(provider);
    queueVolumeForBackup(volume({ volume_uuid: 'plain-dav-uuid' }), provider, {
      includeSidecars: false,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    await capturedTasks[0].onComplete({ type: 'complete', fileId: 'id', size: 1 }, vi.fn());
    expect(watchUploadedVolume).not.toHaveBeenCalled();
  });

  it('offers a cloud upload to the cloud Bunko queue (which watches only while a marker is fresh)', async () => {
    const provider = {
      type: 'google-drive',
      uploadConcurrencyLimit: 2,
      supportsWorkerUpload: true
    } as never;
    getActiveProvider.mockReturnValue(provider);
    queueVolumeForBackup(volume({ volume_uuid: 'cloud-uuid' }), provider, {
      includeSidecars: false,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    await capturedTasks[0].onComplete({ type: 'complete', fileId: 'id', size: 1 }, vi.fn());
    expect(watchUploadedVolume).not.toHaveBeenCalled();
    expect(watchCloudUpload).toHaveBeenCalledWith({
      volumeUuid: 'cloud-uuid',
      series: 'One Piece',
      volume: 'Volume 1'
    });
  });
});

describe('a failed upload is never silent (Addendum B)', () => {
  function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
    return {
      volume_uuid: 'failing-uuid',
      series_uuid: 'series-1',
      series_title: 'One Piece',
      volume_title: 'Volume 9',
      mokuro_version: '0.4.11',
      page_count: 200,
      character_count: 5000,
      page_char_counts: [],
      ...overrides
    };
  }
  const provider = {
    type: 'webdav',
    uploadConcurrencyLimit: 2,
    supportsWorkerUpload: true
  } as never;

  beforeEach(() => {
    capturedTasks.length = 0;
    vi.clearAllMocks();
    getActiveProvider.mockReturnValue(provider);
  });

  async function queued(uuid: string) {
    queueVolumeForBackup(volume({ volume_uuid: uuid }), provider, {
      includeSidecars: false,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    return capturedTasks[0];
  }

  it('records a persistent per-volume failure with the server reason, and raises an error notice', async () => {
    const task = await queued('failing-uuid');
    await task.onError({
      type: 'error',
      error: 'WebDAV upload failed: 422 Unprocessable Entity (archive-damaged: bad CRC)',
      detail: 'bad CRC'
    });
    expect(recordUploadFailure).toHaveBeenCalledWith({
      volume_uuid: 'failing-uuid',
      volume_title: 'Volume 9',
      series_title: 'One Piece',
      provider: 'webdav',
      reason: 'bad CRC'
    });
    expect(bridge.notifyError).toHaveBeenCalledWith('Upload failed: Volume 9 — bad CRC');
    expect(bridge.updateProgress).toHaveBeenCalledWith(
      'backup-failing-uuid',
      'Upload failed: bad CRC',
      0
    );
  });

  it('says the LOCAL copy is damaged when the server says the bytes arrived intact but bad', async () => {
    const task = await queued('damaged-uuid');
    const detail =
      'The copy of this volume on this device is damaged; re-import the volume, then upload it again. (Server: digest matched; 003.jpg fails its CRC)';
    await task.onError({
      type: 'error',
      error: 'WebDAV upload failed: 422 (archive-damaged: digest matched; 003.jpg fails its CRC)',
      detail
    });
    expect(recordUploadFailure).toHaveBeenCalledWith(expect.objectContaining({ reason: detail }));
    expect(bridge.notifyError).toHaveBeenCalledWith(`Upload failed: Volume 9 — ${detail}`);
  });

  it('falls back to the error message when the worker gave no detail', async () => {
    const task = await queued('failing-uuid-2');
    await task.onError({ type: 'error', error: 'Network error during WebDAV upload' });
    expect(recordUploadFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Network error during WebDAV upload' })
    );
  });

  describe('a full account, which the worker can only name by kind or by message', () => {
    const DRIVE_FULL = 'Google Drive storage is full — free up space or upgrade your plan';

    async function queuedOn(type: string, uuid: string) {
      const cloud = { type, uploadConcurrencyLimit: 2, supportsWorkerUpload: true } as never;
      getActiveProvider.mockReturnValue(cloud);
      queueVolumeForBackup(volume({ volume_uuid: uuid }), cloud, {
        includeSidecars: false,
        embedSidecarsInArchive: false
      });
      await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
      return capturedTasks[0];
    }

    it("shows the provider's storage-full wording when the worker says kind quota", async () => {
      const task = await queuedOn('google-drive', 'full-uuid');
      await task.onError({
        type: 'error',
        error: 'Upload init failed: 403 Forbidden [storageQuotaExceeded]',
        kind: 'quota'
      });
      expect(recordUploadFailure).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'google-drive', reason: DRIVE_FULL })
      );
      expect(bridge.notifyError).toHaveBeenCalledWith(`Upload failed: Volume 9 — ${DRIVE_FULL}`);
      expect(bridge.updateProgress).toHaveBeenCalledWith(
        'backup-full-uuid',
        `Upload failed: ${DRIVE_FULL}`,
        0
      );
    });

    it('still recognises a full Drive from the bracketed reason alone (no kind)', async () => {
      const task = await queuedOn('google-drive', 'full-uuid-2');
      await task.onError({
        type: 'error',
        error: 'Upload init failed: 403 Forbidden [storageQuotaExceeded]'
      });
      expect(recordUploadFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: DRIVE_FULL })
      );
    });

    it('a 429 naming storageQuotaExceeded is a rate limit the worker gave up on, not a full account', async () => {
      const task = await queuedOn('google-drive', 'busy-uuid');
      const error = 'Upload init failed: 429 Too Many Requests [storageQuotaExceeded]';
      await task.onError({ type: 'error', error });
      expect(recordUploadFailure).toHaveBeenCalledWith(expect.objectContaining({ reason: error }));
    });

    it('names OneDrive for a full OneDrive', async () => {
      const task = await queuedOn('onedrive', 'od-full-uuid');
      await task.onError({
        type: 'error',
        error: 'OneDrive storage full (507 insufficientStorage)',
        kind: 'quota'
      });
      expect(recordUploadFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'OneDrive storage is full — free up space or upgrade your plan'
        })
      );
    });
  });

  it('clears the failure once the volume uploads', async () => {
    const task = await queued('recovered-uuid');
    await task.onComplete({ type: 'complete', fileId: 'id', size: 1 }, vi.fn());
    expect(clearUploadFailure).toHaveBeenCalledWith('recovered-uuid');
    expect(recordUploadFailure).not.toHaveBeenCalled();
  });

  it('says it is retrying, and why, while the worker backs off', async () => {
    const task = await queued('retrying-uuid');
    task.onProgress({
      type: 'progress',
      phase: 'retrying',
      progress: 0,
      retry: { attempt: 2, attempts: 4, delayMs: 5_000, reason: 'busy' }
    });
    expect(bridge.updateProgress).toHaveBeenCalledWith(
      'backup-retrying-uuid',
      'Upload failed (busy) — retrying in 5 s (attempt 2 of 4)...',
      0
    );
  });

  it('tells the provider when a worker PUT response says the server stages and verifies', async () => {
    const notePutVerified = vi.fn();
    const staged = {
      type: 'webdav',
      uploadConcurrencyLimit: 2,
      supportsWorkerUpload: true,
      notePutVerified
    } as never;
    getActiveProvider.mockReturnValue(staged);
    queueVolumeForBackup(volume({ volume_uuid: 'staged-uuid' }), staged, {
      includeSidecars: false,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    await capturedTasks[0].onComplete(
      { type: 'complete', fileId: 'id', size: 1, serverPutVerified: true },
      vi.fn()
    );
    expect(notePutVerified).toHaveBeenCalledTimes(1);
  });
});

/**
 * bunko 0.8 records series owners: an uploader may add nothing to a series
 * another account owns. Backing such a volume up would be refused file by
 * file, so it is skipped with ONE notice — never an "Upload failed" per file.
 */
describe('a series another account owns on the server', () => {
  function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
    return {
      volume_uuid: 'owned-uuid',
      series_uuid: 'series-1',
      series_title: 'Admin Series',
      volume_title: 'Volume 1',
      mokuro_version: '0.4.11',
      page_count: 200,
      character_count: 5000,
      page_char_counts: [],
      ...overrides
    };
  }
  const NOTICE = 'This series belongs to another account on this server';

  function serverProvider(closedSeries: string[] | undefined) {
    const state = { closedSeries };
    const provider = {
      type: 'webdav',
      uploadConcurrencyLimit: 2,
      supportsWorkerUpload: true,
      refreshIdentity: vi.fn(async () => {}),
      getStatus: () => ({
        isReadOnly: false,
        canAddFiles: true,
        ...(state.closedSeries
          ? {
              addFilesPermissions: {
                scope: 'open' as const,
                closedSeries: state.closedSeries
              }
            }
          : {})
      })
    };
    return { provider, state };
  }

  let items: Array<{ volumeUuid: string }> = [];
  let unsubscribe = () => {};
  beforeEach(() => {
    capturedTasks.length = 0;
    vi.clearAllMocks();
    unsubscribe = backupQueue.subscribe((q) => (items = q));
  });
  afterEach(() => {
    unsubscribe();
    getActiveProvider.mockReturnValue(null);
  });

  it('a single volume of a closed series is not queued, with one notice', () => {
    const { provider } = serverProvider(['admin series']);
    // refused: the caller must not announce it as added over the notice.
    expect(queueVolumeForBackup(volume({ volume_uuid: 'closed-1' }), provider as never)).toBe(
      'refused'
    );
    expect(backupQueue.isVolumeInBackupQueue('closed-1')).toBe(false);
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(bridge.notify).toHaveBeenCalledWith(NOTICE);
  });

  it('a queued volume reports itself added, and already queued the second time', () => {
    const { provider } = serverProvider(['Berserk']);
    expect(queueVolumeForBackup(volume({ volume_uuid: 'open-1' }), provider as never)).toBe(
      'added'
    );
    expect(queueVolumeForBackup(volume({ volume_uuid: 'open-1' }), provider as never)).toBe(
      'already-queued'
    );
  });

  // Pressing Backup again while the first run is still queued must not
  // announce the same volumes as added a second time.
  it('a series backup pressed again counts only what it added', () => {
    const { provider } = serverProvider([]);
    const series = [
      volume({ volume_uuid: 'again-1', series_title: 'Again' }),
      volume({ volume_uuid: 'again-2', series_title: 'Again', volume_title: 'Volume 2' })
    ];
    backupQueue.queueSeriesVolumesForBackup(series, provider as never);
    bridge.notify.mockClear();

    const again = backupQueue.queueSeriesVolumesForBackup(series, provider as never);
    expect(again).toEqual({ queued: 0, alreadyQueued: 2, closed: 0 });
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(bridge.notify).toHaveBeenCalledWith('2 volumes already in backup queue');

    bridge.notify.mockClear();
    const more = backupQueue.queueSeriesVolumesForBackup(
      [...series, volume({ volume_uuid: 'again-3', series_title: 'Again', volume_title: 'V3' })],
      provider as never,
      undefined,
      { alreadyBackedUp: 4 }
    );
    expect(more).toEqual({ queued: 1, alreadyQueued: 2, closed: 0 });
    expect(bridge.notify).toHaveBeenCalledWith(
      'Added 1 volume to backup queue (4 already backed up, 2 already queued)'
    );
  });

  // The snackbar has ONE slot: the series backup's own "Added N" used to be
  // shown by the caller right after the queue's skip notice, wiping it out.
  // The queue now words the one notice for the whole request.
  it('a series backup queues only the open series and gives ONE notice naming both', () => {
    const { provider } = serverProvider(['Admin Series']);
    const result = backupQueue.queueSeriesVolumesForBackup(
      [
        volume({ volume_uuid: 'c-1' }),
        volume({ volume_uuid: 'c-2', volume_title: 'Volume 2' }),
        volume({ volume_uuid: 'o-1', series_title: 'Berserk' })
      ],
      provider as never
    );
    expect(result).toEqual({ queued: 1, alreadyQueued: 0, closed: 2 });
    expect(items.map((item) => item.volumeUuid)).toContain('o-1');
    expect(backupQueue.isVolumeInBackupQueue('c-1')).toBe(false);
    expect(backupQueue.isVolumeInBackupQueue('c-2')).toBe(false);
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(bridge.notify).toHaveBeenCalledWith(
      'Added 1 volume to backup queue. Skipped 2 volumes: their series belongs to another account on this server'
    );
  });

  it('a series backup with every volume closed gives only the skip notice', () => {
    const { provider } = serverProvider(['Admin Series']);
    const result = backupQueue.queueSeriesVolumesForBackup(
      [
        volume({ volume_uuid: 'all-1' }),
        volume({ volume_uuid: 'all-2', volume_title: 'Volume 2' })
      ],
      provider as never,
      undefined,
      { alreadyBackedUp: 3 }
    );
    expect(result).toEqual({ queued: 0, alreadyQueued: 0, closed: 2 });
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(bridge.notify).toHaveBeenCalledWith(
      'Skipped 2 volumes: their series belongs to another account on this server'
    );
  });

  it('an older server (no addFiles) queues everything, as before', () => {
    const { provider } = serverProvider(undefined);
    const result = backupQueue.queueSeriesVolumesForBackup(
      [volume({ volume_uuid: 'old-1' }), volume({ volume_uuid: 'old-2', series_title: 'B' })],
      provider as never,
      undefined,
      { alreadyBackedUp: 1 }
    );
    expect(result).toEqual({ queued: 2, alreadyQueued: 0, closed: 0 });
    expect(backupQueue.isVolumeInBackupQueue('old-1')).toBe(true);
    expect(backupQueue.isVolumeInBackupQueue('old-2')).toBe(true);
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(bridge.notify).toHaveBeenCalledWith(
      'Added 2 volumes to backup queue (1 already backed up)'
    );
  });

  it('a series that closed before its queued volume reached the pool is dropped there', async () => {
    const { provider, state } = serverProvider([]);
    getActiveProvider.mockReturnValue(provider);
    // Its own series: the run-scoped "noticed once" set outlives this test
    // (the describe's earlier volumes never finish, so the run never ends).
    queueVolumeForBackup(
      volume({ volume_uuid: 'pre-1', series_title: 'Pre Series' }),
      provider as never,
      { includeSidecars: false, embedSidecarsInArchive: false }
    );
    // Closed after the enqueue gate, before processBackup submits the task.
    state.closedSeries = ['Pre Series'];
    await vi.waitFor(() => expect(backupQueue.isVolumeInBackupQueue('pre-1')).toBe(false));

    expect(capturedTasks).toHaveLength(0);
    expect(recordUploadFailure).not.toHaveBeenCalled();
    expect(bridge.notifyError).not.toHaveBeenCalled();
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(bridge.notify).toHaveBeenCalledWith(
      'Skipped Pre Series: this series belongs to another account on this server'
    );
  });

  it('a series that closed after it was queued is skipped once, without an upload failure', async () => {
    const { provider, state } = serverProvider([]);
    getActiveProvider.mockReturnValue(provider);
    const sidecars = { includeSidecars: false, embedSidecarsInArchive: false };
    queueVolumeForBackup(volume({ volume_uuid: 'late-1' }), provider as never, sidecars);
    queueVolumeForBackup(
      volume({ volume_uuid: 'late-2', volume_title: 'Volume 2' }),
      provider as never,
      sidecars
    );
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(2));

    // Another account's upload made it theirs; the identity says so now.
    state.closedSeries = ['Admin Series'];
    for (const task of capturedTasks) {
      // The pool's contract: a prepareData that throws goes to onError.
      const error = await task.prepareData().then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(Error);
      await task.onError({ type: 'error', error: (error as Error).message });
    }

    expect(recordUploadFailure).not.toHaveBeenCalled();
    expect(bridge.notifyError).not.toHaveBeenCalled();
    expect(bridge.notify).toHaveBeenCalledTimes(1);
    expect(bridge.notify).toHaveBeenCalledWith(
      'Skipped Admin Series: this series belongs to another account on this server'
    );
    expect(backupQueue.isVolumeInBackupQueue('late-1')).toBe(false);
    expect(backupQueue.isVolumeInBackupQueue('late-2')).toBe(false);
  });

  it('a 403 on an upload asks the server who owns what again, and keeps the volume’s failure', async () => {
    const { provider } = serverProvider([]);
    getActiveProvider.mockReturnValue(provider);
    queueVolumeForBackup(volume({ volume_uuid: 'r-1' }), provider as never, {
      includeSidecars: false,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    provider.refreshIdentity.mockClear();

    await capturedTasks[0].onError({
      type: 'error',
      error:
        'WebDAV upload failed: 403 Forbidden (forbidden: This series belongs to another account.)',
      detail: 'This series belongs to another account.'
    });
    // Throttled like the provider's own ownership refresh: one 403 per volume
    // of a shared folder must not cost one /me each.
    expect(provider.refreshIdentity).toHaveBeenCalledTimes(1);
    expect(provider.refreshIdentity).toHaveBeenCalledWith({ maxAgeMs: 60_000 });
    expect(recordUploadFailure).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'This series belongs to another account.' })
    );
  });

  it('an older server’s 403 asks nothing', async () => {
    const { provider } = serverProvider(undefined);
    getActiveProvider.mockReturnValue(provider);
    queueVolumeForBackup(volume({ volume_uuid: 'r-2' }), provider as never, {
      includeSidecars: false,
      embedSidecarsInArchive: false
    });
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    provider.refreshIdentity.mockClear();
    await capturedTasks[0].onError({ type: 'error', error: 'WebDAV upload failed: 403' });
    expect(provider.refreshIdentity).not.toHaveBeenCalled();
    expect(recordUploadFailure).toHaveBeenCalledTimes(1);
  });
});

describe("cancelling a provider's uploads (explicit logout)", () => {
  function volume(uuid: string): VolumeMetadata {
    return {
      volume_uuid: uuid,
      series_uuid: 'series-1',
      series_title: 'Ippo',
      volume_title: `Volume ${uuid}`,
      mokuro_version: '0.4.11',
      page_count: 200,
      character_count: 5000,
      page_char_counts: [],
      metadata_only: undefined
    };
  }
  const mega = { type: 'mega', uploadConcurrencyLimit: 6, supportsWorkerUpload: true };
  const sidecars = { includeSidecars: false, embedSidecarsInArchive: false };

  let items: Array<{ volumeUuid: string; provider: string }> = [];
  let unsubscribe = () => {};
  beforeEach(async () => {
    // Earlier suites leave uploads parked in the stand-in pool forever; this
    // one needs the queue empty and its run ended.
    capturedTasks.length = 0;
    for (const provider of ['webdav', 'filesystem', 'export-for-download'] as const) {
      cancelBackupsForProvider(provider);
    }
    await backupQueueSettled();
    capturedTasks.length = 0;
    calls.length = 0;
    vi.clearAllMocks();
    unsubscribe = backupQueue.subscribe((q) => (items = q));
    getActiveProvider.mockReturnValue(mega);
  });
  afterEach(() => {
    unsubscribe();
    getActiveProvider.mockReturnValue(null);
  });

  it('drops the uploads in flight without recording a failure, and the run ends without a listing', async () => {
    queueVolumeForBackup(volume('c-1'), mega as never, sidecars);
    queueVolumeForBackup(volume('c-2'), mega as never, sidecars);
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(2));

    await cancelProviderUploads('mega', 'Upload cancelled: logged out of MEGA');

    expect(cancelPoolTasks).toHaveBeenCalledTimes(1);
    const [matches] = cancelPoolTasks.mock.calls[0];
    expect(matches({ provider: 'mega:upload' })).toBe(true);
    expect(matches({ provider: 'mega:download' })).toBe(false);
    expect(matches({ provider: 'webdav:upload' })).toBe(false);
    await vi.waitFor(() => expect(items).toEqual([]));
    expect(recordUploadFailure).not.toHaveBeenCalled();
    expect(bridge.notifyError).not.toHaveBeenCalled();
    expect(bridge.removeProgress).toHaveBeenCalledWith('backup-c-1');
    expect(bridge.removeProgress).toHaveBeenCalledWith('backup-c-2');
    await backupQueueSettled();
    // The run released the pool but listed and wrote nothing for the account
    // being logged out.
    expect(decrementPoolUsers).toHaveBeenCalledTimes(1);
    expect(fetchAllCloudVolumes).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
    expect(flushCatalogFileWrites).not.toHaveBeenCalled();
  });

  it('drops a volume still waiting in the queue before it reaches the pool', async () => {
    queueVolumeForBackup(volume('w-1'), mega as never, sidecars);
    // Synchronously: the queue has not handed it to the pool yet.
    cancelBackupsForProvider('mega');

    expect(items).toEqual([]);
    await backupQueueSettled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(capturedTasks).toHaveLength(0);
    expect(recordUploadFailure).not.toHaveBeenCalled();
  });

  it("leaves another provider's queue alone", async () => {
    const webdav = { type: 'webdav', uploadConcurrencyLimit: 2, supportsWorkerUpload: true };
    getActiveProvider.mockReturnValue(webdav);
    queueVolumeForBackup(volume('o-1'), webdav as never, sidecars);
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));

    cancelBackupsForProvider('mega');

    expect(items.map((i) => i.volumeUuid)).toEqual(['o-1']);
    expect(capturedTasks).toHaveLength(1);
    // Finish it the ordinary way, so the run ends as usual.
    await capturedTasks[0].onError({ type: 'error', error: 'offline' });
    expect(recordUploadFailure).toHaveBeenCalledTimes(1);
  });

  it('a later run after the cancel ends with its listing again', async () => {
    queueVolumeForBackup(volume('l-1'), mega as never, sidecars);
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    cancelBackupsForProvider('mega');
    await backupQueueSettled();
    expect(fetchAllCloudVolumes).not.toHaveBeenCalled();

    queueVolumeForBackup(volume('l-2'), mega as never, sidecars);
    await vi.waitFor(() => expect(capturedTasks).toHaveLength(1));
    await capturedTasks[0].onError({ type: 'error', error: 'offline' });
    await backupQueueSettled();
    expect(fetchAllCloudVolumes).toHaveBeenCalledTimes(1);
  });
});
