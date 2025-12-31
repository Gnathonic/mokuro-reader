/**
 * Mokuro-source pairing logic
 *
 * This module takes a flat list of FileEntry objects and pairs
 * .mokuro files with their corresponding image sources (directories or archives).
 *
 * Pairing Rules:
 * 1. Mokuro inside a directory → pairs with that directory
 * 2. Mokuro at root with same-name directory → pairs with that directory
 * 3. Mokuro at root with same-name archive → pairs with that archive
 * 4. TOC format: Mokuro alone in dir with only subdirs (no sibling images) → pairs as TOC
 * 5. Archive without external mokuro → self-contained pairing (internal mokuro expected)
 * 6. Directory with images but no mokuro anywhere → image-only pairing
 *
 * Priority:
 * - External mokuro takes precedence over internal mokuro
 * - Directory takes precedence over same-name archive (already decompressed)
 */

import type {
	FileEntry,
	CategorizedFile,
	PairedSource,
	SourceDescriptor,
	DirectorySource,
	ArchiveSource,
	TocDirectorySource
} from './types';
import { categorizeFile, parseFilePath, isSystemFile } from './types';
import { generateUUID } from '$lib/util/uuid';

/**
 * Result of the pairing operation
 */
export interface PairingResult {
	/** Successfully paired sources */
	pairings: PairedSource[];
	/** Warning messages (non-fatal issues) */
	warnings: string[];
}

/**
 * Pair mokuro files with their corresponding image sources
 *
 * Uses multi-pass matching to ensure specific matches are resolved first
 * across ALL mokuro files before trying less specific matching strategies.
 *
 * @param entries - Flat list of file entries from drag-drop or file picker
 * @returns Paired sources ready for processing
 */
