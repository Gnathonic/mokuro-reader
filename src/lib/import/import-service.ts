/**
 * Import Service
 *
 * Main entry point for importing volumes from local files.
 * Orchestrates the pairing, routing, processing, and database operations.
 */

import { writable, get } from 'svelte/store';
import { pairMokuroWithSources } from './pairing';
import {
  archiveSourceLabel,
  isThumbnailSidecarPath,
  joinTitlePath,
  planArchiveListing,
  prescanArchives,
  stripArchiveExtension,
  type ArchiveScan,
  type ListedEntry
} from './archive-listing';
import { decideImportRouting } from './routing';
import { processVolume, parseMokuroFile, matchImagesToPages } from './processing';
import { saveVolume, storedTitleSegment, volumeExists } from './database';
import {
  applyImportedSeriesFiles,
  collectSeriesFileFromBytes,
  collectSeriesFileFromFile,
  recordImportedSeriesTitle,
  resetImportedSeriesFiles
} from './series-file-import';
import { isSeriesFilePath } from '$lib/metadata/series-file';
import { hasWritableNonServerProvider } from '$lib/metadata/series-backfill';
import { scheduleSeriesFileWrite } from '$lib/metadata/series-file-sync';
import { createLocalQueueItem, requiresWorkerDecompression } from './local-provider';
import type {
  ArchiveReview,
  FileEntry,
  PairedSource,
  ImportQueueItem,
  DecompressedVolume,
  ProcessedVolume
} from './types';
import { isImageExtension, parseFilePath, isSystemFile } from './types';
import {
  getFileProcessingPool,
  incrementPoolUsers,
  decrementPoolUsers
} from '$lib/util/file-processing-pool';
import { getImportUiBridge, type MissingFilesInfo } from './import-ui';
import {
  applyStashedLayersFor,
  attachLayerFile,
  clearStashedLayerEntries,
  extractLayerEntries,
  stashLayerEntries
} from '$lib/reader/edit/layer-import';
import type { ImportNames } from './image-only-naming';
import {
  groupCandidates,
  nameGroup,
  type ReviewCandidate,
  type ReviewGroup
} from './image-only-review';
import type { GroupDecision } from './review-session';
import { existingVolumeCount } from './library-series';
import { miscSettings } from '$lib/settings/misc';
import { generateUUID } from '$lib/util/uuid';
import { requestPersistentStorage } from '$lib/util/upload';
import {
  extractArchiveByVolumes,
  decompressArchive,
  type VolumeExtractDef,
  type ExtractFilter as ArchiveExtractFilter
} from './archive-extraction';

// ============================================
// QUEUE STORE
// ============================================

/**
 * Import queue store for tracking import progress
 */
export const importQueue = writable<ImportQueueItem[]>([]);

/**
 * Currently processing item
 */
export const currentImport = writable<ImportQueueItem | null>(null);

/**
 * Whether an import is in progress
 */
export const isImporting = writable<boolean>(false);

// ============================================
// PROGRESS TRACKER SYNC
// ============================================

/**
 * Add an import item to the global progress tracker
 */
function addToProgressTracker(item: ImportQueueItem): void {
  getImportUiBridge().addProgress(
    `import-${item.id}`,
    `Importing ${item.displayTitle}`,
    'Queued',
    0
  );
}

/**
 * Update an import item's progress in the global tracker
 */
function updateProgressTracker(id: string, status: string, progress: number): void {
  getImportUiBridge().updateProgress(`import-${id}`, status, progress);
}

/**
 * Remove an import item from the global progress tracker
 */
function removeFromProgressTracker(id: string): void {
  getImportUiBridge().removeProgress(`import-${id}`);
}

/**
 * Mark an import as failed in the progress tracker (keeps visible briefly)
 */
function markProgressTrackerError(id: string, error: string): void {
  getImportUiBridge().updateProgress(`import-${id}`, `Failed: ${error}`, 0);
  // Remove after delay so user can see the error
  setTimeout(() => {
    removeFromProgressTracker(id);
  }, 5000);
}

// ============================================
// FILE CONVERSION
// ============================================

/**
 * Convert File objects to FileEntry format
 */
function filesToEntries(files: File[]): FileEntry[] {
  const sourceStems = new Set(
    files
      .map((file) => file.webkitRelativePath || file.name)
      .map((path) => path.split('/').pop() || path)
      .map((name) => {
        const lower = name.toLowerCase();
        if (lower.endsWith('.mokuro.gz')) return name.slice(0, -10);
        if (lower.endsWith('.mokuro')) return name.slice(0, -7);
        if (/\.(cbz|zip|cbr|rar|7z)$/i.test(name))
          return name.replace(/\.(cbz|zip|cbr|rar|7z)$/i, '');
        return '';
      })
      .filter(Boolean)
      .map((stem) => stem.toLowerCase())
  );

  return files
    .map((file) => {
      // Use webkitRelativePath if available, otherwise use name
      const path = file.webkitRelativePath || file.name;
      return { path, file };
    })
    .filter((entry) => !isThumbnailSidecarPath(entry.path, sourceStems));
}

function getThumbnailCandidatePaths(basePath: string): string[] {
  return [`${basePath}.webp`];
}

/**
 * Image-only review groups offered but not decided yet (#285). An approval
 * still has volumes to save, so they keep a batch's `series.json` waiting.
 */
let pendingReviewGroups = 0;

/**
 * Is work still outstanding — queued, processing, or waiting in review?
 *
 * Deliberately NOT `queue.length === 0`: failed items stay in the store until
 * the user clears them, and a pinned `error` item must not stop later imports
 * from applying their `series.json` (the pending files would then sit in the
 * batch and risk being keyed to an unrelated import).
 */
function hasUnfinishedImports(): boolean {
  return (
    pendingReviewGroups > 0 ||
    get(importQueue).some((item) => item.status === 'queued' || item.status === 'processing')
  );
}

/**
 * Note the series title a saved volume ended up under, so a `series.json` that
 * came with this import can be keyed to it once the batch is done.
 *
 * Also the disk-import half of the install trigger (`download-queue.ts`'s
 * `processVolumeData` is the cloud half): a volume imported from disk carries
 * measured page/char counts that a published 0/0 no-metadata entry for the
 * same archive is waiting on, and without a schedule here nothing publishes
 * them — installing was the one event that never scheduled a `series.json`
 * write. Same shape as the cloud half: the 2 s per-series debounce coalesces
 * a batch import into ~one write, the gate keeps read-only and
 * server-compiled providers untouched, and a series the cloud does not hold
 * is dropped by the write's own fire-time gates.
 */
