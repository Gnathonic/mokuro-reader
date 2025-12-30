/**
 * Unified Volume Processing
 *
 * This module handles the core processing of volume data:
 * - Parsing mokuro files
 * - Matching images to pages
 * - Generating thumbnails
 * - Calculating character counts
 * - Preparing data for database storage
 *
 * Used by both local imports and cloud downloads.
 */

import type {
	DecompressedVolume,
	ProcessedVolume,
	ProcessedMetadata,
	ProcessedPage,
	PairedSource,
	ArchiveSource
} from './types';
import { generateThumbnail } from '$lib/catalog/thumbnails';
import { extractSeriesName } from '$lib/upload/image-only-fallback';

// ============================================
// TYPES
// ============================================

/**
 * Parsed mokuro file data
 */
export interface ParsedMokuro {
	version: string;
	series: string;
	seriesUuid: string;
	volume: string;
	volumeUuid: string;
	pages: MokuroPage[];
	chars: number;
}

/**
 * A page from the mokuro file
 */
interface MokuroPage {
	version?: string;
	img_width?: number;
	img_height?: number;
	img_path: string;
	blocks: MokuroBlock[];
}

/**
 * A text block from mokuro
 */
interface MokuroBlock {
	lines?: string[];
	[key: string]: unknown;
}

/**
 * Result of matching images to mokuro pages
 */
export interface ImageMatchResult {
	/** Pages that were successfully matched */
	matched: string[];
	/** Page paths from mokuro that have no corresponding image */
	missing: string[];
	/** Image files that aren't referenced in mokuro */
	extra: string[];
	/** Map of original path → actual file path (for remapped extensions) */
	remapped: Map<string, string>;
}

/**
 * Extracted volume info from path
 */
export interface VolumeInfo {
	series: string;
	volume: string;
}

// ============================================
// MOKURO PARSING
// ============================================

/**
 * Read file content as text (compatible with both browser and jsdom)
 */
async function readFileAsText(file: File | Blob): Promise<string> {
	// Try the modern text() method first
	if (typeof file.text === 'function') {
		return file.text();
	}

	// Fallback to FileReader (works in jsdom)
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsText(file);
	});
}

/**
 * Parse a mokuro JSON file and extract metadata
 *
 * @param file - The mokuro File object
 * @returns Parsed mokuro data
 * @throws If the file is invalid or missing required fields
 */
export async function parseMokuroFile(file: File): Promise<ParsedMokuro> {
	const text = await readFileAsText(file);
	let data: unknown;

	try {
		data = JSON.parse(text);
	} catch {
		throw new Error('Invalid mokuro file: not valid JSON');
	}

	// Validate required fields
	const obj = data as Record<string, unknown>;
	const requiredFields = ['version', 'title', 'title_uuid', 'volume', 'volume_uuid', 'pages'];
	const missingFields = requiredFields.filter((field) => !(field in obj));

	if (missingFields.length > 0) {
		throw new Error(`Invalid mokuro file: missing required fields: ${missingFields.join(', ')}`);
	}

	return {
		version: obj.version as string,
		series: obj.title as string,
		seriesUuid: obj.title_uuid as string,
		volume: obj.volume as string,
		volumeUuid: obj.volume_uuid as string,
		pages: obj.pages as MokuroPage[],
		chars: (obj.chars as number) ?? 0
	};
}

// ============================================
// IMAGE MATCHING
// ============================================

/**
 * Get the stem (filename without extension) from a path
 */
