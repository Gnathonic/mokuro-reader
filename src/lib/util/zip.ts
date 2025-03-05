import type { VolumeMetadata } from '$lib/types';
import { db } from '$lib/catalog/db';
import { BlobReader, BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';

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
 * Adds a volume's files to a zip archive
 * @param zipWriter The ZipWriter instance
 * @param volume The volume metadata
 * @returns Promise resolving to an array of promises for adding files
 */
async function addVolumeToArchive(zipWriter: ZipWriter<Blob>, volume: VolumeMetadata) {
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
        return zipWriter.add(`${folderName}/${filename}`, new BlobReader(file));
      })
    : [];

  // Add mokuro data file in the root directory (for both ZIP and CBZ)
  return [
    ...imagePromises,
    zipWriter.add(`${volume.volume_title}.mokuro`, new TextReader(JSON.stringify(mokuroData)))
  ];
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
  const zipWriter = new ZipWriter(new BlobWriter('application/zip'));

  // Add each volume to the archive
  const volumePromises = volumes.map((volume) => addVolumeToArchive(zipWriter, volume));

  // Wait for all volumes to be added
  await Promise.all((await Promise.all(volumePromises)).flat());

  // Close the archive and get the blob
  const zipFileBlob = await zipWriter.close();

  // Create a download link
  const link = document.createElement('a');
  link.href = URL.createObjectURL(zipFileBlob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);

  return false;
}
