/**
 * Shared WebDAV upload utilities
 * Can be used by both the main thread provider and Web Workers
 */

import type { WebDAVClient } from 'webdav';
import type { ServerOcrQueued } from '$lib/util/sync/provider-interface';

/** What one PUT established. */
export interface WebdavPutResult {
  /** The path written (the old string-returning contract's value). */
  path: string;
  /**
   * The server queued this file for OCR (mokuro-bunko's `X-Mokuro-Manifest` /
   * `X-Mokuro-Recheck-After`); absent for any other server or file.
   */
  serverOcr?: ServerOcrQueued;
}

/** A response header, or null — never throws (CORS-hidden headers read as null). */
type HeaderReader = (name: string) => string | null;

/** The OCR queue headers of a PUT response, resolved against the upload URL. */
export function readServerOcrHeaders(
  header: HeaderReader,
  uploadUrl: string
): ServerOcrQueued | undefined {
  const manifest = header('X-Mokuro-Manifest');
  if (!manifest) return undefined;
  let manifestUrl: string;
  try {
    manifestUrl = new URL(manifest, uploadUrl).toString();
  } catch {
    return undefined;
  }
  const raw = header('X-Mokuro-Recheck-After');
  const seconds = raw !== null && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return { manifestUrl, recheckAfter: Number.isFinite(seconds) ? seconds : null };
}

/**
 * Upload a file to WebDAV using the webdav library client
 * Handles large files by streaming the Blob body (browser handles chunking)
 *
 * @param client WebDAV client instance
 * @param path Full path including filename (e.g., "/mokuro-reader/Series/Volume.cbz")
 * @param blob File data as Blob
 * @param onProgress Optional progress callback
 * @returns Promise resolving to the path written, plus what the server said about it
 */
export async function uploadFileWithClient(
  client: WebDAVClient,
  path: string,
  blob: Blob,
  onProgress?: (loaded: number, total: number) => void
): Promise<WebdavPutResult> {
  const uploadUrl = client.getFileUploadLink(path);
  const clientHeaders = client.getHeaders();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);

    // Apply client headers (includes Authorization)
    // Note: getHeaders() returns a plain object, not a native Headers instance
    for (const [key, value] of Object.entries(clientHeaders)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    // Long timeout for large files (30 minutes)
    xhr.timeout = 30 * 60 * 1000;

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(event.loaded, event.total);
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const header: HeaderReader = (name) => {
          try {
            return xhr.getResponseHeader(name);
          } catch {
            return null;
          }
        };
        const serverOcr = readServerOcrHeaders(header, uploadUrl);
        resolve(serverOcr ? { path, serverOcr } : { path });
      } else {
        reject(new Error(`WebDAV upload failed: ${xhr.status} ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => {
      reject(new Error(`Network error during WebDAV upload`));
    };

    xhr.ontimeout = () => {
      reject(new Error(`WebDAV upload timed out`));
    };

    // Send Blob directly - browser streams without loading into memory
    xhr.send(blob);
  });
}

/**
 * Create WebDAV folders recursively
 *
 * @param client WebDAV client instance
 * @param path Folder path to create (e.g., "mokuro-reader/Series")
 */
export async function ensureFoldersExist(client: WebDAVClient, path: string): Promise<void> {
  const parts = path.split('/').filter((p) => p);

  let currentPath = '';
  for (const part of parts) {
    currentPath += `/${part}`;
    try {
      const exists = await client.exists(currentPath);
      if (!exists) {
        await client.createDirectory(currentPath);
      }
    } catch {
      // Ignore errors - folder may already exist or be created by another request
    }
  }
}

/**
 * Upload a file to WebDAV with credentials (for use in workers)
 * Creates the webdav client internally
 *
 * @param serverUrl WebDAV server URL
 * @param username Optional username
 * @param password Optional password
 * @param seriesTitle Series folder name
 * @param filename File name (e.g., "Volume 1.cbz")
 * @param blob File data
 * @param onProgress Optional progress callback
 * @returns Promise resolving to the file path
 */
export async function uploadToWebDAV(
  serverUrl: string,
  username: string,
  password: string,
  seriesTitle: string,
  filename: string,
  blob: Blob,
  onProgress?: (loaded: number, total: number) => void
): Promise<string> {
  // Dynamically import webdav to support usage in workers
  const { createClient } = await import('webdav');
  const { webdavAuthOptions } = await import('$lib/util/sync/core/providers/webdav-auth');

  // Create client with credentials (UTF-8-safe Authorization header)
  const client = createClient(serverUrl, webdavAuthOptions(username, password));

  // Ensure folder structure exists
  const folderPath = `mokuro-reader/${seriesTitle}`;
  await ensureFoldersExist(client, folderPath);

  // Upload file
  const filePath = `/${folderPath}/${filename}`;
  return (await uploadFileWithClient(client, filePath, blob, onProgress)).path;
}
