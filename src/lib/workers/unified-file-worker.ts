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
import { File as MegaFile, Storage } from 'megajs';
import { compressVolume, type MokuroMetadata } from '$lib/util/compress-volume';
import { matchFileToVolume } from '$lib/import/archive-extraction';

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

interface ProviderCredentials {
  // Google Drive
  accessToken?: string;
  seriesFolderId?: string; // Pre-created folder ID (avoids race conditions)

  // WebDAV
  webdavUrl?: string;
  webdavUsername?: string;
  webdavPassword?: string;

  // MEGA
  megaShareUrl?: string; // For downloads
  megaEmail?: string; // For uploads
  megaPassword?: string; // For uploads
}

// Download messages
interface DownloadAndDecompressMessage {
  mode: 'download-and-decompress';
  provider: 'google-drive' | 'webdav' | 'mega';
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

// Upload messages
interface CompressAndUploadMessage {
  mode: 'compress-and-upload';
  provider: 'google-drive' | 'webdav' | 'mega';
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

type WorkerMessage =
  | DownloadAndDecompressMessage
  | DecompressOnlyMessage
  | StreamExtractMessage
  | CompressAndUploadMessage
  | CompressAndReturnMessage;

// Progress messages
interface DownloadProgressMessage {
  type: 'progress';
  fileId: string;
  loaded: number;
  total: number;
}

interface UploadProgressMessage {
  type: 'progress';
  phase: 'compressing' | 'uploading';
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
}

interface UploadCompleteMessage {
  type: 'complete';
  fileId?: string; // For cloud uploads
  data?: Uint8Array; // For local exports (Transferable Object)
  filename?: string; // For local exports
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

// ===========================
// DOWNLOAD FUNCTIONS
// ===========================

/**
 * Download from Google Drive using access token
 * Returns ArrayBuffer directly to avoid intermediate Blob creation and disk writes
 */
async function downloadFromGoogleDrive(
  fileId: string,
  accessToken: string,
  onProgress: (loaded: number, total: number) => void
): Promise<ArrayBuffer> {
  // First get the file size
  const sizeResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!sizeResponse.ok) {
    throw new Error(`Failed to get file size: ${sizeResponse.statusText}`);
  }

  const sizeData = await sizeResponse.json();
  const totalSize = parseInt(sizeData.size, 10);

  // Now download the file with progress tracking
  const xhr = new XMLHttpRequest();
  xhr.open('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
  xhr.responseType = 'arraybuffer';

  return new Promise((resolve, reject) => {
    xhr.onprogress = (event) => {
      onProgress(event.loaded, totalSize);
    };

    xhr.onerror = () => reject(new Error('Network error during download'));
    xhr.ontimeout = () => reject(new Error('Download timed out'));
    xhr.onabort = () => reject(new Error('Download aborted'));

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as ArrayBuffer);
      } else {
        reject(new Error(`HTTP error ${xhr.status}: ${xhr.statusText}`));
      }
    };

    xhr.send();
  });
}

/**
 * Download from WebDAV server using Basic Auth
 * Returns ArrayBuffer directly to avoid intermediate Blob creation and disk writes
 */
