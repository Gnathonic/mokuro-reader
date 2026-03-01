/**
 * Volume editor utility functions for updating volume metadata and stats
 */

import { db } from '$lib/catalog/db';
import { isImageExtension } from '$lib/import';
import { volumesWithTrash, VolumeData } from '$lib/settings/volume-data';
import { get } from 'svelte/store';
import { convertToWebP, generateThumbnail } from '$lib/catalog/thumbnails';
import { thumbnailCache } from '$lib/catalog/thumbnail-cache';
import type { VolumeMetadata } from '$lib/types';
import { getCharCount } from '$lib/util/count-chars';
import { normalizeFilename } from '$lib/util/misc';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';

type Volumes = Record<string, VolumeData>;

function isLikelyGeneratedMissingPlaceholder(path: string, file: File): boolean {
  if (!file?.type || file.type.toLowerCase() !== 'image/png') {
    return false;
  }

  // Our generated missing placeholders can keep original filename extensions (e.g. .jpg)
  // while always being PNG blobs. Use this mismatch as a conservative legacy-data filter.
  const lowerPath = path.toLowerCase();
  return (
    lowerPath.endsWith('.jpg') ||
    lowerPath.endsWith('.jpeg') ||
    lowerPath.endsWith('.webp') ||
    lowerPath.endsWith('.avif') ||
    lowerPath.endsWith('.gif') ||
    lowerPath.endsWith('.bmp') ||
    lowerPath.endsWith('.tif') ||
    lowerPath.endsWith('.tiff')
  );
}

function isCoverCandidateImage(path: string, file: File): boolean {
  if (file.type?.toLowerCase().startsWith('image/')) {
    return true;
  }
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return isImageExtension(ext);
}

function basename(path: string): string {
  return path.split('/').pop() || path;
}

async function getPageOrderComparator(
  volumeUuid: string
): Promise<(a: string, b: string) => number> {
  const volumeOcr = await db.volume_ocr.get(volumeUuid);
  const pages = volumeOcr?.pages || [];

  const pageIndexByPath = new Map<string, number>();
  const pageIndexByBasename = new Map<string, number>();

  pages.forEach((page, index) => {
    const normalizedPath = normalizeFilename(page.img_path).toLowerCase();
    const normalizedBase = basename(normalizedPath);

    if (!pageIndexByPath.has(normalizedPath)) {
      pageIndexByPath.set(normalizedPath, index);
    }
    if (!pageIndexByBasename.has(normalizedBase)) {
      pageIndexByBasename.set(normalizedBase, index);
    }
  });

  return (a: string, b: string) => {
    const normalizedA = normalizeFilename(a).toLowerCase();
    const normalizedB = normalizeFilename(b).toLowerCase();

    const aIndex =
      pageIndexByPath.get(normalizedA) ?? pageIndexByBasename.get(basename(normalizedA)) ?? Infinity;
    const bIndex =
      pageIndexByPath.get(normalizedB) ?? pageIndexByBasename.get(basename(normalizedB)) ?? Infinity;

    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }

    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  };
}

async function syncCoverSidecarToCloud(volumeUuid: string, thumbnailFile: File): Promise<void> {
  const provider = unifiedCloudManager.getActiveProvider();
  if (!provider || !provider.isAuthenticated()) {
    return;
  }

  const volume = await db.volumes.get(volumeUuid);
  if (!volume) {
    throw new Error(`Volume ${volumeUuid} not found`);
  }

  const coverWebP = await convertToWebP(thumbnailFile);
  await unifiedCloudManager.uploadFile(
    `${volume.series_title}/${volume.volume_title}.webp`,
    coverWebP
  );
}

/**
 * Get all unique series from the catalog for the series dropdown
 */
export async function getAllSeriesOptions(): Promise<{ uuid: string; title: string }[]> {
  const allVolumes = await db.volumes.toArray();

  // Group by series_uuid to get unique series
  const seriesMap = new Map<string, string>();
  for (const volume of allVolumes) {
    if (volume.series_uuid && volume.series_title) {
      seriesMap.set(volume.series_uuid, volume.series_title);
    }
  }

  // Convert to array and sort by title
  const series = Array.from(seriesMap.entries()).map(([uuid, title]) => ({
    uuid,
    title
  }));

  series.sort((a, b) => a.title.localeCompare(b.title));

  return series;
}

/**
 * Generate a new series UUID
 */
export function generateNewSeriesUuid(): string {
  return crypto.randomUUID();
}

/**
 * Update volume metadata in IndexedDB
 */
export async function updateVolumeInDb(
  volumeUuid: string,
  updates: Partial<VolumeMetadata>
): Promise<void> {
  await db.volumes.update(volumeUuid, updates);
}

/**
 * Update volume stats in localStorage
 */
export function updateVolumeStats(
  volumeUuid: string,
  updates: {
    progress?: number;
    chars?: number;
    timeReadInMinutes?: number;
    completed?: boolean;
    series_uuid?: string;
    series_title?: string;
    volume_title?: string;
  }
): void {
  volumesWithTrash.update((prev: Volumes) => {
    const currentVolume = prev[volumeUuid] || new VolumeData();

    return {
      ...prev,
      [volumeUuid]: new VolumeData({
        ...currentVolume,
        ...(updates.progress !== undefined && { progress: updates.progress }),
        ...(updates.chars !== undefined && { chars: updates.chars }),
        ...(updates.timeReadInMinutes !== undefined && {
          timeReadInMinutes: updates.timeReadInMinutes
        }),
        ...(updates.completed !== undefined && { completed: updates.completed }),
        ...(updates.series_uuid !== undefined && { series_uuid: updates.series_uuid }),
        ...(updates.series_title !== undefined && { series_title: updates.series_title }),
        ...(updates.volume_title !== undefined && { volume_title: updates.volume_title })
      })
    };
  });
}

