import type { VolumeData, VolumeMetadata, Page } from '$lib/types';
import {
  extractTitlesFromPath,
  extractSeriesName,
  generateDeterministicUUID
} from '$lib/util/series-extraction';

// Re-export for backwards compatibility
export { extractSeriesName };

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
  // Generate deterministic volume UUID from series + volume name
  // This ensures the same volume gets the same UUID across devices
  const volumeUuid = generateDeterministicUUID(`${finalSeriesName}/${volumeTitle}`);

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
    character_count: 0, // No OCR data means no characters
    page_char_counts: new Array(pages.length).fill(0) // All zeros for image-only
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
