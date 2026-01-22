import { writable, get } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import { progressTrackerStore } from './progress-tracker';
import type { WorkerTask } from './worker-pool';
import type { VolumeMetadata as WorkerVolumeMetadata } from './worker-pool';
import { tokenManager } from './sync/providers/google-drive/token-manager';
import { db } from '$lib/catalog/db';
import { driveApiClient } from './sync/providers/google-drive/api-client';
import { driveFilesCache } from './sync/providers/google-drive/drive-files-cache';
import { unifiedCloudManager } from './sync/unified-cloud-manager';
import {
  getCloudFileId,
  getCloudProvider,
  getCloudSize,
  getCloudModifiedTime
} from './cloud-fields';
import type { ProviderType } from './sync/provider-interface';
import {
  getFileProcessingPool,
  incrementPoolUsers,
  decrementPoolUsers
} from './file-processing-pool';
import { normalizeFilename } from './misc';
import { getImageMimeType, processVolume, saveVolume, isSystemFile } from '$lib/import';
import type { DecompressedVolume } from '$lib/import';

export interface QueueItem {
  volumeUuid: string;
  cloudFileId: string;
  cloudProvider: ProviderType;
  seriesTitle: string;
  volumeTitle: string;
  volumeMetadata: VolumeMetadata;
  status: 'queued' | 'downloading';
}

interface SeriesQueueStatus {
  hasQueued: boolean;
  hasDownloading: boolean;
  queuedCount: number;
  downloadingCount: number;
}

interface DecompressedEntry {
  filename: string;
  data: ArrayBuffer;
}

// Internal queue state
const queueStore = writable<QueueItem[]>([]);

// Track if this queue is currently using the shared pool
let processingStarted = false;

// Track MEGA share links that need cleanup after download
const megaShareLinksToCleanup = new Map<string, string>(); // fileId -> fileId (for cleanup)

// Rate limiting for MEGA share link creation using a promise chain as mutex
let megaShareLinkMutex: Promise<void | { megaShareUrl: string }> = Promise.resolve();
const MEGA_SHARE_LINK_THROTTLE_MS = 200; // 200ms between share link creations

// Subscribe to queue changes and update progress tracker
queueStore.subscribe((queue) => {
  const totalCount = queue.length;

  if (totalCount > 0) {
    progressTrackerStore.addProcess({
      id: 'download-queue-overall',
      description: 'Download Queue',
      status: `${totalCount} in queue`,
      progress: 0 // Progress bar won't show meaningful data for growing queue
    });
  } else {
    progressTrackerStore.removeProcess('download-queue-overall');
  }
});

/**
 * Add a single volume to the download queue
 */
export function queueVolume(volume: VolumeMetadata): void {
  const cloudFileId = getCloudFileId(volume);
  const cloudProvider = getCloudProvider(volume);

  if (!volume.isPlaceholder || !cloudFileId || !cloudProvider) {
    console.warn('Can only queue placeholder volumes with cloud file IDs');
    return;
  }

  const queue = get(queueStore);

  // Check for duplicates by volumeUuid or cloudFileId
  const isDuplicate = queue.some(
    (item) => item.volumeUuid === volume.volume_uuid || item.cloudFileId === cloudFileId
  );

  if (isDuplicate) {
    console.log(`Volume ${volume.volume_title} already in queue`);
    return;
  }

  const queueItem: QueueItem = {
    volumeUuid: volume.volume_uuid,
    cloudFileId,
    cloudProvider,
    seriesTitle: volume.series_title,
    volumeTitle: volume.volume_title,
    volumeMetadata: volume,
    status: 'queued'
  };

  queueStore.update((q) => [...q, queueItem]);

  // Always call processQueue to handle newly added items
  processQueue();
}

/**
 * Add multiple volumes from a series to the queue
 */
