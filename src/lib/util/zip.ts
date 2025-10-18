import type { VolumeMetadata } from '$lib/types';
import { db } from '$lib/catalog/db';
import { BlobReader, Uint8ArrayWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { compressVolume, type MokuroMetadata } from './compress-volume';

export async function zipManga(
  manga: VolumeMetadata[],
  asCbz = false,
  individualVolumes = false,
  includeSeriesTitle = true
) {
  const extension = asCbz ? 'cbz' : 'zip';

  if (individualVolumes) {
    // Extract each volume individually
    for (const volume of manga) {
      // Generate the filename for this specific volume
      const filename = includeSeriesTitle
        ? `${volume.series_title} - ${volume.volume_title}.${extension}`
        : `${volume.volume_title}.${extension}`;

      await createAndDownloadArchive(
        [volume], // Pass as array for consistency with the shared function
        asCbz,
        filename // Pass the pre-generated filename directly
      );
    }
  } else {
    // Extract all volumes as a single file
    const filename = `${manga[0].series_title}.${extension}`;
    await createAndDownloadArchive(manga, asCbz, filename);
  }

  return false;
}

/**
 * Prepares volume data for compression (loads from DB, converts to Uint8Array)
 * @param volume The volume metadata
 * @returns Promise resolving to metadata and files data
 */
async function prepareVolumeData(volume: VolumeMetadata): Promise<{
  metadata: MokuroMetadata;
  filesData: { filename: string; data: Uint8Array }[];
}> {
  // Get volume data from the database
  const volumeData = await db.volumes_data.get(volume.volume_uuid);
  if (!volumeData) {
    throw new Error(`Volume data not found for ${volume.volume_uuid}`);
  }

  // Create mokuro metadata in the standard format
  const metadata: MokuroMetadata = {
    version: volume.mokuro_version,
    title: volume.series_title,
    title_uuid: volume.series_uuid,
    volume: volume.volume_title,
    volume_uuid: volume.volume_uuid,
    pages: volumeData.pages,
    chars: volume.character_count
  };

  // Convert File objects to Uint8Arrays
  const filesData: { filename: string; data: Uint8Array }[] = [];
  if (volumeData.files) {
    for (const [filename, file] of Object.entries(volumeData.files)) {
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
async function addVolumeToArchive(zipWriter: ZipWriter<Uint8Array>, volume: VolumeMetadata) {
  // Get volume data from the database
  const volumeData = await db.volumes_data.get(volume.volume_uuid);
  if (!volumeData) {
    console.error(`Volume data not found for ${volume.volume_uuid}`);
    return [];
  }

  // Create mokuro data in the old format for compatibility
  const mokuroData = {
    version: volume.mokuro_version,
    title: volume.series_title,
    title_uuid: volume.series_uuid,
    volume: volume.volume_title,
    volume_uuid: volume.volume_uuid,
    pages: volumeData.pages,
    chars: volume.character_count
  };

  // Create folder name for images (same as mokuro file name without extension)
  const folderName = `${volume.volume_title}`;

  // Add image files inside the folder
  const imagePromises = volumeData.files
    ? Object.entries(volumeData.files).map(([filename, file]) => {
        // Extract just the basename to avoid nested folders from original CBZ structure
        const basename = filename.split('/').pop() || filename;
        return zipWriter.add(`${folderName}/${basename}`, new BlobReader(file));
      })
    : [];

  // Add mokuro data file in the root directory (for both ZIP and CBZ)
  return [
    ...imagePromises,
    zipWriter.add(`${volume.volume_title}.mokuro`, new TextReader(JSON.stringify(mokuroData)))
  ];
}

/**
 * Creates an archive blob containing the specified volumes
 * Uses Uint8Array throughout to avoid intermediate Blob disk writes under memory pressure
 * For single volumes, uses shared compression function; for multiple volumes, uses multi-volume archive
 * @param volumes Array of volumes to include in the archive
 * @returns Promise resolving to the archive blob
 */
export async function createArchiveBlob(volumes: VolumeMetadata[]): Promise<Blob> {
  // For single volume, use shared compression function
  if (volumes.length === 1) {
    const { metadata, filesData } = await prepareVolumeData(volumes[0]);
    const uint8Array = await compressVolume(volumes[0].volume_title, metadata, filesData);
    return new Blob([uint8Array], { type: 'application/zip' });
  }

  // For multiple volumes, create a single ZIP containing all volumes
  const zipWriter = new ZipWriter(new Uint8ArrayWriter());

  // Add each volume to the archive
  const volumePromises = volumes.map((volume) => addVolumeToArchive(zipWriter, volume));

  // Wait for all volumes to be added
  await Promise.all((await Promise.all(volumePromises)).flat());

  // Close the archive and get the Uint8Array
  const uint8Array = await zipWriter.close();

  // Convert to Blob only at the very end for download/upload
  return new Blob([uint8Array], { type: 'application/zip' });
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
