import type { VolumeData, VolumeMetadata, Page } from '$lib/types';

/**
 * Strips common metadata suffixes and prefixes from folder/file names
 * Examples: "(2020) (JPN) (Digital)", "[DL版]", "s" suffix
 */
function stripMetadata(name: string): string {
  return (
    name
      // Remove trailing 's' that indicates scan quality
      .replace(/s$/i, '')
      // Remove year and release info: (2020) (JPN) (Digital) (danke-Empire)
      .replace(/\s*\(\d{4}\)(\s*\([^)]+\))*/g, '')
      // Remove [DL版], [Digital], etc.
      .replace(/\s*\[(DL版|Digital|RAW|完)\]/gi, '')
      // Remove trailing (完) for completed series
      .replace(/\s*\(完\)$/g, '')
      // Remove leading category markers: (一般コミック), 【一般コミック】
      .replace(/^[（(【]\s*[^）)】]+[）)】]\s*/g, '')
      .trim()
  );
}

/**
 * Extracts author/group prefix from Japanese naming conventions
 * Returns the name without author prefix
 * Examples: "[Author] Title" -> "Title", "Author 「Title」" -> "Title"
 */
function stripAuthorPrefix(name: string): string {
  // [Author] Title or [Author×Author] Title
  let result = name.replace(/^\[[^\]]+\]\s*/, '');
  // Author 「Title」 -> Title
  const quoteMatch = result.match(/「(.+?)」/);
  if (quoteMatch) {
    result = quoteMatch[1];
  }
  return result.trim();
}

/**
 * Common folder names that are NOT series names
 * These are container/organizational folders
 */
const SUSPECT_PARENT_NAMES = new Set([
  // Common system/user folders
  'downloads',
  'download',
  'desktop',
  'documents',
  'pictures',
  'images',
  'files',
  'temp',
  'tmp',
  'new folder',
  'untitled folder',
  // Common manga organization folders
  'manga',
  'mangas',
  'comics',
  'comic',
  'raw',
  'raws',
  'scans',
  'scan',
  'digital',
  'complete',
  'completed',
  'ongoing',
  'to read',
  'reading',
  'finished',
  // Project-specific
  'no mokuro',
  'without mokuro',
  'image only',
  'images only',
  // Language/source indicators
  'japanese',
  'english',
  'translated',
  'untranslated',
  'jpn',
  'eng',
  'jp',
  'en'
]);

/**
 * Checks if a folder name looks like a generic container rather than a series name
 */
function isSuspectParentFolder(name: string): boolean {
  const normalized = name.toLowerCase().trim();

  // Check against blocklist
  if (SUSPECT_PARENT_NAMES.has(normalized)) {
    return true;
  }

  // Very short names (1-2 chars) are suspect unless they're Japanese
  if (normalized.length <= 2 && !/[\u3040-\u30ff\u4e00-\u9faf]/.test(normalized)) {
    return true;
  }

  // Names that are just numbers are suspect
  if (/^\d+$/.test(normalized)) {
    return true;
  }

  return false;
}

/**
 * Volume indicator patterns for extraction
 * Matches: Vol, Volume, V, v., #, Ch, Chapter, 第X巻, and bare numbers at end
 */
