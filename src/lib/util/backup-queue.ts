import { writable, get } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import { progressTrackerStore } from './progress-tracker';
import type { WorkerTask } from './worker-pool';
import { tokenManager } from './sync/providers/google-drive/token-manager';
import { showSnackbar } from './snackbar';
import { unifiedCloudManager } from './sync/unified-cloud-manager';
import type { BackupProviderType, SyncProvider } from './sync/provider-interface';
import { isPseudoProvider, exportProvider } from './sync/provider-interface';
import {
  getFileProcessingPool,
  incrementPoolUsers,
  decrementPoolUsers
} from './file-processing-pool';
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

// Series folder initialization lock (provider-agnostic)
// Prevents multiple concurrent workers from racing to create the same series folder
// Maps "provider:seriesTitle" -> Promise that resolves when folder is guaranteed to exist
const seriesFolderLocks = new Map<string, Promise<void>>();

// Subscribe to queue changes and update progress tracker
queueStore.subscribe((queue) => {
  const totalCount = queue.length;

  if (totalCount > 0) {
    progressTrackerStore.addProcess({
      id: 'backup-queue-overall',
      description: 'Backup Queue',
      status: `${totalCount} in queue`,
      progress: 0
    });
  } else {
    progressTrackerStore.removeProcess('backup-queue-overall');
  }
});

/**
 * Add a single volume to the backup queue
 */
export function queueVolumeForBackup(
  volume: VolumeMetadata,
  providerInstance?: SyncProvider
): void {
  // Get default provider if not specified
  const targetProvider = providerInstance || unifiedCloudManager.getDefaultProvider();
  if (!targetProvider) {
    console.warn('No cloud provider available for backup');
    showSnackbar('Please connect to a cloud storage provider first');
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
    status: 'queued'
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
  extension: 'zip' | 'cbz' = 'cbz'
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
    downloadFilename: filename
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
  providerInstance?: SyncProvider
): void {
  // Get default provider if not specified
  const targetProvider = providerInstance || unifiedCloudManager.getDefaultProvider();
  if (!targetProvider) {
    console.warn('No cloud provider available for backup');
    showSnackbar('Please connect to a cloud storage provider first');
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
  sorted.forEach((volume) => queueVolumeForBackup(volume, targetProvider));
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

/**
 * Ensure series folder exists for any provider (with race condition protection)
 * Provider-agnostic mutex prevents concurrent folder creation for the same series
 */
async function ensureSeriesFolder(
  provider: BackupProviderType,
  seriesTitle: string,
  credentials: any
): Promise<any> {
  const lockKey = `${provider}:${seriesTitle}`;

  // Check if folder initialization is already in progress or complete
  const existingLock = seriesFolderLocks.get(lockKey);
  if (existingLock) {
    await existingLock;
    // Return provider-specific data after lock resolves
    if (provider === 'google-drive') {
      return await ensureGoogleDriveFolder(seriesTitle, credentials.accessToken);
    }
    return; // MEGA and WebDAV don't need to return folder references
  }

  // Start folder creation and store the promise
  const lockPromise = (async () => {
    try {
      if (provider === 'google-drive') {
        await ensureGoogleDriveFolder(seriesTitle, credentials.accessToken);
      } else if (provider === 'mega') {
        await ensureMEGAFolder(seriesTitle, credentials.megaEmail, credentials.megaPassword);
      } else if (provider === 'webdav') {
        await ensureWebDAVFolder(
          seriesTitle,
          credentials.webdavUrl,
          credentials.webdavUsername,
          credentials.webdavPassword
        );
      }
    } catch (error) {
      // On error, remove lock so it can be retried
      seriesFolderLocks.delete(lockKey);
      throw error;
    }
  })();

  seriesFolderLocks.set(lockKey, lockPromise);
  await lockPromise;

  // Return provider-specific data
  if (provider === 'google-drive') {
    return await ensureGoogleDriveFolder(seriesTitle, credentials.accessToken);
  }
}

/**
 * Google Drive: Ensure series folder exists and return folder ID
 */
async function ensureGoogleDriveFolder(seriesTitle: string, accessToken: string): Promise<string> {
  const escapedSeriesTitle = seriesTitle.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // Ensure mokuro-reader root folder exists
  const rootQuery = `name='mokuro-reader' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const rootSearchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(rootQuery)}&fields=files(id,name)`;
  const rootResponse = await fetch(rootSearchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const rootData = await rootResponse.json();

  let rootFolderId: string;
  if (rootData.files?.length > 0) {
    rootFolderId = rootData.files[0].id;
  } else {
    const createResponse = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'mokuro-reader',
        mimeType: 'application/vnd.google-apps.folder'
      })
    });
    rootFolderId = (await createResponse.json()).id;
  }

  // Ensure series folder exists
  const seriesQuery = `name='${escapedSeriesTitle}' and '${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const seriesSearchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(seriesQuery)}&fields=files(id,name)`;
  const seriesResponse = await fetch(seriesSearchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const seriesData = await seriesResponse.json();

  if (seriesData.files?.length > 0) {
    return seriesData.files[0].id;
  }

  const createResponse = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: seriesTitle,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootFolderId]
    })
  });
  return (await createResponse.json()).id;
}

/**
 * MEGA: Ensure series folder exists in main thread
 * Workers will create their own Storage instances, but folders will already exist
 */
