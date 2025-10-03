import type { VolumeMetadata } from '$lib/types';
import type { DriveFileMetadata } from '$lib/util/google-drive';

/**
 * Generate a temporary UUID for placeholder volumes
 * Format: "placeholder-{driveFileId}" to ensure uniqueness and easy identification
 */
function generatePlaceholderUuid(driveFileId: string): string {
  return `placeholder-${driveFileId}`;
}

/**
 * Generate a temporary series UUID for Drive-only series
 * Format: "placeholder-series-{hash of series title}"
 */
async function generatePlaceholderSeriesUuid(seriesTitle: string): Promise<string> {
  // Use Web Crypto API for deterministic hashing
  const encoder = new TextEncoder();
  const data = encoder.encode(seriesTitle);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `placeholder-series-${hashHex.substring(0, 16)}`;
}

/**
 * Create a set of paths from local volumes for quick lookup
 */
export function getLocalVolumePaths(volumes: VolumeMetadata[]): Set<string> {
  const paths = new Set<string>();

  for (const volume of volumes) {
    // Skip placeholders from previous reconciliation
    if (volume.isPlaceholder) continue;

    const path = `${volume.series_title}/${volume.volume_title}.cbz`;
    paths.add(path);
  }

  return paths;
}

/**
 * Create placeholder VolumeMetadata from Drive file metadata
 */
async function createPlaceholder(driveFile: DriveFileMetadata): Promise<VolumeMetadata> {
  // Parse path: "seriesTitle/volumeTitle.cbz"
  const pathParts = driveFile.path.split('/');
  if (pathParts.length !== 2) {
    throw new Error(`Invalid Drive file path: ${driveFile.path}`);
  }

  const seriesTitle = pathParts[0];
  const volumeFileName = pathParts[1]; // "volumeTitle.cbz"
  const volumeTitle = volumeFileName.replace('.cbz', '');

  return {
    mokuro_version: '', // Unknown until downloaded
    series_title: seriesTitle,
    series_uuid: await generatePlaceholderSeriesUuid(seriesTitle),
    volume_title: volumeTitle,
    volume_uuid: generatePlaceholderUuid(driveFile.fileId),
    page_count: 0, // Unknown until downloaded
    character_count: 0, // Unknown until downloaded

    // Placeholder-specific fields
    isPlaceholder: true,
    driveFileId: driveFile.fileId,
    driveModifiedTime: driveFile.modifiedTime,
    driveSize: driveFile.size
  };
}

/**
 * Reconcile local volumes with Drive cache to identify placeholders
 *
 * Algorithm:
 * 1. Create set of paths from local volumes
 * 2. Filter Drive files to those NOT in local paths
 * 3. Create placeholder metadata for remaining Drive files
 * 4. Return combined array of local + placeholder volumes
 */
export async function reconcileDriveWithLocal(
  localVolumes: VolumeMetadata[],
  driveFiles: DriveFileMetadata[]
): Promise<VolumeMetadata[]> {
  const localPaths = getLocalVolumePaths(localVolumes);

  // Find Drive files that don't exist locally
  const driveOnlyFiles = driveFiles.filter(driveFile => {
    return !localPaths.has(driveFile.path);
  });

  // Create placeholders for Drive-only files
  const placeholders = await Promise.all(
    driveOnlyFiles.map(driveFile => createPlaceholder(driveFile))
  );

  // Filter out any old placeholders from local volumes and combine with new placeholders
  const realLocalVolumes = localVolumes.filter(v => !v.isPlaceholder);

  return [...realLocalVolumes, ...placeholders];
}

/**
 * Check if a volume is a placeholder (helper for UI)
 */
export function isPlaceholder(volume: VolumeMetadata): boolean {
  return volume.isPlaceholder === true;
}

/**
 * Check if a series is entirely placeholders (no local volumes)
 */
export function isSeriesPlaceholder(volumes: VolumeMetadata[]): boolean {
  return volumes.length > 0 && volumes.every(v => isPlaceholder(v));
}

/**
 * Check if a series has mixed local and placeholder volumes
 */
export function isSeriesMixed(volumes: VolumeMetadata[]): boolean {
  const hasPlaceholders = volumes.some(v => isPlaceholder(v));
  const hasLocal = volumes.some(v => !isPlaceholder(v));
  return hasPlaceholders && hasLocal;
}
