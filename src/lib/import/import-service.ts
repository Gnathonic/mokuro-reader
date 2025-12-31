/**
 * Import Service
 *
 * Main entry point for importing volumes from local files.
 * Orchestrates the pairing, routing, processing, and database operations.
 */

import { writable, get } from 'svelte/store';
import { pairMokuroWithSources } from './pairing';
import { decideImportRouting } from './routing';
import { processVolume, parseMokuroFile, matchImagesToPages } from './processing';
import { saveVolume, volumeExists } from './database';
import { promptMissingFiles, type MissingFilesInfo } from '$lib/util/modals';
import { createLocalQueueItem, requiresWorkerDecompression } from './local-provider';
import type {
	FileEntry,
	PairedSource,
	ImportQueueItem,
	DecompressedVolume,
	ProcessedVolume
} from './types';
import { progressTrackerStore } from '$lib/util/progress-tracker';
import { isImageExtension, isMokuroExtension, isArchiveExtension, parseFilePath } from './types';
import {
	getFileProcessingPool,
	incrementPoolUsers,
	decrementPoolUsers
} from '$lib/util/file-processing-pool';
import { promptImageOnlyImport, type SeriesImportInfo } from '$lib/util/modals';
import { extractSeriesName } from '$lib/upload/image-only-fallback';
import { generateUUID } from '$lib/util/uuid';

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
	progressTrackerStore.addProcess({
		id: `import-${item.id}`,
		description: `Importing ${item.displayTitle}`,
		status: 'Queued',
		progress: 0
	});
}

/**
 * Update an import item's progress in the global tracker
 */
function updateProgressTracker(id: string, status: string, progress: number): void {
	progressTrackerStore.updateProcess(`import-${id}`, {
		status,
		progress
	});
}

/**
 * Remove an import item from the global progress tracker
 */
function removeFromProgressTracker(id: string): void {
	progressTrackerStore.removeProcess(`import-${id}`);
}

/**
 * Mark an import as failed in the progress tracker (keeps visible briefly)
 */