function getStem(path: string): string {
	const filename = path.split('/').pop() || path;
	const lastDot = filename.lastIndexOf('.');
	return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

/**
 * Normalize path for comparison (lowercase, forward slashes)
 */
function normalizePath(path: string): string {
	return path.toLowerCase().replace(/\\/g, '/');
}

/**
 * Match image files to mokuro page paths
 *
 * Handles:
 * - Exact path matches
 * - Extension remapping (e.g., .png → .webp)
 * - Case-insensitive matching
 *
 * @param pages - Pages from the mokuro file
 * @param files - Map of available image files
 * @returns Match result with matched, missing, extra, and remapped paths
 */
export function matchImagesToPages(
	pages: MokuroPage[],
	files: Map<string, File>
): ImageMatchResult {
	const matched: string[] = [];
	const missing: string[] = [];
	const remapped = new Map<string, string>();

	// Create normalized lookup maps
	const normalizedFiles = new Map<string, string>(); // normalized → original
	const stemFiles = new Map<string, string>(); // stem → original (for extension remapping)

	for (const filePath of files.keys()) {
		normalizedFiles.set(normalizePath(filePath), filePath);
		stemFiles.set(getStem(filePath).toLowerCase(), filePath);
	}

	// Track which files have been used
	const usedFiles = new Set<string>();

	for (const page of pages) {
		const pagePath = page.img_path;
		const normalizedPagePath = normalizePath(pagePath);

		// Try exact match (normalized)
		if (normalizedFiles.has(normalizedPagePath)) {
			const actualPath = normalizedFiles.get(normalizedPagePath)!;
			matched.push(pagePath);
			usedFiles.add(actualPath);
			continue;
		}

		// Try stem-based match (extension remapping)
		const pageStem = getStem(pagePath).toLowerCase();
		if (stemFiles.has(pageStem)) {
			const actualPath = stemFiles.get(pageStem)!;
			if (!usedFiles.has(actualPath)) {
				matched.push(pagePath);
				remapped.set(pagePath, actualPath);
				usedFiles.add(actualPath);
				continue;
			}
		}

		// No match found
		missing.push(pagePath);
	}

	// Find extra files (not referenced in mokuro)
	const extra: string[] = [];
	for (const filePath of files.keys()) {
		if (!usedFiles.has(filePath)) {
			extra.push(filePath);
		}
	}

	return { matched, missing, extra, remapped };
}

// ============================================
// VOLUME INFO EXTRACTION
// ============================================

/**
 * Generates a deterministic UUID from a string using a simple hash
 * This ensures the same series name always produces the same UUID,
 * allowing image-only volumes from the same series to be grouped together.
 */
function generateDeterministicUUID(input: string): string {
	// Normalize input for consistent hashing
	const normalized = input.toLowerCase().trim();

	// Simple hash function (djb2 algorithm)
	let hash1 = 5381;
	let hash2 = 52711;

	for (let i = 0; i < normalized.length; i++) {
		const char = normalized.charCodeAt(i);
		hash1 = (hash1 * 33) ^ char;
		hash2 = (hash2 * 33) ^ char;
	}

	// Convert to positive numbers
	hash1 = hash1 >>> 0;
	hash2 = hash2 >>> 0;

	// Create UUID-like format from hashes
	const hex1 = hash1.toString(16).padStart(8, '0');
	const hex2 = hash2.toString(16).padStart(8, '0');

	// Create additional variation
	const hash3 = ((hash1 ^ hash2) >>> 0).toString(16).padStart(8, '0');
	const hash4 = ((hash1 + hash2) >>> 0).toString(16).padStart(8, '0');

	return `${hex1}-${hex2.slice(0, 4)}-4${hex2.slice(5, 8)}-${(8 + (parseInt(hash3[0], 16) % 4)).toString(16)}${hash3.slice(1, 4)}-${hash3.slice(4)}${hash4.slice(0, 4)}`;
}

/**
 * Extract series and volume info from a base path
 *
 * Assumes path structure like: "Author/Series Name/Volume 01"
 * Falls back to using path segments for series/volume names
 *
 * @param basePath - The base path of the volume
 * @returns Extracted series and volume names
 */
export function extractVolumeInfo(basePath: string): VolumeInfo {
	if (!basePath) {
		return { series: 'Untitled', volume: 'Untitled' };
	}

	const parts = basePath.split('/').filter((p) => p.length > 0);

	if (parts.length === 0) {
		return { series: 'Untitled', volume: 'Untitled' };
	}

	if (parts.length === 1) {
		// Single segment - use it for both
		return { series: parts[0], volume: parts[0] };
	}

	// Two or more segments - last is volume, second-to-last is series
	return {
		series: parts[parts.length - 2],
		volume: parts[parts.length - 1]
	};
}

// ============================================
// PLACEHOLDER IMAGE GENERATION
// ============================================

/**
 * Generate a placeholder image for missing pages
 * Creates a simple gray image with "File Missing" text
 */
function generatePlaceholderImage(filename: string, width = 800, height = 1200): File {
	// Create a canvas to generate the placeholder
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d')!;

	// Dark gray background
	ctx.fillStyle = '#2a2a2a';
	ctx.fillRect(0, 0, width, height);

	// Border
	ctx.strokeStyle = '#444';
	ctx.lineWidth = 4;
	ctx.strokeRect(10, 10, width - 20, height - 20);

	// Icon (simple X)
	ctx.strokeStyle = '#666';
	ctx.lineWidth = 8;
	ctx.lineCap = 'round';
	const iconSize = 80;
	const iconX = width / 2;
	const iconY = height / 2 - 60;
	ctx.beginPath();
	ctx.moveTo(iconX - iconSize / 2, iconY - iconSize / 2);
	ctx.lineTo(iconX + iconSize / 2, iconY + iconSize / 2);
	ctx.moveTo(iconX + iconSize / 2, iconY - iconSize / 2);
	ctx.lineTo(iconX - iconSize / 2, iconY + iconSize / 2);
	ctx.stroke();

	// "File Missing" text
	ctx.fillStyle = '#888';
	ctx.font = 'bold 32px sans-serif';
	ctx.textAlign = 'center';
	ctx.fillText('File Missing', width / 2, height / 2 + 40);

	// Filename text (truncated if too long)
	ctx.font = '16px monospace';
	ctx.fillStyle = '#666';
	const displayName = filename.length > 40 ? '...' + filename.slice(-37) : filename;
	ctx.fillText(displayName, width / 2, height / 2 + 80);

	// Convert canvas to blob synchronously using toDataURL
	const dataUrl = canvas.toDataURL('image/png');
	const byteString = atob(dataUrl.split(',')[1]);
	const mimeString = dataUrl.split(',')[0].split(':')[1].split(';')[0];
	const ab = new ArrayBuffer(byteString.length);
	const ia = new Uint8Array(ab);
	for (let i = 0; i < byteString.length; i++) {
		ia[i] = byteString.charCodeAt(i);
	}
	const blob = new Blob([ab], { type: mimeString });

	return new File([blob], filename.split('/').pop() || 'missing.png', { type: 'image/png' });
}

// ============================================
// CHARACTER COUNT CALCULATION
// ============================================

/**
 * Count characters in a mokuro block
 */
function countBlockChars(block: MokuroBlock): number {
	if (!block.lines || !Array.isArray(block.lines)) {
		return 0;
	}
	return block.lines.reduce((sum, line) => sum + (typeof line === 'string' ? line.length : 0), 0);
}

/**
 * Count characters in a page
 */
function countPageChars(page: MokuroPage): number {
	if (!page.blocks || !Array.isArray(page.blocks)) {
		return 0;
	}
	return page.blocks.reduce((sum, block) => sum + countBlockChars(block), 0);
}

/**
 * Calculate cumulative character counts for pages
 *
 * @param pages - Array of mokuro pages
 * @returns Array of cumulative character counts
 */
function calculateCumulativeChars(pages: MokuroPage[]): number[] {
	const counts: number[] = [];
	let cumulative = 0;

	for (const page of pages) {
		cumulative += countPageChars(page);
		counts.push(cumulative);
	}

	return counts;
}

// ============================================
// MAIN PROCESSING
// ============================================

/**
 * Process a decompressed volume into a format ready for database storage
 *
 * This is the main entry point for volume processing. It handles:
 * 1. Parsing mokuro file (if present)
 * 2. Matching images to pages
 * 3. Generating thumbnails
 * 4. Calculating character counts
 * 5. Creating nested source pairings for discovered archives
 *
 * @param input - Decompressed volume data
 * @returns Processed volume ready for database
 */
export async function processVolume(input: DecompressedVolume): Promise<ProcessedVolume> {
	const { mokuroFile, imageFiles, basePath, sourceType, nestedArchives } = input;

	// Parse mokuro or extract info from path
	let mokuroData: ParsedMokuro | null = null;
	let volumeInfo: VolumeInfo;
	let isImageOnly = false;

	if (mokuroFile) {
		mokuroData = await parseMokuroFile(mokuroFile);
		volumeInfo = {
			series: mokuroData.series,
			volume: mokuroData.volume
		};
	} else {
		// Image-only volume
		isImageOnly = true;
		volumeInfo = extractVolumeInfo(basePath);
	}

	// Match images to pages
	let matchResult: ImageMatchResult;
	let pages: ProcessedPage[];
	let pageCount: number;
	let totalChars: number;

	if (mokuroData) {
		matchResult = matchImagesToPages(mokuroData.pages, imageFiles);

		// Calculate cumulative character counts
		const cumulativeCounts = calculateCumulativeChars(mokuroData.pages);

		// Create processed pages (preserve all mokuro page fields)
		pages = mokuroData.pages.map((page, index) => ({
			version: page.version,
			img_width: page.img_width,
			img_height: page.img_height,
			img_path: matchResult.remapped.get(page.img_path) || page.img_path,
			blocks: page.blocks,
			cumulativeChars: cumulativeCounts[index]
		}));

		pageCount = mokuroData.pages.length;
		totalChars = mokuroData.chars || cumulativeCounts[cumulativeCounts.length - 1] || 0;
	} else {
		// Image-only: sort images and create minimal pages
		const sortedImages = Array.from(imageFiles.keys()).sort((a, b) =>
			a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
		);

		pages = sortedImages.map((imgPath) => ({
			img_path: imgPath,
			blocks: [],
			cumulativeChars: 0
		}));

		matchResult = {
			matched: sortedImages,
			missing: [],
			extra: [],
			remapped: new Map()
		};

		pageCount = sortedImages.length;
		totalChars = 0;
	}

	// Generate thumbnail from first image
	let thumbnail: Blob | null = null;
	let thumbnailWidth = 0;
	let thumbnailHeight = 0;

	const firstImagePath = pages[0]?.img_path;
	const firstImage = firstImagePath ? imageFiles.get(firstImagePath) : null;

	if (firstImage) {
		try {
			const result = await generateThumbnail(firstImage);
			thumbnail = result.file;
			thumbnailWidth = result.width;
			thumbnailHeight = result.height;
		} catch (error) {
			console.warn('Failed to generate thumbnail:', error);
		}
	}

	// Create file data (use matched files + extra files)
	const files: Record<string, File> = {};
	for (const [path, file] of imageFiles) {
		files[path] = file;
	}

	// Generate placeholder images for missing files
	for (const missingPath of matchResult.missing) {
		// Try to get dimensions from mokuro data if available
		const mokuroPage = mokuroData?.pages.find((p) => p.img_path === missingPath);
		const width = mokuroPage?.img_width || 800;
		const height = mokuroPage?.img_height || 1200;
		files[missingPath] = generatePlaceholderImage(missingPath, width, height);
	}

	// Create mismatch warning if needed
	let mismatchWarning: string | undefined;
	if (matchResult.missing.length > 0) {
		mismatchWarning = `Missing images: ${matchResult.missing.join(', ')}`;
	}

	// Create nested sources for discovered archives
	const nestedSources: PairedSource[] = nestedArchives.map((archiveFile) => {
		const archiveSource: ArchiveSource = {
			type: 'archive',
			file: archiveFile
		};

		const archiveStem = archiveFile.name.replace(/\.(zip|cbz|cbr|rar|7z)$/i, '');

		return {
			id: crypto.randomUUID(),
			mokuroFile: null,
			source: archiveSource,
			basePath: archiveStem,
			estimatedSize: archiveFile.size * 2.5,
			imageOnly: false
		};
	});

	// Build metadata
	// For image-only volumes, use deterministic series UUID based on extracted series name
	// This ensures volumes from the same series are grouped together
	let seriesUuid: string;
	let seriesName: string;

	if (mokuroData) {
		seriesUuid = mokuroData.seriesUuid;
		seriesName = volumeInfo.series;
	} else {
		// Image-only: use sophisticated series extraction and deterministic UUID
		seriesName = extractSeriesName(basePath);
		seriesUuid = generateDeterministicUUID(seriesName);
	}

	const metadata: ProcessedMetadata = {
		volumeUuid: mokuroData?.volumeUuid || crypto.randomUUID(),
		seriesUuid,
		series: seriesName,
		volume: volumeInfo.volume,
		mokuroVersion: mokuroData?.version,
		pageCount,
		chars: totalChars,
		thumbnail,
		thumbnailWidth,
		thumbnailHeight,
		mismatchWarning,
		missingPages: matchResult.missing.length > 0 ? matchResult.missing.length : undefined,
		missingPagePaths: matchResult.missing.length > 0 ? matchResult.missing : undefined,
		imageOnly: isImageOnly,
		sourceType
	};

	return {
		metadata,
		ocrData: {
			volume_uuid: metadata.volumeUuid,
			pages
		},
		fileData: {
			volume_uuid: metadata.volumeUuid,
			files
		},
		nestedSources
	};
}