const VOLUME_PATTERNS: Array<{ pattern: RegExp; seriesGroup: number; volGroup: number }> = [
  // [Author] Series 第XX巻 - must come before simpler patterns
  {
    pattern: /^\[[^\]]+\]\s*(.+?)\s+第(\d+)巻/,
    seriesGroup: 1,
    volGroup: 2
  },
  // Series 第X巻 (no author) - Japanese volume
  {
    pattern: /^(.+?)\s+第(\d+)巻$/,
    seriesGroup: 1,
    volGroup: 2
  },
  // Series X巻 (without 第)
  {
    pattern: /^(.+?)\s+(\d+)巻$/,
    seriesGroup: 1,
    volGroup: 2
  },
  // Standard volume indicators: "Vol 1", "Volume 01", "v.1", "V1", "v01"
  {
    pattern: /^(.+?)\s*[-–—]?\s*(vol\.?|volume)\s*(\d+)/i,
    seriesGroup: 1,
    volGroup: 3
  },
  // Bare v followed by number: "Series v01", "Series_v01"
  {
    pattern: /^(.+?)[_\s-]v(\d+)/i,
    seriesGroup: 1,
    volGroup: 2
  },
  // Chapter indicators: "Ch 1", "Chapter 01", "Ch.1"
  {
    pattern: /^(.+?)\s*[-–—]?\s*(ch\.?|chapter)\s*(\d+)/i,
    seriesGroup: 1,
    volGroup: 3
  },
  // Version numbers: "Series Ver.1.0"
  {
    pattern: /^(.+?)\s+Ver\.?\s*(\d+)/i,
    seriesGroup: 1,
    volGroup: 2
  },
  // Hash prefix: "Series #01"
  {
    pattern: /^(.+?)\s*#\s*(\d+)/,
    seriesGroup: 1,
    volGroup: 2
  },
  // Hyphen separator: "Series-Name-01", "Series--01"
  {
    pattern: /^(.+?)-{1,2}(\d+)$/,
    seriesGroup: 1,
    volGroup: 2
  },
  // Underscore separator: "series_name_01"
  {
    pattern: /^(.+?)_(\d+)$/,
    seriesGroup: 1,
    volGroup: 2
  },
  // Space separator: "Series 01" (but not years like 2020)
  {
    pattern: /^(.+?)\s+(\d{1,3})$/,
    seriesGroup: 1,
    volGroup: 2
  },
  // No separator, just trailing number: "series1", "shindou1"
  {
    pattern: /^(.+?)(\d+)$/,
    seriesGroup: 1,
    volGroup: 2
  }
];

/**
 * Patterns for bare volume numbers (no series name in the string)
 * Used when folder name is just a volume indicator like "第01巻" or "vol1"
 */
const BARE_VOLUME_PATTERNS = [
  // Japanese bare volume: "第01巻", "第1巻"
  /^第(\d+)巻$/,
  // Bare vol: "vol1", "Vol01", "vol 1"
  /^vol\.?\s*(\d+)$/i,
  // Bare v: "v01", "V1"
  /^v\.?\s*(\d+)$/i,
  // Just a number: "01", "1"
  /^(\d+)$/
];

/**
 * Extracts volume number from a name string
 * Returns the series name and volume number if found
 */
function extractVolumeInfo(name: string): { seriesName: string; volumeNum: string } | null {
  // First strip metadata to get cleaner name
  const cleanName = stripMetadata(name);

  for (const { pattern, seriesGroup, volGroup } of VOLUME_PATTERNS) {
    const match = cleanName.match(pattern);
    if (match && match[seriesGroup] && match[volGroup]) {
      let seriesName = match[seriesGroup].trim();

      // Clean up series name - remove trailing separators
      seriesName = seriesName.replace(/[-_\s]+$/, '').trim();

      // Skip if series name is empty or just punctuation
      if (!seriesName || /^[-_\s.]+$/.test(seriesName)) {
        continue;
      }

      return {
        seriesName,
        volumeNum: match[volGroup]
      };
    }
  }
  return null;
}

/**
 * Extracts just a volume number from a bare volume string like "第01巻" or "01"
 * Returns just the volume number, or null if not a bare volume pattern
 */