function markProgressTrackerError(id: string, error: string): void {
	progressTrackerStore.updateProcess(`import-${id}`, {
		status: `Failed: ${error}`,
		progress: 0
	});
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
	return files.map((file) => {
		// Use webkitRelativePath if available, otherwise use name
		const path = file.webkitRelativePath || file.name;
		return { path, file };
	});
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
 */
async function decompressArchiveRaw(
	archiveFile: File,
	onProgress?: (status: string, progress: number) => void,
	filter?: ExtractFilter,
	listOnly?: boolean,
	listAllExtractFiltered?: boolean
): Promise<RawDecompressedArchive> {
	onProgress?.(listOnly ? 'Scanning...' : 'Decompressing...', 10);

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
			memoryRequirement: listOnly ? 1024 * 1024 : (filter ? archiveFile.size * 0.1 : archiveFile.size * 3),
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
 * Volume definition for multi-volume extraction
 */
interface VolumeExtractDef {
	id: string;
	pathPrefix: string;
}

/**
 * Stream extract images for ALL volumes in a single archive pass
 * Opens the archive ONCE, extracts images for all volumes, groups by volume ID
 * Much faster than opening archive N times for N volumes
 */
async function streamExtractAllVolumes(
	archiveFile: File,
	volumes: VolumeExtractDef[],
	onProgress?: (status: string, progress: number) => void
): Promise<Map<string, Map<string, File>>> {
	// Map of volumeId → (relativePath → File)
	const allVolumeFiles = new Map<string, Map<string, File>>();

	// Initialize maps for each volume
	for (const vol of volumes) {
		allVolumeFiles.set(vol.id, new Map());
	}

	// Build prefix → volumeId lookup
	const prefixToVolume = new Map<string, { id: string; prefix: string }>();
	for (const vol of volumes) {
		prefixToVolume.set(vol.pathPrefix, { id: vol.id, prefix: vol.pathPrefix });
	}

	return new Promise((resolve, reject) => {
		const taskId = generateUUID();

		// Create a dedicated worker for streaming
		const worker = new Worker(
			new URL('$lib/workers/unified-file-worker.ts', import.meta.url),
			{ type: 'module' }
		);

		const cleanup = () => {
			worker.terminate();
		};

		worker.onmessage = (event) => {
			const msg = event.data;

			if (msg.type === 'stream-entry') {
				// Find which volume this belongs to
				const volumeFiles = allVolumeFiles.get(msg.volumeId);
				if (volumeFiles) {
					// Find the prefix for this volume to calculate relative path
					const vol = volumes.find(v => v.id === msg.volumeId);
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
			volumes: volumes.map(v => ({ id: v.id, pathPrefix: v.pathPrefix }))
		});
	});
}

/**
 * Convert raw decompressed entries to FileEntry format for pairing
 */
function entriesToFileEntries(entries: DecompressedEntry[]): FileEntry[] {
	const fileEntries: FileEntry[] = [];

	for (const entry of entries) {
		const filename = entry.filename;

		// Skip problematic files
		if (filename.includes('__MACOSX') || filename.startsWith('._')) continue;
		// Skip directory entries (end with /)
		if (filename.endsWith('/')) continue;

		// Create File from ArrayBuffer, preserving the full path in the name
		const file = new File([entry.data], filename.split('/').pop() || filename, {
			lastModified: Date.now()
		});

		fileEntries.push({
			path: filename,
			file
		});
	}

	return fileEntries;
}

/**
 * Process an archive using streaming extraction for memory efficiency.
 * Opens archive once to scan + extract mokuro files, then streams images.
 */
async function processArchiveContents(
	archiveFile: File,
	externalMokuroFile: File | null,
	onProgress?: (status: string, progress: number) => void
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
		true   // listAllExtractFiltered - list all, extract only mokuro
	);

	onProgress?.('Analyzing structure...', 15);

	// Build file entries from scan result
	// Mokuro files have data, other files have empty ArrayBuffers (listed only)
	const fileEntries: FileEntry[] = [];
	const nestedArchivePaths: string[] = [];

	for (const entry of scanResult.entries) {
		const ext = entry.filename.split('.').pop()?.toLowerCase() || '';
		const filename = entry.filename.split('/').pop() || entry.filename;

		if (isMokuroExtension(ext)) {
			// Mokuro file - has actual content
			const file = new File([entry.data], filename, { lastModified: Date.now() });
			fileEntries.push({ path: entry.filename, file });
		} else if (isImageExtension(ext)) {
			// Image file - placeholder only (empty data)
			const file = new File([], filename, { lastModified: Date.now() });
			fileEntries.push({ path: entry.filename, file });
		} else if (isArchiveExtension(ext)) {
			// Track nested archives for later
			nestedArchivePaths.push(entry.filename);
		}
	}

	// Add external mokuro if provided
	if (externalMokuroFile) {
		fileEntries.push({ path: externalMokuroFile.name, file: externalMokuroFile });
	}

	// Run pairing logic
	const pairingResult = await pairMokuroWithSources(fileEntries);

	if (pairingResult.warnings.length > 0) {
		pairingResult.warnings.forEach((warning) => {
			console.warn('[Archive Import]', warning);
		});
	}

	// If no pairings and no nested archives, nothing to import
	if (pairingResult.pairings.length === 0 && nestedArchivePaths.length === 0) {
		return { success: false, error: 'No importable volumes found in archive' };
	}

	// PASS 2: Extract ALL volumes' images in a single archive pass
	// This is much faster than opening the archive N times
	const allNestedSources: PairedSource[] = [];
	let successCount = 0;
	let lastError: string | undefined;
	const totalVolumes = pairingResult.pairings.length;
	const volumeTimes: number[] = [];

	// Only extract and process volumes if there are pairings
	if (totalVolumes > 0) {
		console.log(`[Streaming Import] Starting extraction of ${totalVolumes} volumes`);

		// Build volume definitions for extraction
		const volumeDefs: VolumeExtractDef[] = pairingResult.pairings.map((pairing, i) => ({
			id: `vol-${i}`,
			pathPrefix: pairing.basePath
		}));

		onProgress?.(`Extracting ${totalVolumes} volumes...`, 20);

		// Single-pass extraction for all volumes
		const extractStart = performance.now();
		const allVolumeFiles = await streamExtractAllVolumes(
			archiveFile,
			volumeDefs,
			(status, progress) => {
				// Extraction is 20-70% of total progress
				const overallProgress = 20 + (progress / 100) * 50;
				onProgress?.(status, overallProgress);
			}
		);
		const extractTime = performance.now() - extractStart;
		console.log(`[Streaming Import] Extraction complete: ${(extractTime / 1000).toFixed(1)}s`);

		// Process each volume sequentially (to manage memory during processing)
		console.log(`[Streaming Import] Starting processing of ${totalVolumes} volumes`);
		for (let i = 0; i < pairingResult.pairings.length; i++) {
			const volumeStart = performance.now();
			const pairing = pairingResult.pairings[i];
			const volumeId = `vol-${i}`;
			const volumeImageFiles = allVolumeFiles.get(volumeId) || new Map();

			const processingProgress = 70 + (i / totalVolumes) * 25;
			onProgress?.(`Processing ${i + 1}/${totalVolumes}: ${pairing.basePath}...`, processingProgress);

			// Create DecompressedVolume for processing
			const decompressed: DecompressedVolume = {
				mokuroFile: pairing.mokuroFile,
				imageFiles: volumeImageFiles,
				basePath: pairing.basePath,
				sourceType: 'local',
				nestedArchives: []
			};

			try {
				// Process the volume
				const processed = await processVolume(decompressed);

				// Check for duplicates
				if (await volumeExists(processed.metadata.volumeUuid)) {
					lastError = `Volume "${processed.metadata.volume}" already exists`;
				} else {
					// Save to database
					await saveVolume(processed);
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

			const volumeTime = performance.now() - volumeStart;
			volumeTimes.push(volumeTime);
			const avg = volumeTimes.reduce((a, b) => a + b, 0) / volumeTimes.length;
			console.log(`[Streaming Import] Volume ${i + 1}/${totalVolumes}: ${volumeTime.toFixed(0)}ms (avg: ${avg.toFixed(0)}ms)`);

			// Clear this volume's files to free memory before next volume
			volumeImageFiles.clear();
			allVolumeFiles.delete(volumeId);
		}

		const processTime = volumeTimes.reduce((a, b) => a + b, 0);
		console.log(`[Streaming Import] Processing complete: ${totalVolumes} volumes in ${(processTime / 1000).toFixed(1)}s (avg: ${(processTime / totalVolumes).toFixed(0)}ms/vol)`);
	}

	// Extract nested archives if any
	if (nestedArchivePaths.length > 0) {
		onProgress?.('Extracting nested archives...', 95);
		const nestedResult = await decompressArchiveRaw(
			archiveFile,
			undefined,
			{ extensions: ['zip', 'cbz', 'cbr', 'rar', '7z'] }
		);

		for (const entry of nestedResult.entries) {
			const filename = entry.filename.split('/').pop() || entry.filename;
			const file = new File([entry.data], filename, { lastModified: Date.now() });
			allNestedSources.push({
				id: generateUUID(),
				mokuroFile: null,
				source: { type: 'archive', file },
				basePath: filename.replace(/\.(zip|cbz|cbr|rar|7z)$/i, ''),
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
		imageFiles: source.source.files,
		basePath: source.basePath,
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
		imageFiles,
		basePath: source.basePath,
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

		// For archive sources, use two-pass extraction for memory efficiency
		// processArchiveContents handles everything: scan, extract per-volume, process, save
		if (source.source.type === 'archive') {
			const result = await processArchiveContents(
				source.source.file,
				source.mokuroFile,
				onProgress
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
		const processed = await processVolume(decompressed);

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

		onProgress?.('Complete', 100);

		// Queue nested archives for processing
		// Add at FRONT of queue so nested archives complete before moving to other items
		if (processed.nestedSources.length > 0) {
			const queue = get(importQueue);
			const newItems = processed.nestedSources.map(createLocalQueueItem);
			newItems.forEach(addToProgressTracker);
			const processing = queue.filter(item => item.status === 'processing');
			const queued = queue.filter(item => item.status === 'queued');
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

	// Session-level timing
	const sessionStart = performance.now();
	const itemTimes: number[] = [];
	let itemCount = 0;

	try {
		while (true) {
			const queue = get(importQueue);
			const nextItem = queue.find((item) => item.status === 'queued');

			if (!nextItem) break;

			const itemStart = performance.now();
			itemCount++;

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
					const processing = q.filter(item => item.status === 'processing');
					const queued = q.filter(item => item.status === 'queued');
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

			// Log timing for this item
			const itemTime = performance.now() - itemStart;
			itemTimes.push(itemTime);
			const avg = itemTimes.reduce((a, b) => a + b, 0) / itemTimes.length;
			const remaining = get(importQueue).filter(i => i.status === 'queued').length;
			console.log(`[Queue] Item ${itemCount}: ${itemTime.toFixed(0)}ms (avg: ${avg.toFixed(0)}ms, ${remaining} remaining)`);

			currentImport.set(null);
		}
	} finally {
		// Log session summary
		if (itemTimes.length > 0) {
			const totalTime = performance.now() - sessionStart;
			const avg = itemTimes.reduce((a, b) => a + b, 0) / itemTimes.length;
			console.log(`[Queue] Session complete: ${itemCount} items in ${(totalTime / 1000).toFixed(1)}s (avg: ${avg.toFixed(0)}ms/item)`);
		}

		processingQueue = false;
		isImporting.set(false);
		currentImport.set(null);
		decrementPoolUsers(); // Release pool when queue is empty
	}
}

// ============================================
// MAIN ENTRY POINT
// ============================================

export interface ImportResult {
	success: boolean;
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
 * @returns Import result with success/failure counts
 */
export async function importFiles(files: File[]): Promise<ImportResult> {
	const result: ImportResult = {
		success: true,
		imported: 0,
		failed: 0,
		errors: []
	};

	if (files.length === 0) {
		return result;
	}

	try {
		// Convert to FileEntry format
		const entries = filesToEntries(files);

		// Pair mokuro files with sources
		const pairingResult = await pairMokuroWithSources(entries);

		if (pairingResult.warnings.length > 0) {
			pairingResult.warnings.forEach((warning) => {
				console.warn('[Import]', warning);
			});
		}

		if (pairingResult.pairings.length === 0) {
			return result;
		}

		// Separate image-only pairings from mokuro pairings
		const mokuroPairings = pairingResult.pairings.filter((p) => !p.imageOnly);
		const imageOnlyPairings = pairingResult.pairings.filter((p) => p.imageOnly);

		// If there are image-only pairings, prompt user for confirmation
		let confirmedImageOnlyPairings: PairedSource[] = [];
		if (imageOnlyPairings.length > 0) {
			const confirmed = await promptForImageOnlyImport(imageOnlyPairings);
			if (confirmed) {
				confirmedImageOnlyPairings = imageOnlyPairings;
			}
		}

		// Combine confirmed pairings
		const allPairings = [...mokuroPairings, ...confirmedImageOnlyPairings];

		if (allPairings.length === 0) {
			return result;
		}

		// Decide routing
		const routing = decideImportRouting(allPairings);

		if (routing.directProcess) {
			// Single item - process directly
			const queueItem = createLocalQueueItem(routing.directProcess);
			isImporting.set(true);
			currentImport.set(queueItem);
			addToProgressTracker(queueItem);
			updateProgressTracker(queueItem.id, 'Processing', 5);

			try {
				const processResult = await processSingleVolume(routing.directProcess, (status, progress) => {
					updateProgressTracker(queueItem.id, status, progress);
				});

				// Queue additional sources (from multi-volume archives or nested archives)
				// Add at FRONT of queue so all volumes from same archive complete together
				if (processResult.additionalSources && processResult.additionalSources.length > 0) {
					const newItems = processResult.additionalSources.map(createLocalQueueItem);
					newItems.forEach(addToProgressTracker);
					importQueue.update((q) => {
						const processing = q.filter(item => item.status === 'processing');
						const queued = q.filter(item => item.status === 'queued');
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
		} else {
			// Multiple items - queue all
			const queueItems = routing.queuedItems.map(createLocalQueueItem);
			queueItems.forEach(addToProgressTracker);
			importQueue.update((q) => [...q, ...queueItems]);

			// Start processing queue
			processQueue();

			// Return immediately - queue will process in background
			result.imported = routing.queuedItems.length;
		}

		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		result.success = false;
		result.errors.push(message);
		return result;
	}
}

/**
 * Prompt user to confirm image-only import
 * Groups volumes by series and shows a confirmation modal
 */
async function promptForImageOnlyImport(pairings: PairedSource[]): Promise<boolean> {
	// Group by series name
	const seriesGroups = new Map<string, number>();

	for (const pairing of pairings) {
		const seriesName = extractSeriesName(pairing.basePath);
		seriesGroups.set(seriesName, (seriesGroups.get(seriesName) || 0) + 1);
	}

	// Convert to sorted list
	const seriesList: SeriesImportInfo[] = [...seriesGroups.entries()]
		.map(([seriesName, volumeCount]) => ({ seriesName, volumeCount }))
		.sort((a, b) => a.seriesName.localeCompare(b.seriesName));

	// Show confirmation modal
	return new Promise<boolean>((resolve) => {
		promptImageOnlyImport(
			seriesList,
			pairings.length,
			() => resolve(true),
			() => resolve(false)
		);
	});
}

/**
 * Prompt user when importing a volume with missing files
 * Shows the list of missing files and lets user choose to import anyway
 */
async function promptForMissingFiles(info: MissingFilesInfo): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		promptMissingFiles(
			info,
			() => resolve(true), // Import anyway
			() => resolve(false) // Cancel
		);
	});
}

/**
 * Clear completed/errored items from the queue
 */
export function clearCompletedImports(): void {
	importQueue.update((q) => q.filter((item) => item.status === 'queued' || item.status === 'processing'));
}

/**
 * Cancel all queued imports
 */
export function cancelQueuedImports(): void {
	importQueue.update((q) => q.filter((item) => item.status === 'processing'));
}