function noteImportedVolume(processed: ProcessedVolume): void {
  recordImportedSeriesTitle(
    storedTitleSegment(processed.metadata.series),
    processed.metadata.volumeUuid
  );
  // Layer files that rode beside this volume in the batch attach now that its
  // row exists. Never throws; a layer that finds no volume simply stays behind.
  void applyStashedLayersFor(processed.metadata.volumeUuid, processed.metadata.volume);
  if (hasWritableNonServerProvider()) {
    scheduleSeriesFileWrite(storedTitleSegment(processed.metadata.series));
  }
}

// ============================================
// ARCHIVE DECOMPRESSION (via Worker)
// ============================================

interface DecompressedEntry {
  filename: string;
  data: ArrayBuffer;
}

/**
 * Filter options for selective extraction
 */
interface ExtractFilter {
  extensions?: string[];
  pathPrefixes?: string[];
}

/**
 * Raw decompression result - entries from the archive
 */
interface RawDecompressedArchive {
  entries: DecompressedEntry[];
}

/**
 * Decompress an archive and return raw entries
 * Uses streaming via BlobReader - handles large files (>2GB) without ArrayBuffer limits
 * Optional filter allows extracting only specific files (mokuro first, then images per volume)
 * If listOnly is true, returns file list without extracting content (for planning)
 * If listAllExtractFiltered is true, lists ALL files but only extracts content for filtered ones
 *
 * In test environment (no Worker available), uses direct extraction.
 * In browser, uses Worker pool for off-main-thread processing.
 */
async function decompressArchiveRaw(
  archiveFile: File,
  onProgress?: (status: string, progress: number) => void,
  filter?: ExtractFilter,
  listOnly?: boolean,
  listAllExtractFiltered?: boolean
): Promise<RawDecompressedArchive> {
  onProgress?.(listOnly ? 'Scanning...' : 'Decompressing...', 10);

  // Check if we're in a test environment (vitest with jsdom)
  // In tests, use direct extraction instead of workers
  // Check multiple indicators since environment detection varies
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalProcess = (globalThis as any).process;
  const isTestEnvironment =
    globalProcess?.env?.NODE_ENV === 'test' ||
    globalProcess?.env?.VITEST === 'true' ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__vitest__ !== undefined;

  if (isTestEnvironment) {
    // Direct extraction for test environment
    const archiveFilter: ArchiveExtractFilter | undefined = filter
      ? { extensions: filter.extensions, pathPrefixes: filter.pathPrefixes }
      : undefined;

    const entries = await decompressArchive(
      archiveFile,
      archiveFilter,
      listOnly,
      listAllExtractFiltered,
      (extracted, total) => {
        const pct = Math.round((extracted / total) * 40) + 10;
        onProgress?.(listOnly ? 'Scanning...' : 'Decompressing...', pct);
      }
    );

    return { entries };
  }

  // Get the worker pool
  const pool = await getFileProcessingPool();

  // Pass File directly to worker - BlobReader will stream it without loading into ArrayBuffer
  // This avoids the 2GB ArrayBuffer limit and reduces memory pressure
  const entries = await new Promise<DecompressedEntry[]>((resolve, reject) => {
    const taskId = generateUUID();

    pool.addTask({
      id: taskId,
      data: {
        mode: 'decompress-only',
        fileId: taskId,
        fileName: archiveFile.name,
        blob: archiveFile, // Pass File directly - it's a Blob subclass
        filter, // Optional filter for selective extraction
        listOnly, // If true, return file list without content
        listAllExtractFiltered // If true, list all but only extract filtered
      },
      memoryRequirement: listOnly
        ? 1024 * 1024
        : filter
          ? archiveFile.size * 0.1
          : archiveFile.size * 3,
      onProgress: (progress) => {
        if (progress.loaded && progress.total) {
          const pct = Math.round((progress.loaded / progress.total) * 40) + 10;
          onProgress?.(listOnly ? 'Scanning...' : 'Decompressing...', pct);
        }
      },
      onComplete: (result, completeTask) => {
        completeTask();
        if (result.entries) {
          resolve(result.entries);
        } else {
          reject(new Error('No entries returned from worker'));
        }
      },
      onError: (error) => {
        reject(new Error(error.error || 'Worker decompression failed'));
      }
    });
  });

  return { entries };
}

/**
 * Stream extract images for ALL volumes in a single archive pass
 * Opens the archive ONCE, extracts images for all volumes, groups by volume ID
 * Much faster than opening archive N times for N volumes
 *
 * In test environment (no Worker available), uses direct extraction.
 * In browser, uses Worker for off-main-thread processing.
 */
async function streamExtractAllVolumes(
  archiveFile: File,
  volumes: VolumeExtractDef[],
  onProgress?: (status: string, progress: number) => void
): Promise<Map<string, Map<string, File>>> {
  // Check if we're in a test environment (vitest with jsdom)
  // In tests, use direct extraction instead of workers
  // Check multiple indicators since environment detection varies
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalProcess = (globalThis as any).process;
  const isTestEnvironment =
    globalProcess?.env?.NODE_ENV === 'test' ||
    globalProcess?.env?.VITEST === 'true' ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__vitest__ !== undefined;

  if (isTestEnvironment) {
    // Direct extraction for test environment
    return extractArchiveByVolumes(archiveFile, volumes, (extracted, total) => {
      const pct = Math.round((extracted / total) * 100);
      onProgress?.(`Extracting... ${pct}%`, pct);
    });
  }

  // Worker-based extraction for browser
  const allVolumeFiles = new Map<string, Map<string, File>>();

  // Initialize maps for each volume
  for (const vol of volumes) {
    allVolumeFiles.set(vol.id, new Map());
  }

  return new Promise((resolve, reject) => {
    const taskId = generateUUID();

    // Create a dedicated worker for streaming
    const worker = new Worker(new URL('$lib/workers/unified-file-worker.ts', import.meta.url), {
      type: 'module'
    });

    const cleanup = () => {
      worker.terminate();
    };

    worker.onmessage = (event) => {
      const msg = event.data;

      if (msg.type === 'stream-entry') {
        // Skip system files
        if (isSystemFile(msg.entry.filename)) return;

        // Find which volume this belongs to
        const volumeFiles = allVolumeFiles.get(msg.volumeId);
        if (volumeFiles) {
          // Find the prefix for this volume to calculate relative path
          const vol = volumes.find((v) => v.id === msg.volumeId);
          const prefix = vol?.pathPrefix || '';

          const filename = msg.entry.filename.split('/').pop() || msg.entry.filename;
          const relativePath = msg.entry.filename.startsWith(prefix + '/')
            ? msg.entry.filename.slice(prefix.length + 1)
            : msg.entry.filename;
          const file = new File([msg.entry.data], filename, { lastModified: Date.now() });
          volumeFiles.set(relativePath, file);
        }
      } else if (msg.type === 'progress' && msg.fileId === taskId) {
        const pct = Math.round((msg.loaded / msg.total) * 100);
        onProgress?.(`Extracting... ${pct}%`, pct);
      } else if (msg.type === 'stream-complete' && msg.fileId === taskId) {
        cleanup();
        resolve(allVolumeFiles);
      } else if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.error || 'Stream extraction failed'));
      }
    };

    worker.onerror = (err) => {
      cleanup();
      reject(new Error(`Worker error: ${err.message}`));
    };

    // Start streaming extraction for ALL volumes at once
    worker.postMessage({
      mode: 'stream-extract',
      fileId: taskId,
      fileName: archiveFile.name,
      blob: archiveFile,
      volumes: volumes.map((v) => ({ id: v.id, pathPrefix: v.pathPrefix }))
    });
  });
}

