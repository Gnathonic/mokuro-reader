import { writable, get } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import { progressTrackerStore } from './progress-tracker';
import type { WorkerTask } from './worker-pool';
import type { VolumeMetadata as WorkerVolumeMetadata } from './worker-pool';
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
import {
  getImageMimeType,
  isImageExtension,
  processVolume,
  saveVolume,
  isSystemFile
} from '$lib/import';
import type { DecompressedVolume } from '$lib/import';
import { extractTitlesFromPath, generateDeterministicUUID } from './series-extraction';

export interface QueueItem {
  volumeUuid: string;
  cloudFileId: string;
  cloudProvider: ProviderType;
  seriesTitle: string;
  volumeTitle: string;
  volumeMetadata: VolumeMetadata;
  status: 'queued' | 'downloading';
  libraryId?: string;
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

function getBaseStem(basePath: string): string {
  const filename = basePath.split('/').pop() || basePath;
  return filename.replace(/\.(cbz|zip|cbr|rar|7z)$/i, '');
}

function isThumbnailSidecar(filename: string, basePath: string): boolean {
  const normalized = filename.toLowerCase();
  if (normalized.includes('/')) return false;
  const stem = getBaseStem(basePath).toLowerCase();
  return normalized === `${stem}.webp`;
}

async function parseMokuroGzEntry(
  entry: DecompressedEntry,
  normalizedFilename: string
): Promise<File | null> {
  if (typeof DecompressionStream === 'undefined') {
    return null;
  }

  const stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('gzip'));
  const decompressedBlob = await new Response(stream).blob();
  const mokuroName = normalizedFilename.replace(/\.gz$/i, '');
  return new File([decompressedBlob], mokuroName, { type: 'application/json' });
}

// Internal queue state
const queueStore = writable<QueueItem[]>([]);

