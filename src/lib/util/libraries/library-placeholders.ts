/**
 * Generate placeholder VolumeMetadata for library files
 * Similar to catalog/placeholders.ts but for library sources
 */

import { browser } from '$app/environment';
import type { VolumeMetadata } from '$lib/types';
import type { LibraryFileMetadata } from './library-webdav-client';
import { getLibraryById } from '$lib/settings/libraries';
import { enqueueLibraryOcrUpgrade } from './library-ocr-upgrade-queue';

/**
 * Generate a deterministic UUID from a string
 */
function generateUuidFromString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }

  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `library-${hex}`;
}

/**
 * Parse series and volume title from library file path
 * Expected format: "SeriesTitle/VolumeTitle.cbz" or just "VolumeTitle.cbz"
 */
function parseLibraryPath(path: string): { seriesTitle: string; volumeTitle: string } | null {
  const parts = path.split('/');

  if (parts.length === 1) {
    // Just a filename, no folder
    const volumeTitle = parts[0].replace(/\.(cbz|zip)$/i, '');
    return { seriesTitle: volumeTitle, volumeTitle };
  }

  if (parts.length === 2) {
    // SeriesTitle/VolumeTitle.cbz
    const seriesTitle = parts[0];
    const volumeTitle = parts[1].replace(/\.(cbz|zip)$/i, '');
    return { seriesTitle, volumeTitle };
  }

  if (parts.length > 2) {
    // Nested folders - use first folder as series, last part as volume
    const seriesTitle = parts[0];
    const volumeTitle = parts[parts.length - 1].replace(/\.(cbz|zip)$/i, '');
    return { seriesTitle, volumeTitle };
  }

  return null;
}

/**
 * Create a placeholder VolumeMetadata for a library file
 */
function createLibraryPlaceholder(
  libraryFile: LibraryFileMetadata,
  seriesUuid: string,
  libraryName: string
): VolumeMetadata | null {
  const parsed = parseLibraryPath(libraryFile.path);
  if (!parsed) return null;

  const { seriesTitle, volumeTitle } = parsed;

  // Use fileId + libraryId for volume UUID to ensure uniqueness across libraries
  const volumeUuid = generateUuidFromString(`${libraryFile.libraryId}:${libraryFile.fileId}`);

  return {
    mokuro_version: 'unknown',
    series_title: seriesTitle,
    series_uuid: seriesUuid,
    volume_title: volumeTitle,
    volume_uuid: volumeUuid,
    page_count: 0,
    character_count: 0,
    page_char_counts: [],

    // Placeholder fields
    isPlaceholder: true,
    cloudProvider: 'webdav',
    cloudFileId: libraryFile.fileId,
    cloudModifiedTime: libraryFile.modifiedTime,
    cloudSize: libraryFile.size,

    // Library-specific fields
    libraryId: libraryFile.libraryId,
    libraryName: libraryName
  };
}

/**
 * Generate placeholder VolumeMetadata for library files
 *
 * @param libraryFilesMap Map of libraryId -> LibraryFileMetadata[]
 * @param localVolumes Array of local VolumeMetadata
 * @param selectedLibraryId The currently selected library ID (null = show all)
 */
