import { Uint8ArrayReader, Uint8ArrayWriter, TextReader, ZipWriter } from '@zip.js/zip.js';

/**
 * Mokuro metadata format for CBZ files
 */
export interface MokuroMetadata {
  version: string;
  title: string;
  title_uuid: string;
  volume: string;
  volume_uuid: string;
  pages: any[];
  chars: number;
}

/**
 * Shared compression function that works in both main thread and Web Workers
 * Creates a CBZ file (ZIP with manga pages + optional mokuro metadata)
 *
 * @param volumeTitle The title of the volume (used for folder name)
 * @param metadata Mokuro metadata object (null for image-only volumes)
 * @param filesData Array of files with filenames and Uint8Array data
 * @param onProgress Optional progress callback (completed items, total items)
 * @returns Promise resolving to compressed CBZ as Uint8Array
 */
export async function compressVolume(
  volumeTitle: string,
  metadata: MokuroMetadata | null,
  filesData: { filename: string; data: Uint8Array }[],
  onProgress?: (completed: number, total: number) => void
): Promise<Uint8Array> {
  // Create zip writer with Uint8Array output
  const zipWriter = new ZipWriter(new Uint8ArrayWriter());

  // Total items to add: all files + mokuro file (if present)
  const totalItems = filesData.length + (metadata ? 1 : 0);
  let completedItems = 0;

  // Add image files inside a folder
  const folderName = volumeTitle;
  for (const { filename, data } of filesData) {
    // Extract just the basename to avoid nested folders from original CBZ structure
    const basename = filename.split('/').pop() || filename;
    await zipWriter.add(`${folderName}/${basename}`, new Uint8ArrayReader(data));
    completedItems++;
    if (onProgress) {
      onProgress(completedItems, totalItems);
    }
  }

  // Add mokuro metadata file only for volumes that had mokuro data
  if (metadata) {
    await zipWriter.add(`${volumeTitle}.mokuro`, new TextReader(JSON.stringify(metadata)));
    completedItems++;
    if (onProgress) {
      onProgress(completedItems, totalItems);
    }
  }

  // Close and get the compressed data
  const uint8Array = await zipWriter.close();

  return uint8Array;
}
