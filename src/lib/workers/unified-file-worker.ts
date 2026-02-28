// Unified worker for all file operations: downloads, uploads, exports, compression, decompression
// Combines functionality from universal-download-worker and upload-worker
// Handles all cloud providers: Google Drive, WebDAV, MEGA

import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  getMimeType,
  BlobReader
} from '@zip.js/zip.js';
import {
  compressVolume,
  compressVolumeFromDb,
  generateVolumeSidecarsFromDb,
  type MokuroMetadata
} from '$lib/util/compress-volume';
import { matchFileToVolume } from '$lib/import/archive-extraction';
import { getWorkerCloudProvider } from './cloud-providers';
import type { WorkerProviderCredentials, WorkerProviderType } from './cloud-providers/types';

// Define the worker context
const ctx: Worker = self as any;

// ===========================
// TYPE DEFINITIONS
// ===========================

interface VolumeMetadata {
  volumeUuid: string;
  cloudFileId: string;
  seriesTitle: string;
  volumeTitle: string;
  cloudModifiedTime?: string;
  cloudSize?: number;
}

type ProviderCredentials = WorkerProviderCredentials;

// Download messages
interface DownloadAndDecompressMessage {
  mode: 'download-and-decompress';
  provider: WorkerProviderType;
  fileId: string;
  fileName: string;
  credentials: ProviderCredentials;
  metadata?: VolumeMetadata;
}

interface DecompressOnlyMessage {
  mode: 'decompress-only';
  fileId: string;
  fileName: string;
  blob: Blob; // File/Blob for streaming - avoids loading entire file into ArrayBuffer
  metadata?: VolumeMetadata;
  /** Optional filter - only extract files matching these extensions or paths */
  filter?: {
    /** Extract only files with these extensions (e.g., ['mokuro']) */
    extensions?: string[];
    /** Extract only files matching these path prefixes */
    pathPrefixes?: string[];
  };
  /** If true, return file list without extracting content (for planning extraction) */
  listOnly?: boolean;
  /** If true, list ALL files but only extract content for files matching filter */
  listAllExtractFiltered?: boolean;
}

/** Message for streaming extraction - extracts one volume at a time */
interface StreamExtractMessage {
  mode: 'stream-extract';
  fileId: string;
  fileName: string;
  blob: Blob;
  /** Volume definitions - which path prefixes belong to which volume */
  volumes: Array<{
    id: string;
    pathPrefix: string;
    mokuroPath?: string; // If known, extract this mokuro file for this volume
  }>;
}

interface DownloadHttpBundleMessage {
  mode: 'download-http-bundle';
  fileId: string;
  fileName: string;
  archiveUrl: string;
  mokuroUrls: string[];
  coverUrls: string[];
}

// Upload messages
interface CompressAndUploadMessage {
  mode: 'compress-and-upload';
  provider: WorkerProviderType;
  volumeTitle: string;
  seriesTitle: string;
  metadata: MokuroMetadata;
  filesData: { filename: string; data: ArrayBuffer }[];
  credentials: ProviderCredentials;
}

interface CompressAndReturnMessage {
  mode: 'compress-and-return';
  volumeTitle: string;
  metadata: MokuroMetadata;
  filesData: { filename: string; data: ArrayBuffer }[];
  downloadFilename?: string;
}

/** Compress from IndexedDB and optionally upload to cloud provider */
interface CompressFromDbMessage {
  mode: 'compress-from-db';
  provider: WorkerProviderType | null; // null = local export (return data)
  volumeUuid: string;
  volumeTitle: string;
  seriesTitle: string;
  credentials?: ProviderCredentials;
  downloadFilename?: string; // For local export
  embedThumbnailSidecar?: boolean;
  embedMokuroInArchive?: boolean;
  includeSidecars?: boolean;
}

type WorkerMessage =
  | DownloadAndDecompressMessage
  | DecompressOnlyMessage
  | DownloadHttpBundleMessage
  | StreamExtractMessage
  | CompressAndUploadMessage
  | CompressAndReturnMessage
  | CompressFromDbMessage;

// Progress messages
interface DownloadProgressMessage {
  type: 'progress';
  fileId: string;
  loaded: number;
  total: number;
}

interface UploadProgressMessage {
  type: 'progress';
  phase: 'compressing' | 'sidecars' | 'uploading';
  progress: number; // 0-100
}