async function ensureMEGAFolder(
  seriesTitle: string,
  email: string,
  password: string
): Promise<void> {
  const { Storage } = await import('megajs');
  const storage = new Storage({ email, password });
  await storage.ready;

  // Ensure mokuro-reader folder exists
  let mokuroFolder = storage.root.children?.find(
    (c: any) => c.name === 'mokuro-reader' && c.directory
  );
  if (!mokuroFolder) {
    mokuroFolder = await storage.root.mkdir('mokuro-reader');
  }

  // Ensure series folder exists
  let seriesFolder = mokuroFolder.children?.find((c: any) => c.name === seriesTitle && c.directory);
  if (!seriesFolder) {
    await mokuroFolder.mkdir(seriesTitle);
  }
}

/**
 * WebDAV: Ensure series folder path exists
 */
async function ensureWebDAVFolder(
  seriesTitle: string,
  serverUrl: string,
  username: string,
  password: string
): Promise<void> {
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);
  const path = `mokuro-reader/${seriesTitle}`;
  const parts = path.split('/').filter((p) => p);

  let currentPath = '';
  for (const part of parts) {
    currentPath += `/${part}`;
    const folderUrl = `${serverUrl}${currentPath}`;

    try {
      const response = await fetch(folderUrl, {
        method: 'MKCOL',
        headers: { Authorization: authHeader }
      });
      // 201 = created, 405 = already exists (both OK)
      if (!response.ok && response.status !== 405) {
        console.warn(`Failed to create folder ${currentPath}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`Error creating folder ${currentPath}:`, error);
    }
  }
}

/**
 * Get provider credentials for worker uploads
 */
async function getProviderCredentials(provider: BackupProviderType): Promise<any> {
  if (provider === 'google-drive') {
    let token = '';
    tokenManager.token.subscribe((value) => {
      token = value;
    })();
    return { accessToken: token };
  } else if (provider === 'webdav') {
    const serverUrl = localStorage.getItem('webdav_server_url');
    const username = localStorage.getItem('webdav_username');
    const password = localStorage.getItem('webdav_password');
    return { webdavUrl: serverUrl, webdavUsername: username, webdavPassword: password };
  } else if (provider === 'mega') {
    // MEGA credentials need to be passed to worker (can't access localStorage in worker)
    const email = localStorage.getItem('mega_email');
    const password = localStorage.getItem('mega_password');
    return { megaEmail: email, megaPassword: password };
  }
  return {};
}

/**
 * Handle backup errors consistently
 */
function handleBackupError(item: BackupQueueItem, processId: string, errorMessage: string): void {
  progressTrackerStore.updateProcess(processId, {
    progress: 0,
    status: `Error: ${errorMessage}`
  });
  showSnackbar(`Failed to backup ${item.volumeTitle}: ${errorMessage}`);
  queueStore.update((q) =>
    q.filter((i) => !(i.volumeUuid === item.volumeUuid && i.provider === item.provider))
  );
  setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
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
        progressTrackerStore.updateProcess(processId, {
          progress: 5,
          status: 'Preparing...'
        });

        // Handle export-for-download (pseudo-provider)
        if (isExport) {
          return {
            mode: 'compress-from-db',
            provider: null, // null = local export
            volumeUuid: item.volumeUuid,
            volumeTitle: item.volumeTitle,
            seriesTitle: item.seriesTitle,
            downloadFilename: item.downloadFilename || `${item.volumeTitle}.cbz`
          };
        }

        // Handle real cloud providers
        const credentials = await getProviderCredentials(provider!.type);

        // Ensure series folder exists BEFORE worker starts (prevents race conditions)
        // This is provider-agnostic and works for Google Drive, MEGA, and WebDAV
        const folderData = await ensureSeriesFolder(provider!.type, item.seriesTitle, credentials);

        // For Google Drive, pass folder ID to worker to avoid redundant folder lookups
        if (provider!.type === 'google-drive' && folderData) {
          credentials.seriesFolderId = folderData;
        }

        return {
          mode: 'compress-from-db',
          provider: provider!.type,
          volumeUuid: item.volumeUuid,
          volumeTitle: item.volumeTitle,
          seriesTitle: item.seriesTitle,
          credentials
        };
      },
      onProgress: (data) => {
        const percent = Math.round(data.progress);
        // Each phase goes from 0-100%
        const status = data.phase === 'compressing' ? 'Compressing...' : 'Uploading...';

        progressTrackerStore.updateProcess(processId, {
          progress: percent,
          status
        });
      },
      onComplete: async (data, releaseMemory) => {
        try {
          // Handle export-for-download (trigger browser download)
          if (isExport && data?.data) {
            progressTrackerStore.updateProcess(processId, {
              progress: 100,
              status: 'Download ready'
            });

            // Trigger browser download using Transferable Object data
            const blob = new Blob([data.data], { type: 'application/x-cbz' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = item.downloadFilename || `${item.volumeTitle}.cbz`;
            link.click();
            URL.revokeObjectURL(url);

            showSnackbar(`Exported ${item.volumeTitle} successfully`);
            queueStore.update((q) =>
              q.filter((i) => !(i.volumeUuid === item.volumeUuid && i.provider === item.provider))
            );
            setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);

            return; // Early return for export
          }

          // Handle real cloud backup
          progressTrackerStore.updateProcess(processId, {
            progress: 100,
            status: 'Backup complete'
          });

          showSnackbar(`Backed up ${item.volumeTitle} successfully`);
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

          // Note: Full cache refresh is deferred until all uploads complete (see checkAndTerminatePool)
          // to prevent overlapping fetches from overwriting manual cache additions

          setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
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
    progressTrackerStore.addProcess({
      id: processId,
      description: isExport ? `Exporting ${item.volumeTitle}` : `Backing up ${item.volumeTitle}`,
      progress: 0,
      status: 'Queued...'
    });

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