export function queueSeriesVolumes(volumes: VolumeMetadata[]): void {
  const placeholders = volumes.filter((v) => {
    const cloudFileId = getCloudFileId(v);
    return v.isPlaceholder && cloudFileId;
  });

  if (placeholders.length === 0) {
    console.warn('No placeholder volumes to queue');
    return;
  }

  // Sort alphabetically by series title first, then by volume title
  placeholders.sort((a, b) => {
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

  // Add each volume individually (duplicate check happens in queueVolume)
  placeholders.forEach((volume) => queueVolume(volume));
}

/**
 * Parse a filename to extract series and volume information
 * Examples:
 *   "Dragon Ball 01.cbz" => { series: "Dragon Ball", volume: "01" }
 *   "The Girl From the Other Side Vol 05.cbz" => { series: "The Girl From the Other Side", volume: "05" }
 */
function parseFilename(filename: string): { series: string; volume: string } {
  // Remove extension
  const nameWithoutExt = filename.replace(/\.(cbz|zip)$/i, '');

  // Try to match common patterns: "Series Name 01", "Series Name v01", "Series Name Vol 01", etc.
  const volumePattern = /^(.+?)\s+(?:vol\.?\s*|v\.?\s*)?(\d+)$/i;
  const match = nameWithoutExt.match(volumePattern);

  if (match) {
    return {
      series: match[1].trim(),
      volume: match[2].padStart(2, '0') // Ensure 2-digit volume numbers
    };
  }

  // Fallback: use entire filename as series, no volume number
  return {
    series: nameWithoutExt,
    volume: '01'
  };
}

/**
 * Queue volumes from cloud file metadata (for sideloaded files)
 * Converts CloudFileMetadata to placeholder VolumeMetadata and queues for download
 */
export function queueVolumesFromCloudFiles(
  cloudFiles: import('./sync/provider-interface').CloudFileMetadata[]
): void {
  const placeholders: VolumeMetadata[] = cloudFiles.map((file) => {
    const { series, volume } = parseFilename(file.path);

    // Generate UUIDs for the placeholder
    const seriesUuid = crypto.randomUUID();
    const volumeUuid = crypto.randomUUID();

    return {
      mokuro_version: '0.0.0', // Placeholder - will be updated after download
      series_title: series,
      series_uuid: seriesUuid,
      volume_title: `${series} ${volume}`,
      volume_uuid: volumeUuid,
      page_count: 0, // Placeholder - will be updated after download
      character_count: 0, // Placeholder - will be updated after download
      page_char_counts: [], // Placeholder - will be updated after download
      isPlaceholder: true,
      cloudProvider: file.provider,
      cloudFileId: file.fileId,
      cloudModifiedTime: file.modifiedTime,
      cloudSize: file.size
    };
  });

  queueSeriesVolumes(placeholders);
}

/**
 * Check if a specific volume is in the queue
 */
export function isVolumeInQueue(volumeUuid: string): boolean {
  const queue = get(queueStore);
  return queue.some((item) => item.volumeUuid === volumeUuid);
}

/**
 * Get queue status for an entire series
 */
export function getSeriesQueueStatus(seriesTitle: string): SeriesQueueStatus {
  const queue = get(queueStore);
  const seriesItems = queue.filter((item) => item.seriesTitle === seriesTitle);

  return {
    hasQueued: seriesItems.some((item) => item.status === 'queued'),
    hasDownloading: seriesItems.some((item) => item.status === 'downloading'),
    queuedCount: seriesItems.filter((item) => item.status === 'queued').length,
    downloadingCount: seriesItems.filter((item) => item.status === 'downloading').length
  };
}

/**
 * Get provider credentials for worker downloads
 * For MEGA, creates a temporary share link instead of passing credentials
 * Implements rate limiting to prevent API congestion
 */
async function getProviderCredentials(provider: ProviderType, fileId: string): Promise<any> {
  if (provider === 'google-drive') {
    let token = '';
    tokenManager.token.subscribe((value) => {
      token = value;
    })();
    return { accessToken: token };
  } else if (provider === 'webdav') {
    // Get WebDAV credentials from localStorage
    const serverUrl = localStorage.getItem('webdav_server_url');
    const username = localStorage.getItem('webdav_username');
    const password = localStorage.getItem('webdav_password');
    return { webdavUrl: serverUrl, webdavUsername: username, webdavPassword: password };
  } else if (provider === 'mega') {
    // Serialize MEGA share link creation using a promise chain as mutex
    // This prevents concurrent API calls that could trigger rate limiting
    const result = await (megaShareLinkMutex = megaShareLinkMutex.then(async () => {
      // Add throttle delay between each share link creation
      await new Promise((resolve) => setTimeout(resolve, MEGA_SHARE_LINK_THROTTLE_MS));

      // Create a temporary share link for this file (with built-in retry logic)
      const { megaProvider } = await import('./sync/providers/mega/mega-provider');
      const shareUrl = await megaProvider.createShareLink(fileId);

      // Track this share link for cleanup after download
      megaShareLinksToCleanup.set(fileId, fileId);

      return { megaShareUrl: shareUrl };
    }));

    return result;
  }
  return {};
}

/**
 * Convert worker decompressed entries to DecompressedVolume format
 * for use with the unified import system
 */
function entriesToDecompressedVolume(
  entries: DecompressedEntry[],
  basePath: string
): DecompressedVolume {
  let mokuroFile: File | null = null;
  const imageFiles = new Map<string, File>();
  const nestedArchives: File[] = [];

  for (const entry of entries) {
    // Skip system files (macOS metadata, etc.)
    if (isSystemFile(entry.filename)) {
      continue;
    }

    const normalizedFilename = normalizeFilename(entry.filename);
    const extension = normalizedFilename.toLowerCase().split('.').pop() || '';

    if (normalizedFilename.endsWith('.mokuro')) {
      // Found mokuro file
      mokuroFile = new File([entry.data], normalizedFilename, { type: 'application/json' });
    } else if (['zip', 'cbz', 'cbr', 'rar', '7z'].includes(extension)) {
      // Nested archive
      nestedArchives.push(new File([entry.data], normalizedFilename));
    } else {
      // Image file - determine MIME type
      const mimeType = getImageMimeType(extension);
      if (mimeType) {
        imageFiles.set(
          normalizedFilename,
          new File([entry.data], normalizedFilename, { type: mimeType })
        );
      }
    }
  }

  return {
    mokuroFile,
    imageFiles,
    basePath,
    sourceType: 'cloud',
    nestedArchives
  };
}

/**
 * Process downloaded volume data using unified import system
 * Handles missing pages, image-only volumes, and all other import scenarios
 */
async function processVolumeData(
  entries: DecompressedEntry[],
  placeholder: VolumeMetadata
): Promise<void> {
  // Convert entries to DecompressedVolume format
  const decompressedVolume = entriesToDecompressedVolume(entries, placeholder.volume_title);

  // Use unified import system to process the volume
  // This handles missing pages, image-only volumes, placeholder generation, etc.
  const processedVolume = await processVolume(decompressedVolume);

  // Check if volume already exists
  const existingVolume = await db.volumes
    .where('volume_uuid')
    .equals(processedVolume.metadata.volumeUuid)
    .first();

  if (!existingVolume) {
    // Save using unified database function
    await saveVolume(processedVolume);
  }

  // Update cloud file description if folder name doesn't match series title
  const cloudFileId = getCloudFileId(placeholder);
  const cloudProvider = getCloudProvider(placeholder);

  if (cloudFileId && cloudProvider) {
    try {
      const folderName = placeholder.series_title;
      const actualSeriesTitle = processedVolume.metadata.series;

      if (folderName !== actualSeriesTitle && cloudProvider === 'google-drive') {
        // Only Drive supports description updates currently
        const fileMetadata = await driveApiClient.getFileMetadata(
          cloudFileId,
          'capabilities/canEdit,description'
        );
        const canEdit = fileMetadata.capabilities?.canEdit ?? false;
        const currentDescription = fileMetadata.description || '';

        if (canEdit) {
          const hasSeriesTag = /^series:\s*.+/im.test(currentDescription);

          if (!hasSeriesTag) {
            const seriesTag = `Series: ${actualSeriesTitle}`;
            const newDescription = currentDescription
              ? `${seriesTag}\n${currentDescription}`
              : seriesTag;

            await driveApiClient.updateFileDescription(cloudFileId, newDescription);

            // Also update driveFilesCache
            driveFilesCache.updateFileDescription(cloudFileId, newDescription);
            // Update unified cloud manager cache
            unifiedCloudManager.updateCacheEntry(cloudFileId, {
              description: newDescription
            });
          }
        }
      }
    } catch (error) {
      console.warn('Failed to update cloud file description:', error);
    }
  }
}

/**
 * Handle download errors consistently
 */
function handleDownloadError(item: QueueItem, processId: string, errorMessage: string): void {
  progressTrackerStore.updateProcess(processId, {
    progress: 0,
    status: `Error: ${errorMessage}`
  });
  queueStore.update((q) => q.filter((i) => i.volumeUuid !== item.volumeUuid));
  setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
}

/**
 * Check if queue is empty and release shared pool if so
 */
function checkAndTerminatePool(): void {
  const currentQueue = get(queueStore);
  if (currentQueue.length === 0 && processingStarted) {
    decrementPoolUsers();
    processingStarted = false;
  }
}

/**
 * Cleanup MEGA share link after download completes or fails
 *
 * NOTE: Cleanup failures are not critical. MEGA likely reuses existing share links,
 * so if cleanup fails (due to disconnect, crash, etc.), the next download attempt
 * will automatically reuse the existing link. This provides a self-healing behavior
 * where orphaned links are eventually reused and cleaned up on successful downloads.
 */
async function cleanupMegaShareLink(fileId: string): Promise<void> {
  if (megaShareLinksToCleanup.has(fileId)) {
    try {
      const { megaProvider } = await import('./sync/providers/mega/mega-provider');
      await megaProvider.deleteShareLink(fileId);
      megaShareLinksToCleanup.delete(fileId);
    } catch (error) {
      console.warn(`Failed to cleanup MEGA share link for ${fileId}:`, error);
      // Still remove from tracking to prevent memory leak
      megaShareLinksToCleanup.delete(fileId);
    }
  }
}

/**
 * Process download using workers for all providers
 * - Google Drive: Workers download with OAuth token and decompress
 * - WebDAV: Workers download with Basic Auth and decompress
 * - MEGA: Workers download from share link via MEGA API and decompress
 */
async function processDownload(item: QueueItem, processId: string): Promise<void> {
  // Get the active provider (single-provider architecture - only one provider active at a time)
  const provider = unifiedCloudManager.getActiveProvider();

  if (!provider) {
    handleDownloadError(item, processId, `No cloud provider authenticated`);
    return;
  }

  const pool = await getFileProcessingPool();
  const fileSize = getCloudSize(item.volumeMetadata) || 0;

  // Check if provider supports worker downloads
  if (provider.supportsWorkerDownload) {
    // Strategy 1: Worker handles download + decompress (Drive, WebDAV, MEGA)
    // Estimate memory requirement (download + decompress + processing overhead)
    // More accurate multiplier: compressed file + decompressed data + working memory
    const memoryRequirement = Math.max(fileSize * 2.8, 50 * 1024 * 1024);

    // Create worker metadata
    const workerMetadata: WorkerVolumeMetadata = {
      volumeUuid: item.volumeUuid,
      driveFileId: item.cloudFileId,
      seriesTitle: item.seriesTitle,
      volumeTitle: item.volumeTitle,
      driveModifiedTime: getCloudModifiedTime(item.volumeMetadata) ?? undefined,
      driveSize: getCloudSize(item.volumeMetadata) ?? undefined
    };

    // Create worker task for download+decompress
    const task: WorkerTask = {
      id: item.cloudFileId,
      memoryRequirement,
      provider: `${provider.type}:download`, // Provider:operation identifier for concurrency tracking
      providerConcurrencyLimit: provider.downloadConcurrencyLimit, // Provider's download limit
      metadata: workerMetadata,
      // Defer credential fetching until worker is actually ready (prevents race conditions in queue ordering)
      prepareData: async () => {
        // Get provider credentials (for MEGA, this creates a temporary share link)
        const credentials = await getProviderCredentials(provider.type, item.cloudFileId);

        return {
          mode: 'download-and-decompress',
          provider: provider.type,
          fileId: item.cloudFileId,
          fileName: item.volumeTitle + '.cbz',
          credentials,
          metadata: workerMetadata
        };
      },
      onProgress: (data) => {
        const percent = Math.round((data.loaded / data.total) * 100);
        progressTrackerStore.updateProcess(processId, {
          progress: percent * 0.9, // 0-90% for download
          status: `Downloading... ${percent}%`
        });
      },
      onComplete: async (data, releaseMemory) => {
        try {
          progressTrackerStore.updateProcess(processId, {
            progress: 95,
            status: 'Processing files...'
          });

          await processVolumeData(data.entries, item.volumeMetadata);

          progressTrackerStore.updateProcess(processId, {
            progress: 100,
            status: 'Download complete'
          });

          queueStore.update((q) => q.filter((i) => i.volumeUuid !== item.volumeUuid));
          setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);

          // Process next item in queue
          processQueue();
        } catch (error) {
          console.error(`Failed to process ${item.volumeTitle}:`, error);
          handleDownloadError(
            item,
            processId,
            error instanceof Error ? error.message : 'Unknown error'
          );
        } finally {
          // Cleanup MEGA share link if this was a MEGA download
          await cleanupMegaShareLink(item.cloudFileId);
          releaseMemory();
          checkAndTerminatePool();
        }
      },
      onError: async (data) => {
        console.error(`Error downloading ${item.volumeTitle}:`, data.error);
        // Cleanup MEGA share link if this was a MEGA download
        await cleanupMegaShareLink(item.cloudFileId);
        handleDownloadError(item, processId, data.error);
        checkAndTerminatePool();

        // Process next item in queue even after error
        processQueue();
      }
    };

    pool.addTask(task);
  }
}

/**
 * Process the queue - unified download handling for all providers
 * Processes items one at a time to preserve queue ordering
 * When a download completes, processQueue() is called again to start the next item
 */
async function processQueue(): Promise<void> {
  // Check if there are queued items and initialize pool if needed
  // Take initial snapshot just to check if we need to initialize
  const initialQueue = get(queueStore);
  const hasQueuedItems = initialQueue.some((item) => item.status === 'queued');

  // Mark processing as started and register as pool user if we have queued items
  if (hasQueuedItems && !processingStarted) {
    processingStarted = true;
    incrementPoolUsers();

    // Pre-initialize the pool BEFORE processing any items
    await getFileProcessingPool();
  }

  // CRITICAL: Re-fetch queue state AFTER any await points
  // This prevents race conditions where multiple processQueue() calls interleave
  // and process the same item using stale snapshots
  const queue = get(queueStore);
  const queuedItems = queue.filter((item) => item.status === 'queued');

  // Process only the FIRST queued item to preserve ordering
  // When it completes, it will call processQueue() again to process the next item
  // This ensures downloads complete in the order they were queued
  const item = queuedItems[0];
  if (!item) {
    return; // No queued items
  }

  // Get active provider (single-provider architecture)
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider) {
    console.error(`[Download Queue] No cloud provider authenticated, skipping ${item.volumeTitle}`);
    return;
  }

  // Mark as downloading
  queueStore.update((q) =>
    q.map((i) => (i.volumeUuid === item.volumeUuid ? { ...i, status: 'downloading' as const } : i))
  );

  const processId = `download-${item.cloudFileId}`;

  // Add progress tracker
  progressTrackerStore.addProcess({
    id: processId,
    description: `Downloading ${item.volumeTitle}`,
    progress: 0,
    status: 'Starting download...'
  });

  // Start download - process one at a time to preserve queue ordering
  // When this completes, onComplete will call processQueue() to start the next item
  processDownload(item, processId);
}

// Export the store for reactive subscriptions
export const downloadQueue = {
  subscribe: queueStore.subscribe,
  queueVolume,
  queueSeriesVolumes,
  isVolumeInQueue,
  getSeriesQueueStatus
};
