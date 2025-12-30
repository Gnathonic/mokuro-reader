/**
 * Database Operations for Volume Import
 *
 * Handles atomic writes to IndexedDB for imported volumes.
 * Writes to three tables in a single transaction:
 * - volumes: metadata
 * - volume_ocr: OCR data (pages with text blocks)
 * - volume_files: image files
 */

import { db } from '$lib/catalog/db';
import { requestPersistentStorage } from '$lib/util/upload';
import type { ProcessedVolume } from './types';
import type { VolumeMetadata } from '$lib/types';

/**
 * Check if a volume already exists in the database
 *
 * @param volumeUuid - The volume UUID to check
 * @returns True if the volume exists
 */
export async function volumeExists(volumeUuid: string): Promise<boolean> {
	const existing = await db.volumes.where('volume_uuid').equals(volumeUuid).first();
	return existing !== undefined;
}

/**
 * Save a processed volume to the database
 *
 * Performs an atomic write to all three tables.
 * Will fail if the volume already exists (duplicate prevention).
 *
 * @param volume - The processed volume to save
 * @throws If the volume already exists or if the transaction fails
 */
export async function saveVolume(volume: ProcessedVolume): Promise<void> {
	const { metadata, ocrData, fileData } = volume;

	// Check for duplicates
	if (await volumeExists(metadata.volumeUuid)) {
		throw new Error(`Volume ${metadata.volumeUuid} already exists in database`);
	}

	// Request persistent storage
	await requestPersistentStorage();

	// Sort files by name for consistent ordering
	const sortedFiles = Object.fromEntries(
		Object.entries(fileData.files).sort(([aKey], [bKey]) =>
			aKey.localeCompare(bKey, undefined, { numeric: true, sensitivity: 'base' })
		)
	);

	// Calculate page_char_counts from pages
	const pageCharCounts = ocrData.pages.map((page) => page.cumulativeChars);

	// Convert ProcessedMetadata to VolumeMetadata format
	const volumeMetadata: VolumeMetadata = {
		mokuro_version: metadata.mokuroVersion || '',
		series_title: metadata.series,
		series_uuid: metadata.seriesUuid,
		volume_title: metadata.volume,
		volume_uuid: metadata.volumeUuid,
		page_count: metadata.pageCount,
		character_count: metadata.chars,
		page_char_counts: pageCharCounts,
		thumbnail: metadata.thumbnail instanceof Blob
			? new File([metadata.thumbnail], 'thumbnail.jpg', { type: 'image/jpeg' })
			: undefined,
		thumbnail_width: metadata.thumbnailWidth,
		thumbnail_height: metadata.thumbnailHeight,
		missing_pages: metadata.missingPages,
		missing_page_paths: metadata.missingPagePaths
	};

	// Write to all 3 tables atomically
	await db.transaction('rw', [db.volumes, db.volume_ocr, db.volume_files], async () => {
		// Write metadata
		await db.volumes.add(volumeMetadata);

		// Write OCR data (strip cumulativeChars as it's stored in page_char_counts)
		const pagesForDb = ocrData.pages.map(({ cumulativeChars, ...page }) => page);
		await db.volume_ocr.add({
			volume_uuid: ocrData.volume_uuid,
			pages: pagesForDb as any // Cast to any since Page type is stricter
		});

		// Write files
		await db.volume_files.add({
			volume_uuid: fileData.volume_uuid,
			files: sortedFiles
		});
	});
}

/**
 * Delete a volume from the database
 *
 * Removes all data for a volume from all three tables atomically.
 *
 * @param volumeUuid - The volume UUID to delete
 */
export async function deleteVolume(volumeUuid: string): Promise<void> {
	await db.transaction('rw', [db.volumes, db.volume_ocr, db.volume_files], async () => {
		await db.volumes.delete(volumeUuid);
		await db.volume_ocr.delete(volumeUuid);
		await db.volume_files.delete(volumeUuid);
	});
}
