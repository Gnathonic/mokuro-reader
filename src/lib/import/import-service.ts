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
import { showSnackbar } from '$lib/util/snackbar';
import { isImageExtension, isMokuroExtension, isArchiveExtension, parseFilePath } from './types';
import {
	getFileProcessingPool,
	incrementPoolUsers,
	decrementPoolUsers
} from '$lib/util/file-processing-pool';
import { promptImageOnlyImport, type SeriesImportInfo } from '$lib/util/modals';
import { extractSeriesName } from '$lib/upload/image-only-fallback';

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
 * Decompress an archive file into a DecompressedVolume using the worker pool
 */
async function decompressArchive(
	archiveFile: File,
	mokuroFile: File | null,
	basePath: string,
	onProgress?: (status: string, progress: number) => void
): Promise<DecompressedVolume> {
	onProgress?.('Decompressing...', 10);

	// Get the worker pool
	const pool = await getFileProcessingPool();

	// Convert File to ArrayBuffer for transfer to worker
	const arrayBuffer = await archiveFile.arrayBuffer();

	// Use a promise to wrap the worker task
	const entries = await new Promise<DecompressedEntry[]>((resolve, reject) => {
		const taskId = crypto.randomUUID();

		pool.addTask({
			id: taskId,
			data: {
				mode: 'decompress-only',
				fileId: taskId,
				fileName: archiveFile.name,
				blob: arrayBuffer
			},
			memoryRequirement: archiveFile.size * 3, // Estimate: compressed + decompressed + overhead
			onProgress: (progress) => {
				// Worker doesn't send progress for decompress-only, but handle it if it does
				if (progress.loaded && progress.total) {
					const pct = Math.round((progress.loaded / progress.total) * 40) + 10;
					onProgress?.('Decompressing...', pct);
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

	onProgress?.('Processing files...', 50);

	// Convert entries to our format
	const imageFiles = new Map<string, File>();
	const nestedArchives: File[] = [];
	let foundMokuro: File | null = mokuroFile;

	for (const entry of entries) {
		const filename = entry.filename;
		const { extension } = parseFilePath(filename);

		// Skip problematic files
		if (filename.includes('__MACOSX') || filename.startsWith('._')) continue;

		// Create File from ArrayBuffer
		const file = new File([entry.data], filename.split('/').pop() || filename, {
			lastModified: Date.now()
		});

		if (isMokuroExtension(extension) && !foundMokuro) {
			foundMokuro = file;
		} else if (isImageExtension(extension)) {
			imageFiles.set(filename, file);
		} else if (isArchiveExtension(extension)) {
			nestedArchives.push(file);
		}
	}

	return {
		mokuroFile: foundMokuro,
		imageFiles,
		basePath,
		sourceType: 'local',
		nestedArchives
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
 */
async function processSingleVolume(
	source: PairedSource,
	onProgress?: (status: string, progress: number) => void
): Promise<{ success: boolean; error?: string }> {
	try {
		onProgress?.('Preparing...', 0);

		// Convert source to DecompressedVolume
		let decompressed: DecompressedVolume;

		if (source.source.type === 'archive') {
			decompressed = await decompressArchive(
				source.source.file,
				source.mokuroFile,
				source.basePath,
				onProgress
			);
		} else if (source.source.type === 'toc-directory') {
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

		showSnackbar(`Added "${processed.metadata.volume}" to catalog`);

		// Queue nested archives for processing
		if (processed.nestedSources.length > 0) {
			const queue = get(importQueue);
			const newItems = processed.nestedSources.map(createLocalQueueItem);
			importQueue.set([...queue, ...newItems]);
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

			// Process the volume
			const result = await processSingleVolume(nextItem.source, (status, progress) => {
				importQueue.update((q) =>
					q.map((item) =>
						item.id === nextItem.id ? { ...item, status: status as any, progress } : item
					)
				);
			});

			if (result.success) {
				// Remove from queue on success
				importQueue.update((q) => q.filter((item) => item.id !== nextItem.id));
			} else {
				// Mark as error
				importQueue.update((q) =>
					q.map((item) =>
						item.id === nextItem.id
							? { ...item, status: 'error' as const, errorMessage: result.error }
							: item
					)
				);
				showSnackbar(`Failed to import: ${result.error}`);
			}

			currentImport.set(null);
		}
	} finally {
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
			showSnackbar('No importable volumes found');
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
			showSnackbar('No volumes to import');
			return result;
		}

		// Decide routing
		const routing = decideImportRouting(allPairings);

		if (routing.directProcess) {
			// Single item - process directly
			isImporting.set(true);
			currentImport.set(createLocalQueueItem(routing.directProcess));

			try {
				const processResult = await processSingleVolume(routing.directProcess);
				if (processResult.success) {
					result.imported = 1;
				} else {
					result.failed = 1;
					result.errors.push(processResult.error || 'Unknown error');
					result.success = false;
				}
			} finally {
				isImporting.set(false);
				currentImport.set(null);
			}
		} else {
			// Multiple items - queue all
			const queueItems = routing.queuedItems.map(createLocalQueueItem);
			importQueue.update((q) => [...q, ...queueItems]);

			showSnackbar(`Queued ${queueItems.length} volumes for import`);

			// Start processing queue
			processQueue();

			// Return immediately - queue will process in background
			result.imported = routing.queuedItems.length;
		}

		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		showSnackbar(`Import failed: ${message}`);
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