export async function pairMokuroWithSources(entries: FileEntry[]): Promise<PairingResult> {
	// Filter out system files before processing
	const filteredEntries = entries.filter((e) => !isSystemFile(e.path));

	// Categorize all files
	const categorized = filteredEntries.map(categorizeFile);

	// Group by category
	const mokuroFiles = categorized.filter((f) => f.category === 'mokuro');
	const imageFiles = categorized.filter((f) => f.category === 'image');
	const archiveFiles = categorized.filter((f) => f.category === 'archive');

	const pairings: PairedSource[] = [];
	const warnings: string[] = [];

	// Track which files have been paired
	const pairedMokuroPaths = new Set<string>();
	const pairedArchivePaths = new Set<string>();
	const pairedImageDirs = new Set<string>();

	// Build directory structure map
	const dirStructure = buildDirectoryStructure(imageFiles);

	// Helper to get unpaired mokuro files
	const getUnpairedMokuro = () => mokuroFiles.filter((m) => !pairedMokuroPaths.has(m.path));

	// PASS 1: Same-directory images (mokuro inside folder with images)
	// Most specific - mokuro is literally in the same folder as images
	for (const mokuro of getUnpairedMokuro()) {
		const mokuroDir = mokuro.parentDir || '.';
		const sameDirImages = dirStructure.get(mokuroDir);
		if (sameDirImages && sameDirImages.size > 0 && !pairedImageDirs.has(mokuroDir)) {
			pairedImageDirs.add(mokuroDir);
			pairedMokuroPaths.add(mokuro.path);
			pairings.push(createDirectoryPairing(mokuroDir, sameDirImages, mokuro.file, false));
		}
	}

	// PASS 2: Same-name directory matching
	// Matches directories that are in the same branch as the mokuro file and start with the mokuro's stem
	// e.g., series/vol1.mokuro can match series/vol1/, series/vol1/nested/, series/vol1/deep/nested/
	// but NOT other/vol1/ (different branch)
	for (const mokuro of getUnpairedMokuro()) {
		const mokuroStem = mokuro.stem;
		const mokuroParent = mokuro.parentDir || '.';

		// Build the expected prefix for matching directories
		// Directories must start with {parent}/{stem}/ to be in the same branch
		const expectedPrefix = mokuroParent === '.'
			? mokuroStem.toLowerCase() + '/'
			: (mokuroParent + '/' + mokuroStem).toLowerCase() + '/';

		// Also check for exact match (directory name equals stem, direct sibling)
		const exactMatch = mokuroParent === '.'
			? mokuroStem.toLowerCase()
			: (mokuroParent + '/' + mokuroStem).toLowerCase();

		// Collect all directories that match (either exact or nested)
		const matchingDirs: string[] = [];
		for (const [dir] of dirStructure) {
			if (pairedImageDirs.has(dir)) continue;
			const dirLower = dir.toLowerCase();
			if (dirLower === exactMatch || dirLower.startsWith(expectedPrefix)) {
				matchingDirs.push(dir);
			}
		}

		if (matchingDirs.length > 0) {
			// Merge all matching directories into a single pairing
			const mergedFiles = new Map<string, File>();
			for (const dir of matchingDirs) {
				const files = dirStructure.get(dir)!;
				for (const [filename, file] of files) {
					// Preserve the path structure relative to mokuro's parent
					const relativePath = mokuroParent === '.'
						? dir
						: dir.slice(mokuroParent.length + 1);
					mergedFiles.set(relativePath + '/' + filename, file);
				}
				pairedImageDirs.add(dir);
			}

			if (mergedFiles.size > 0) {
				pairedMokuroPaths.add(mokuro.path);
				pairings.push(createDirectoryPairing(mokuroStem, mergedFiles, mokuro.file, false));
			}
		}
	}

	// PASS 3: Same-name sibling archive (mokuro.stem matches archive name)
	// Only matches archives in the same parent as the mokuro file
	// e.g., series1/vol1.mokuro can match series1/vol1.cbz but NOT series2/vol1.cbz
	for (const mokuro of getUnpairedMokuro()) {
		const mokuroStem = mokuro.stem;
		const mokuroParent = mokuro.parentDir || '.';
		for (const archive of archiveFiles) {
			if (pairedArchivePaths.has(archive.path)) continue;
			// Check that archive is a sibling (same parent as mokuro)
			const archiveParent = archive.parentDir || '.';
			if (archiveParent !== mokuroParent) continue; // Must be siblings
			if (archive.stem.toLowerCase() === mokuroStem.toLowerCase()) {
				pairedArchivePaths.add(archive.path);
				pairedMokuroPaths.add(mokuro.path);
				pairings.push(createArchivePairing(archive, mokuro.file));
				break;
			}
		}
	}

	// PASS 4: TOC format (mokuro alone with chapter subdirectories)
	// Most greedy - only use if no specific match found
	for (const mokuro of getUnpairedMokuro()) {
		const tocResult = checkTocFormat(mokuro, imageFiles, dirStructure, pairedImageDirs);
		if (tocResult) {
			const mokuroDir = mokuro.parentDir || '.';
			const prefix = mokuroDir === '.' ? '' : mokuroDir + '/';
			for (const chapterName of tocResult.chapters.keys()) {
				pairedImageDirs.add(prefix + chapterName);
			}
			pairedMokuroPaths.add(mokuro.path);
			pairings.push(createTocPairing(mokuroDir, mokuro.file, tocResult.chapters));
		}
	}

	// PASS 5: Report orphaned mokuro files
	for (const mokuro of getUnpairedMokuro()) {
		warnings.push(`Orphaned mokuro file: ${mokuro.path} (no matching images or archive)`);
	}

	// PASS 6: Standalone archives (no external mokuro)
	for (const archive of archiveFiles) {
		if (!pairedArchivePaths.has(archive.path)) {
			pairings.push(createArchivePairing(archive, null));
			pairedArchivePaths.add(archive.path);
		}
	}

	// PASS 7: Image-only directories (no mokuro found anywhere)
	const unpairedDirs = findUnpairedImageDirectories(
		imageFiles,
		pairedImageDirs,
		dirStructure
	);

	for (const dir of unpairedDirs) {
		const files = dirStructure.get(dir);
		if (files && files.size > 0) {
			pairings.push(createDirectoryPairing(dir, files, null, true));
			pairedImageDirs.add(dir);
		}
	}

	return { pairings, warnings };
}

/**
 * Build a map of directory paths to their image files
 */