function extractBareVolumeNumber(name: string): string | null {
  const cleanName = stripMetadata(name);

  for (const pattern of BARE_VOLUME_PATTERNS) {
    const match = cleanName.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Extracts volume number from leaf folder, using any method available
 * Returns volume number or null
 */
function extractAnyVolumeNumber(name: string): string | null {
  // Try bare volume patterns first
  const bareVol = extractBareVolumeNumber(name);
  if (bareVol) return bareVol;

  // Try full extraction patterns
  const volumeInfo = extractVolumeInfo(name);
  if (volumeInfo) return volumeInfo.volumeNum;

  return null;
}

/**
 * Extracts a clean title from a file or folder path
 *
 * Key principle: Prefer parent folder as series name, unless it's a suspect
 * container folder (like "Downloads", "Manga", etc.)
 *
 * Examples:
 *   "Downloads/Gleipnir 01" -> { series: "Gleipnir", volume: "Volume 01" }
 *   "Ichigo Mashimaro/Ichigo-Mashimaro-01" -> { series: "Ichigo Mashimaro", volume: "Volume 01" }
 *   "Vinland Saga/第01巻" -> { series: "Vinland Saga", volume: "Volume 01" }
 *   "no Mokuro/Gleipnir 01" -> { series: "Gleipnir", volume: "Volume 01" }
 *
 * Logic:
 * 1. Single folder: extract series+volume from name
 * 2. Multiple folders with suspect parent: extract series from leaf
 * 3. Multiple folders with good parent: use parent as series
 */
function extractTitlesFromPath(path: string): { seriesTitle: string; volumeTitle: string } {
  // Remove file extension if present
  const pathWithoutExt = path.replace(/\.(cbz|zip)$/i, '');

  // Split by path separator
  const parts = pathWithoutExt.split('/').filter((p) => p.length > 0);

  if (parts.length === 0) {
    return { seriesTitle: 'Unknown', volumeTitle: 'Unknown' };
  }

  if (parts.length === 1) {
    // Single folder - try to extract series+volume from name
    const name = parts[0];

    const volumeInfo = extractVolumeInfo(name);
    if (volumeInfo) {
      return {
        seriesTitle: volumeInfo.seriesName,
        volumeTitle: `Volume ${volumeInfo.volumeNum}`
      };
    }

    // No volume detected - use name as both
    return { seriesTitle: stripMetadata(name), volumeTitle: stripMetadata(name) };
  }

  // Multiple parts
  const leafFolder = parts[parts.length - 1];
  const parentFolder = parts[parts.length - 2];

  // Check if parent contains the leaf name (case-sensitive)
  // This happens when a zip file is extracted and creates a duplicate structure
  // e.g., "D049-213 One-Punch Man - One-Punch Man 01/One-Punch Man 01"
  const parentContainsLeaf = parentFolder.includes(leafFolder);

  // Check if parent folder is suspect (generic container name)
  if (isSuspectParentFolder(parentFolder) || parentContainsLeaf) {
    // Parent is suspect or contains leaf - try to extract series from leaf
    const volumeInfo = extractVolumeInfo(leafFolder);
    if (volumeInfo) {
      return {
        seriesTitle: volumeInfo.seriesName,
        volumeTitle: `Volume ${volumeInfo.volumeNum}`
      };
    }

    // Couldn't extract from leaf either - use cleaned leaf as series
    const cleanedLeaf = stripMetadata(stripAuthorPrefix(leafFolder));
    return { seriesTitle: cleanedLeaf, volumeTitle: cleanedLeaf };
  }

  // Parent folder looks like a valid series name - use it
  const seriesTitle = parentFolder;

  // Try to extract volume number from leaf
  const volumeNum = extractAnyVolumeNumber(leafFolder);
  if (volumeNum) {
    return {
      seriesTitle,
      volumeTitle: `Volume ${volumeNum}`
    };
  }

  // No volume number found - use cleaned leaf as volume title
  return {
    seriesTitle,
    volumeTitle: stripMetadata(stripAuthorPrefix(leafFolder))
  };
}

/**
 * Extracts just the series name from a path (for grouping purposes)
 * This normalizes the series name for consistent UUID generation
 */
export function extractSeriesName(path: string): string {
  const { seriesTitle } = extractTitlesFromPath(path);
  // Normalize: trim, collapse whitespace
  return seriesTitle.trim().replace(/\s+/g, ' ');
}

/**
 * Generates a deterministic UUID from a string using a simple hash
 * This ensures the same series name always produces the same UUID
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
  // Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const hex1 = hash1.toString(16).padStart(8, '0');
  const hex2 = hash2.toString(16).padStart(8, '0');

  // Create additional variation
  const hash3 = ((hash1 ^ hash2) >>> 0).toString(16).padStart(8, '0');
  const hash4 = ((hash1 + hash2) >>> 0).toString(16).padStart(8, '0');

  return `${hex1}-${hex2.slice(0, 4)}-4${hex2.slice(5, 8)}-${(8 + (parseInt(hash3[0], 16) % 4)).toString(16)}${hash3.slice(1, 4)}-${hash3.slice(4)}${hash4.slice(0, 4)}`;
}

/**
 * Generates a UUID v4
 */
function generateUUID(): string {
  // Use crypto.randomUUID if available (modern browsers)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Gets image dimensions from a File object
 */
async function getImageDimensions(imageFile: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(imageFile);

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.width, height: img.height });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

/**
 * Creates a minimal Page object for an image without mokuro data
 */
async function createPageFromImage(imageFileName: string, imageFile: File): Promise<Page> {
  try {
    const { width, height } = await getImageDimensions(imageFile);

    return {
      version: '', // No mokuro version for image-only pages
      img_width: width,
      img_height: height,
      blocks: [], // No OCR data
      img_path: imageFileName
    };
  } catch (error) {
    console.warn(`Failed to get dimensions for ${imageFileName}, using defaults:`, error);
    // Fallback dimensions if image loading fails
    return {
      version: '',
      img_width: 1920,
      img_height: 1080,
      blocks: [],
      img_path: imageFileName
    };
  }
}

/**
 * Series info that can be pre-computed for grouping
 */
export interface SeriesInfo {
  seriesName: string;
  seriesUuid: string;
}

/**
 * Generates volume metadata and data for images without a .mokuro file
 * @param path - The file/folder path
 * @param imageFiles - Record of image filename to File object
 * @param seriesInfo - Optional pre-computed series info for grouping multiple volumes
 */
export async function generateFallbackVolumeData(
  path: string,
  imageFiles: Record<string, File>,
  seriesInfo?: SeriesInfo
): Promise<{
  metadata: Partial<VolumeMetadata>;
  data: Partial<VolumeData>;
  seriesUuid: string;
}> {
  const { seriesTitle, volumeTitle } = extractTitlesFromPath(path);

  // Use provided series info or generate deterministic UUID from series title
  const finalSeriesName = seriesInfo?.seriesName ?? seriesTitle;
  const seriesUuid = seriesInfo?.seriesUuid ?? generateDeterministicUUID(seriesTitle);
  const volumeUuid = generateUUID();

  // Sort image files naturally (1.jpg, 2.jpg, 10.jpg instead of 1.jpg, 10.jpg, 2.jpg)
  const sortedFileNames = Object.keys(imageFiles).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );

  // Create Page objects for each image
  const pages: Page[] = await Promise.all(
    sortedFileNames.map((fileName) => createPageFromImage(fileName, imageFiles[fileName]))
  );

  const metadata: Partial<VolumeMetadata> = {
    mokuro_version: '', // Empty string indicates image-only volume
    series_title: finalSeriesName,
    series_uuid: seriesUuid,
    volume_title: volumeTitle,
    volume_uuid: volumeUuid,
    page_count: pages.length,
    character_count: 0 // No OCR data means no characters
  };

  const data: Partial<VolumeData> = {
    volume_uuid: volumeUuid,
    pages: pages,
    files: imageFiles
  };

  return {
    metadata,
    data,
    seriesUuid
  };
}
