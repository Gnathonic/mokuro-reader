import { Uint8ArrayReader, BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';

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
 * Uses BlobWriter instead of Uint8ArrayWriter to avoid "Array buffer allocation failed"
 * errors with large volumes (>1GB). BlobWriter allows the browser to use disk-backed
 * storage for the output, avoiding the need for a contiguous memory allocation.
 *
 * @param volumeTitle The title of the volume (used for folder name)
 * @param metadata Mokuro metadata object (null for image-only volumes)
 * @param filesData Array of files with filenames and Uint8Array data
 * @param onProgress Optional progress callback (completed items, total items)
 * @returns Promise resolving to compressed CBZ as Blob
 */
export async function compressVolume(
  volumeTitle: string,
  metadata: MokuroMetadata | null,
  filesData: { filename: string; data: Uint8Array }[],
  onProgress?: (completed: number, total: number) => void
): Promise<Blob> {
  // Create zip writer with compatibility options:
  // - bufferedWrite: true - writes sizes in header (not data descriptor after data)
  // - extendedTimestamp: false - reduces per-entry overhead, improves compatibility
  // - BlobWriter: avoids single contiguous allocation, browser can use disk-backed storage
  const zipWriter = new ZipWriter(new BlobWriter('application/x-cbz'), {
    bufferedWrite: true,
    extendedTimestamp: false
  });

  // Total items to add: folder + all files + mokuro file (if present)
  const totalItems = filesData.length + (metadata ? 1 : 0) + 1;
  let completedItems = 0;

  // Add explicit folder entry first (required by some CBZ readers)
  const folderName = volumeTitle;
  await zipWriter.add(`${folderName}/`, new Uint8ArrayReader(new Uint8Array(0)), {
    directory: true
  });
  completedItems++;
  if (onProgress) {
    onProgress(completedItems, totalItems);
  }

  // Check if we need to preserve folder structure (TOC-style CBZs with chapters)
  // by detecting duplicate basenames
  const basenames = filesData.map(({ filename }) => filename.split('/').pop() || filename);
  const hasDuplicates = new Set(basenames).size !== basenames.length;

  // Track created subdirectories to add folder entries
  const createdDirs = new Set<string>();

  // Add image files inside the folder
  for (const { filename, data } of filesData) {
    let entryPath: string;

    if (hasDuplicates) {
      // Preserve folder structure for TOC-style CBZs (e.g., chapter1/001.jpg, chapter2/001.jpg)
      // First, ensure any subdirectories exist as folder entries
      const parts = filename.split('/');
      if (parts.length > 1) {
        // Build up directory path and create folder entries
        for (let i = 0; i < parts.length - 1; i++) {
          const dirPath = `${folderName}/${parts.slice(0, i + 1).join('/')}/`;
          if (!createdDirs.has(dirPath)) {
            await zipWriter.add(dirPath, new Uint8ArrayReader(new Uint8Array(0)), {
              directory: true
            });
            createdDirs.add(dirPath);
          }
        }
      }
      entryPath = `${folderName}/${filename}`;
    } else {
      // Flatten structure for simple CBZs (no duplicate filenames)
      const basename = filename.split('/').pop() || filename;
      entryPath = `${folderName}/${basename}`;
    }

    await zipWriter.add(entryPath, new Uint8ArrayReader(data));
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

  // Close and get the compressed data as Blob
  const blob = await zipWriter.close();

  return blob;
}