/**
 * The "keep folder names as titles" import setting (#285), read when a volume
 * is named, so every path — prompt, directory, archive, nested archive — sees
 * the same value.
 */
function keepFolderNames(): boolean {
  return get(miscSettings).keepFolderNamesAsTitles === true;
}

/**
 * Process an archive using streaming extraction for memory efficiency.
 * Opens archive once to scan + extract mokuro files, then streams images.
 *
 * @param archiveTitlePath - Where the archive itself sits, extension dropped,
 *   for verbatim titles ("keep folder names"); defaults to the file's own
 *   picked path. A nested archive passes its outer archive's path + its own.
 * @param review - Names approved in the pre-import review; without it,
 *   image-only volumes are reviewed here (nested archives, unlisted archives,
 *   deep links).
 */
async function processArchiveContents(
  archiveFile: File,
  externalMokuroFile: File | null,
  onProgress?: (status: string, progress: number) => void,
  archiveTitlePath?: string,
  review?: ArchiveReview
): Promise<{
  success: boolean;
  error?: string;
  nestedSources?: PairedSource[];
}> {
  onProgress?.('Scanning archive...', 5);

  // PASS 1: Single pass - list ALL files and extract mokuro files only
  // Uses listAllExtractFiltered to scan file list while extracting mokuro content
  const scanResult = await decompressArchiveRaw(
    archiveFile,
    undefined,
    { extensions: ['mokuro'] },
    false, // not listOnly
    true // listAllExtractFiltered - list all, extract only mokuro
  );

  onProgress?.('Analyzing structure...', 15);

  // The same names → pairings step the pre-import scan runs
  // (archive-listing.ts), here with the `.mokuro` bytes in hand.
  const archivePath =
    archiveTitlePath ?? stripArchiveExtension(archiveFile.webkitRelativePath || archiveFile.name);
  const plan = await planArchiveListing(
    scanResult.entries,
    { name: archiveFile.name, titlePath: archivePath },
    externalMokuroFile
  );
  for (const warning of plan.warnings) console.warn('[Archive Import]', warning);
  // `<stem>.<id>.mokuro` entries beside a volume are its OCR layers, not
  // volumes of their own: hold them until the volume is saved.
  stashLayerEntries(plan.layerEntries);
  const { mokuroPairings, imageOnlyPairings, nestedArchivePaths, seriesFilePaths } = plan;

  // Image-only volumes: named in the pre-import review when the archive was
  // listed before it was queued; otherwise reviewed now (#285).
  let confirmedImageOnlyPairings: PairedSource[] = [];
  if (imageOnlyPairings.length > 0) {
    const approved = review
      ? namesFromReview(imageOnlyPairings, plan.innerPaths, review)
      : await reviewInQueue(imageOnlyPairings, archiveFile, plan.innerPaths);
    confirmedImageOnlyPairings = imageOnlyPairings.filter((pairing) => {
      pairing.importNames = approved.get(pairing.id);
      return pairing.importNames !== undefined;
    });
  }

  // Combine confirmed pairings
  const allPairings = [...mokuroPairings, ...confirmedImageOnlyPairings];

  // Extract embedded thumbnail sidecars (small files) for matched volumes only.
  // We keep this separate from image extraction so sidecars do not become pages.
  const thumbnailCandidates = new Set<string>();
  const pairingThumbPaths = new Map<string, string[]>();
  for (const pairing of allPairings) {
    const candidates = getThumbnailCandidatePaths(pairing.basePath);
    pairingThumbPaths.set(pairing.id, candidates);
    for (const candidate of candidates) {
      thumbnailCandidates.add(candidate);
    }
  }

  // One targeted pass for the small files we only listed so far: the thumbnail
  // sidecars of the matched volumes and any `series.json` in the archive.
  const thumbnailByPath = new Map<string, File>();
  const smallFilePaths = [...thumbnailCandidates, ...seriesFilePaths];
  if (smallFilePaths.length > 0) {
    const smallResult = await decompressArchiveRaw(archiveFile, undefined, {
      pathPrefixes: smallFilePaths
    });
    for (const entry of smallResult.entries) {
      if (isSeriesFilePath(entry.filename)) {
        collectSeriesFileFromBytes(entry.filename, entry.data, archiveFile.lastModified);
        continue;
      }
      const filename = entry.filename.split('/').pop() || entry.filename;
      thumbnailByPath.set(
        entry.filename.toLowerCase(),
        new File([entry.data], filename, { lastModified: Date.now() })
      );
    }
  }

  // If no pairings and no nested archives, nothing to import
  if (allPairings.length === 0 && nestedArchivePaths.length === 0) {
    return { success: false, error: 'No importable volumes found in archive' };
  }

  // PASS 2: Extract ALL volumes' images in a single archive pass
  // This is much faster than opening the archive N times
  const allNestedSources: PairedSource[] = [];
  let successCount = 0;
  let lastError: string | undefined;
  const totalVolumes = allPairings.length;

  // Only extract and process volumes if there are pairings
  if (totalVolumes > 0) {
    // Build volume definitions for extraction
    // Use original basePath for extraction (images are at that path), not the renamed one
    const volumeDefs: VolumeExtractDef[] = allPairings.map((pairing, i) => {
      const pathPrefix = plan.innerPaths.get(pairing.id) ?? pairing.basePath;
      return {
        id: `vol-${i}`,
        pathPrefix
      };
    });

    onProgress?.(`Extracting ${totalVolumes} volumes...`, 20);

    // Single-pass extraction for all volumes
    const allVolumeFiles = await streamExtractAllVolumes(
      archiveFile,
      volumeDefs,
      (status, progress) => {
        // Extraction is 20-70% of total progress
        const overallProgress = 20 + (progress / 100) * 50;
        onProgress?.(status, overallProgress);
      }
    );
    // Process each volume sequentially (to manage memory during processing)
    for (let i = 0; i < allPairings.length; i++) {
      const pairing = allPairings[i];
      const volumeId = `vol-${i}`;
      const volumeImageFiles = allVolumeFiles.get(volumeId) || new Map();

      const processingProgress = 70 + (i / totalVolumes) * 25;
      onProgress?.(
        `Processing ${i + 1}/${totalVolumes}: ${pairing.basePath}...`,
        processingProgress
      );

      // Create DecompressedVolume for processing
      const decompressed: DecompressedVolume = {
        mokuroFile: pairing.mokuroFile,
        thumbnailSidecar: null,
        imageFiles: volumeImageFiles,
        basePath: pairing.basePath,
        titlePath: pairing.titlePath,
        importNames: pairing.importNames,
        sourceType: 'local',
        nestedArchives: []
      };

      const thumbCandidates = pairingThumbPaths.get(pairing.id) || [];
      for (const candidate of thumbCandidates) {
        const thumb = thumbnailByPath.get(candidate.toLowerCase());
        if (thumb) {
          decompressed.thumbnailSidecar = thumb;
          break;
        }
      }

      try {
        // Check for missing files before processing (same as directory flow)
        if (decompressed.mokuroFile) {
          const mokuroData = await parseMokuroFile(decompressed.mokuroFile);
          const matchResult = matchImagesToPages(mokuroData.pages, decompressed.imageFiles);

          if (matchResult.missing.length > 0) {
            // Show warning modal and wait for user decision
            const shouldContinue = await promptForMissingFiles({
              volumeName: mokuroData.volume || pairing.basePath,
              missingFiles: matchResult.missing,
              totalPages: mokuroData.pages.length
            });

            if (!shouldContinue) {
              lastError = `Import cancelled - ${matchResult.missing.length} missing files`;
              continue; // Skip this volume, continue with next
            }
          }
        }

        // Process the volume
        const processed = await processVolume(decompressed, { keepFolderNames: keepFolderNames() });

        // Check for duplicates
        if (await volumeExists(processed.metadata.volumeUuid)) {
          lastError = `Volume "${processed.metadata.volume}" already exists`;
        } else {
          // Save to database
          await saveVolume(processed);
          noteImportedVolume(processed);
          successCount++;
        }

        // Collect nested sources
        if (processed.nestedSources.length > 0) {
          allNestedSources.push(...processed.nestedSources);
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[Archive Import] Error processing volume ${i + 1}:`, err);
      }

      // Clear this volume's files to free memory before next volume
      volumeImageFiles.clear();
      allVolumeFiles.delete(volumeId);
    }
  }

  // Extract nested archives if any
  if (nestedArchivePaths.length > 0) {
    onProgress?.('Extracting nested archives...', 95);
    const nestedResult = await decompressArchiveRaw(archiveFile, undefined, {
      extensions: ['zip', 'cbz', 'cbr', 'rar', '7z']
    });

    for (const entry of nestedResult.entries) {
      const filename = entry.filename.split('/').pop() || entry.filename;
      const file = new File([entry.data], filename, { lastModified: Date.now() });
      allNestedSources.push({
        id: generateUUID(),
        mokuroFile: null,
        source: { type: 'archive', file },
        basePath: filename.replace(/\.(zip|cbz|cbr|rar|7z)$/i, ''),
        titlePath: joinTitlePath(archivePath, stripArchiveExtension(entry.filename)),
        estimatedSize: entry.data.byteLength,
        imageOnly: false
      });
    }
  }

  // Success if we imported volumes OR found nested archives to queue
  const hasNestedSources = allNestedSources.length > 0;
  return {
    success: successCount > 0 || hasNestedSources,
    error: successCount === 0 && !hasNestedSources ? lastError : undefined,
    nestedSources: hasNestedSources ? allNestedSources : undefined
  };
}

/**
 * Convert a directory-based PairedSource to DecompressedVolume
 */
function directoryToDecompressed(source: PairedSource): DecompressedVolume {
  if (source.source.type !== 'directory') {
    throw new Error('Expected directory source');
  }

  return {
    mokuroFile: source.mokuroFile,
    thumbnailSidecar: null,
    imageFiles: source.source.files,
    basePath: source.basePath,
    titlePath: source.titlePath,
    importNames: source.importNames,
    sourceType: 'local',
    nestedArchives: []
  };
}

/**
 * Convert a TOC directory source to DecompressedVolume
 * Merges all chapter files into a single volume
 */
function tocDirectoryToDecompressed(source: PairedSource): DecompressedVolume {
  if (source.source.type !== 'toc-directory') {
    throw new Error('Expected toc-directory source');
  }

  const imageFiles = new Map<string, File>();

  // Merge all chapters, preserving chapter path prefixes
  for (const [chapterName, files] of source.source.chapters) {
    for (const [filename, file] of files) {
      imageFiles.set(`${chapterName}/${filename}`, file);
    }
  }

  return {
    mokuroFile: source.mokuroFile,
    thumbnailSidecar: null,
    imageFiles,
    basePath: source.basePath,
    titlePath: source.titlePath,
    importNames: source.importNames,
    sourceType: 'local',
    nestedArchives: []
  };
}

// ============================================
// SINGLE VOLUME PROCESSING
// ============================================

/**
 * Process and save a single volume
 * Returns additional sources to queue (for multi-volume archives and nested archives)
 */
async function processSingleVolume(
  source: PairedSource,
  onProgress?: (status: string, progress: number) => void
): Promise<{ success: boolean; error?: string; additionalSources?: PairedSource[] }> {
  try {
    onProgress?.('Preparing...', 0);

    // For archive + external mokuro, process as a single explicit pair.
    // This avoids generic intra-archive pairing that can split CBZ and sidecar imports.
    if (source.source.type === 'archive' && source.mokuroFile) {
      onProgress?.('Decompressing...', 20);
      const archiveEntries = await decompressArchiveRaw(source.source.file, (status, progress) => {
        onProgress?.(status, progress);
      });

      const archiveStem = source.source.file.name
        .replace(/\.(zip|cbz|cbr|rar|7z)$/i, '')
        .toLowerCase();
      const imageFiles = new Map<string, File>();
      for (const entry of archiveEntries.entries) {
        if (isSystemFile(entry.filename)) continue;
        if (isSeriesFilePath(entry.filename)) {
          collectSeriesFileFromBytes(entry.filename, entry.data, source.source.file.lastModified);
          continue;
        }
        const ext = entry.filename.split('.').pop()?.toLowerCase() || '';
        if (!isImageExtension(ext)) continue;

        // Ignore embedded cover sidecar if it matches archive stem.
        const filename = entry.filename.split('/').pop() || entry.filename;
        const lowerFilename = filename.toLowerCase();
        if (lowerFilename.endsWith('.webp') && lowerFilename === `${archiveStem}.webp`) {
          continue;
        }

        imageFiles.set(
          entry.filename,
          new File([entry.data], filename, { lastModified: Date.now() })
        );
      }

      const decompressed: DecompressedVolume = {
        mokuroFile: source.mokuroFile,
        thumbnailSidecar: null,
        imageFiles,
        basePath: source.basePath,
        sourceType: 'local',
        nestedArchives: []
      };

      onProgress?.('Checking files...', 45);
      const mokuroData = await parseMokuroFile(source.mokuroFile);
      const matchResult = matchImagesToPages(mokuroData.pages, decompressed.imageFiles);
      if (matchResult.missing.length > 0) {
        const shouldContinue = await promptForMissingFiles({
          volumeName: mokuroData.volume || source.basePath,
          missingFiles: matchResult.missing,
          totalPages: mokuroData.pages.length
        });
        if (!shouldContinue) {
          return {
            success: false,
            error: `Import cancelled - ${matchResult.missing.length} missing files`
          };
        }
      }

      onProgress?.('Processing...', 60);
      const processed = await processVolume(decompressed, { keepFolderNames: keepFolderNames() });

      if (await volumeExists(processed.metadata.volumeUuid)) {
        return {
          success: false,
          error: `Volume "${processed.metadata.volume}" already exists`
        };
      }

      onProgress?.('Saving...', 85);
      await saveVolume(processed);
      noteImportedVolume(processed);
      onProgress?.('Complete', 100);
      return { success: true };
    }

    // For archive-only sources, use two-pass extraction for memory efficiency.
    // processArchiveContents handles scan, extraction, pairing, and saving.
    if (source.source.type === 'archive') {
      const result = await processArchiveContents(
        source.source.file,
        source.mokuroFile,
        onProgress,
        source.titlePath,
        source.archiveReview
      );

      return {
        success: result.success,
        error: result.error,
        additionalSources: result.nestedSources
      };
    }

    // Convert source to DecompressedVolume
    let decompressed: DecompressedVolume;

    if (source.source.type === 'toc-directory') {
      decompressed = tocDirectoryToDecompressed(source);
    } else {
      decompressed = directoryToDecompressed(source);
    }

    // Check for missing files before processing (only for volumes with mokuro files)
    if (decompressed.mokuroFile) {
      onProgress?.('Checking files...', 45);

      const mokuroData = await parseMokuroFile(decompressed.mokuroFile);
      const matchResult = matchImagesToPages(mokuroData.pages, decompressed.imageFiles);

      if (matchResult.missing.length > 0) {
        // Show warning modal and wait for user decision
        const shouldContinue = await promptForMissingFiles({
          volumeName: mokuroData.volume || source.basePath,
          missingFiles: matchResult.missing,
          totalPages: mokuroData.pages.length
        });

        if (!shouldContinue) {
          return {
            success: false,
            error: `Import cancelled - ${matchResult.missing.length} missing files`
          };
        }
      }
    }

    onProgress?.('Processing...', 50);

    // Process the volume
    const processed = await processVolume(decompressed, { keepFolderNames: keepFolderNames() });

    // Check for duplicates
    if (await volumeExists(processed.metadata.volumeUuid)) {
      return {
        success: false,
        error: `Volume "${processed.metadata.volume}" already exists`
      };
    }

    onProgress?.('Saving...', 80);

    // Save to database
    await saveVolume(processed);
    noteImportedVolume(processed);

    onProgress?.('Complete', 100);

    // Queue nested archives for processing
    // Add at FRONT of queue so nested archives complete before moving to other items
    if (processed.nestedSources.length > 0) {
      const queue = get(importQueue);
      const newItems = processed.nestedSources.map(createLocalQueueItem);
      newItems.forEach(addToProgressTracker);
      const processing = queue.filter((item) => item.status === 'processing');
      const queued = queue.filter((item) => item.status === 'queued');
      importQueue.set([...processing, ...newItems, ...queued]);
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

// ============================================
// QUEUE PROCESSING
// ============================================

let processingQueue = false;

/**
 * Process the import queue
 */
async function processQueue(): Promise<void> {
  if (processingQueue) return;

  processingQueue = true;
  isImporting.set(true);
  incrementPoolUsers(); // Track pool usage for proper cleanup

  try {
    while (true) {
      const queue = get(importQueue);
      const nextItem = queue.find((item) => item.status === 'queued');

      if (!nextItem) break;

      // Update status
      importQueue.update((q) =>
        q.map((item) =>
          item.id === nextItem.id ? { ...item, status: 'processing' as const } : item
        )
      );
      currentImport.set({ ...nextItem, status: 'processing' });
      updateProgressTracker(nextItem.id, 'Processing', 5);

      // Process the volume
      const result = await processSingleVolume(nextItem.source, (status, progress) => {
        importQueue.update((q) =>
          q.map((item) =>
            item.id === nextItem.id ? { ...item, status: status as any, progress } : item
          )
        );
        updateProgressTracker(nextItem.id, status, progress);
      });

      // Queue additional sources (from multi-volume archives or nested archives)
      // Add at FRONT of queue so all volumes from same archive complete together
      if (result.additionalSources && result.additionalSources.length > 0) {
        const newItems = result.additionalSources.map(createLocalQueueItem);
        newItems.forEach(addToProgressTracker);
        importQueue.update((q) => {
          // Insert after any currently processing items, before queued items
          const processing = q.filter((item) => item.status === 'processing');
          const queued = q.filter((item) => item.status === 'queued');
          return [...processing, ...newItems, ...queued];
        });
      }

      if (result.success) {
        // Remove from queue on success
        importQueue.update((q) => q.filter((item) => item.id !== nextItem.id));
        removeFromProgressTracker(nextItem.id);
      } else {
        // Mark as error
        importQueue.update((q) =>
          q.map((item) =>
            item.id === nextItem.id
              ? { ...item, status: 'error' as const, errorMessage: result.error }
              : item
          )
        );
        markProgressTrackerError(nextItem.id, result.error || 'Unknown error');
      }

      currentImport.set(null);
    }
  } finally {
    processingQueue = false;
    isImporting.set(false);
    currentImport.set(null);
    decrementPoolUsers(); // Release pool when queue is empty
    // The queue is drained and no review step is still open: every volume of
    // this batch has a stored title, so any `series.json` that came with it
    // can finally be keyed to a series. (A series still in review has
    // volumes to come; its approval runs the queue again.)
    if (!hasUnfinishedImports()) await applyImportedSeriesFiles();
  }
}

// ============================================
// MAIN ENTRY POINT
// ============================================

export interface ImportResult {
  success: boolean;
  /**
   * Volumes imported or queued by the time `importFiles` resolves. Image-only
   * volumes are not counted: they are offered for review and queued only once
   * the user approves their series (#285).
   */
  imported: number;
  failed: number;
  errors: string[];
}

/**
 * Import files into the catalog
 *
 * Main entry point for local file imports. Handles:
 * - Pairing mokuro files with image sources
 * - Routing single items directly, multiple to queue
 * - Decompressing archives
 * - Processing and saving volumes
 *
 * @param files - Array of File objects from drag-drop or file picker
 * @param options - Optional callbacks for preparation progress
 * @returns Import result with success/failure counts
 */
export interface ImportOptions {
  /** Called when pairing is complete with the number of volumes found */
  onPreparing?: (volumesFound: number) => void;
}

function createArchiveSource(archiveFile: File, mokuroFile: File | null): PairedSource {
  const path = archiveFile.webkitRelativePath || archiveFile.name;
  const { stem } = parseFilePath(path);
  const estimatedSize = archiveFile.size + (mokuroFile?.size || 0);

  return {
    id: generateUUID(),
    mokuroFile,
    source: { type: 'archive', file: archiveFile },
    basePath: stem || archiveFile.name.replace(/\.(cbz|zip|cbr|rar|7z)$/i, ''),
    estimatedSize,
    imageOnly: false
  };
}

export async function importArchiveWithOptionalMokuro(
  archiveFile: File,
  mokuroFile: File | null
): Promise<ImportResult> {
  const result: ImportResult = {
    success: true,
    imported: 0,
    failed: 0,
    errors: []
  };

  // Request persistent storage within the originating user gesture (see the
  // note in importFiles) before we await any decompression/processing work.
  void requestPersistentStorage();

  const pairedSource = createArchiveSource(archiveFile, mokuroFile);
  const queueItem = createLocalQueueItem(pairedSource);
  addToProgressTracker(queueItem);

  isImporting.set(true);
  currentImport.set({ ...queueItem, status: 'processing' });
  updateProgressTracker(queueItem.id, 'Processing', 5);

  try {
    const processResult = await processSingleVolume(pairedSource, (status, progress) => {
      updateProgressTracker(queueItem.id, status, progress);
    });

    if (processResult.additionalSources && processResult.additionalSources.length > 0) {
      const newItems = processResult.additionalSources.map(createLocalQueueItem);
      newItems.forEach(addToProgressTracker);
      importQueue.update((q) => [...q, ...newItems]);
      processQueue();
      result.imported += processResult.additionalSources.length;
    }

    if (processResult.success) {
      result.imported += 1;
      removeFromProgressTracker(queueItem.id);
    } else {
      result.success = false;
      result.failed = 1;
      result.errors.push(processResult.error || 'Unknown error');
      markProgressTrackerError(queueItem.id, processResult.error || 'Unknown error');
    }
  } finally {
    isImporting.set(false);
    currentImport.set(null);
    if (!hasUnfinishedImports()) {
      await applyImportedSeriesFiles();
    }
  }

  return result;
}

export async function importFiles(files: File[], options?: ImportOptions): Promise<ImportResult> {
  try {
    return await runImportFiles(files, options);
  } finally {
    // Anything still queued (a multi-item batch, a nested archive) has volumes
    // that are not saved yet, so its `series.json` files wait for the queue to
    // drain — `processQueue` applies them there, once every volume of the batch
    // has a stored title to key them to.
    if (!hasUnfinishedImports()) {
      await applyImportedSeriesFiles();
    }
  }
}

async function runImportFiles(files: File[], options?: ImportOptions): Promise<ImportResult> {
  const result: ImportResult = {
    success: true,
    imported: 0,
    failed: 0,
    errors: []
  };

  if (files.length === 0) {
    return result;
  }

  // Request persistent storage now, while we still hold the user gesture that
  // triggered this import. Firefox only surfaces its persistent-storage prompt
  // for a gesture-initiated request; once we await pairing/decompression below,
  // the user activation is gone and the prompt never appears. Fire-and-forget —
  // the prompt is non-blocking and resolves independently of the import.
  void requestPersistentStorage();

  try {
    // Convert to FileEntry format
    clearStashedLayerEntries();
    const picked = filesToEntries(files);

    // A picked/dropped `series.json` is not a volume — pairing ignores it, so
    // collect it here and apply it once the batch's volumes are saved.
    for (const entry of picked) {
      if (isSeriesFilePath(entry.path)) {
        await collectSeriesFileFromFile(entry.path, entry.file);
      }
    }

    // OCR layer files (`<stem>.<id>.mokuro`): beside their volume they wait
    // for it to be saved; on their own they attach to the installed volume
    // they name. One that names nothing installed falls through to pairing
    // (and is reported like any other stray file).
    const layerSplit = extractLayerEntries(picked);
    stashLayerEntries(layerSplit.layers);
    const entries = layerSplit.entries;
    let attachedLayers = 0;
    for (const layer of layerSplit.standalone) {
      const attached = await attachLayerFile(layer.file, { path: layer.path });
      if (attached.status === 'attached') {
        attachedLayers++;
        getImportUiBridge().notify(
          `Attached OCR layer "${attached.layerId}" to ${attached.volumeTitle}`
        );
      } else {
        entries.push({ path: layer.path, file: layer.file });
      }
    }

    // Pair mokuro files with sources
    const pairingResult = await pairMokuroWithSources(entries);

    if (pairingResult.warnings.length > 0) {
      pairingResult.warnings.forEach((warning) => {
        console.warn('[Import]', warning);
      });
    }

    if (pairingResult.pairings.length === 0) {
      if (attachedLayers === 0) getImportUiBridge().notify('No importable volumes found');
      return result;
    }

    // Image-only folders are reviewed; archives are LISTED first (entry names
    // only, one at a time) so their image-only volumes join the same review
    // instead of stopping the queue archive by archive (#285).
    const imageOnlyFolders = pairingResult.pairings.filter((p) => p.imageOnly);
    const others = pairingResult.pairings.filter((p) => !p.imageOnly);
    incrementPoolUsers();
    let scans: Map<string, ArchiveScan>;
    try {
      scans = await prescanArchives(others, listArchiveNames);
    } finally {
      decrementPoolUsers();
    }

    const plain: PairedSource[] = [];
    const candidates: ReviewCandidate[] = [];
    const targets = new Map<string, ReviewTarget>();
    for (const pairing of imageOnlyFolders) {
      candidates.push({
        id: pairing.id,
        basePath: pairing.basePath,
        titlePath: pairing.titlePath,
        source: pairing.basePath
      });
      targets.set(pairing.id, { kind: 'folder', pairing });
    }
    for (const pairing of others) {
      const scan = scans.get(pairing.id);
      if (scan?.kind !== 'review' || pairing.source.type !== 'archive') {
        plain.push(pairing);
        continue;
      }
      const held: HeldArchive = {
        pairing,
        waiting: new Set(),
        names: new Map(),
        importsRegardless: scan.importsRegardless,
        settled: false
      };
      for (const inner of scan.inner) {
        const id = `${pairing.id}:${inner.innerPath}`;
        candidates.push({
          id,
          basePath: inner.basePath,
          titlePath: inner.titlePath,
          source: archiveSourceLabel(pairing.source.file, inner.innerPath)
        });
        targets.set(id, { kind: 'archive', held, innerPath: inner.innerPath });
        held.waiting.add(id);
      }
    }

    if (plain.length === 0 && candidates.length === 0) {
      getImportUiBridge().notify('No volumes to import');
      return result;
    }

    // Notify caller that preparation is complete
    options?.onPreparing?.(plain.length + candidates.length);

    // `.mokuro` volumes route as before — but a lone one is processed directly
    // only when nothing else is running or waiting in review: two imports at
    // once would hold two archives in memory (the queue is strictly sequential).
    const routing = decideImportRouting(plain);
    if (routing.directProcess && candidates.length === 0 && !hasUnfinishedImports()) {
      // Single item - process directly
      const queueItem = createLocalQueueItem(routing.directProcess);
      isImporting.set(true);
      currentImport.set(queueItem);
      addToProgressTracker(queueItem);
      updateProgressTracker(queueItem.id, 'Processing', 5);

      try {
        const processResult = await processSingleVolume(
          routing.directProcess,
          (status, progress) => {
            updateProgressTracker(queueItem.id, status, progress);
          }
        );

        // Queue additional sources (from multi-volume archives or nested archives)
        // Add at FRONT of queue so all volumes from same archive complete together
        if (processResult.additionalSources && processResult.additionalSources.length > 0) {
          const newItems = processResult.additionalSources.map(createLocalQueueItem);
          newItems.forEach(addToProgressTracker);
          importQueue.update((q) => {
            const processing = q.filter((item) => item.status === 'processing');
            const queued = q.filter((item) => item.status === 'queued');
            return [...processing, ...newItems, ...queued];
          });

          // Start processing queue for additional items
          processQueue();

          result.imported += processResult.additionalSources.length;
        }

        if (processResult.success) {
          result.imported += 1;
          removeFromProgressTracker(queueItem.id);
        } else {
          result.failed = 1;
          result.errors.push(processResult.error || 'Unknown error');
          result.success = false;
          markProgressTrackerError(queueItem.id, processResult.error || 'Unknown error');
        }
      } finally {
        isImporting.set(false);
        currentImport.set(null);
      }
    } else if (plain.length > 0) {
      enqueueAtEnd(plain);
      processQueue();
      // The queue processes in the background.
      result.imported = plain.length;
    }

    // Image-only volumes: one review step per series. Each approval is queued
    // at once, so series 1 imports while series 2 is on screen.
    if (candidates.length > 0) await offerForReview(candidates, targets);

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    getImportUiBridge().notify(`Import failed: ${message}`);
    result.success = false;
    result.errors.push(message);
    return result;
  }
}

/** What approving a review candidate queues. */
type ReviewTarget =
  | { kind: 'folder'; pairing: PairedSource }
  | { kind: 'archive'; held: HeldArchive; innerPath: string };

/** A pre-scanned archive waiting for the review of its image-only volumes. */
interface HeldArchive {
  pairing: PairedSource;
  /** Candidate ids not decided yet; the archive is queued once, after the last. */
  waiting: Set<string>;
  names: Map<string, ImportNames>;
  /** It also holds `.mokuro` volumes or archives: queued whatever the review decides. */
  importsRegardless: boolean;
  settled: boolean;
}

/**
 * Entry names of an archive — central directory only, no entry bytes (not
 * even `.mokuro`): the pre-scan must not raise an import's peak memory.
 */
async function listArchiveNames(file: File): Promise<ListedEntry[]> {
  return (await decompressArchiveRaw(file, undefined, undefined, true)).entries;
}

/** Queue `sources` behind everything already queued; `tracked` collects each progress row added. */
function enqueueAtEnd(sources: PairedSource[], tracked: ImportQueueItem[] = []): void {
  const items = sources.map(createLocalQueueItem);
  for (const item of items) {
    addToProgressTracker(item);
    tracked.push(item);
  }
  importQueue.update((q) => [...q, ...items]);
}

/** Each group's count of volumes its series already has, outside the group (keys only). */
async function withExistingCounts(groups: ReviewGroup[]): Promise<ReviewGroup[]> {
  for (const group of groups) {
    group.existingCount = await existingVolumeCount(group.series, group.ownUuids);
  }
  return groups;
}

/**
 * A review decision the import could not act on. The review session swallows
 * a throwing callback with a console line only, so every decision callback
 * reports its own failures here: to the user, and by dropping any progress
 * row it added for an item that never reached the queue.
 */
function reportDecisionFailure(error: unknown, tracked: ImportQueueItem[] = []): void {
  console.error('[Import] Could not import a reviewed series:', error);
  try {
    const queued = new Set(get(importQueue).map((item) => item.id));
    for (const item of tracked) if (!queued.has(item.id)) removeFromProgressTracker(item.id);
    const message = error instanceof Error ? error.message : 'Unknown error';
    getImportUiBridge().notify(`Import failed: ${message}`);
  } catch (reportError) {
    console.error('[Import] Could not report the failure:', reportError);
  }
}

/**
 * Offer `groups` for review and count them as pending until each is decided.
 * `onDecided` runs exactly once per group (a repeated or unknown id is
 * ignored), with how many of these groups are still undecided.
 */
function offerGroups(
  groups: ReviewGroup[],
  onDecided: (group: ReviewGroup, decision: GroupDecision, undecided: number) => void
): void {
  const undecided = new Set(groups.map((g) => g.id));
  pendingReviewGroups += groups.length;
  try {
    getImportUiBridge().reviewImageOnly(groups, (groupId, decision) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group || !undecided.delete(groupId)) return;
      pendingReviewGroups--;
      onDecided(group, decision, undecided.size);
    });
  } catch (error) {
    // Never offered: nothing will ever decide these groups.
    pendingReviewGroups -= undecided.size;
    undecided.clear();
    throw error;
  }
}

/** The names a decision gives a group's volumes; a failure to name them is reported and skips them. */
function approvedNames(group: ReviewGroup, decision: GroupDecision): Map<string, ImportNames> {
  if (decision.action !== 'import') return new Map();
  try {
    return nameGroup(group, decision.naming);
  } catch (error) {
    reportDecisionFailure(error);
    return new Map();
  }
}

/**
 * Offer a batch's image-only volumes for review and queue each approved
 * group as soon as it is decided. Resolves once the groups are OFFERED — the
 * user reviews while earlier approvals import.
 */
async function offerForReview(
  candidates: ReviewCandidate[],
  targets: Map<string, ReviewTarget>
): Promise<void> {
  const groups = await withExistingCounts(groupCandidates(candidates));
  offerGroups(groups, (group, decision) => {
    const names = approvedNames(group, decision);
    const ready: PairedSource[] = [];
    for (const candidate of group.candidates) {
      const target = targets.get(candidate.id);
      const approved = names.get(candidate.id);
      if (!target) continue;
      if (target.kind === 'folder') {
        if (approved) {
          target.pairing.importNames = approved;
          ready.push(target.pairing);
        }
        continue;
      }
      const { held } = target;
      held.waiting.delete(candidate.id);
      if (approved) held.names.set(target.innerPath, approved);
      if (held.waiting.size === 0 && !held.settled) {
        held.settled = true;
        if (held.names.size > 0 || held.importsRegardless) {
          held.pairing.archiveReview = { approved: true, names: held.names };
          ready.push(held.pairing);
        }
      }
    }

    const tracked: ImportQueueItem[] = [];
    try {
      if (ready.length > 0) {
        enqueueAtEnd(ready, tracked);
        processQueue().catch((error) => reportDecisionFailure(error));
      } else if (!hasUnfinishedImports()) {
        // Everything skipped and nothing running: settle the batch's series.json.
        applyImportedSeriesFiles().catch((error) => reportDecisionFailure(error));
      }
    } catch (error) {
      reportDecisionFailure(error, tracked);
    }
  });
}

/** Approved names of an archive reviewed before it was queued, by pairing id. */
function namesFromReview(
  pairings: PairedSource[],
  innerPaths: Map<string, string>,
  review: ArchiveReview
): Map<string, ImportNames> {
  const names = new Map<string, ImportNames>();
  for (const pairing of pairings) {
    const approved = review.names.get(innerPaths.get(pairing.id) ?? pairing.basePath);
    if (approved) names.set(pairing.id, approved);
  }
  return names;
}

/**
 * Review an archive's image-only volumes from inside the queue — archives the
 * pre-scan could not see (nested in another archive, unlisted, deep links).
 * The queue waits for these groups' decisions, as it always waited here.
 */
async function reviewInQueue(
  pairings: PairedSource[],
  archiveFile: File,
  innerPaths: Map<string, string>
): Promise<Map<string, ImportNames>> {
  const candidates: ReviewCandidate[] = pairings.map((p) => ({
    id: p.id,
    basePath: p.basePath,
    titlePath: p.titlePath,
    source: archiveSourceLabel(archiveFile, innerPaths.get(p.id) ?? p.basePath)
  }));
  const groups = await withExistingCounts(groupCandidates(candidates));
  const approved = new Map<string, ImportNames>();
  await new Promise<void>((resolve, reject) => {
    try {
      offerGroups(groups, (group, decision, undecided) => {
        for (const [id, names] of approvedNames(group, decision)) approved.set(id, names);
        // The queue resumes after the last decision, whatever became of it.
        if (undecided === 0) resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
  return approved;
}

/**
 * Prompt user when importing a volume with missing files
 * Shows the list of missing files and lets user choose to import anyway
 */
async function promptForMissingFiles(info: MissingFilesInfo): Promise<boolean> {
  return getImportUiBridge().promptMissing(info);
}

/**
 * Clear completed/errored items from the queue
 */
export function clearCompletedImports(): void {
  importQueue.update((q) =>
    q.filter((item) => item.status === 'queued' || item.status === 'processing')
  );
}

/**
 * Cancel all queued imports
 */
export function cancelQueuedImports(): void {
  importQueue.update((q) => q.filter((item) => item.status === 'processing'));
  // The volumes those items would have saved are never coming, so any
  // `series.json` still waiting for them has nothing left to key onto.
  resetImportedSeriesFiles();
}
