/**
 * Shared WebDAV upload utilities
 * Can be used by both the main thread provider and Web Workers
 */

import type { WebDAVClient } from 'webdav';

/**
 * Upload a file to WebDAV using the webdav library client
 * Handles large files by streaming the Blob body (browser handles chunking)
 *
 * @param client WebDAV client instance
 * @param path Full path including filename (e.g., "/mokuro-reader/Series/Volume.cbz")
 * @param blob File data as Blob
 * @param onProgress Optional progress callback
 * @returns Promise resolving to the file path
 */
export async function uploadFileWithClient(
  client: WebDAVClient,
  path: string,
  blob: Blob,
  onProgress?: (loaded: number, total: number) => void
): Promise<string> {
  const uploadUrl = client.getFileUploadLink(path);
  const clientHeaders = client.getHeaders();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);

    // Apply client headers (includes Authorization)
    clientHeaders.forEach((value, key) => {
      xhr.setRequestHeader(key, value);
    });
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
        resolve(path);
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

  // Create client with credentials
  const clientOptions: { username?: string; password?: string } = {};
  if (username || password) {
    clientOptions.username = username || '';
    clientOptions.password = password || '';
  }
  const client = createClient(serverUrl, clientOptions);

  // Ensure folder structure exists
  const folderPath = `mokuro-reader/${seriesTitle}`;
  await ensureFoldersExist(client, folderPath);

  // Upload file
  const filePath = `/${folderPath}/${filename}`;
  return uploadFileWithClient(client, filePath, blob, onProgress);
}