/**
 * Reset all reading progress for a volume
 */
export function resetVolumeProgress(volumeUuid: string): void {
  volumesWithTrash.update((prev: Volumes) => {
    const currentVolume = prev[volumeUuid];
    if (!currentVolume) return prev;

    return {
      ...prev,
      [volumeUuid]: new VolumeData({
        ...currentVolume,
        progress: 0,
        chars: 0,
        timeReadInMinutes: 0,
        completed: false,
        recentPageTurns: [],
        sessions: [],
        lastProgressUpdate: new Date(0).toISOString()
      })
    };
  });
}

/**
 * Update the cover/thumbnail for a volume
 */
export async function updateVolumeCover(volumeUuid: string, imageFile: File): Promise<void> {
  // Generate thumbnail from the image
  const thumbnailResult = await generateThumbnail(imageFile);

  // Invalidate cached bitmap before updating DB
  thumbnailCache.invalidate(volumeUuid);

  // Update in IndexedDB
  await db.volumes.update(volumeUuid, {
    thumbnail: thumbnailResult.file,
    thumbnail_width: thumbnailResult.width,
    thumbnail_height: thumbnailResult.height
  });

  await syncCoverSidecarToCloud(volumeUuid, thumbnailResult.file);
}

/**
 * Reset cover to first page of the volume
 */
export async function resetVolumeCover(volumeUuid: string): Promise<void> {
  // Get the volume files
  const volumeFiles = await db.volume_files.get(volumeUuid);
  if (!volumeFiles?.files) {
    throw new Error('Volume files not found');
  }
  const volume = await db.volumes.get(volumeUuid);
  if (!volume) {
    throw new Error(`Volume ${volumeUuid} not found`);
  }

  // Exclude known placeholder pages generated for missing files.
  const placeholderPaths = new Set(volume.missing_page_paths || []);
  const compareByPageOrder = await getPageOrderComparator(volumeUuid);
  const candidatePaths = Object.keys(volumeFiles.files).filter((path) => {
    if (placeholderPaths.has(path)) return false;
    const file = volumeFiles.files[path];
    if (!isCoverCandidateImage(path, file)) return false;
    return !isLikelyGeneratedMissingPlaceholder(path, file);
  });

  // Prefer OCR page order, then natural filename order.
  const filePaths = candidatePaths.sort(compareByPageOrder);

  if (filePaths.length === 0) {
    throw new Error('No non-placeholder image files in volume');
  }

  // Use the first image file
  const firstFile = volumeFiles.files[filePaths[0]];

  // Generate thumbnail
  const thumbnailResult = await generateThumbnail(firstFile);

  // Invalidate cached bitmap before updating DB
  thumbnailCache.invalidate(volumeUuid);

  // Update in IndexedDB
  await db.volumes.update(volumeUuid, {
    thumbnail: thumbnailResult.file,
    thumbnail_width: thumbnailResult.width,
    thumbnail_height: thumbnailResult.height
  });

  await syncCoverSidecarToCloud(volumeUuid, thumbnailResult.file);
}

/**
 * Get volume files for cover picker (page selection)
 */
export async function getVolumeFiles(
  volumeUuid: string
): Promise<{ path: string; file: File }[] | null> {
  const volumeFiles = await db.volume_files.get(volumeUuid);
  if (!volumeFiles?.files) {
    return null;
  }

  const compareByPageOrder = await getPageOrderComparator(volumeUuid);

  // Get file paths sorted naturally
  const filePaths = Object.keys(volumeFiles.files)
    .filter((path) => {
      const file = volumeFiles.files[path];
      if (!isCoverCandidateImage(path, file)) return false;
      return true;
    })
    .sort(compareByPageOrder);

  return filePaths.map((path) => ({
    path,
    file: volumeFiles.files[path]
  }));
}

/**
 * Get current volume data from both IndexedDB and localStorage
 */
export async function getVolumeData(
  volumeUuid: string
): Promise<{ metadata: VolumeMetadata; stats: VolumeData } | null> {
  const metadata = await db.volumes.get(volumeUuid);
  if (!metadata) {
    return null;
  }

  const allStats = get(volumesWithTrash) as Volumes;
  const stats = allStats[volumeUuid] || new VolumeData();

  return { metadata, stats };
}

/**
 * Calculate character count from volume OCR pages.
 * Used as fallback when page_char_counts and character_count are missing.
 */
export async function calculateVolumeCharacterCount(volumeUuid: string): Promise<number> {
  const volumeOcr = await db.volume_ocr.get(volumeUuid);
  if (!volumeOcr?.pages || volumeOcr.pages.length === 0) {
    return 0;
  }
  const { charCount } = getCharCount(volumeOcr.pages);
  return charCount;
}

/**
 * Get the next volume UUID in a series using natural title sort.
 */
export async function getNextVolumeUuidInSeries(
  seriesUuid: string,
  currentVolumeUuid: string
): Promise<string | null> {
  const seriesVolumes = await db.volumes.where('series_uuid').equals(seriesUuid).toArray();
  if (seriesVolumes.length === 0) {
    return null;
  }

  seriesVolumes.sort((a, b) =>
    a.volume_title.localeCompare(b.volume_title, undefined, {
      numeric: true,
      sensitivity: 'base'
    })
  );

  const currentIndex = seriesVolumes.findIndex((v) => v.volume_uuid === currentVolumeUuid);
  if (currentIndex < 0 || currentIndex + 1 >= seriesVolumes.length) {
    return null;
  }

  return seriesVolumes[currentIndex + 1]?.volume_uuid || null;
}
