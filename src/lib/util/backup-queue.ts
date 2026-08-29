import { writable, get } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import type { WorkerTask } from './worker-pool';
import { getBackupUiBridge } from './backup-ui';
import { unifiedCloudManager } from './sync/unified-cloud-manager';
import type { BackupProviderType, SyncProvider } from './sync/provider-interface';
import { isPseudoProvider, exportProvider } from './sync/provider-interface';
import {
  getFileProcessingPool,
  incrementPoolUsers,
  decrementPoolUsers
} from './file-processing-pool';
import { downloadFileBlob } from './volume-sidecars';
import { flushCatalogFileWrites } from '$lib/metadata/catalog-file-sync';
import {
  cancelScheduledSeriesFileWrite,
  markListingFresh,
  scheduleSeriesFileWrite
} from '$lib/metadata/series-file-sync';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import { recordArchiveSize } from '$lib/catalog/archive-size';
import { getUploadWorkerCredentials, prepareSeriesUploadTarget } from './upload-worker-credentials';

export interface SidecarOptions {
  includeSidecars: boolean;
  embedSidecarsInArchive: boolean;
}
// Note: prepareVolumeData is no longer used - worker reads from IndexedDB directly

// Type for provider instances (real or export)
type ProviderInstance = SyncProvider | typeof exportProvider;

export interface BackupQueueItem {
  volumeUuid: string;
  seriesTitle: string;
  volumeTitle: string;
  provider: BackupProviderType; // Provider type string for routing
  uploadConcurrencyLimit: number; // Concurrency limit from provider instance
  volumeMetadata: VolumeMetadata;
  status: 'queued' | 'backing-up';
  downloadFilename?: string; // Only for export-for-download pseudo-provider
  sidecarOptions: SidecarOptions;
}

interface SeriesQueueStatus {
  hasQueued: boolean;
  hasBackingUp: boolean;
  queuedCount: number;
  backingUpCount: number;
}

interface WorkerUploadSidecars {
  mokuro?: { filename: string; blob: Blob };
  thumbnail?: { filename: string; blob: Blob };
}

interface WorkerUploadCompleteData {
  type: 'complete';
  fileId?: string;
  /** Server-reported mtime from the upload response, when the provider returned one. */
  modifiedTime?: string;
  size?: number;
  data?: Uint8Array;
  filename?: string;
  sidecars?: WorkerUploadSidecars;
}

// Internal queue state
const queueStore = writable<BackupQueueItem[]>([]);

// Track if this queue is currently using the shared pool
let processingStarted = false;

/**
 * Is a backup/export run currently draining the queue?
 *
 * Read by the two upload-success sites below to decide how they schedule this
 * volume's `series.json` write (see `scheduleSeriesFileWrite`'s
 * `duringBackupRun` option in `series-file-sync.ts` for what that changes).
 * Exposed as a function rather than the raw flag so the writer module reads
 * an intent, not a mutable internal — and because it must be evaluated AT THE
 * CALL SITE, synchronously, inside the same `onComplete` handler that just
 * finished: that is the instant that is genuinely "mid-run", not whatever the
 * flag happens to read 2 seconds later when the debounce timer fires.
 */
export function isBackupRunActive(): boolean {
  return processingStarted;
}

// Queue lock: Ensures processQueue() executions wait in line instead of skipping
// Each call waits for the previous one to finish before proceeding
let queueLock = Promise.resolve();

// Subscribe to queue changes and update progress tracker
let lastQueueCount = 0;
queueStore.subscribe((queue) => {
  const totalCount = queue.length;

  if (totalCount > 0) {
    getBackupUiBridge().addProgress(
      'backup-queue-overall',
      'Backup Queue',
      `${totalCount} in queue`,
      0
    );
  } else {
    getBackupUiBridge().removeProgress('backup-queue-overall');
    if (lastQueueCount > 0) {
      // Drain: the uploads may have changed what this account owns server-side
      // (mokuro-bunko grants series ownership from archive uploads), so re-ask
      // the identity endpoint — otherwise the edit/delete gates keep judging by
      // the connect-time snapshot and wrongly block series just uploaded.
      void unifiedCloudManager.getActiveProvider()?.refreshIdentity?.();
    }
  }
  lastQueueCount = totalCount;
});

/**
 * Add a single volume to the backup queue
 */
