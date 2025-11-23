import type { VolumeMetadata } from '$lib/types';
import { driveApiClient, escapeNameForDriveQuery } from './sync/providers/google-drive/api-client';
import { createArchiveBlob } from './zip';
import { unifiedCloudManager } from './sync/unified-cloud-manager';
import type { ProviderType } from './sync/provider-interface';

/**
 * Uploads a CBZ blob to Google Drive
 * @param blob The CBZ blob to upload
 * @param filename The name for the file
 * @param parentFolderId Optional parent folder ID
 * @returns Promise resolving to the uploaded file ID
 */
export async function uploadCbzToDrive(
  blob: Blob,
  filename: string,
  parentFolderId?: string
): Promise<string> {
  // Use simple resumable upload for large binary files
  const { access_token } = gapi.auth.getToken();

  const metadata = {
    name: filename,
    mimeType: 'application/x-cbz',
    ...(parentFolderId && { parents: [parentFolderId] })
  };

  // Step 1: Initiate resumable upload session
  const initResponse = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(metadata)
    }
  );

  if (!initResponse.ok) {
    throw new Error(`Upload init failed: ${initResponse.status} ${initResponse.statusText}`);
  }

  // Step 2: Upload the actual file data
  const uploadUrl = initResponse.headers.get('Location');
  if (!uploadUrl) {
    throw new Error('No upload URL returned');
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/x-cbz'
    },
    body: blob
  });

  if (!uploadResponse.ok) {
    throw new Error(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
  }

  const result = await uploadResponse.json();
  return result.id;
}

/**
 * Finds or creates a folder in Google Drive
 * @param folderName The name of the folder
 * @param parentFolderId Optional parent folder ID
 * @returns Promise resolving to the folder ID
 */
export async function getOrCreateFolder(
  folderName: string,
  parentFolderId?: string
): Promise<string> {
  const escapedFolderName = escapeNameForDriveQuery(folderName);

  // Search for existing folder
  const query = parentFolderId
    ? `name='${escapedFolderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${escapedFolderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const files = await driveApiClient.listFiles(query, 'files(id, name)');

  if (files.length > 0) {
    return files[0].id;
  }

  // Create folder if it doesn't exist
  return await driveApiClient.createFolder(folderName, parentFolderId);
}

/**
 * Checks if a file exists in Google Drive
 * @param fileName The name of the file
 * @param parentFolderId Optional parent folder ID
 * @returns Promise resolving to the file ID if it exists, or null
 */
export async function findFile(fileName: string, parentFolderId?: string): Promise<string | null> {
  const escapedFileName = escapeNameForDriveQuery(fileName);

  const query = parentFolderId
    ? `name='${escapedFileName}' and '${parentFolderId}' in parents and trashed=false`
    : `name='${escapedFileName}' and trashed=false`;

  const files = await driveApiClient.listFiles(query, 'files(id, name)');

  return files.length > 0 ? files[0].id : null;
}
