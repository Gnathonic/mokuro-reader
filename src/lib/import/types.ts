import type { ImportNames } from './image-only-naming';
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
  /**
   * Where the source sat, when `basePath` alone loses it: a picked archive's
   * folder path, a nested archive's outer archive path plus its own
   * (`Series.zip/Vol 1.cbz` → `Series/Vol 1`). The image-only review groups
   * the volume and derives its uuid from it (`locateVolume`, #285).
   */
  titlePath?: string;
  /**
   * The names an image-only volume is saved under, decided in the image-only
   * review (`nameGroup`, #285).
   */
  importNames?: ImportNames;
  /**
   * An archive whose image-only volumes were reviewed before it was queued
   * (#285). `processArchiveContents` takes their names from here and never
   * prompts. Its `.mokuro` volumes import regardless.
   */
  archiveReview?: ArchiveReview;
  /** Estimated size in bytes for memory management */
  estimatedSize: number;
  /** Whether this is an image-only source (no mokuro found anywhere) */
  imageOnly: boolean;
  /**
   * The import (one pick, drop or deep link) this source belongs to; archives
   * found inside it inherit it. "Skip all remaining" and a cancel apply to
   * every later review of the same import (#285).
   */
  batch?: number;
}

export interface ArchiveReview {
  approved: true;
  /**
   * Approved names by the volume's path INSIDE the archive (`.` = its root),
   * as `planArchiveListing` reports it. An image-only volume not listed here
   * was skipped.
   */
  names: Map<string, ImportNames>;
}

/**
 * Describes where the images come from
 */
export type SourceDescriptor = DirectorySource | ArchiveSource | TocDirectorySource;

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
  /** Optional thumbnail sidecar (e.g., Volume.webp) */
  thumbnailSidecar?: File | null;
  /** Map of relative path → File for all images */
  imageFiles: Map<string, File>;
  /** Base path for series/volume name extraction */
  basePath: string;
  /**
   * The volume's full path, including the folder or archive it came from —
   * `basePath` of an archive's image-only volume is relative to the archive's
   * inside. Defaults to `basePath`. Archives found inside the volume inherit
   * it, so their review sees where they sat (#285).
   */
  titlePath?: string;
  /**
   * The names an image-only volume is saved under, decided in the image-only
   * review (`nameGroup`, #285).
   */
  importNames?: ImportNames;
  /** Where this came from */
  sourceType: 'local' | 'cloud';
  /** Archives discovered inside (for recursive processing) */
  nestedArchives: File[];
  /** OCR layer files (`<stem>.<id>.mokuro`) found beside the volume's own `.mokuro`. */
  layerFiles?: Array<{ layerId: string; file: File }>;
  /**
   * `mokuroFile` is the cloud's LISTED primary sidecar (not an archive entry):
   * that file's listing stamp — see `ProcessedMetadata.mokuroCloud`.
   */
  mokuroCloud?: import('$lib/catalog/mokuro-hash').MokuroCloudAttestation;
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
  /**
   * Restore a volume the library kept after "Remove from device" (#285): if
   * its row is still there, the save keeps the row's own series and volume
   * titles (and series uuid) instead of `series`/`volume`/`seriesUuid`.
   */
  keepStoredTitles?: boolean;
  /** Where this volume came from */
  sourceType?: 'local' | 'cloud';
  /** Spine width in pixels (from mokuro metadata) */
  spineWidth?: number;
  /**
   * SHA-256 (lowercase hex) of the `.mokuro` bytes this volume's OCR was parsed
   * from — becomes `VolumeMetadata.mokuro_sha256`. Absent for image-only.
   */
  mokuroSha256?: string;
  /**
   * Set by a cloud download whose primary came from the LISTED sidecar beside
   * the archive (not one embedded in it): the stored file's listing stamp,
   * which is what lets `buildSeriesFile` publish the hash. Becomes
   * `VolumeMetadata.mokuro_sha256_cloud`.
   */
  mokuroCloud?: import('$lib/catalog/mokuro-hash').MokuroCloudAttestation;
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

/** Image extension to MIME type mapping - single source of truth */
export const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  jxl: 'image/jxl'
};

/** Supported image extensions (derived from MIME types map) */
export const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_TYPES));

/** Supported archive extensions */
export const ARCHIVE_EXTENSIONS = new Set(['zip', 'cbz', 'cbr', 'rar', '7z']);

/**
 * System files and directories that should never be imported.
 * These are commonly found in archives created on various operating systems.
 */
export const EXCLUDED_SYSTEM_PATTERNS = new Set([
  // macOS
  '__MACOSX',
  '.DS_Store',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  '.TemporaryItems',
  '.Trash',
  // Windows
  'System Volume Information',
  '$RECYCLE.BIN',
  'Thumbs.db',
  'desktop.ini',
  'Desktop.ini',
  'RECYCLER',
  'RECYCLED',
  // Linux
  '.Trash-1000',
  '.thumbnails',
  '.directory',
  // Cloud storage
  '.dropbox',
  '.dropbox.cache',
  // Version control
  '.git',
  '.svn'
]);

/**
 * File extensions that indicate temporary/backup files
 */
const EXCLUDED_EXTENSIONS = new Set(['bak', 'tmp', 'temp']);

/**
 * Check if a path contains any system files/directories that should be excluded.
 * This filters out OS metadata, version control, temporary files, etc.
 *
 * @param path - The file path to check
 * @returns true if the path should be excluded from import
 */
export function isSystemFile(path: string): boolean {
  // Normalize path separators
  const normalizedPath = path.replace(/\\/g, '/');
  const segments = normalizedPath.split('/');

  for (const segment of segments) {
    // Skip empty segments
    if (!segment) continue;

    // Check for Mac resource fork files (start with "._")
    if (segment.startsWith('._')) return true;

    // Check for backup files (end with "~")
    if (segment.endsWith('~')) return true;

    // Check exact matches against excluded patterns
    if (EXCLUDED_SYSTEM_PATTERNS.has(segment)) return true;
  }

  // Check for excluded extensions on the filename
  const filename = segments[segments.length - 1] || '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot >= 0) {
    const ext = filename.slice(lastDot + 1).toLowerCase();
    if (EXCLUDED_EXTENSIONS.has(ext)) return true;
  }

  return false;
}

/** Check if extension is an image */
export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

/** Get MIME type for an image extension */
export function getImageMimeType(ext: string): string {
  return IMAGE_MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream';
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
  // Normalize path separators and strip leading slashes
  const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '');

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