// Complete messages
interface DownloadCompleteMessage {
  type: 'complete';
  fileId: string;
  fileName: string;
  data: ArrayBuffer;
  entries: DecompressedEntry[];
  metadata?: VolumeMetadata;
  bundle?: {
    archive: { url: string; data: ArrayBuffer; contentType?: string };
    mokuro?: { url: string; data: ArrayBuffer; contentType?: string };
    cover?: { url: string; data: ArrayBuffer; contentType?: string };
  };
}

interface UploadCompleteMessage {
  type: 'complete';
  fileId?: string; // For cloud uploads
  size?: number; // Archive size in bytes (for optimistic cache entry)
  data?: Uint8Array; // For local exports (Transferable Object)
  filename?: string; // For local exports
  sidecars?: {
    mokuro?: { filename: string; blob: Blob };
    thumbnail?: { filename: string; blob: Blob };
  };
}

interface ErrorMessage {
  type: 'error';
  fileId?: string;
  error: string;
}

interface DecompressedEntry {
  filename: string;
  data: ArrayBuffer;
}

/** Filter options for selective extraction */
interface ExtractFilter {
  extensions?: string[];
  pathPrefixes?: string[];
}

/**
 * System files and directories that should never be extracted.
 * These are commonly found in archives created on various operating systems.
 */
const EXCLUDED_SYSTEM_PATTERNS = new Set([
  // macOS
  '__MACOSX',
  '.DS_Store',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  '.TemporaryItems',
  '.Trash',
  // Windows
  'System Volume Information',
  '$RECYCLE.BIN',
  'Thumbs.db',
  'desktop.ini',
  'Desktop.ini',
  'RECYCLER',
  'RECYCLED',
  // Linux
  '.Trash-1000',
  '.thumbnails',
  '.directory',
  // Cloud storage
  '.dropbox',
  '.dropbox.cache',
  // Version control
  '.git',
  '.svn'
]);

const EXCLUDED_EXTENSIONS = new Set(['bak', 'tmp', 'temp']);

/**
 * Check if a path contains any system files/directories that should be excluded.
 */
function isSystemFile(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const segments = normalizedPath.split('/');

  for (const segment of segments) {
    if (!segment) continue;
    if (segment.startsWith('._')) return true;
    if (segment.endsWith('~')) return true;
    if (EXCLUDED_SYSTEM_PATTERNS.has(segment)) return true;
  }

  const filename = segments[segments.length - 1] || '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot >= 0) {
    const ext = filename.slice(lastDot + 1).toLowerCase();
    if (EXCLUDED_EXTENSIONS.has(ext)) return true;
  }

  return false;
}

/**
 * Check if a filename matches the filter criteria
 */
function matchesFilter(filename: string, filter?: ExtractFilter): boolean {
  if (!filter) return true;

  if (filter.extensions && filter.extensions.length > 0) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    if (filter.extensions.includes(ext)) return true;
  }

  if (filter.pathPrefixes && filter.pathPrefixes.length > 0) {
    for (const prefix of filter.pathPrefixes) {
      if (filename.startsWith(prefix + '/') || filename === prefix) return true;
    }
  }

  if (filter.extensions?.length && filter.pathPrefixes?.length) {
    return false;
  }
  if (filter.extensions?.length) return false;
  if (filter.pathPrefixes?.length) return false;

  return true;
}

// Concurrency limit for parallel extraction - higher = faster but more memory
const EXTRACT_CONCURRENCY = 16;

async function decompressCbz(
  data: Blob | ArrayBuffer,
  filter?: ExtractFilter,
  listOnly?: boolean,
  listAllExtractFiltered?: boolean
): Promise<DecompressedEntry[]> {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const zipReader = new ZipReader(new BlobReader(blob));
  const entries = await zipReader.getEntries();

  const toExtract: { entry: (typeof entries)[0]; filename: string }[] = [];
  const toList: string[] = [];

  for (const entry of entries) {
    if (entry.directory) continue;
    if (isSystemFile(entry.filename)) continue;

    const matchesFilterCriteria = matchesFilter(entry.filename, filter);
    if (!listAllExtractFiltered && !matchesFilterCriteria) {
      continue;
    }

    if (listOnly) {
      toList.push(entry.filename);
    } else if (listAllExtractFiltered) {
      if (matchesFilterCriteria) {
        toExtract.push({ entry, filename: entry.filename });
      } else {
        toList.push(entry.filename);
      }
    } else {
      toExtract.push({ entry, filename: entry.filename });
    }
  }

  const decompressedEntries: DecompressedEntry[] = [];

  for (const filename of toList) {
    decompressedEntries.push({ filename, data: new ArrayBuffer(0) });
  }

  if (toExtract.length > 0) {
    for (let i = 0; i < toExtract.length; i += EXTRACT_CONCURRENCY) {
      const batch = toExtract.slice(i, i + EXTRACT_CONCURRENCY);

      const results = await Promise.all(
        batch.map(async ({ entry, filename }) => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const uint8Array = await (entry as any).getData(new Uint8ArrayWriter());
            return { filename, data: uint8Array.buffer as ArrayBuffer };
          } catch (err) {
            console.error(`Worker: Error extracting ${filename}:`, err);
            return null;
          }
        })
      );

      for (const result of results) {
        if (result) {
          decompressedEntries.push(result);
        }
      }
    }
  }

  await zipReader.close();
  return decompressedEntries;
}

