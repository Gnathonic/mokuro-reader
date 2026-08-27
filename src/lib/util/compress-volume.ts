import { Uint8ArrayReader, BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import Dexie from 'dexie';
import type { VolumeMetadata } from '$lib/types';
import {
  SERIES_FILE_NAME,
  buildSeriesFileFrom,
  type SeriesFile,
  stringifySeriesFile
} from '$lib/metadata/series-file';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { MOKURO_DB_NAME, declareMokuroSchema } from '$lib/catalog/db-schema';
import { buildMokuroMetadata, type MokuroMetadata } from './mokuro-metadata';

// Re-exported for existing importers (volume-sidecars, zip, tests).
export type { MokuroMetadata } from './mokuro-metadata';

export interface VolumeSidecarBlobData {
  filename: string;
  blob: Blob;
}

export interface VolumeSidecarBlobResult {
  mokuro?: VolumeSidecarBlobData;
  thumbnail?: VolumeSidecarBlobData;
}

function extensionFromMimeType(contentType: string): string {
  const value = contentType.toLowerCase();
  if (value.includes('webp')) return 'webp';
  if (value.includes('png')) return 'png';
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  if (value.includes('avif')) return 'avif';
  if (value.includes('gif')) return 'gif';
  return 'webp';
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
 * @param options.seriesFile The series' `series.json`, written at the archive
 *   root for self-contained exports. Cloud uploads leave it out: there the file
 *   lives once per series folder, merged with what other devices published.
 * @returns Promise resolving to compressed CBZ as Blob
 */
export async function compressVolume(
  volumeTitle: string,
  metadata: MokuroMetadata | null,
  filesData: { filename: string; data: Uint8Array }[],
  onProgress?: (completed: number, total: number) => void,
  options: { seriesFile?: SeriesFile | null } = {}
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

  // The series sidecar rides at the archive root, next to the .mokuro.
  if (options.seriesFile) {
    await zipWriter.add(SERIES_FILE_NAME, new TextReader(stringifySeriesFile(options.seriesFile)));
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
    // A SEPARATE Dexie connection to the same on-disk database `CatalogDexieV3`
    // (src/lib/catalog/db-v3.ts) owns, opened from a Web Worker. It takes the
    // schema from the shared declaration rather than restating it: two
    // hand-written ladders for one database have no mechanical guard, and a
    // divergence between them is silent data loss (see `db-schema.ts`).
    //
    // `db-schema.ts` imports nothing at runtime, so this does NOT pull the
    // main-thread graph `db-v3.ts` carries ($app/environment, the progress
    // tracker, the thumbnail generator) into the Worker bundle.
    workerDb = new Dexie(MOKURO_DB_NAME);
    declareMokuroSchema(workerDb);
  }
  return workerDb;
}

export async function generateVolumeSidecarsFromDb(
  volumeUuid: string,
  overrides?: { seriesTitle?: string; volumeTitle?: string }
): Promise<VolumeSidecarBlobResult> {
  const db = getDatabase();

  const volume = await db.table('volumes').get(volumeUuid);
  if (!volume) {
    throw new Error(`Volume ${volumeUuid} not found in database`);
  }

  // Allow the caller to build sidecars for a NOT-YET-committed rename: the
  // .mokuro embeds the title/volume, so a rename must regenerate it with the
  // new names BEFORE the DB is updated (the remote rename gates the local
  // commit). UUIDs and OCR pages are unaffected by a rename.
  const seriesTitle = overrides?.seriesTitle ?? volume.series_title;
  const volumeTitle = overrides?.volumeTitle ?? volume.volume_title;

  const sidecars: VolumeSidecarBlobResult = {};
  const hasMokuroVersion =
    typeof volume.mokuro_version === 'string' && volume.mokuro_version.trim() !== '';
  if (hasMokuroVersion) {
    const volumeOcr = await db.table('volume_ocr').get(volumeUuid);
    if (volumeOcr?.pages) {
      const metadata = buildMokuroMetadata(volume, volumeOcr.pages, {
        seriesTitle,
        volumeTitle
      });
      sidecars.mokuro = {
        filename: `${volumeTitle}.mokuro`,
        blob: new Blob([JSON.stringify(metadata)], { type: 'application/json' })
      };
    }
  }

  if (volume.thumbnail) {
    const ext = extensionFromMimeType(volume.thumbnail.type || 'image/webp');
    sidecars.thumbnail = {
      filename: `${volumeTitle}.${ext}`,
      blob: volume.thumbnail
    };
  }

  return sidecars;
}

/**
 * The series sidecar an export embeds, built from the same database handle the
 * compression uses (this runs in a Worker, which has no access to the app's own
 * Dexie instance). Mirrors `buildSeriesFileForExport` in `volume-sidecars.ts`.
 */
async function buildSeriesFileFromDb(
  db: Dexie,
  seriesTitle: string
): Promise<SeriesFile | undefined> {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return undefined;

  const [meta, cached, volumes] = await Promise.all([
    db.table('series_metadata').get(key),
    db.table('series_index').get(key),
    db.table('volumes').toArray()
  ]);

  return buildSeriesFileFrom({
    seriesTitle,
    meta,
    volumes: volumes as VolumeMetadata[],
    existing: cached?.file
  });
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
  onProgress?: (completed: number, total: number) => void,
  options: {
    embedThumbnailSidecar?: boolean;
    embedMokuroInArchive?: boolean;
    embedSeriesFile?: boolean;
  } = {}
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
  const embedMokuroInArchive = options.embedMokuroInArchive !== false;

  // Build mokuro metadata
  const isImageOnly = volume.mokuro_version === '';
  const metadata: MokuroMetadata | null = isImageOnly
    ? null
    : buildMokuroMetadata(volume, volumeOcr?.pages || []);

  // Get list of files, excluding placeholders
  const filenames = Object.keys(volumeFiles.files);
  const placeholderPaths = new Set(volume.missing_page_paths || []);
  const validFilenames = filenames.filter((f) => !placeholderPaths.has(f));

  const thumbnailSidecar = options.embedThumbnailSidecar ? volume.thumbnail : null;

  // Total items: folder + files + embedded mokuro file (optional) + thumbnail sidecar (optional)
  const totalItems =
    validFilenames.length +
    (metadata && embedMokuroInArchive ? 1 : 0) +
    (thumbnailSidecar ? 1 : 0) +
    1;
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

  // Add mokuro metadata file only when embedding is enabled.
  if (metadata && embedMokuroInArchive) {
    await zipWriter.add(`${volumeTitle}.mokuro`, new TextReader(JSON.stringify(metadata)));
    completedItems++;
    if (onProgress) onProgress(completedItems, totalItems);
  }

  // The series sidecar: only for self-contained exports. A cloud upload gets
  // `<Series>/series.json` written once per series instead, merged with the
  // copy other devices published — an archive-local copy would be stale.
  if (options.embedSeriesFile) {
    const seriesFile = await buildSeriesFileFromDb(db, volume.series_title);
    if (seriesFile) {
      await zipWriter.add(SERIES_FILE_NAME, new TextReader(stringifySeriesFile(seriesFile)));
    }
  }

  // Add thumbnail sidecar when requested (used by sidecar-aware exports/backups)
  if (thumbnailSidecar) {
    const thumbBuffer = await thumbnailSidecar.arrayBuffer();
    await zipWriter.add(`${volumeTitle}.webp`, new Uint8ArrayReader(new Uint8Array(thumbBuffer)));
    completedItems++;
    if (onProgress) onProgress(completedItems, totalItems);
  }

  // Close and return blob
  return await zipWriter.close();
}