export function queueVolumeForBackup(
  volume: VolumeMetadata,
  providerInstance?: SyncProvider,
  sidecarOptions: SidecarOptions = { includeSidecars: true, embedSidecarsInArchive: false }
): void {
  // Nothing to upload for a volume whose pages are not on this device (a
  // metadata-only row, or a cloud placeholder that never was).
  if (!isVolumeInstalled(volume)) {
    console.warn('Skipping backup of a volume that is not installed:', volume.volume_title);
    return;
  }

  // Get default provider if not specified
  const targetProvider = providerInstance || unifiedCloudManager.getDefaultProvider();
  if (!targetProvider) {
    console.warn('No cloud provider available for backup');
    getBackupUiBridge().notify('Please connect to a cloud storage provider first');
    return;
  }

  const queue = get(queueStore);

  // Check for duplicates by volumeUuid:provider (allows same volume to be queued for different providers)
  const isDuplicate = queue.some(
    (item) => item.volumeUuid === volume.volume_uuid && item.provider === targetProvider.type
  );

  if (isDuplicate) {
    console.log(`Volume ${volume.volume_title} already in backup queue for ${targetProvider.type}`);
    return;
  }

  const queueItem: BackupQueueItem = {
    volumeUuid: volume.volume_uuid,
    seriesTitle: volume.series_title,
    volumeTitle: volume.volume_title,
    provider: targetProvider.type,
    uploadConcurrencyLimit: targetProvider.uploadConcurrencyLimit,
    volumeMetadata: volume,
    status: 'queued',
    sidecarOptions
  };

  queueStore.update((q) => [...q, queueItem]);

  // Always call processQueue to handle newly added items
  processQueue();
}

/**
 * Add a single volume to the export queue (local download)
 */
export function queueVolumeForExport(
  volume: VolumeMetadata,
  filename: string,
  extension: 'zip' | 'cbz' = 'cbz',
  sidecarOptions: SidecarOptions = { includeSidecars: false, embedSidecarsInArchive: false }
): void {
  // Same rule as the backup queue: there are no pages to write out.
  if (!isVolumeInstalled(volume)) {
    console.warn('Skipping export of a volume that is not installed:', volume.volume_title);
    return;
  }

  const queue = get(queueStore);

  // Check for duplicates by volumeUuid
  const isDuplicate = queue.some((item) => item.volumeUuid === volume.volume_uuid);

  if (isDuplicate) {
    console.log(`Volume ${volume.volume_title} already in export queue`);
    return;
  }

  const queueItem: BackupQueueItem = {
    volumeUuid: volume.volume_uuid,
    seriesTitle: volume.series_title,
    volumeTitle: volume.volume_title,
    provider: exportProvider.type,
    uploadConcurrencyLimit: exportProvider.uploadConcurrencyLimit,
    volumeMetadata: volume,
    status: 'queued',
    downloadFilename: filename,
    sidecarOptions
  };

  queueStore.update((q) => [...q, queueItem]);

  // Always call processQueue to handle newly added items
  processQueue();
}

/**
 * Add multiple volumes to the backup queue
 */