function buildDirectoryStructure(
	imageFiles: CategorizedFile[]
): Map<string, Map<string, File>> {
	const structure = new Map<string, Map<string, File>>();

	for (const img of imageFiles) {
		const dir = img.parentDir || '.';
		if (!structure.has(dir)) {
			structure.set(dir, new Map());
		}
		structure.get(dir)!.set(img.filename, img.file);
	}

	return structure;
}

/**
 * Check if a mokuro file is in TOC format
 * TOC format: mokuro alone in a directory with only subdirectories containing images
 *
 * NOTE: This should only be called AFTER same-name matching has been attempted.
 * It skips directories that have already been paired.
 */
function checkTocFormat(
	mokuro: CategorizedFile,
	imageFiles: CategorizedFile[],
	dirStructure: Map<string, Map<string, File>>,
	pairedImageDirs: Set<string>
): { chapters: Map<string, Map<string, File>> } | null {
	const mokuroDir = mokuro.parentDir || '.';

	// Check if mokuro has sibling images (same directory)
	const siblingImages = imageFiles.filter((img) => (img.parentDir || '.') === mokuroDir);
	if (siblingImages.length > 0) {
		// Has sibling images, not TOC format
		return null;
	}

	// Find subdirectories with images that haven't been paired yet
	const chapters = new Map<string, Map<string, File>>();
	const prefix = mokuroDir === '.' ? '' : mokuroDir + '/';

	for (const [dir, files] of dirStructure) {
		// Skip directories that have already been paired
		if (pairedImageDirs.has(dir)) {
			continue;
		}

		// Check if this directory is a subdirectory of mokuro's directory
		if (dir !== mokuroDir && dir.startsWith(prefix)) {
			const relativePath = prefix ? dir.slice(prefix.length) : dir;
			// Only direct children (no nested paths in the relative path)
			if (!relativePath.includes('/')) {
				chapters.set(relativePath, files);
			}
		}
	}

	// Need at least 2 chapter subdirs to be considered TOC format
	if (chapters.size >= 2) {
		return { chapters };
	}

	return null;
}

/**
 * Find directories with images that haven't been paired
 */
function findUnpairedImageDirectories(
	imageFiles: CategorizedFile[],
	pairedImageDirs: Set<string>,
	dirStructure: Map<string, Map<string, File>>
): string[] {
	const unpaired: string[] = [];

	for (const dir of dirStructure.keys()) {
		if (!pairedImageDirs.has(dir)) {
			unpaired.push(dir);
		}
	}

	return unpaired;
}

/**
 * Create a directory-based pairing
 */
function createDirectoryPairing(
	basePath: string,
	files: Map<string, File>,
	mokuroFile: File | null,
	imageOnly: boolean
): PairedSource {
	// Calculate estimated size
	let estimatedSize = 0;
	for (const file of files.values()) {
		estimatedSize += file.size;
	}
	if (mokuroFile) {
		estimatedSize += mokuroFile.size;
	}

	const source: DirectorySource = {
		type: 'directory',
		files
	};

	return {
		id: generateUUID(),
		mokuroFile,
		source,
		basePath,
		estimatedSize,
		imageOnly
	};
}

/**
 * Create an archive-based pairing
 */
function createArchivePairing(
	archive: CategorizedFile,
	mokuroFile: File | null
): PairedSource {
	const source: ArchiveSource = {
		type: 'archive',
		file: archive.file
	};

	// For archives, estimate ~2.5x compressed size for decompression
	const estimatedSize = archive.file.size * 2.5 + (mokuroFile?.size || 0);

	return {
		id: generateUUID(),
		mokuroFile,
		source,
		basePath: archive.stem,
		estimatedSize,
		imageOnly: false // Can't know until decompressed
	};
}

/**
 * Create a TOC-style pairing
 */
function createTocPairing(
	basePath: string,
	mokuroFile: File,
	chapters: Map<string, Map<string, File>>
): PairedSource {
	// Calculate estimated size across all chapters
	let estimatedSize = mokuroFile.size;
	for (const files of chapters.values()) {
		for (const file of files.values()) {
			estimatedSize += file.size;
		}
	}

	const source: TocDirectorySource = {
		type: 'toc-directory',
		chapters
	};

	return {
		id: generateUUID(),
		mokuroFile,
		source,
		basePath,
		estimatedSize,
		imageOnly: false
	};
}