async function downloadFromUrl(
  url: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ data: ArrayBuffer; contentType?: string }> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`HTTP download failed: ${response.status}`);
  }

  const total = parseInt(response.headers.get('content-length') || '0', 10);
  const contentType = response.headers.get('content-type') || undefined;
  const reader = response.body?.getReader();
  if (!reader) {
    const data = await response.arrayBuffer();
    onProgress?.(data.byteLength, total || data.byteLength);
    return { data, contentType };
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total || loaded);
    }
  }

  const full = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    full.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { data: full.buffer, contentType };
}

async function tryDownloadOptionalUrl(
  urls: string[]
): Promise<{ url: string; data: ArrayBuffer; contentType?: string } | undefined> {
  for (const url of urls) {
    try {
      const result = await downloadFromUrl(url);
      return { url, data: result.data, contentType: result.contentType };
    } catch {
      // best effort
    }
  }
  return undefined;
}

// ===========================
// MAIN MESSAGE HANDLER
// ===========================

ctx.addEventListener('message', async (event) => {
  const message = event.data as WorkerMessage;

  // Guard against null/undefined messages (can happen during worker cleanup)
  if (!message || !message.mode) {
    console.warn('Worker: Received invalid message (null or missing mode)');
    return;
  }

  console.log('Worker: Received message', message.mode);

  try {
    if (message.mode === 'download-and-decompress') {
      // ========== DOWNLOAD AND DECOMPRESS MODE ==========
      const { provider, fileId, fileName, credentials, metadata } = message;
      console.log(`Worker: Starting download for ${fileName} (${fileId})`);

      const cloudProvider = getWorkerCloudProvider(provider);
      const arrayBuffer = await cloudProvider.downloadFile({
        fileId,
        credentials,
        onProgress: (loaded, total) => {
          const progressMessage: DownloadProgressMessage = {
            type: 'progress',
            fileId,
            loaded,
            total
          };
          ctx.postMessage(progressMessage);
        }
      });

      console.log(`Worker: Download complete for ${fileName}`);

      // Decompress the ArrayBuffer
      const entries = await decompressCbz(arrayBuffer);

      // Send completion message
      const completeMessage: DownloadCompleteMessage = {
        type: 'complete',
        fileId,
        fileName,
        data: new ArrayBuffer(0),
        entries,
        metadata
      };

      // Transfer ownership of ArrayBuffers to main thread
      const transferables = entries.map((entry) => entry.data);
      ctx.postMessage(completeMessage, transferables);

      console.log(`Worker: Sent complete message for ${fileName}`);
    } else if (message.mode === 'decompress-only') {
      // ========== DECOMPRESS ONLY MODE ==========
      const { fileId, fileName, blob, metadata, filter, listOnly, listAllExtractFiltered } =
        message;

      // Decompress with optional filter (for selective extraction)
      // If listOnly, returns file list without extracting content
      // If listAllExtractFiltered, lists all files but only extracts content for filtered ones
      const entries = await decompressCbz(blob, filter, listOnly, listAllExtractFiltered);

      // Send completion message
      const completeMessage: DownloadCompleteMessage = {
        type: 'complete',
        fileId,
        fileName,
        data: new ArrayBuffer(0),
        entries,
        metadata
      };

      // Transfer ownership of ArrayBuffers to main thread
      const transferables = entries.map((entry) => entry.data);
      ctx.postMessage(completeMessage, transferables);

      console.log(`Worker: Sent complete message for ${fileName}`);
    } else if (message.mode === 'download-http-bundle') {
      const { fileId, fileName, archiveUrl, mokuroUrls, coverUrls } = message;

      const archive = await downloadFromUrl(archiveUrl, (loaded, total) => {
        const progressMessage: DownloadProgressMessage = {
          type: 'progress',
          fileId,
          loaded,
          total
        };
        ctx.postMessage(progressMessage);
      });

      const mokuro = await tryDownloadOptionalUrl(mokuroUrls);
      const cover = await tryDownloadOptionalUrl(coverUrls);

      const completeMessage: DownloadCompleteMessage = {
        type: 'complete',
        fileId,
        fileName,
        data: new ArrayBuffer(0),
        entries: [],
        bundle: {
          archive: { url: archiveUrl, data: archive.data, contentType: archive.contentType },
          ...(mokuro ? { mokuro } : {}),
          ...(cover ? { cover } : {})
        }
      };

      const transferables: Transferable[] = [archive.data];
      if (mokuro?.data) transferables.push(mokuro.data);
      if (cover?.data) transferables.push(cover.data);
      ctx.postMessage(completeMessage, transferables);

      console.log(`Worker: Sent HTTP bundle complete message for ${fileName}`);
    } else if (message.mode === 'stream-extract') {
      // ========== STREAM EXTRACT MODE ==========
      // Extracts in parallel batches, sending each immediately to prevent memory exhaustion
      const { fileId, fileName, blob, volumes } = message;

      const zipReader = new ZipReader(new BlobReader(blob));
      const entries = await zipReader.getEntries();

      // Build a set of path prefixes for quick matching
      const volumePrefixes = new Map<string, string>(); // prefix -> volumeId
      for (const vol of volumes) {
        volumePrefixes.set(vol.pathPrefix, vol.id);
      }

      // Categorize entries
      const toExtract: { entry: (typeof entries)[0]; volumeId: string }[] = [];
      const IMAGE_EXTS = new Set([
        'jpg',
        'jpeg',
        'png',
        'webp',
        'gif',
        'bmp',
        'avif',
        'tif',
        'tiff',
        'jxl'
      ]);

      for (const entry of entries) {
        if (entry.directory) continue;
        // Skip system files (macOS, Windows, Linux metadata)
        if (isSystemFile(entry.filename)) continue;

        // Match file to volume using shared logic
        const matchedVolumeId = matchFileToVolume(entry.filename, volumePrefixes);
        if (!matchedVolumeId) continue;

        const ext = entry.filename.split('.').pop()?.toLowerCase() || '';
        if (!IMAGE_EXTS.has(ext)) continue;

        toExtract.push({ entry, volumeId: matchedVolumeId });
      }

      // Extract in parallel batches
      let extracted = 0;
      const totalFiles = toExtract.length;
      const skipped = entries.filter((e) => !e.directory).length - toExtract.length;

      for (let i = 0; i < toExtract.length; i += EXTRACT_CONCURRENCY) {
        const batch = toExtract.slice(i, i + EXTRACT_CONCURRENCY);

        const results = await Promise.all(
          batch.map(async ({ entry, volumeId }) => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const uint8Array = await (entry as any).getData(new Uint8ArrayWriter());
              return { filename: entry.filename, data: uint8Array.buffer as ArrayBuffer, volumeId };
            } catch (err) {
              console.error(`Worker: Error extracting ${entry.filename}:`, err);
              return null;
            }
          })
        );

        // Send each result immediately with transferable
        for (const result of results) {
          if (result) {
            ctx.postMessage(
              {
                type: 'stream-entry',
                fileId,
                volumeId: result.volumeId,
                entry: {
                  filename: result.filename,
                  data: result.data
                }
              },
              [result.data]
            );
            extracted++;
          }
        }

        // Progress update after each batch
        ctx.postMessage({
          type: 'progress',
          fileId,
          loaded: extracted,
          total: totalFiles
        });
      }

      await zipReader.close();

      // Send completion message
      ctx.postMessage({
        type: 'stream-complete',
        fileId,
        fileName,
        extracted,
        skipped
      });

      console.log(
        `Worker: Stream extraction complete - ${extracted} files extracted, ${skipped} skipped`
      );
    } else if (message.mode === 'compress-and-upload') {
      // ========== COMPRESS AND UPLOAD MODE ==========
      const { provider, volumeTitle, seriesTitle, metadata, filesData, credentials } = message;

      // Phase 1: Compression (0-100%)
      // Convert ArrayBuffers to Uint8Arrays for the shared compression function
      const filesDataUint8: { filename: string; data: Uint8Array }[] = filesData.map(
        ({ filename, data }) => ({
          filename,
          data: new Uint8Array(data)
        })
      );

      console.log(`Worker: Compressing ${volumeTitle}...`);
      let compressionProgress = 0;

      // compressVolume returns a Blob (uses BlobWriter to avoid memory allocation issues)
      const cbzBlob = await compressVolume(
        volumeTitle,
        metadata,
        filesDataUint8,
        (completed, total) => {
          compressionProgress = (completed / total) * 100; // 0-100% compression
          const progressMessage: UploadProgressMessage = {
            type: 'progress',
            phase: 'compressing',
            progress: compressionProgress
          };
          ctx.postMessage(progressMessage);
        }
      );

      console.log(`Worker: Compressed ${volumeTitle} (${cbzBlob.size} bytes)`);

      // Phase 2: Upload (0-100%)
      if (!credentials) {
        throw new Error(`Missing ${provider} worker credentials`);
      }
      const cloudProvider = getWorkerCloudProvider(provider);
      const filename = `${volumeTitle}.cbz`;
      const fileId = await cloudProvider.uploadFile({
        seriesTitle,
        filename,
        blob: cbzBlob,
        credentials,
        mimeType: 'application/x-cbz',
        onProgress: (loaded, total) => {
          const uploadProgress = total > 0 ? (loaded / total) * 100 : 0;
          const progressMessage: UploadProgressMessage = {
            type: 'progress',
            phase: 'uploading',
            progress: uploadProgress
          };
          ctx.postMessage(progressMessage);
        }
      });

      // Send completion message
      const completeMessage: UploadCompleteMessage = {
        type: 'complete',
        fileId
      };
      ctx.postMessage(completeMessage);

      console.log(`Worker: Backup complete for ${volumeTitle}`);
    } else if (message.mode === 'compress-and-return') {
      // ========== COMPRESS AND RETURN MODE (LOCAL EXPORT) ==========
      const { volumeTitle, metadata, filesData, downloadFilename } = message;

      // Phase 1: Compression (0-100%)
      // Convert ArrayBuffers to Uint8Arrays for the shared compression function
      const filesDataUint8: { filename: string; data: Uint8Array }[] = filesData.map(
        ({ filename, data }) => ({
          filename,
          data: new Uint8Array(data)
        })
      );

      console.log(`Worker: Compressing ${volumeTitle}...`);
      let compressionProgress = 0;

      // compressVolume returns a Blob (uses BlobWriter to avoid memory allocation issues)
      const cbzBlob = await compressVolume(
        volumeTitle,
        metadata,
        filesDataUint8,
        (completed, total) => {
          compressionProgress = (completed / total) * 100; // 0-100% compression
          const progressMessage: UploadProgressMessage = {
            type: 'progress',
            phase: 'compressing',
            progress: compressionProgress
          };
          ctx.postMessage(progressMessage);
        }
      );

      console.log(`Worker: Compressed ${volumeTitle} (${cbzBlob.size} bytes)`);
      console.log(`Worker: Returning compressed data for download`);

      // Convert Blob to ArrayBuffer for transfer back to main thread
      const cbzArrayBuffer = await cbzBlob.arrayBuffer();
      const cbzData = new Uint8Array(cbzArrayBuffer);

      // Send completion message with Transferable Object (zero-copy)
      const completeMessage: UploadCompleteMessage = {
        type: 'complete',
        data: cbzData,
        filename: downloadFilename || `${volumeTitle}.cbz`
      };
      ctx.postMessage(completeMessage, [cbzData.buffer]); // Transfer ownership
      console.log(`Worker: Export complete for ${volumeTitle}`);
    } else if (message.mode === 'compress-from-db') {
      // ========== COMPRESS FROM DB MODE ==========
      // Uses shared compressVolumeFromDb utility which:
      // 1. Reads files one at a time from IndexedDB
      // 2. Streams directly to zip
      // 3. Releases references immediately to prevent memory issues
      const { provider, volumeUuid, volumeTitle, seriesTitle, credentials, downloadFilename } =
        message;

      console.log(`Worker: Compressing volume ${volumeTitle} from IndexedDB...`);

      // Compress using shared utility (handles streaming from IndexedDB)
      const cbzBlob = await compressVolumeFromDb(
        volumeUuid,
        (completed, total) => {
          const progressMessage: UploadProgressMessage = {
            type: 'progress',
            phase: 'compressing',
            progress: (completed / total) * 100
          };
          ctx.postMessage(progressMessage);
        },
        {
          embedThumbnailSidecar: message.embedThumbnailSidecar === true,
          embedMokuroInArchive: message.embedMokuroInArchive !== false
        }
      );

      console.log(`Worker: Compressed ${volumeTitle} (${cbzBlob.size} bytes)`);

      // Handle based on provider
      if (provider === null) {
        // Local export - return blob
        console.log(`Worker: Returning compressed data for download`);
        const cbzArrayBuffer = await cbzBlob.arrayBuffer();
        const cbzData = new Uint8Array(cbzArrayBuffer);
        let sidecars:
          | {
              mokuro?: { filename: string; blob: Blob };
              thumbnail?: { filename: string; blob: Blob };
            }
          | undefined;
        if (message.includeSidecars === true) {
          const generated = await generateVolumeSidecarsFromDb(volumeUuid);
          if (generated.mokuro || generated.thumbnail) {
            sidecars = {};
            if (generated.mokuro) {
              sidecars.mokuro = generated.mokuro;
            }
            if (generated.thumbnail) {
              sidecars.thumbnail = generated.thumbnail;
            }
          }
        }
        const completeMessage: UploadCompleteMessage = {
          type: 'complete',
          data: cbzData,
          filename: downloadFilename || `${volumeTitle}.cbz`,
          sidecars
        };
        ctx.postMessage(completeMessage, [cbzData.buffer]);
        console.log(`Worker: Export complete for ${volumeTitle}`);
      } else {
        // Upload to cloud provider
        if (!credentials) {
          throw new Error(`Missing ${provider} worker credentials`);
        }
        const cloudProvider = getWorkerCloudProvider(provider);
        const filename = `${volumeTitle}.cbz`;

        const uploadSidecar = async (sidecarFilename: string, sidecarBlob: Blob): Promise<void> => {
          await cloudProvider.uploadFile({
            seriesTitle,
            filename: sidecarFilename,
            blob: sidecarBlob,
            credentials,
            mimeType: sidecarBlob.type || 'application/octet-stream'
          });
        };

        if (message.includeSidecars === true) {
          const generatedSidecars = await generateVolumeSidecarsFromDb(volumeUuid);
          const sidecarsToUpload: Array<{ filename: string; blob: Blob }> = [];
          if (generatedSidecars.mokuro) {
            sidecarsToUpload.push(generatedSidecars.mokuro);
          }
          if (generatedSidecars.thumbnail) {
            sidecarsToUpload.push(generatedSidecars.thumbnail);
          }

          if (sidecarsToUpload.length > 0) {
            const sidecarProgressMessage: UploadProgressMessage = {
              type: 'progress',
              phase: 'sidecars',
              progress: 100
            };

            ctx.postMessage(sidecarProgressMessage);
            for (const sidecar of sidecarsToUpload) {
              console.log(`Worker: Uploading sidecar ${sidecar.filename}...`);
              await uploadSidecar(sidecar.filename, sidecar.blob);
              ctx.postMessage(sidecarProgressMessage);
            }
          }
        }

        ctx.postMessage({
          type: 'progress',
          phase: 'uploading',
          progress: 0
        } satisfies UploadProgressMessage);

        const fileId = await cloudProvider.uploadFile({
          seriesTitle,
          filename,
          blob: cbzBlob,
          credentials,
          mimeType: 'application/x-cbz',
          onProgress: (loaded, total) => {
            const progressMessage: UploadProgressMessage = {
              type: 'progress',
              phase: 'uploading',
              progress: total > 0 ? (loaded / total) * 100 : 0
            };
            ctx.postMessage(progressMessage);
          }
        });

        const completeMessage: UploadCompleteMessage = {
          type: 'complete',
          fileId,
          size: cbzBlob.size
        };
        ctx.postMessage(completeMessage);
        console.log(`Worker: Backup complete for ${volumeTitle}`);
      }
    } else {
      throw new Error(`Unknown mode: ${(message as any).mode}`);
    }
  } catch (error) {
    console.error('Worker: Error processing message:', error);
    const errorMessage: ErrorMessage = {
      type: 'error',
      fileId:
        'mode' in message &&
        (message.mode === 'download-and-decompress' || message.mode === 'decompress-only')
          ? message.fileId
          : undefined,
      error: error instanceof Error ? error.message : String(error)
    };
    ctx.postMessage(errorMessage);
  }
});