export function generateLibraryPlaceholders(
  libraryFilesMap: Map<string, LibraryFileMetadata[]>,
  libraryMokuroFilesMap: Map<string, LibraryFileMetadata[]>,
  localVolumes: VolumeMetadata[],
  selectedLibraryId: string | null
): VolumeMetadata[] {
  // Skip during SSR/build
  if (!browser) {
    return [];
  }

  // Create a set of local volume paths for fast lookup
  // Include both local volumes and any cloud placeholders (to avoid duplicates)
  const localPaths = new Set<string>();
  const localVolumeByPath = new Map<string, VolumeMetadata>();
  for (const vol of localVolumes) {
    const key = `${vol.series_title}/${vol.volume_title}.cbz`.toLowerCase();
    localPaths.add(key);
    if (!vol.isPlaceholder && !localVolumeByPath.has(key)) {
      localVolumeByPath.set(key, vol);
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

  const placeholders: VolumeMetadata[] = [];

  for (const [libraryId, files] of libraryFilesMap) {
    // Skip if filtering and this isn't the selected library
    if (selectedLibraryId !== null && libraryId !== selectedLibraryId) {
      continue;
    }

    const mokuroLookup = new Map<string, LibraryFileMetadata>();
    const mokuroFiles = libraryMokuroFilesMap.get(libraryId) || [];
    console.log(
      `[Library OCR Upgrade] Matcher scan for library ${libraryId}: ${files.length} archives, ${mokuroFiles.length} mokuro sidecars`
    );
    for (const sidecar of mokuroFiles) {
      const cbzLikePath = sidecar.path.replace(/\.mokuro(?:\.gz)?$/i, '.cbz');
      const parsedSidecar = parseLibraryPath(cbzLikePath);
      if (!parsedSidecar) continue;
      const key = `${parsedSidecar.seriesTitle}/${parsedSidecar.volumeTitle}`.toLowerCase();
      // Prefer plain .mokuro over gz when both exist.
      const existing = mokuroLookup.get(key);
      if (!existing || existing.path.toLowerCase().endsWith('.mokuro.gz')) {
        mokuroLookup.set(key, sidecar);
      }
    }

    // Get library name
    const library = getLibraryById(libraryId);
    const libraryName = library?.name || 'Unknown Library';

    for (const file of files) {
      const parsed = parseLibraryPath(file.path);
      if (!parsed) continue;

      // Check if already exists locally (case-insensitive)
      const localPath = `${parsed.seriesTitle}/${parsed.volumeTitle}.cbz`.toLowerCase();
      if (localPaths.has(localPath)) {
        const localVolume = localVolumeByPath.get(localPath);
        const mokuroKey = `${parsed.seriesTitle}/${parsed.volumeTitle}`.toLowerCase();
        const remoteMokuro = mokuroLookup.get(mokuroKey);
        if (
          localVolume &&
          (typeof localVolume.mokuro_version !== 'string' ||
            localVolume.mokuro_version.trim() === '') &&
          remoteMokuro
        ) {
          console.log(
            '[Library OCR Upgrade] Match found, enqueueing upgrade:',
            `${localVolume.series_title}/${localVolume.volume_title}`,
            'using',
            remoteMokuro.path
          );
          enqueueLibraryOcrUpgrade(localVolume, remoteMokuro);
        } else if (localVolume && !remoteMokuro) {
          console.log(
            '[Library OCR Upgrade] Local image-only match has no remote mokuro sidecar:',
            `${localVolume.series_title}/${localVolume.volume_title}`
          );
        } else if (localVolume) {
          console.log(
            '[Library OCR Upgrade] Local match already has OCR, skipping:',
            `${localVolume.series_title}/${localVolume.volume_title}`,
            'mokuro_version=',
            localVolume.mokuro_version
          );
        }
        continue;
      }

      // Use existing series UUID if we have local volumes with this series title
      // Otherwise generate a deterministic UUID
      const lowerSeriesTitle = parsed.seriesTitle.toLowerCase();
      const seriesUuid =
        seriesTitleToUuid.get(lowerSeriesTitle) ||
        generateUuidFromString(`library-series:${lowerSeriesTitle}`);

      const placeholder = createLibraryPlaceholder(file, seriesUuid, libraryName);
      if (placeholder) {
        placeholders.push(placeholder);

        // Add to local paths to prevent duplicates within same library batch
        localPaths.add(localPath);
      }
    }
  }

  return placeholders;
}

/**
 * Check if a volume is from a library
 */
export function isLibraryVolume(volume: VolumeMetadata): boolean {
  return volume.libraryId !== undefined;
}
