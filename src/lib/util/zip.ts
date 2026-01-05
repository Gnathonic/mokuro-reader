import type { VolumeMetadata } from '$lib/types';
import { db } from '$lib/catalog/db';
import { BlobReader, BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { compressVolume, type MokuroMetadata } from './compress-volume';
import { backupQueue } from './backup-queue';

export async function zipManga(
  manga: VolumeMetadata[],
  asCbz = false,
  individualVolumes = false,
  includeSeriesTitle = true
) {
  const extension = asCbz ? 'cbz' : 'zip';

  if (individualVolumes) {
    // Queue each volume for export (non-blocking with progress tracking)
    for (const volume of manga) {
      // Generate the filename for this specific volume
      const filename = includeSeriesTitle
        ? `${volume.series_title} - ${volume.volume_title}.${extension}`
        : `${volume.volume_title}.${extension}`;

      backupQueue.queueVolumeForExport(volume, filename, extension);
    }
  } else {
    // Multi-volume export: Keep blocking approach for now (edge case, less common)
    const filename = `${manga[0].series_title}.${extension}`;
    await createAndDownloadArchive(manga, asCbz, filename);
  }

  return false;
}

/**
 * Prepares volume data for compression (loads from DB, converts to Uint8Array)
 * This is the SINGLE source of truth for preparing export data.
 * Used by both direct export (zip.ts) and cloud backup (backup-queue.ts).
 *
 * @param volumeOrUuid Either a VolumeMetadata object or a volume UUID string
 * @returns Promise resolving to metadata (null for image-only) and files data
 */
export async function prepareVolumeData(volumeOrUuid: VolumeMetadata | string): Promise<{
  metadata: MokuroMetadata | null;
  filesData: { filename: string; data: Uint8Array }[];
}> {
  // Resolve volume metadata - either use passed object or fetch from DB
  const volume =
    typeof volumeOrUuid === 'string'
      ? await db.volumes.where('volume_uuid').equals(volumeOrUuid).first()
      : volumeOrUuid;

  if (!volume) {
    throw new Error(
      `Volume not found: ${typeof volumeOrUuid === 'string' ? volumeOrUuid : volumeOrUuid.volume_uuid}`
    );
  }

  // Get OCR and files data from separate tables
  const volumeOcr = await db.volume_ocr.get(volume.volume_uuid);
  const volumeFiles = await db.volume_files.get(volume.volume_uuid);
  if (!volumeOcr) {
    throw new Error(`Volume OCR data not found for ${volume.volume_uuid}`);
  }

  // Check if this is an image-only volume (no mokuro data)
  const isImageOnly = volume.mokuro_version === '';

  // Create mokuro metadata only for volumes that had mokuro data
  const metadata: MokuroMetadata | null = isImageOnly
    ? null
    : {
        version: volume.mokuro_version,
        title: volume.series_title,
        title_uuid: volume.series_uuid,
        volume: volume.volume_title,
        volume_uuid: volume.volume_uuid,
        pages: volumeOcr.pages,
        chars: volume.character_count
      };

  // Get set of placeholder page paths to exclude from export
  const placeholderPaths = new Set(volume.missing_page_paths || []);

  // Convert File objects to Uint8Arrays, excluding placeholder pages
  const filesData: { filename: string; data: Uint8Array }[] = [];
  if (volumeFiles?.files) {
    for (const [filename, file] of Object.entries(volumeFiles.files)) {
      // Skip placeholder pages - they shouldn't be exported
      if (placeholderPaths.has(filename)) {
        continue;
      }
      const arrayBuffer = await file.arrayBuffer();
      filesData.push({ filename, data: new Uint8Array(arrayBuffer) });
    }
  }

  return { metadata, filesData };
}

/**
 * Adds a volume's files to a zip archive (for multi-volume ZIP files)
 * @param zipWriter The ZipWriter instance
 * @param volume The volume metadata
 * @returns Promise resolving to an array of promises for adding files
 */
async function addVolumeToArchive(zipWriter: ZipWriter<Blob>, volume: VolumeMetadata) {
  // Get OCR and files data from separate tables
  const volumeOcr = await db.volume_ocr.get(volume.volume_uuid);
  const volumeFiles = await db.volume_files.get(volume.volume_uuid);
  if (!volumeOcr) {
    console.error(`Volume OCR data not found for ${volume.volume_uuid}`);
    return [];
  }

  // Check if this is an image-only volume
  const isImageOnly = volume.mokuro_version === '';

  // Get set of placeholder page paths to exclude from export
  const placeholderPaths = new Set(volume.missing_page_paths || []);

  // Create folder name for images (same as mokuro file name without extension)
  const folderName = `${volume.volume_title}`;

  // Add explicit folder entry first (required by some CBZ readers)
  const folderPromise = zipWriter.add(`${folderName}/`, new BlobReader(new Blob([])), {
    directory: true
  });

  // Add image files inside the folder, excluding placeholders
  const imagePromises = volumeFiles?.files
    ? Object.entries(volumeFiles.files)
        .filter(([filename]) => !placeholderPaths.has(filename))
        .map(([filename, file]) => {
          // Extract just the basename to avoid nested folders from original CBZ structure
          const basename = filename.split('/').pop() || filename;
          return zipWriter.add(`${folderName}/${basename}`, new BlobReader(file));
        })
    : [];

  // Only add mokuro file for volumes that had mokuro data
  if (isImageOnly) {
    return [folderPromise, ...imagePromises];
  }

  // Create mokuro data in the old format for compatibility
  const mokuroData = {
    version: volume.mokuro_version,
    title: volume.series_title,
    title_uuid: volume.series_uuid,
    volume: volume.volume_title,
    volume_uuid: volume.volume_uuid,
    pages: volumeOcr.pages,
    chars: volume.character_count
  };

  // Add mokuro data file in the root directory (for both ZIP and CBZ)
  return [
    folderPromise,
    ...imagePromises,
    zipWriter.add(`${volume.volume_title}.mokuro`, new TextReader(JSON.stringify(mokuroData)))
  ];
}

/**
 * Creates an archive blob containing the specified volumes
 * Uses BlobWriter to avoid memory allocation issues with large volumes
 * For single volumes, uses shared compression function; for multiple volumes, uses multi-volume archive
 * @param volumes Array of volumes to include in the archive
 * @returns Promise resolving to the archive blob
 */
export async function createArchiveBlob(volumes: VolumeMetadata[]): Promise<Blob> {
  // For single volume, use shared compression function (returns Blob directly)
  if (volumes.length === 1) {
    const { metadata, filesData } = await prepareVolumeData(volumes[0]);
    return await compressVolume(volumes[0].volume_title, metadata, filesData);
  }

  // For multiple volumes, create a single ZIP containing all volumes
  // Use BlobWriter to avoid memory allocation issues with large archives
  const zipWriter = new ZipWriter(new BlobWriter('application/zip'), {
    bufferedWrite: true,
    extendedTimestamp: false
  });

  // Add each volume to the archive
  const volumePromises = volumes.map((volume) => addVolumeToArchive(zipWriter, volume));

  // Wait for all volumes to be added
  await Promise.all((await Promise.all(volumePromises)).flat());

  // Close the archive and get the Blob directly
  return await zipWriter.close();
}

/**
 * Creates and downloads an archive containing the specified volumes
 * @param volumes Array of volumes to include in the archive
 * @param asCbz Whether to create a CBZ file (true) or ZIP file (false)
 * @param filename The filename to use for the archive
 * @returns Promise resolving to false when complete
 */
async function createAndDownloadArchive(
  volumes: VolumeMetadata[],
  asCbz: boolean,
  filename: string
) {
  const zipFileBlob = await createArchiveBlob(volumes);

  // Create a download link
  const link = document.createElement('a');
  link.href = URL.createObjectURL(zipFileBlob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);

  return false;
}