async function downloadFromWebDAV(
  fileId: string,
  url: string,
  username: string,
  password: string,
  onProgress: (loaded: number, total: number) => void
): Promise<ArrayBuffer> {
  const fullUrl = `${url}${fileId}`;
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  const response = await fetch(fullUrl, {
    headers: {
      Authorization: authHeader
    }
  });

  if (!response.ok) {
    throw new Error(`WebDAV download failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error('Response body is not readable');
  }

  const chunks: Uint8Array[] = [];
  let receivedLength = 0;

  // Throttle progress updates to ~15/second (matches XHR behavior)
  let lastProgressUpdate = 0;
  const PROGRESS_THROTTLE_MS = 67; // ~15 updates per second

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    receivedLength += value.length;

    // Only send progress update if enough time has passed
    const now = Date.now();
    if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS) {
      onProgress(receivedLength, contentLength || receivedLength);
      lastProgressUpdate = now;
    }
  }

  // Always send final progress update at 100%
  onProgress(receivedLength, contentLength || receivedLength);

  // Use Blob to combine chunks - avoids allocating a second copy of the entire file
  const blob = new Blob(chunks as BlobPart[]);
  const buffer = await blob.arrayBuffer();
  // Clear chunks array to free memory
  chunks.length = 0;
  return buffer;
}

/**
 * Download from MEGA using a share link via the MEGA API
 * The share link includes the decryption key, MEGA API handles download
 * Returns ArrayBuffer directly to avoid intermediate Blob creation and disk writes
 */
async function downloadFromMega(
  shareUrl: string,
  onProgress: (loaded: number, total: number) => void
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    try {
      // Load file from share link using MEGA API
      const file = MegaFile.fromURL(shareUrl);

      // Load file metadata
      file.loadAttributes((error) => {
        if (error) {
          reject(new Error(`MEGA metadata failed: ${error.message}`));
          return;
        }

        const totalSize = file.size || 0;

        // Download file with progress tracking
        const stream = file.download({});
        const chunks: Uint8Array[] = [];
        let loaded = 0;

        stream.on('data', (chunk: Uint8Array) => {
          chunks.push(chunk);
          loaded += chunk.length;
          onProgress(loaded, totalSize);
        });

        stream.on('end', async () => {
          // Use Blob to combine chunks - avoids allocating a second copy of the entire file
          const blob = new Blob(chunks as BlobPart[]);
          const buffer = await blob.arrayBuffer();
          // Clear chunks array to free memory before resolving
          chunks.length = 0;
          resolve(buffer);
        });

        stream.on('error', (error: Error) => {
          reject(new Error(`MEGA download failed: ${error.message}`));
        });
      });
    } catch (error) {
      reject(
        new Error(
          `MEGA initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      );
    }
  });
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

  // Check extension filter
  if (filter.extensions && filter.extensions.length > 0) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    if (filter.extensions.includes(ext)) return true;
  }

  // Check path prefix filter
  if (filter.pathPrefixes && filter.pathPrefixes.length > 0) {
    for (const prefix of filter.pathPrefixes) {
      if (filename.startsWith(prefix + '/') || filename === prefix) return true;
    }
  }

  // If both filters are specified, match either; if only one, that one must match
  if (filter.extensions?.length && filter.pathPrefixes?.length) {
    return false; // Neither matched
  }
  if (filter.extensions?.length) return false; // Extension filter didn't match
  if (filter.pathPrefixes?.length) return false; // Path filter didn't match

  return true; // No filters = match all
}

/**
 * Decompress a CBZ file from Blob or ArrayBuffer into entries
 * Uses BlobReader for streaming - handles large files (>2GB) without loading into ArrayBuffer
 * Optional filter allows extracting only specific files (e.g., mokuro files first, then images per volume)
 * If listOnly is true, returns file list without extracting content (for planning extraction)
 */
// Concurrency limit for parallel extraction - higher = faster but more memory
const EXTRACT_CONCURRENCY = 16;

