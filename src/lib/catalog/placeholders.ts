import type { VolumeMetadata } from '$lib/types';
import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';
import { browser } from '$app/environment';

/**
 * Generate a deterministic UUID from a string (used for placeholder UUIDs)
 */
function generateUuidFromString(str: string): string {
  // Simple hash-based UUID generation
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Format as UUID-like string with placeholder prefix
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `placeholder-${hex}`;
}

/**
 * Extract series title from description field
 * Format: "Series: <series name>" on the first line (case-insensitive)
 * Allows user to add their own notes on subsequent lines
 */
function extractSeriesTitleFromDescription(description: string | undefined): string | null {
  if (!description) return null;

  const lines = description.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Match "Series:" prefix (case-insensitive)
    const match = trimmed.match(/^series:\s*(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Parse series and volume title from cloud file path and description
 * Expected format: "SeriesTitle/VolumeTitle.cbz"
 * Description overrides folder name if present
 */
function parseCloudPath(
  path: string,
  description?: string
): { seriesTitle: string; volumeTitle: string } | null {
  const parts = path.split('/');
  if (parts.length !== 2) return null;

  const folderName = parts[0];
  const volumeWithExt = parts[1];

  // Remove .cbz extension
  const volumeTitle = volumeWithExt.replace(/\.cbz$/i, '');

  // Prefer verified series title from description over folder name
  const seriesTitle = extractSeriesTitleFromDescription(description) || folderName;

  return { seriesTitle, volumeTitle };
}

/**
 * Generate placeholder VolumeMetadata for a cloud-only file
 */
function createPlaceholder(cloudFile: CloudVolumeWithProvider, seriesUuid: string): VolumeMetadata | null {
  const parsed = parseCloudPath(cloudFile.path, cloudFile.description);
  if (!parsed) return null;

  const { seriesTitle, volumeTitle } = parsed;

  // Use fileId for volume UUID to ensure uniqueness
  const volumeUuid = generateUuidFromString(cloudFile.fileId);

  return {
    mokuro_version: 'unknown', // Will be filled in after download
    series_title: seriesTitle,
    series_uuid: seriesUuid,
    volume_title: volumeTitle,
    volume_uuid: volumeUuid,
    page_count: 0, // Unknown until downloaded
    character_count: 0, // Unknown until downloaded

    // Placeholder-specific fields
    isPlaceholder: true,
    cloudProvider: cloudFile.provider,
    cloudFileId: cloudFile.fileId,
    cloudModifiedTime: cloudFile.modifiedTime,
    cloudSize: cloudFile.size
  };
}

/**
 * Identify cloud-only files by comparing cloud files with local volumes
 * Returns placeholder VolumeMetadata for files that exist in cloud but not locally
 */
export function generatePlaceholders(
  cloudFilesMap: Map<string, CloudVolumeWithProvider[]>,
  localVolumes: VolumeMetadata[]
): VolumeMetadata[] {
  // Skip during SSR/build
  if (!browser) {
    return [];
  }

  // Create a set of local volume paths for fast lookup
  const localPaths = new Set(
    localVolumes.map(vol => `${vol.series_title}/${vol.volume_title}.cbz`)
  );

  // Create a map of series titles to their UUIDs from local volumes
  const seriesTitleToUuid = new Map<string, string>();
  for (const vol of localVolumes) {
    if (!seriesTitleToUuid.has(vol.series_title)) {
      seriesTitleToUuid.set(vol.series_title, vol.series_uuid);
    }
  }

  // Flatten Map values into a single array
  const cloudFiles: CloudVolumeWithProvider[] = [];
  for (const files of cloudFilesMap.values()) {
    cloudFiles.push(...files);
  }

  // Find cloud-only files
  const cloudOnlyFiles = cloudFiles.filter(file => !localPaths.has(file.path));

  // Generate placeholders
  const placeholders: VolumeMetadata[] = [];
  for (const cloudFile of cloudOnlyFiles) {
    const parsed = parseCloudPath(cloudFile.path, cloudFile.description);
    if (!parsed) continue;

    // Use existing series UUID if we have local volumes with this series title
    // Otherwise generate a deterministic UUID for a new series
    const seriesUuid = seriesTitleToUuid.get(parsed.seriesTitle)
      || generateUuidFromString(parsed.seriesTitle);

    const placeholder = createPlaceholder(cloudFile, seriesUuid);
    if (placeholder) {
      placeholders.push(placeholder);
    }
  }

  return placeholders;
}

/**
 * Check if a volume is a placeholder
 */
export function isPlaceholder(volume: VolumeMetadata): boolean {
  return volume.isPlaceholder === true;
}
