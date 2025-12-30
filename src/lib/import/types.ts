/**
 * Types for the unified import system
 *
 * This module handles both local file uploads and cloud downloads
 * through a unified pairing and processing pipeline.
 */

// ============================================
// INPUT TYPES - What we receive from various sources
// ============================================

/**
 * A file entry from any source (drag-drop, file picker, or extracted from archive)
 */
export interface FileEntry {
	/** Full path including any ZIP nesting (e.g., "manga/page001.jpg" or "bundle.zip/vol1/page.jpg") */
	path: string;
	/** The actual file object */
	file: File;
}

/**
 * Categorized file entry with type detection applied
 */
export interface CategorizedFile extends FileEntry {
	/** File category based on extension */
	category: 'mokuro' | 'image' | 'archive' | 'other';
	/** Parent directory path (e.g., "manga" for "manga/page001.jpg") */
	parentDir: string;
	/** Filename without path (e.g., "page001.jpg") */
	filename: string;
	/** Filename without extension (e.g., "page001") */
	stem: string;
	/** File extension lowercase without dot (e.g., "jpg") */
	extension: string;
}

// ============================================
// PAIRING TYPES - Pre-processing stage output
// ============================================

/**
 * A paired source ready for processing.
 * Represents a mokuro file matched with its image source.
 */
export interface PairedSource {
	/** Unique ID for queue tracking */
	id: string;
	/** External .mokuro file (null if expected inside archive or image-only) */
	mokuroFile: File | null;
	/** The source containing images */
	source: SourceDescriptor;
	/** Base path for series/volume name extraction */
	basePath: string;
	/** Estimated size in bytes for memory management */
	estimatedSize: number;
	/** Whether this is an image-only source (no mokuro found anywhere) */
	imageOnly: boolean;
}

/**
 * Describes where the images come from
 */
export type SourceDescriptor =
	| DirectorySource
	| ArchiveSource
	| TocDirectorySource;

export interface DirectorySource {
	type: 'directory';
	/** Map of relative path → File for all images in the directory */
	files: Map<string, File>;
}

export interface ArchiveSource {
	type: 'archive';
	/** The archive file to decompress */
	file: File;
}

export interface TocDirectorySource {
	type: 'toc-directory';
	/**
	 * Map of chapter name → (relative path → File)
	 * Used for TOC-style volumes where one mokuro covers multiple chapter subdirs
	 */
	chapters: Map<string, Map<string, File>>;
}

// ============================================
// EXPECTED OUTPUT FORMAT (for test fixtures)
// ============================================

/**
 * Expected pairing result for a test fixture.
 * Used in expected.json files alongside fixture inputs.
 */
export interface ExpectedPairing {
	/** Number of pairings that should result */
	count: number;
	/** Details for each expected pairing */
	pairings: ExpectedPairingDetail[];
	/** Optional error that should be thrown */
	error?: string;
	/** Optional warnings that should be generated */
	warnings?: string[];
}

export interface ExpectedPairingDetail {
	/** Expected source type */
	sourceType: 'directory' | 'archive' | 'toc-directory';
	/** Whether external mokuro file should be present */
	hasMokuro: boolean;
	/** Expected base path (partial match) */
	basePathContains: string;
	/** Whether this should be flagged as image-only */
	imageOnly: boolean;
	/** For directory sources: expected file count */
	fileCount?: number;
	/** For TOC sources: expected chapter names */
	chapterNames?: string[];
}

// ============================================
// PROCESSING TYPES - After decompression
// ============================================

/**
 * Common format after decompression, ready for volume processing.
 * Both local directories and cloud downloads converge to this format.
 */
export interface DecompressedVolume {
	/** The mokuro file if found (null for image-only) */
	mokuroFile: File | null;
	/** Map of relative path → File for all images */
	imageFiles: Map<string, File>;
	/** Base path for series/volume name extraction */
	basePath: string;
	/** Where this came from */
	sourceType: 'local' | 'cloud';
	/** Archives discovered inside (for recursive processing) */
	nestedArchives: File[];
}

/**
 * Fully processed volume ready for database storage
 */