async function decompressCbz(
  data: Blob | ArrayBuffer,
  filter?: ExtractFilter,
  listOnly?: boolean,
  listAllExtractFiltered?: boolean
): Promise<DecompressedEntry[]> {
  // Convert ArrayBuffer to Blob if needed (for downloaded data)
  const blob = data instanceof Blob ? data : new Blob([data]);

  // Use BlobReader for streaming - doesn't require loading entire file into memory at once
  const zipReader = new ZipReader(new BlobReader(blob));

  // Get all entries from the zip file
  const entries = await zipReader.getEntries();

  // Categorize entries
  const toExtract: { entry: (typeof entries)[0]; filename: string }[] = [];
  const toList: string[] = [];

  for (const entry of entries) {
    if (entry.directory) continue;
    // Skip system files (macOS, Windows, Linux metadata)
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

  // Build results
  const decompressedEntries: DecompressedEntry[] = [];

  // Add list-only entries (no extraction needed)
  for (const filename of toList) {
    decompressedEntries.push({ filename, data: new ArrayBuffer(0) });
  }

  // Extract entries in parallel batches
  if (toExtract.length > 0) {
    // Process in batches for controlled concurrency
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

// ===========================
// UPLOAD FUNCTIONS
// ===========================

/**
 * Upload to Google Drive using resumable upload
 * Progress: 0-100% of upload phase
 */
async function uploadToGoogleDrive(
  cbzBlob: Blob,
  filename: string,
  seriesFolderId: string,
  accessToken: string,
  onProgress: (loaded: number, total: number) => void
): Promise<string> {
  console.log(`Worker: Uploading ${filename} to Google Drive...`);

  // Use pre-created folder ID (created in backup-queue to avoid race conditions)
  const metadata = {
    name: filename,
    mimeType: 'application/x-cbz',
    parents: [seriesFolderId]
  };

  // Step 1: Initiate resumable upload session
  const initResponse = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(metadata)
    }
  );

  if (!initResponse.ok) {
    throw new Error(`Upload init failed: ${initResponse.status} ${initResponse.statusText}`);
  }

  const uploadUrl = initResponse.headers.get('Location');
  if (!uploadUrl) {
    throw new Error('No upload URL returned');
  }

  // Step 2: Upload the actual file data with progress tracking
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', 'application/x-cbz');

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    };

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const result = JSON.parse(xhr.responseText);
        console.log(`Worker: Upload complete, file ID: ${result.id}`);
        resolve(result.id);
      } else {
        reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));

    // Send Blob directly - browser streams the data
    xhr.send(cbzBlob);
  });
}

/**
 * Upload to WebDAV server
 * Progress: 0-100% of upload phase
 */
