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
import { loadVolumeSidecars, downloadFileBlob } from './volume-sidecars';

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

// Internal queue state
const queueStore = writable<BackupQueueItem[]>([]);

// Track if this queue is currently using the shared pool
let processingStarted = false;

// Queue lock: Ensures processQueue() executions wait in line instead of skipping
// Each call waits for the previous one to finish before proceeding
let queueLock = Promise.resolve();

// Series upload target initialization lock (provider-agnostic)
// Prevents multiple concurrent workers from racing to prepare the same provider+series target
// Maps "provider:seriesTitle" -> Promise that resolves when target is guaranteed to exist
const seriesFolderLocks = new Map<string, Promise<Record<string, any> | void>>();

// Subscribe to queue changes and update progress tracker
queueStore.subscribe((queue) => {
  const totalCount = queue.length;

  if (totalCount > 0) {
    getBackupUiBridge().addProgress('backup-queue-overall', 'Backup Queue', `${totalCount} in queue`, 0);
  } else {
    getBackupUiBridge().removeProgress('backup-queue-overall');
  }
});

/**
 * Add a single volume to the backup queue
 */
export function queueVolumeForBackup(
  volume: VolumeMetadata,
  providerInstance?: SyncProvider,
  sidecarOptions: SidecarOptions = { includeSidecars: true, embedSidecarsInArchive: true }
): void {
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
  sidecarOptions: SidecarOptions = { includeSidecars: true, embedSidecarsInArchive: true }
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

async function prepareSeriesUploadTarget(
  provider: SyncProvider,
  seriesTitle: string
): Promise<Record<string, any> | void> {
  if (!provider.prepareUploadTarget) return;

  const lockKey = `${provider.type}:${seriesTitle}`;
  const existingLock = seriesFolderLocks.get(lockKey);
  if (existingLock) {
    return await existingLock;
  }

  const lockPromise = (async () => {
    try {
      return await provider.prepareUploadTarget!(seriesTitle);
    } catch (error) {
      // On error, remove lock so it can be retried
      seriesFolderLocks.delete(lockKey);
      throw error;
    }
  })();

  seriesFolderLocks.set(lockKey, lockPromise);
  return await lockPromise;
}

async function getUploadWorkerCredentials(
  provider: SyncProvider,
  seriesTitle: string
): Promise<Record<string, any>> {
  const baseCredentials = provider.getWorkerUploadCredentials
    ? await provider.getWorkerUploadCredentials()
    : {};

  const targetData = await prepareSeriesUploadTarget(provider, seriesTitle);
  return { ...baseCredentials, ...(targetData || {}) };
}

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
 * Check if queue is empty and release shared pool if so
 */
async function checkAndTerminatePool(): Promise<void> {
  const currentQueue = get(queueStore);
  if (currentQueue.length === 0 && processingStarted) {
    decrementPoolUsers();
    processingStarted = false;

    // Refresh cache immediately for all providers
    // This replaces optimistic entries with real server data
    console.log('[Backup Queue] All uploads complete, refreshing cloud cache...');
    await unifiedCloudManager.fetchAllCloudVolumes();
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

        // Handle export-for-download (pseudo-provider)
        if (isExport) {
          return {
            mode: 'compress-from-db',
            provider: null, // null = local export
            volumeUuid: item.volumeUuid,
            volumeTitle: item.volumeTitle,
            seriesTitle: item.seriesTitle,
            downloadFilename: item.downloadFilename || `${item.volumeTitle}.cbz`,
            embedThumbnailSidecar: item.sidecarOptions.embedSidecarsInArchive
          };
        }

        // Handle real cloud providers
        const credentials = await getUploadWorkerCredentials(provider!, item.seriesTitle);

        return {
          mode: 'compress-from-db',
          provider: provider!.type,
          volumeUuid: item.volumeUuid,
          volumeTitle: item.volumeTitle,
          seriesTitle: item.seriesTitle,
          credentials,
          embedThumbnailSidecar: item.sidecarOptions.embedSidecarsInArchive
        };
      },
      onProgress: (data) => {
        const percent = Math.round(data.progress);
        // Each phase goes from 0-100%
        const status = data.phase === 'compressing' ? 'Compressing...' : 'Uploading...';

        getBackupUiBridge().updateProgress(processId, status, percent);
      },
      onComplete: async (data, releaseMemory) => {
        try {
          // Handle export-for-download (trigger browser download)
          if (isExport && data?.data) {
            getBackupUiBridge().updateProgress(processId, 'Download ready', 100);

            // Trigger browser download using Transferable Object data
            const blob = new Blob([data.data], { type: 'application/x-cbz' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = item.downloadFilename || `${item.volumeTitle}.cbz`;
            link.click();
            URL.revokeObjectURL(url);

            if (item.sidecarOptions.includeSidecars) {
              const sidecars = await loadVolumeSidecars(item.volumeUuid);
              if (sidecars.mokuroFile) {
                downloadFileBlob(sidecars.mokuroFile);
              }
              if (sidecars.thumbnailFile) {
                downloadFileBlob(sidecars.thumbnailFile);
              }
            }

            getBackupUiBridge().notify(`Exported ${item.volumeTitle} successfully`);
            queueStore.update((q) =>
              q.filter((i) => !(i.volumeUuid === item.volumeUuid && i.provider === item.provider))
            );
            setTimeout(() => getBackupUiBridge().removeProgress(processId), 3000);

            return; // Early return for export
          }

          // Handle real cloud backup
          getBackupUiBridge().updateProgress(processId, 'Backup complete', 100);

          getBackupUiBridge().notify(`Backed up ${item.volumeTitle} successfully`);
          queueStore.update((q) =>
            q.filter((i) => !(i.volumeUuid === item.volumeUuid && i.provider === item.provider))
          );

          // Add the uploaded file to cache immediately for ALL providers
          // This ensures the UI updates right away, showing the file as backed up
          if (data?.fileId) {
            const { cacheManager } = await import('./sync/cache-manager');
            const cache = cacheManager.getCache(provider!.type);
            const path = `${item.seriesTitle}/${item.volumeTitle}.cbz`;

            if (cache && cache.add) {
              // All providers now use the same interface: full path as first parameter
              // The cache implementations internally extract the series title for Map grouping
              cache.add(path, {
                fileId: data.fileId,
                path,
                modifiedTime: new Date().toISOString(),
                size: 0 // Size unknown at this point, will be updated on next full fetch
              });
              console.log(`✅ Added ${path} to ${provider!.type} cache`);
            }
          }

          if (item.sidecarOptions.includeSidecars) {
            const sidecars = await loadVolumeSidecars(item.volumeUuid);
            if (sidecars.mokuroFile) {
              await provider!.uploadFile(
                `${item.seriesTitle}/${item.volumeTitle}.mokuro`,
                sidecars.mokuroFile
              );
            }
            if (sidecars.thumbnailFile) {
              await provider!.uploadFile(
                `${item.seriesTitle}/${item.volumeTitle}.webp`,
                sidecars.thumbnailFile
              );
            }
          }

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