// Track if this queue is currently using the shared pool
let processingStarted = false;

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
    status: 'queued',
    libraryId: volume.libraryId
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
 *   "Sample Series 01.cbz" => { series: "Sample Series", volume: "01" }
 *   "Another Test Manga Vol 05.cbz" => { series: "Another Test Manga", volume: "05" }
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
  const placeholders: VolumeMetadata[] = cloudFiles
    .filter((file) => file.path.toLowerCase().endsWith('.cbz'))
    .map((file) => {
      // Look up file in cache to get proper path with parent folder
      // The cache has the full path (e.g., "SeriesName/Volume01.cbz")
      const cachedFile = unifiedCloudManager.getCloudVolume(file.fileId);
      const filePath = cachedFile?.path || file.path;

      // Use sophisticated extraction for consistent series names
      const { seriesTitle, volumeTitle } = extractTitlesFromPath(filePath);

      // Generate deterministic UUIDs from series + volume names
      // This ensures the same volume gets the same UUID across devices
      const seriesUuid = generateDeterministicUUID(seriesTitle);
      const volumeUuid = generateDeterministicUUID(`${seriesTitle}/${volumeTitle}`);

      return {
        mokuro_version: '0.0.0', // Placeholder - will be updated after download
        series_title: seriesTitle,
        series_uuid: seriesUuid,
        volume_title: volumeTitle,
        volume_uuid: volumeUuid,
        page_count: 0, // Placeholder - will be updated after download
        character_count: 0, // Placeholder - will be updated after download
        page_char_counts: [], // Placeholder - will be updated after download
        isPlaceholder: true,
        cloudProvider: file.provider,
        cloudFileId: file.fileId,
        cloudModifiedTime: file.modifiedTime,
        cloudSize: file.size,
        cloudPath: filePath // Store path for processing (from cache if available)
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
async function getProviderCredentials(
  provider: ProviderType,
  fileId: string,
  libraryId?: string
): Promise<any> {
  if (libraryId) {
    const { getLibraryById } = await import('$lib/settings/libraries');
    const library = getLibraryById(libraryId);
    if (!library) {
      throw new Error(`Library not found: ${libraryId}`);
    }
    return {
      webdavUrl: library.serverUrl.replace(/\/$/, ''),
      webdavUsername: library.username,
      webdavPassword: library.password
    };
  }

  const activeProvider = unifiedCloudManager.getActiveProvider();
  if (!activeProvider || activeProvider.type !== provider) {
    throw new Error(`Active provider mismatch for download credentials: expected ${provider}`);
  }
  return activeProvider.getWorkerDownloadCredentials
    ? await activeProvider.getWorkerDownloadCredentials(fileId)
    : {};
}

/**
 * Convert worker decompressed entries to DecompressedVolume format
 * for use with the unified import system
 */
async function entriesToDecompressedVolume(
  entries: DecompressedEntry[],
  basePath: string
): Promise<DecompressedVolume> {
  let mokuroFile: File | null = null;
  let thumbnailSidecar: File | null = null;
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
    } else if (normalizedFilename.endsWith('.mokuro.gz')) {
      const decompressedMokuro = await parseMokuroGzEntry(entry, normalizedFilename);
      if (decompressedMokuro) {
        mokuroFile = decompressedMokuro;
      }
    } else if (isThumbnailSidecar(normalizedFilename, basePath)) {
      const mimeType = getImageMimeType(extension);
      thumbnailSidecar = new File([entry.data], normalizedFilename, { type: mimeType });
      console.log('[Download Queue] Detected thumbnail sidecar entry:', normalizedFilename);
    } else if (['zip', 'cbz', 'cbr', 'rar', '7z'].includes(extension)) {
      // Nested archive
      nestedArchives.push(new File([entry.data], normalizedFilename));
    } else {
      // Only keep known image extensions as pages.
      // Unknown files were previously coerced to application/octet-stream and surfaced
      // as broken "page 1" entries in the cover picker.
      if (!isImageExtension(extension)) {
        continue;
      }
      const mimeType = getImageMimeType(extension);
      imageFiles.set(
        normalizedFilename,
        new File([entry.data], normalizedFilename, { type: mimeType })
      );
    }
  }

  return {
    mokuroFile,
    thumbnailSidecar,
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
  // Use the original cloud path for basePath to get proper series extraction
  // Falls back to volume_title if cloudPath not available (older placeholders)
  const basePath =
    (placeholder as VolumeMetadata & { cloudPath?: string }).cloudPath || placeholder.volume_title;

  // Convert entries to DecompressedVolume format
  const decompressedVolume = await entriesToDecompressedVolume(entries, basePath);

  // Use unified import system to process the volume
  // This handles missing pages, image-only volumes, placeholder generation, etc.
  const processedVolume = await processVolume(decompressedVolume);

  // Keep cloud placeholder series identity for image-only imports so they stay grouped
  // with existing volumes before OCR sidecars are applied.
  const isImageOnly =
    !processedVolume.metadata.mokuroVersion || processedVolume.metadata.mokuroVersion.trim() === '';
  if (isImageOnly) {
    processedVolume.metadata.series = placeholder.series_title;
    processedVolume.metadata.seriesUuid = placeholder.series_uuid;
    processedVolume.metadata.volume = placeholder.volume_title;
    processedVolume.metadata.volumeUuid = placeholder.volume_uuid;
  }

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

function getSidecarCandidatesForPlaceholder(placeholder: VolumeMetadata): string[] {
  const cloudPath =
    (placeholder as VolumeMetadata & { cloudPath?: string }).cloudPath ||
    `${placeholder.series_title}/${placeholder.volume_title}.cbz`;
  const noExt = cloudPath.replace(/\.(cbz|zip|cbr|rar|7z)$/i, '');
  return [`${noExt}.mokuro`, `${noExt}.mokuro.gz`, `${noExt}.webp`];
}

function normalizePathKey(value: string): string {
  return normalizeFilename(value).toLowerCase();
}

function basename(path: string): string {
  return path.split('/').pop() || path;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx) : '';
}

function findSidecarFiles(
  placeholder: VolumeMetadata,
  allFiles: import('./sync/provider-interface').CloudFileMetadata[]
): import('./sync/provider-interface').CloudFileMetadata[] {
  const exactCandidates = new Set(
    getSidecarCandidatesForPlaceholder(placeholder).map((candidate) => normalizePathKey(candidate))
  );

  // Fast path: exact normalized path match
  const exactMatches = allFiles.filter((file) => exactCandidates.has(normalizePathKey(file.path)));
  if (exactMatches.length > 0) {
    console.log(
      '[Download Queue] Sidecar exact matches:',
      exactMatches.map((file) => file.path)
    );
    return exactMatches;
  }

  // Fallback: robust basename/stem matching to handle encoded paths and naming variance.
  const targetStem = normalizePathKey(placeholder.volume_title);
  const cloudPath =
    (placeholder as VolumeMetadata & { cloudPath?: string }).cloudPath ||
    `${placeholder.series_title}/${placeholder.volume_title}.cbz`;
  const cloudDir = normalizePathKey(dirname(cloudPath));
  const seriesPrefix = `${normalizePathKey(placeholder.series_title)}/`;

  const fallbackMatches = allFiles.filter((file) => {
    const filePathKey = normalizePathKey(file.path);
    // Prefer the original cloud directory when available, then fall back to series title.
    if (
      cloudDir &&
      !filePathKey.startsWith(`${cloudDir}/`) &&
      !filePathKey.startsWith(seriesPrefix)
    ) {
      return false;
    }

    const name = normalizePathKey(basename(file.path));
    return (
      name === `${targetStem}.mokuro` ||
      name === `${targetStem}.mokuro.gz` ||
      name === `${targetStem}.webp`
    );
  });

  if (fallbackMatches.length > 0) {
    console.log(
      '[Download Queue] Sidecar fallback matches:',
      fallbackMatches.map((file) => file.path)
    );
    return fallbackMatches;
  }

  console.log(
    '[Download Queue] No sidecar matches found for:',
    placeholder.series_title,
    placeholder.volume_title
  );
  return [];
}

async function downloadSidecarEntries(placeholder: VolumeMetadata): Promise<DecompressedEntry[]> {
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider) return [];

  const allFiles = unifiedCloudManager.getAllCloudVolumes();
  const selected = findSidecarFiles(placeholder, allFiles);
  if (selected.length > 0) {
    console.log(
      '[Download Queue] Downloading sidecars:',
      selected.map((sidecar) => sidecar.path)
    );
  }

  const sidecarEntries: DecompressedEntry[] = [];
  for (const sidecar of selected) {
    const blob = await provider.downloadFile(sidecar);
    const data = await blob.arrayBuffer();
    sidecarEntries.push({
      filename: sidecar.path.split('/').pop() || sidecar.path,
      data
    });
  }

  return sidecarEntries;
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
async function cleanupProviderDownloadCredentials(
  providerType: ProviderType,
  fileId: string
): Promise<void> {
  const activeProvider = unifiedCloudManager.getActiveProvider();
  if (!activeProvider || activeProvider.type !== providerType) return;
  if (activeProvider.cleanupWorkerDownload) {
    await activeProvider.cleanupWorkerDownload(fileId);
  }
}

/**
 * Process download using workers for all providers
 * - Google Drive: Workers download with OAuth token and decompress
 * - WebDAV: Workers download with Basic Auth and decompress
 * - MEGA: Workers download from share link via MEGA API and decompress
 */
async function processDownload(item: QueueItem, processId: string): Promise<void> {
  const isLibraryDownload = !!item.libraryId;
  const provider = isLibraryDownload ? null : unifiedCloudManager.getActiveProvider();

  if (!isLibraryDownload && !provider) {
    handleDownloadError(item, processId, `No cloud provider authenticated`);
    return;
  }

  const pool = await getFileProcessingPool();
  const fileSize = getCloudSize(item.volumeMetadata) || 0;

  const providerType = isLibraryDownload ? 'webdav' : provider!.type;
  const downloadConcurrencyLimit = isLibraryDownload ? 8 : provider!.downloadConcurrencyLimit;
  const supportsWorkerDownload = isLibraryDownload ? true : provider!.supportsWorkerDownload;

  if (supportsWorkerDownload) {
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
      provider: `${providerType}:download`,
      providerConcurrencyLimit: downloadConcurrencyLimit,
      metadata: workerMetadata,
      // Defer credential fetching until worker is actually ready (prevents race conditions in queue ordering)
      prepareData: async () => {
        // Get provider credentials (for MEGA, this creates a temporary share link)
        const credentials = await getProviderCredentials(
          providerType,
          item.cloudFileId,
          item.libraryId
        );

        return {
          mode: 'download-and-decompress',
          provider: providerType,
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

          const sidecarEntries = await downloadSidecarEntries(item.volumeMetadata);
          const allEntries =
            sidecarEntries.length > 0 ? [...data.entries, ...sidecarEntries] : data.entries;
          console.log(
            '[Download Queue] Sidecar entries merged:',
            sidecarEntries.map((entry) => entry.filename)
          );
          await processVolumeData(allEntries, item.volumeMetadata);

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
          if (!isLibraryDownload) {
            await cleanupProviderDownloadCredentials(provider!.type, item.cloudFileId);
          }
          releaseMemory();
          checkAndTerminatePool();
        }
      },
      onError: async (data) => {
        console.error(`Error downloading ${item.volumeTitle}:`, data.error);
        if (!isLibraryDownload) {
          await cleanupProviderDownloadCredentials(provider!.type, item.cloudFileId);
        }
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
  const isLibraryDownload = !!item.libraryId;
  const provider = unifiedCloudManager.getActiveProvider();
  if (!isLibraryDownload && !provider) {
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
