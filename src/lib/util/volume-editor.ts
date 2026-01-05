/**
 * Volume editor utility functions for updating volume metadata and stats
 */

import { db } from '$lib/catalog/db';
import { volumesWithTrash, VolumeData } from '$lib/settings/volume-data';
import { get } from 'svelte/store';
import { generateThumbnail } from '$lib/catalog/thumbnails';
import type { VolumeMetadata } from '$lib/types';
import { getCharCount } from '$lib/util/count-chars';

type Volumes = Record<string, VolumeData>;

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

  // Update in IndexedDB
  await db.volumes.update(volumeUuid, {
    thumbnail: thumbnailResult.file,
    thumbnail_width: thumbnailResult.width,
    thumbnail_height: thumbnailResult.height
  });
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

  // Get file paths sorted naturally
  const filePaths = Object.keys(volumeFiles.files).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );

  if (filePaths.length === 0) {
    throw new Error('No image files in volume');
  }

  // Use the first image file
  const firstFile = volumeFiles.files[filePaths[0]];

  // Generate thumbnail
  const thumbnailResult = await generateThumbnail(firstFile);

  // Update in IndexedDB
  await db.volumes.update(volumeUuid, {
    thumbnail: thumbnailResult.file,
    thumbnail_width: thumbnailResult.width,
    thumbnail_height: thumbnailResult.height
  });
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

  // Get file paths sorted naturally
  const filePaths = Object.keys(volumeFiles.files).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );

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