export function queueSeriesVolumesForBackup(
  volumes: VolumeMetadata[],
  providerInstance?: SyncProvider,
  sidecarOptions: SidecarOptions = { includeSidecars: true, embedSidecarsInArchive: false }
): void {
  // Get default provider if not specified
  const targetProvider = providerInstance || unifiedCloudManager.getDefaultProvider();
  if (!targetProvider) {
    console.warn('No cloud provider available for backup');
    getBackupUiBridge().notify('Please connect to a cloud storage provider first');
    return;
  }

  if (volumes.length === 0) {
    console.warn('No volumes to queue for backup');
    return;
  }

  // Sort alphabetically by series title first, then by volume title
  const sorted = [...volumes].sort((a, b) => {
    const seriesCompare = a.series_title.localeCompare(b.series_title, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
    if (seriesCompare !== 0) {
      return seriesCompare;
    }
    return a.volume_title.localeCompare(b.volume_title, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });

  // Add each volume individually (duplicate check happens in queueVolumeForBackup)
  sorted.forEach((volume) => queueVolumeForBackup(volume, targetProvider, sidecarOptions));
}

/**
 * Check if a specific volume is in the backup queue
 * @param volumeUuid The volume UUID to check
 * @param provider Optional provider to check for. If not specified, checks if volume is queued for ANY provider
 */
export function isVolumeInBackupQueue(volumeUuid: string, provider?: string): boolean {
  const queue = get(queueStore);
  if (provider) {
    return queue.some((item) => item.volumeUuid === volumeUuid && item.provider === provider);
  }
  return queue.some((item) => item.volumeUuid === volumeUuid);
}

/**
 * Get queue status for an entire series
 */
export function getSeriesBackupQueueStatus(seriesTitle: string): SeriesQueueStatus {
  const queue = get(queueStore);
  const seriesItems = queue.filter((item) => item.seriesTitle === seriesTitle);

  return {
    hasQueued: seriesItems.some((item) => item.status === 'queued'),
    hasBackingUp: seriesItems.some((item) => item.status === 'backing-up'),
    queuedCount: seriesItems.filter((item) => item.status === 'queued').length,
    backingUpCount: seriesItems.filter((item) => item.status === 'backing-up').length
  };
}

// prepareSeriesUploadTarget / getUploadWorkerCredentials moved to
// `upload-worker-credentials.ts` — the sidecar backfill's worker feed shares
// them (and, deliberately, their per-`provider:series` folder lock map).

/**
 * Handle backup errors consistently
 */
function handleBackupError(item: BackupQueueItem, processId: string, errorMessage: string): void {
  getBackupUiBridge().updateProgress(processId, `Error: ${errorMessage}`, 0);
  getBackupUiBridge().notify(`Failed to backup ${item.volumeTitle}: ${errorMessage}`);
  queueStore.update((q) =>
    q.filter((i) => !(i.volumeUuid === item.volumeUuid && i.provider === item.provider))
  );
  setTimeout(() => getBackupUiBridge().removeProgress(processId), 3000);
}

/**
 * Series that got at least one volume uploaded in this run, kept as the
 * DRAIN-TIME catch-all for their `<Series>/series.json` index.
 *
 * The primary write now happens live: each upload-success site also calls
 * `scheduleSeriesFileWrite(item.seriesTitle, { duringBackupRun: true })`,
 * whose 2 s debounce + serialized write chain already collapses a whole
 * run's volumes for one series into one or two PUTs. This set exists for what
 * that debounced write can lose a race with — a run that gets interrupted
 * before its timer fires, or a volume removed mid-run right after its own
 * write went out — so a run still ends with every backed-up series indexed
 * even if its live write never landed. Redundant with an already-successful
 * live write is fine: `writeSeriesFile` is a cheap union, not a resend of
 * bytes nobody asked for.
 */
const seriesNeedingIndexWrite = new Set<string>();

/**
 * Did this run put anything IN the cloud? `finishBackupRun` also ends
 * export-to-disk drains, and a purely local download must not end in a
 * `catalog.json` upload. Not derivable from the set above: that one is emptied
 * by the index writes that run first.
 */
let uploadedThisRun = false;

/** Note that this run uploaded a volume of `seriesTitle`. */
export function noteSeriesNeedingIndexWrite(seriesTitle: string): void {
  uploadedThisRun = true;
  if (seriesTitle) seriesNeedingIndexWrite.add(seriesTitle);
}

/**
 * Write the per-series index for every series this run backed up. Runs after
 * the cache refresh so the file is built from the server's real listing (which
 * is also what prunes entries for volumes that are no longer in the cloud).
 * Non-fatal: a failed index write never fails a backup that succeeded.
 */
async function writeSeriesIndexesForRun(): Promise<void> {
  const seriesTitles = [...seriesNeedingIndexWrite];
  seriesNeedingIndexWrite.clear();
  for (const seriesTitle of seriesTitles) {
    try {
      // The live per-completion write is still pending — or already running —
      // for this exact series (2 s debounce, scheduled as its last volume
      // finished; the listing fetch above takes longer than that). Cancel it
      // FIRST and AWAIT what was already in flight: this pass writes the same
      // file from the same builder, so a timer left armed costs a duplicate PUT
      // (new mtime, every other device re-downloading an unchanged file), and a
      // write already out on its PUT would otherwise run concurrently with this
      // one — a same-series race nothing else serializes.
      await cancelScheduledSeriesFileWrite(seriesTitle);
      await unifiedCloudManager.writeSeriesFile(seriesTitle);
    } catch (error) {
      // Best-effort by contract: never fails a backup that succeeded.
      console.debug(`[Backup Queue] could not write series.json for '${seriesTitle}':`, error);
    }
  }
}

/**
 * The end of a backup run: replace the optimistic cache entries with the
 * server's real listing, publish this run's `series.json` files against it, and
 * only THEN let the index refresh read them back.
 *
 * The order matters. The refresh downloads every sidecar whose listing stamp
 * differs from the cached record, so running it on the pre-write listing races
 * the writes: it re-reads the copies we are about to replace and can cache the
 * pre-upload version of a file we just wrote. Suppressing it during the fetch
 * and starting it afterwards makes the run strictly write-then-read.
 */
export async function finishBackupRun(): Promise<void> {
  await unifiedCloudManager.fetchAllCloudVolumes({ refreshIndexes: false });
  // That fetch IS the whole-account listing the metadata writers need. Stamping
  // it makes them reuse it, instead of every run paying for a second one.
  markListingFresh();
  await writeSeriesIndexesForRun();
  // The run may have created or removed whole series folders, which is exactly
  // what the root catalog lists. One write for the whole run — and none at all
  // for a run that only wrote files to the user's disk.
  //
  // Read and cleared HERE rather than at the top of the run: everything above
  // can throw, and the intent to publish has to survive that for the next run,
  // exactly like the series still queued in `seriesNeedingIndexWrite` do.
  // Cleared before the await, so an upload finishing during the write still
  // arms the following run.
  if (uploadedThisRun) {
    uploadedThisRun = false;
    await flushCatalogFileWrites();
  }
  unifiedCloudManager.refreshSeriesIndexesInBackground();
}

/**
 * Check if queue is empty and release shared pool if so
 */
async function checkAndTerminatePool(): Promise<void> {
  const currentQueue = get(queueStore);
  if (currentQueue.length === 0 && processingStarted) {
    decrementPoolUsers();
    processingStarted = false;

    // Replace the optimistic cache entries with real server data, write this
    // run's series.json files against that listing, then let the index refresh
    // read them back.
    console.log('[Backup Queue] All uploads complete, refreshing cloud cache...');
    await finishBackupRun();
    console.log('[Backup Queue] Cloud cache refreshed with server data');
  }
}

/**
 * Process backup/export using workers for all providers (including pseudo-providers)
 * Data loading is deferred until worker is ready to prevent memory pressure
 */
async function processBackup(item: BackupQueueItem, processId: string): Promise<void> {
  // Check if this is an export operation (pseudo-provider)
  const isExport = isPseudoProvider(item.provider);

  // For real providers, get the active provider and validate authentication
  const provider = isExport ? null : unifiedCloudManager.getActiveProvider();

  if (!isExport && !provider) {
    handleBackupError(item, processId, 'No cloud provider authenticated');
    return;
  }

  // Providers that can't upload from a worker (e.g. filesystem: the directory
  // handle is bound to the window that received it) still go through the pool.
  // The worker compresses only — main thread then performs the actual upload
  // inside onComplete, while the task's memory reservation is still held.
  const needsMainThreadUpload = !isExport && provider !== null && !provider.supportsWorkerUpload;

  const pool = await getFileProcessingPool();

  // Estimate volume size (rough estimate: page count * 0.5MB average per page)
  const estimatedSize = (item.volumeMetadata.page_count || 10) * 0.5 * 1024 * 1024;
  // Estimate memory requirement (compression + upload buffer)
  // Compression overhead can be 2-3x the input size during processing
  const memoryRequirement = Math.max(estimatedSize * 6.0, 50 * 1024 * 1024);

  // Calculate effective concurrency limit for export tasks
  // Export is CPU/memory bound, so we use pool limit minus 2 to leave headroom for other operations
  let effectiveConcurrencyLimit = item.uploadConcurrencyLimit;
  console.log(`[Backup Queue] Initial concurrency limit for ${item.volumeTitle}:`, {
    provider: item.provider,
    isExport,
    storedLimit: item.uploadConcurrencyLimit,
    poolMax: pool.maxConcurrentWorkers
  });
  if (isExport) {
    effectiveConcurrencyLimit = Math.max(1, pool.maxConcurrentWorkers - 2);
    console.log(
      `[Backup Queue] Export concurrency limit: ${effectiveConcurrencyLimit} (pool: ${pool.maxConcurrentWorkers})`
    );
  }

  try {
    // Create worker task with lazy data loading
    const task: WorkerTask = {
      id: item.volumeUuid,
      memoryRequirement,
      provider: `${item.provider}:upload`, // Provider:operation identifier for concurrency tracking
      providerConcurrencyLimit: effectiveConcurrencyLimit, // Provider's upload limit (dynamic for exports)
      // Worker reads from IndexedDB directly - avoids memory issues with large volumes
      // by not transferring file data through postMessage
      prepareData: async () => {
        getBackupUiBridge().updateProgress(processId, 'Preparing...', 5);

        // Export-for-download (pseudo-provider) and main-thread-upload providers
        // both use the worker's "null provider" compress-only mode. For the
        // filesystem provider the real upload happens in onComplete using the
        // main-thread uploadFile API — the worker is only doing compression.
        if (isExport || needsMainThreadUpload) {
          return {
            mode: 'compress-from-db',
            provider: null,
            volumeUuid: item.volumeUuid,
            volumeTitle: item.volumeTitle,
            seriesTitle: item.seriesTitle,
            downloadFilename: item.downloadFilename || `${item.volumeTitle}.cbz`,
            embedThumbnailSidecar: item.sidecarOptions.embedSidecarsInArchive,
            // Export-to-file keeps embedding OCR data (self-contained .cbz);
            // main-thread cloud upload (filesystem) stores it as a sidecar,
            // matching every other cloud provider.
            embedMokuroInArchive: isExport,
            // Same split for the series sidecar: an exported archive carries
            // `series.json` so a re-import restores the series facts, while a
            // cloud upload gets the managed `<Series>/series.json` instead.
            embedSeriesFile: isExport,
            includeSidecars: item.sidecarOptions.includeSidecars
          };
        }

        // Worker-driven cloud upload (Google Drive, MEGA, WebDAV)
        const credentials = await getUploadWorkerCredentials(provider!, item.seriesTitle);

        return {
          mode: 'compress-from-db',
          provider: provider!.type,
          volumeUuid: item.volumeUuid,
          volumeTitle: item.volumeTitle,
          seriesTitle: item.seriesTitle,
          credentials,
          embedThumbnailSidecar: item.sidecarOptions.embedSidecarsInArchive,
          // Cloud uploads store OCR metadata as a separate sidecar file.
          embedMokuroInArchive: false,
          downloadFilename: `${item.volumeTitle}.cbz`,
          includeSidecars: item.sidecarOptions.includeSidecars
        };
      },
      onProgress: (data) => {
        if (data.phase === 'compressing') {
          getBackupUiBridge().updateProgress(
            processId,
            'Compressing...',
            Math.round(data.progress)
          );
          return;
        }
        if (data.phase === 'sidecars') {
          // Sidecar uploads are informational only and don't affect tracked progress.
          getBackupUiBridge().updateProgress(processId, 'Uploading sidecars...', 100);
          return;
        }
        if (data.phase === 'uploading') {
          getBackupUiBridge().updateProgress(
            processId,
            'Uploading archive...',
            Math.round(data.progress)
          );
        }
      },
      onComplete: async (rawData, releaseMemory) => {
        try {
          const data = rawData as WorkerUploadCompleteData;
          // Main-thread upload path (e.g. filesystem provider). Worker returned
          // the compressed archive + sidecars; we perform the actual writes now.
          // Memory remains reserved by the pool until this handler returns.
          if (needsMainThreadUpload && data?.data) {
            if (provider!.prepareUploadTarget) {
              await prepareSeriesUploadTarget(provider!, item.seriesTitle);
            }

            const archivePath = `${item.seriesTitle}/${item.volumeTitle}.cbz`;
            const archiveBytes = new Uint8Array(data.data);
            const archiveBlob = new Blob([archiveBytes], { type: 'application/x-cbz' });

            if (item.sidecarOptions.includeSidecars && data.sidecars) {
              getBackupUiBridge().updateProgress(processId, 'Uploading sidecars...', 100);
              const sidecars: Array<{ filename: string; blob: Blob }> = [];
              if (data.sidecars.mokuro) sidecars.push(data.sidecars.mokuro);
              if (data.sidecars.thumbnail) sidecars.push(data.sidecars.thumbnail);
              for (const sidecar of sidecars) {
                const sidecarPath = `${item.seriesTitle}/${sidecar.filename}`;
                await provider!.uploadFile(sidecarPath, sidecar.blob);
              }
            }

            getBackupUiBridge().updateProgress(processId, 'Uploading archive...', 0);
            const uploaded = await provider!.uploadFile(
              archivePath,
              archiveBlob,
              undefined,
              (loaded, total) => {
                if (total > 0) {
                  getBackupUiBridge().updateProgress(
                    processId,
                    'Uploading archive...',
                    Math.round((loaded / total) * 100)
                  );
                }
              }
            );

            const { cacheManager } = await import('./sync/cache-manager');
            const cache = cacheManager.getCache(provider!.type);
            if (cache?.add) {
              // Server mtime when the upload response carried one; otherwise a
              // client-clock fallback explicitly marked provisional so no stamp
              // publisher treats it as a server fact (`cloud-sidecar-stamps.ts`).
              cache.add(archivePath, {
                provider: provider!.type,
                fileId: uploaded.fileId,
                path: archivePath,
                modifiedTime: uploaded.modifiedTime ?? new Date().toISOString(),
                modifiedTimeProvisional: !uploaded.modifiedTime,
                size: uploaded.size ?? archiveBlob.size
              });
            }

            // The blob we just uploaded IS the archive, so its size is the one
            // fact about it nobody has to guess. Recorded before the index
            // write below, which reads the row to build the `series.json` entry.
            await recordArchiveSize(item.volumeUuid, archiveBlob.size);

            noteSeriesNeedingIndexWrite(item.seriesTitle);
            // Debounced (2s), coalesced per series, and — mid-run —
            // network-read-free (see `series-file-sync.ts`'s
            // `duringBackupRun`). A run of hundreds no longer waits until
            // drain for its first sidecar; the drain-time pass above stays as
            // the catch-all for whatever this loses a debounce race with.
            scheduleSeriesFileWrite(item.seriesTitle, { duringBackupRun: isBackupRunActive() });
            getBackupUiBridge().updateProgress(processId, 'Backup complete', 100);
            getBackupUiBridge().notify(`Backed up ${item.volumeTitle} successfully`);
            queueStore.update((q) =>
              q.filter((i) => !(i.volumeUuid === item.volumeUuid && i.provider === item.provider))
            );
            setTimeout(() => getBackupUiBridge().removeProgress(processId), 3000);
            return;
          }

          // Handle export-for-download (trigger browser download)
          if (isExport && data?.data) {
            getBackupUiBridge().updateProgress(processId, 'Download ready', 100);

            // Trigger browser download using Transferable Object data
            const archiveBytes = new Uint8Array(data.data);
            const blob = new Blob([archiveBytes], { type: 'application/x-cbz' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = item.downloadFilename || `${item.volumeTitle}.cbz`;
            link.click();
            URL.revokeObjectURL(url);

            if (item.sidecarOptions.includeSidecars && data.sidecars) {
              if (data.sidecars.mokuro) {
                downloadFileBlob(
                  new File([data.sidecars.mokuro.blob], data.sidecars.mokuro.filename, {
                    type: data.sidecars.mokuro.blob.type || 'application/json'
                  })
                );
              }
              if (data.sidecars.thumbnail) {
                downloadFileBlob(
                  new File([data.sidecars.thumbnail.blob], data.sidecars.thumbnail.filename, {
                    type: data.sidecars.thumbnail.blob.type || 'image/webp'
                  })
                );
              }
            }

            getBackupUiBridge().notify(`Exported ${item.volumeTitle} successfully`);
            queueStore.update((q) =>
              q.filter((i) => !(i.volumeUuid === item.volumeUuid && i.provider === item.provider))
            );
            setTimeout(() => getBackupUiBridge().removeProgress(processId), 3000);

            return; // Early return for export
          }

          // Handle real cloud backup (worker-driven upload flow)
          const uploadedFileId = data?.fileId;
          if (!uploadedFileId) {
            throw new Error('Backup worker did not return cloud file ID');
          }

          const { cacheManager } = await import('./sync/cache-manager');
          const cache = cacheManager.getCache(provider!.type);
          const addToCache = (
            path: string,
            fileId: string,
            size: number,
            serverModifiedTime?: string
          ): void => {
            if (!cache || !cache.add) return;
            // Server mtime when the worker's upload response carried one;
            // otherwise a client-clock fallback explicitly marked provisional
            // so no stamp publisher treats it as a server fact
            // (`cloud-sidecar-stamps.ts`).
            cache.add(path, {
              provider: provider!.type,
              fileId,
              path,
              modifiedTime: serverModifiedTime ?? new Date().toISOString(),
              modifiedTimeProvisional: !serverModifiedTime,
              size
            });
            console.log(`✅ Added ${path} to ${provider!.type} cache`);
          };

          const archivePath = `${item.seriesTitle}/${item.volumeTitle}.cbz`;
          addToCache(archivePath, uploadedFileId, data.size || 0, data.modifiedTime);
          // Same fact the cache entry above carries: the bytes the worker sent.
          await recordArchiveSize(item.volumeUuid, data.size);
          noteSeriesNeedingIndexWrite(item.seriesTitle);
          // See the matching comment on the main-thread-upload path above.
          scheduleSeriesFileWrite(item.seriesTitle, { duringBackupRun: isBackupRunActive() });

          getBackupUiBridge().updateProgress(processId, 'Backup complete', 100);
          getBackupUiBridge().notify(`Backed up ${item.volumeTitle} successfully`);
          queueStore.update((q) =>
            q.filter((i) => !(i.volumeUuid === item.volumeUuid && i.provider === item.provider))
          );

          // Archive cache entry is added immediately after upload.

          // Note: Full cache refresh is deferred until all uploads complete (see checkAndTerminatePool)
          // to prevent overlapping fetches from overwriting manual cache additions

          setTimeout(() => getBackupUiBridge().removeProgress(processId), 3000);
        } catch (error) {
          console.error(
            `Failed to finalize ${isExport ? 'export' : 'backup'} for ${item.volumeTitle}:`,
            error
          );
          handleBackupError(
            item,
            processId,
            error instanceof Error ? error.message : 'Unknown error'
          );
        } finally {
          releaseMemory();
          await checkAndTerminatePool();
        }
      },
      onError: async (data) => {
        console.error(`Error backing up ${item.volumeTitle}:`, data.error);
        handleBackupError(item, processId, data.error);
        await checkAndTerminatePool();
      }
    };

    pool.addTask(task);
  } catch (error) {
    console.error(`Failed to prepare backup for ${item.volumeTitle}:`, error);
    handleBackupError(item, processId, error instanceof Error ? error.message : 'Unknown error');
    await checkAndTerminatePool();
  }
}

/**
 * Process the queue - unified backup handling for all providers
 * Processes all queued items concurrently (respecting worker pool limits)
 *
 * Lock pattern: Only queue read/update is serialized, everything else is parallel
 */
async function processQueue(): Promise<void> {
  // Wait for previous processQueue() to finish queue access
  await queueLock;

  // Create new lock for next caller to wait on
  let releaseLock: () => void;
  queueLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  let queuedItems: BackupQueueItem[];
  try {
    // CRITICAL SECTION: Only queue reading/updating (serialized)
    const queue = get(queueStore);
    queuedItems = queue.filter((item) => item.status === 'queued');

    // Nothing to do if no queued items
    if (queuedItems.length === 0) {
      return;
    }

    // Mark all items as backing-up atomically
    queuedItems.forEach((item) => {
      queueStore.update((q) =>
        q.map((i) =>
          i.volumeUuid === item.volumeUuid && i.provider === item.provider
            ? { ...i, status: 'backing-up' as const }
            : i
        )
      );
    });
  } finally {
    // Release lock immediately after queue update
    releaseLock!();
  }

  // OUTSIDE LOCK: Pool initialization and task submission (parallel)

  // Mark processing as started and register as pool user
  if (!processingStarted) {
    processingStarted = true;
    incrementPoolUsers();

    // Pre-initialize the pool (parallel - don't block other processQueue calls)
    await getFileProcessingPool();
  }

  // Submit tasks to worker pool (parallel)
  queuedItems.forEach((item) => {
    const processId = `backup-${item.volumeUuid}`;

    // Add progress tracker
    const isExport = isPseudoProvider(item.provider);
    getBackupUiBridge().addProgress(
      processId,
      isExport ? `Exporting ${item.volumeTitle}` : `Backing up ${item.volumeTitle}`,
      'Queued...',
      0
    );

    console.log(`[Backup Queue] Processing ${isExport ? 'export' : 'backup'}:`, {
      volumeTitle: item.volumeTitle,
      provider: item.provider
    });

    // Start backup/export (worker pool handles global concurrency)
    processBackup(item, processId);
  });
}

// Export the store for reactive subscriptions
export const backupQueue = {
  subscribe: queueStore.subscribe,
  queueVolumeForBackup,
  queueVolumeForExport,
  queueSeriesVolumesForBackup,
  isVolumeInBackupQueue,
  getSeriesBackupQueueStatus
};
