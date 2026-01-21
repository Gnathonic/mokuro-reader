import { Uint8ArrayReader, BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import Dexie from 'dexie';

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

// ===========================
// DATABASE ACCESS FOR WORKERS
// ===========================

let workerDb: Dexie | null = null;

/**
 * Get or create a Dexie database connection
 * Works in both main thread and Web Workers (IndexedDB supports concurrent access)
 */
function getDatabase(): Dexie {
  if (!workerDb) {
    workerDb = new Dexie('mokuro_v3');
    workerDb.version(1).stores({
      volumes: 'volume_uuid, series_uuid, series_title',
      volume_ocr: 'volume_uuid',
      volume_files: 'volume_uuid'
    });
  }
  return workerDb;
}

/**
 * Compress a volume by streaming files directly from IndexedDB
 * This avoids memory issues with large volumes by:
 * 1. Reading files one at a time from IndexedDB
 * 2. Adding each file to the zip immediately
 * 3. Releasing the file reference before reading the next
 *
 * @param volumeUuid The UUID of the volume to compress
 * @param onProgress Optional progress callback (completed items, total items)
 * @returns Promise resolving to compressed CBZ as Blob
 */
export async function compressVolumeFromDb(
  volumeUuid: string,
  onProgress?: (completed: number, total: number) => void
): Promise<Blob> {
  const db = getDatabase();

  // Read metadata from IndexedDB
  const volume = await db.table('volumes').get(volumeUuid);
  const volumeOcr = await db.table('volume_ocr').get(volumeUuid);
  const volumeFiles = await db.table('volume_files').get(volumeUuid);

  if (!volume || !volumeFiles) {
    throw new Error(`Volume ${volumeUuid} not found in database`);
  }

  const volumeTitle = volume.volume_title;

  // Build mokuro metadata
  const isImageOnly = volume.mokuro_version === '';
  const metadata: MokuroMetadata | null = isImageOnly
    ? null
    : {
        version: volume.mokuro_version,
        title: volume.series_title,
        title_uuid: volume.series_uuid,
        volume: volume.volume_title,
        volume_uuid: volume.volume_uuid,
        pages: volumeOcr?.pages || [],
        chars: volume.character_count
      };

  // Get list of files, excluding placeholders
  const filenames = Object.keys(volumeFiles.files);
  const placeholderPaths = new Set(volume.missing_page_paths || []);
  const validFilenames = filenames.filter((f) => !placeholderPaths.has(f));

  // Total items: folder + files + mokuro file (if present)
  const totalItems = validFilenames.length + (metadata ? 1 : 0) + 1;
  let completedItems = 0;

  // Create zip writer with BlobWriter to avoid memory issues
  const zipWriter = new ZipWriter(new BlobWriter('application/x-cbz'), {
    bufferedWrite: true,
    extendedTimestamp: false
  });

  // Add folder entry
  const folderName = volumeTitle;
  await zipWriter.add(`${folderName}/`, new Uint8ArrayReader(new Uint8Array(0)), {
    directory: true
  });
  completedItems++;
  if (onProgress) onProgress(completedItems, totalItems);

  // Check for duplicate basenames (TOC-style CBZs need folder structure preserved)
  const basenames = validFilenames.map((f) => f.split('/').pop() || f);
  const hasDuplicates = new Set(basenames).size !== basenames.length;
  const createdDirs = new Set<string>();

  // Stream each file: read from DB → add to zip → release memory
  for (const filename of filenames) {
    if (placeholderPaths.has(filename)) continue;

    const file = volumeFiles.files[filename];
    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    // Release file reference immediately to allow GC
    delete volumeFiles.files[filename];

    // Determine entry path (preserve structure for TOC-style, flatten otherwise)
    let entryPath: string;
    if (hasDuplicates) {
      // Preserve folder structure for TOC-style CBZs
      const parts = filename.split('/');
      if (parts.length > 1) {
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
      const basename = filename.split('/').pop() || filename;
      entryPath = `${folderName}/${basename}`;
    }

    // Add to zip
    await zipWriter.add(entryPath, new Uint8ArrayReader(data));

    completedItems++;
    if (onProgress) onProgress(completedItems, totalItems);
  }

  // Add mokuro metadata file
  if (metadata) {
    await zipWriter.add(`${volumeTitle}.mokuro`, new TextReader(JSON.stringify(metadata)));
    completedItems++;
    if (onProgress) onProgress(completedItems, totalItems);
  }

  // Close and return blob
  return await zipWriter.close();
}