async function uploadToWebDAV(
  cbzBlob: Blob,
  filename: string,
  seriesTitle: string,
  serverUrl: string,
  username: string,
  password: string,
  onProgress: (loaded: number, total: number) => void
): Promise<string> {
  console.log(`Worker: Uploading ${filename} to WebDAV...`);

  // Ensure folder exists
  const seriesFolderPath = `mokuro-reader/${seriesTitle}`;
  await createWebDAVFolderRecursive(seriesFolderPath, serverUrl, username, password);

  // Upload file
  const filePath = `/${seriesFolderPath}/${filename}`;
  const fileUrl = `${serverUrl}${filePath}`;
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', fileUrl);
    xhr.setRequestHeader('Authorization', authHeader);
    xhr.setRequestHeader('Content-Type', 'application/x-cbz');

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        console.log(`Worker: WebDAV upload complete`);
        resolve(filePath); // Return path as "file ID"
      } else {
        reject(new Error(`WebDAV upload failed: ${xhr.status} ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during WebDAV upload'));
    xhr.ontimeout = () => reject(new Error('WebDAV upload timed out'));

    // Send Blob directly - browser streams the data
    xhr.send(cbzBlob);
  });
}

/**
 * Helper: Create WebDAV folder recursively
 */
async function createWebDAVFolderRecursive(
  path: string,
  serverUrl: string,
  username: string,
  password: string
): Promise<void> {
  const authHeader = 'Basic ' + btoa(`${username}:${password}`);
  const parts = path.split('/').filter((p) => p);

  let currentPath = '';
  for (const part of parts) {
    currentPath += `/${part}`;
    const folderUrl = `${serverUrl}${currentPath}`;

    // Try to create folder (MKCOL)
    try {
      const response = await fetch(folderUrl, {
        method: 'MKCOL',
        headers: { Authorization: authHeader }
      });

      // 201 = created, 405 = already exists, both are OK
      if (!response.ok && response.status !== 405) {
        console.warn(`Failed to create folder ${currentPath}: ${response.status}`);
      }
    } catch (error) {
      console.warn(`Error creating folder ${currentPath}:`, error);
    }
  }
}

/**
 * Upload to MEGA
 * Progress: 0-100% of upload phase
 */
async function uploadToMEGA(
  cbzBlob: Blob,
  filename: string,
  seriesTitle: string,
  email: string,
  password: string,
  onProgress: (loaded: number, total: number) => void
): Promise<string> {
  console.log(`Worker: Uploading ${filename} to MEGA...`);

  if (!email || !password) {
    throw new Error('MEGA credentials not provided');
  }

  // Create MEGA storage instance
  const storage = new Storage({ email, password });

  // Wait for ready
  await storage.ready;

  // Ensure folder structure exists
  let currentFolder = storage.root;

  // Create/find mokuro-reader folder
  let mokuroFolder = currentFolder.children?.find(
    (child: any) => child.name === 'mokuro-reader' && child.directory
  );

  if (!mokuroFolder) {
    mokuroFolder = await currentFolder.mkdir('mokuro-reader');
  }

  // Create/find series folder
  let seriesFolder = mokuroFolder.children?.find(
    (child: any) => child.name === seriesTitle && child.directory
  );

  if (!seriesFolder) {
    seriesFolder = await mokuroFolder.mkdir(seriesTitle);
  }

  // Upload file to series folder using chunked streaming to avoid OOM
  console.log(`Worker: Starting MEGA upload for ${filename}, size: ${cbzBlob.size} bytes`);

  try {
    const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

    // Create upload stream without passing data - we'll write chunks manually
    const uploadStream = seriesFolder.upload({ name: filename, size: cbzBlob.size });

    // Wait for upload to complete while streaming chunks
    await new Promise<void>((resolve, reject) => {
      let offset = 0;

      uploadStream.on('progress', (stats: any) => {
        // megajs progress: { bytesLoaded, bytesUploaded, bytesTotal }
        // Use bytesUploaded for actual upload progress to server
        const uploaded = stats?.bytesUploaded || stats?.loaded || 0;
        const total = stats?.bytesTotal || stats?.total || cbzBlob.size;
        onProgress(uploaded, total);
      });

      uploadStream.on('complete', () => {
        console.log('Worker: MEGA upload stream completed');
        resolve();
      });

      uploadStream.on('error', (err: any) => {
        console.error('Worker: MEGA upload stream error:', err);
        reject(err);
      });

      // Stream chunks to MEGA
      const writeNextChunk = async () => {
        if (offset >= cbzBlob.size) {
          uploadStream.end();
          return;
        }

        const chunk = cbzBlob.slice(offset, Math.min(offset + CHUNK_SIZE, cbzBlob.size));
        const arrayBuffer = await chunk.arrayBuffer();
        uploadStream.write(new Uint8Array(arrayBuffer));
        offset += CHUNK_SIZE;

        // Use setTimeout to avoid blocking event loop and allow GC
        setTimeout(() => writeNextChunk(), 0);
      };

      writeNextChunk();
    });

    // After upload completes, find the file in the folder's children
    // The file should now be in seriesFolder.children
    const uploadedFile = seriesFolder.children?.find(
      (child: any) => child.name === filename && !child.directory
    );

    if (!uploadedFile || !uploadedFile.nodeId) {
      console.error('Worker: Could not find uploaded file in folder children');
      throw new Error('MEGA upload succeeded but could not find uploaded file');
    }

    console.log(`Worker: MEGA upload complete, file ID: ${uploadedFile.nodeId}`);
    return uploadedFile.nodeId;
  } catch (error: any) {
    console.error('Worker: MEGA upload error:', error);
    throw new Error(`MEGA upload failed: ${error.message || error}`);
  }
}

// ===========================
// MAIN MESSAGE HANDLER
// ===========================

ctx.addEventListener('message', async (event) => {
  const message = event.data as WorkerMessage;
  console.log('Worker: Received message', message.mode);

  try {
    if (message.mode === 'download-and-decompress') {
      // ========== DOWNLOAD AND DECOMPRESS MODE ==========
      const { provider, fileId, fileName, credentials, metadata } = message;
      console.log(`Worker: Starting download for ${fileName} (${fileId})`);

      let arrayBuffer: ArrayBuffer;

      // Download based on provider - all return ArrayBuffer directly
      if (provider === 'google-drive') {
        if (!credentials.accessToken) {
          throw new Error('Missing access token for Google Drive');
        }
        arrayBuffer = await downloadFromGoogleDrive(
          fileId,
          credentials.accessToken,
          (loaded, total) => {
            const progressMessage: DownloadProgressMessage = {
              type: 'progress',
              fileId,
              loaded,
              total
            };
            ctx.postMessage(progressMessage);
          }
        );
      } else if (provider === 'webdav') {
        if (!credentials.webdavUrl) {
          throw new Error('Missing WebDAV URL');
        }
        arrayBuffer = await downloadFromWebDAV(
          fileId,
          credentials.webdavUrl,
          credentials.webdavUsername ?? '',
          credentials.webdavPassword ?? '',
          (loaded, total) => {
            const progressMessage: DownloadProgressMessage = {
              type: 'progress',
              fileId,
              loaded,
              total
            };
            ctx.postMessage(progressMessage);
          }
        );
      } else if (provider === 'mega') {
        if (!credentials.megaShareUrl) {
          throw new Error('Missing MEGA share URL');
        }
        arrayBuffer = await downloadFromMega(credentials.megaShareUrl, (loaded, total) => {
          const progressMessage: DownloadProgressMessage = {
            type: 'progress',
            fileId,
            loaded,
            total
          };
          ctx.postMessage(progressMessage);
        });
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }

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
      let fileId: string;
      const filename = `${volumeTitle}.cbz`;

      if (provider === 'google-drive') {
        if (!credentials.accessToken || !credentials.seriesFolderId) {
          throw new Error('Missing Google Drive access token or series folder ID');
        }
        fileId = await uploadToGoogleDrive(
          cbzBlob,
          filename,
          credentials.seriesFolderId,
          credentials.accessToken,
          (loaded, total) => {
            const uploadProgress = (loaded / total) * 100; // 0-100% upload
            const progressMessage: UploadProgressMessage = {
              type: 'progress',
              phase: 'uploading',
              progress: uploadProgress
            };
            ctx.postMessage(progressMessage);
          }
        );
      } else if (provider === 'webdav') {
        if (!credentials.webdavUrl) {
          throw new Error('Missing WebDAV URL');
        }
        fileId = await uploadToWebDAV(
          cbzBlob,
          filename,
          seriesTitle,
          credentials.webdavUrl,
          credentials.webdavUsername ?? '',
          credentials.webdavPassword ?? '',
          (loaded, total) => {
            const uploadProgress = (loaded / total) * 100; // 0-100% upload
            const progressMessage: UploadProgressMessage = {
              type: 'progress',
              phase: 'uploading',
              progress: uploadProgress
            };
            ctx.postMessage(progressMessage);
          }
        );
      } else if (provider === 'mega') {
        if (!credentials.megaEmail || !credentials.megaPassword) {
          throw new Error('Missing MEGA credentials');
        }
        fileId = await uploadToMEGA(
          cbzBlob,
          filename,
          seriesTitle,
          credentials.megaEmail,
          credentials.megaPassword,
          (loaded, total) => {
            const uploadProgress = (loaded / total) * 100; // 0-100% upload
            const progressMessage: UploadProgressMessage = {
              type: 'progress',
              phase: 'uploading',
              progress: uploadProgress
            };
            ctx.postMessage(progressMessage);
          }
        );
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }

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
