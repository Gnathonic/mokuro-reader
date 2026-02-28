import type { VolumeMetadata } from '$lib/types';
import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';
import { browser } from '$app/environment';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
import { enqueueCloudOcrUpgrade } from '$lib/util/libraries/library-ocr-upgrade-queue';

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
  if (!volumeWithExt.toLowerCase().endsWith('.cbz')) return null;

  // Remove .cbz extension
  const volumeTitle = volumeWithExt.replace(/\.cbz$/i, '');

  // Prefer verified series title from description over folder name
  const seriesTitle = extractSeriesTitleFromDescription(description) || folderName;

  return { seriesTitle, volumeTitle };
}

/**
 * Generate placeholder VolumeMetadata for a cloud-only file
 */
function createPlaceholder(
  cloudFile: CloudVolumeWithProvider,
  seriesUuid: string
): VolumeMetadata | null {
  const parsed = parseCloudPath(cloudFile.path, cloudFile.description);
  if (!parsed) return null;

  const { seriesTitle, volumeTitle } = parsed;

  // Generate deterministic volume UUID from series + volume name
  // This ensures the same volume gets the same UUID across devices
  const volumeUuid = generateDeterministicUUID(`${seriesTitle}/${volumeTitle}`);

  return {
    mokuro_version: 'unknown', // Will be filled in after download
    series_title: seriesTitle,
    series_uuid: seriesUuid,
    volume_title: volumeTitle,
    volume_uuid: volumeUuid,
    page_count: 0, // Unknown until downloaded
    character_count: 0, // Unknown until downloaded
    page_char_counts: [], // Empty until downloaded and calculated

    // Placeholder-specific fields
    isPlaceholder: true,
    cloudProvider: cloudFile.provider,
    cloudFileId: cloudFile.fileId,
    cloudModifiedTime: cloudFile.modifiedTime,
    cloudSize: cloudFile.size,
    cloudPath: cloudFile.path // Store path for series extraction during download
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
  const localPaths = new Set(localVolumes.map((vol) => `${vol.series_title}/${vol.volume_title}.cbz`));
  const localVolumeByPath = new Map<string, VolumeMetadata>();
  const localImageOnlyByVolumeTitle = new Map<string, VolumeMetadata[]>();
  for (const vol of localVolumes) {
    const key = `${vol.series_title}/${vol.volume_title}.cbz`.toLowerCase();
    if (!vol.isPlaceholder && !localVolumeByPath.has(key)) {
      localVolumeByPath.set(key, vol);
    }

    const currentMokuroVersion =
      typeof vol.mokuro_version === 'string' ? vol.mokuro_version.trim() : '';
    if (!vol.isPlaceholder && currentMokuroVersion === '') {
      const titleKey = vol.volume_title.toLowerCase();
      const existing = localImageOnlyByVolumeTitle.get(titleKey) || [];
      existing.push(vol);
      localImageOnlyByVolumeTitle.set(titleKey, existing);
    }
  }

  // Create a map of series titles to their UUIDs from local volumes
  const seriesTitleToUuid = new Map<string, string>();
  for (const vol of localVolumes) {
    const lowerTitle = vol.series_title.toLowerCase();
    if (!seriesTitleToUuid.has(lowerTitle)) {
      seriesTitleToUuid.set(lowerTitle, vol.series_uuid);
    }
  }

  // Flatten Map values into a single array and split out .webp sidecars
  const cloudFiles: CloudVolumeWithProvider[] = [];
  const thumbnailMap = new Map<string, string>(); // basePath -> fileId
  const mokuroMap = new Map<string, CloudVolumeWithProvider>(); // basePath -> sidecar metadata
  for (const files of cloudFilesMap.values()) {
    for (const file of files) {
      const lowerPath = file.path.toLowerCase();
      if (lowerPath.endsWith('.webp')) {
        const basePath = file.path.replace(/\.webp$/i, '');
        thumbnailMap.set(basePath, file.fileId);
      } else if (lowerPath.endsWith('.mokuro.gz')) {
        const basePath = file.path.replace(/\.mokuro\.gz$/i, '');
        // Prefer plain .mokuro over .mokuro.gz when both exist.
        if (!mokuroMap.has(basePath)) {
          mokuroMap.set(basePath, file);
        }
      } else if (lowerPath.endsWith('.mokuro')) {
        const basePath = file.path.replace(/\.mokuro$/i, '');
        mokuroMap.set(basePath, file);
      } else {
        cloudFiles.push(file);
      }
    }
  }

  // Find cloud-only files
  const cloudOnlyFiles = cloudFiles.filter((file) => !localPaths.has(file.path));

  // Generate placeholders
  const placeholders: VolumeMetadata[] = [];
  for (const cloudFile of cloudOnlyFiles) {
    const parsed = parseCloudPath(cloudFile.path, cloudFile.description);
    if (!parsed) continue;

    // Use existing series UUID if we have local volumes with this series title
    // Otherwise generate a deterministic UUID for a new series
    const seriesUuid =
      seriesTitleToUuid.get(parsed.seriesTitle.toLowerCase()) ||
      generateDeterministicUUID(parsed.seriesTitle);

    const placeholder = createPlaceholder(cloudFile, seriesUuid);
    if (placeholder) {
      const basePath = cloudFile.path.replace(/\.cbz$/i, '');
      const thumbnailFileId = thumbnailMap.get(basePath);
      if (thumbnailFileId) {
        placeholder.cloudThumbnailFileId = thumbnailFileId;
      }
      placeholders.push(placeholder);
    }
  }

  console.log(
    '[Cloud OCR Upgrade] Placeholder matcher scan:',
    `cbz=${cloudFiles.length}`,
    `mokuro=${mokuroMap.size}`,
    `locals=${localPaths.size}`
  );

  // Auto-upgrade local image-only volumes when matching remote .mokuro sidecar exists.
  for (const cloudFile of cloudFiles) {
    const parsed = parseCloudPath(cloudFile.path, cloudFile.description);
    if (!parsed) continue;

    const cloudPathKey = cloudFile.path.toLowerCase();
    let localVolume = localVolumeByPath.get(cloudPathKey);
    if (!localVolume) {
      // Fallback only when series title also matches; never pair by volume title alone.
      const candidates = localImageOnlyByVolumeTitle.get(parsed.volumeTitle.toLowerCase()) || [];
      const seriesMatches = candidates.filter(
        (candidate) => candidate.series_title.toLowerCase() === parsed.seriesTitle.toLowerCase()
      );
      if (seriesMatches.length === 1) {
        localVolume = seriesMatches[0];
      } else if (seriesMatches.length > 1 || candidates.length > 0) {
        console.log(
          '[Cloud OCR Upgrade] Ambiguous local image-only match; skipping fallback:',
          parsed.seriesTitle,
          parsed.volumeTitle,
          `seriesMatches=${seriesMatches.length}`,
          `candidates=${candidates.length}`
        );
      }
    }

    if (!localVolume) continue;

    const currentMokuroVersion =
      typeof localVolume.mokuro_version === 'string' ? localVolume.mokuro_version.trim() : '';
    if (currentMokuroVersion !== '') continue;

    const basePath = cloudFile.path.replace(/\.cbz$/i, '');
    const remoteMokuro = mokuroMap.get(basePath);
    if (remoteMokuro) {
      console.log(
        '[Cloud OCR Upgrade] Match found, enqueueing upgrade:',
        `${localVolume.series_title}/${localVolume.volume_title}`,
        'using',
        remoteMokuro.path
      );
      enqueueCloudOcrUpgrade(localVolume, remoteMokuro);
    } else {
      console.log(
        '[Cloud OCR Upgrade] Local image-only match has no remote mokuro sidecar:',
        `${localVolume.series_title}/${localVolume.volume_title}`
      );
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
