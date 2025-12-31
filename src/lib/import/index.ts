/**
 * Unified Import System
 *
 * This module provides a unified pathway for importing manga volumes
 * from both local files and cloud providers.
 *
 * @module import
 */

// Types
export type {
	FileEntry,
	CategorizedFile,
	PairedSource,
	SourceDescriptor,
	DirectorySource,
	ArchiveSource,
	TocDirectorySource,
	ExpectedPairing,
	ExpectedPairingDetail,
	DecompressedVolume,
	ProcessedVolume,
	ProcessedMetadata,
	ProcessedPage,
	ImportProvider,
	ImportQueueItem
} from './types';

// Type utilities
export {
	IMAGE_EXTENSIONS,
	IMAGE_MIME_TYPES,
	ARCHIVE_EXTENSIONS,
	isImageExtension,
	isArchiveExtension,
	isMokuroExtension,
	getImageMimeType,
	parseFilePath,
	categorizeFile,
	isSystemFile
} from './types';

// Pairing
export { pairMokuroWithSources, type PairingResult } from './pairing';

// Routing
export { decideImportRouting, type ImportDecision } from './routing';

// Local Provider
export {
	localImportProvider,
	requiresWorkerDecompression,
	createLocalQueueItem
} from './local-provider';

// Processing
export {
	processVolume,
	parseMokuroFile,
	matchImagesToPages,
	extractVolumeInfo,
	type ParsedMokuro,
	type ImageMatchResult,
	type VolumeInfo
} from './processing';

// Database
export { saveVolume, volumeExists, deleteVolume } from './database';

// Import Service (main entry point)
export {
	importFiles,
	importQueue,
	currentImport,
	isImporting,
	clearCompletedImports,
	cancelQueuedImports,
	type ImportResult
} from './import-service';