export interface ProcessedVolume {
	/** Volume metadata for db.volumes */
	metadata: ProcessedMetadata;
	/** OCR data for db.volume_ocr */
	ocrData: {
		volume_uuid: string;
		pages: ProcessedPage[];
	};
	/** File data for db.volume_files */
	fileData: {
		volume_uuid: string;
		files: Record<string, File>;
	};
	/** Nested sources discovered during processing (to be queued) */
	nestedSources: PairedSource[];
}

/**
 * Processed metadata (subset of VolumeMetadata with required fields)
 */
export interface ProcessedMetadata {
	volumeUuid: string;
	seriesUuid: string;
	series: string;
	volume: string;
	mokuroVersion?: string;
	pageCount: number;
	chars: number;
	thumbnail: Blob | null;
	thumbnailWidth: number;
	thumbnailHeight: number;
	mismatchWarning?: string;
	/** Number of pages that were missing and replaced with placeholders */
	missingPages?: number;
	/** Paths of pages that were replaced with placeholders */
	missingPagePaths?: string[];
	/** Whether this is an image-only volume (no mokuro) */
	imageOnly?: boolean;
	/** Where this volume came from */
	sourceType?: 'local' | 'cloud';
}

/**
 * Processed page - extends the mokuro page format with cumulative chars
 * Note: The Page type from mokuro includes version, img_width, img_height, blocks, img_path
 * For database storage, we pass through the original page data from mokuro
 */
export interface ProcessedPage {
	version?: string;
	img_width?: number;
	img_height?: number;
	img_path: string;
	blocks: unknown[]; // OCR blocks from mokuro (Block[])
	cumulativeChars: number;
}

// ============================================
// QUEUE TYPES - For unified import queue
// ============================================

export type ImportProvider = 'local-import' | 'google-drive' | 'mega' | 'webdav';

export interface ImportQueueItem {
	/** Unique ID matching PairedSource.id */
	id: string;
	/** The paired source to process */
	source: PairedSource;
	/** Provider type for concurrency management */
	provider: ImportProvider;
	/** Current status */
	status: 'queued' | 'decompressing' | 'processing' | 'complete' | 'error';
	/** Progress 0-100 */
	progress: number;
	/** Display title for UI */
	displayTitle: string;
	/** Error message if status is 'error' */
	errorMessage?: string;
}

// ============================================
// UTILITY TYPES
// ============================================

/** Supported image extensions */
export const IMAGE_EXTENSIONS = new Set([
	'jpg',
	'jpeg',
	'png',
	'webp',
	'gif',
	'bmp',
	'avif'
]);

/** Supported archive extensions */
export const ARCHIVE_EXTENSIONS = new Set(['zip', 'cbz', 'cbr', 'rar', '7z']);

/** Check if extension is an image */
export function isImageExtension(ext: string): boolean {
	return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

/** Check if extension is an archive */
export function isArchiveExtension(ext: string): boolean {
	return ARCHIVE_EXTENSIONS.has(ext.toLowerCase());
}

/** Check if extension is mokuro */
export function isMokuroExtension(ext: string): boolean {
	return ext.toLowerCase() === 'mokuro';
}

/** Extract file info from a path */
export function parseFilePath(path: string): {
	parentDir: string;
	filename: string;
	stem: string;
	extension: string;
} {
	// Normalize path separators
	const normalizedPath = path.replace(/\\/g, '/');

	// Get filename (last segment)
	const lastSlash = normalizedPath.lastIndexOf('/');
	const filename = lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;
	const parentDir = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) : '';

	// Get extension
	const lastDot = filename.lastIndexOf('.');
	const extension = lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
	const stem = lastDot >= 0 ? filename.slice(0, lastDot) : filename;

	return { parentDir, filename, stem, extension };
}

/** Categorize a FileEntry */
export function categorizeFile(entry: FileEntry): CategorizedFile {
	const parsed = parseFilePath(entry.path);

	let category: CategorizedFile['category'];
	if (isMokuroExtension(parsed.extension)) {
		category = 'mokuro';
	} else if (isImageExtension(parsed.extension)) {
		category = 'image';
	} else if (isArchiveExtension(parsed.extension)) {
		category = 'archive';
	} else {
		category = 'other';
	}

	return {
		...entry,
		category,
		...parsed
	};
}
