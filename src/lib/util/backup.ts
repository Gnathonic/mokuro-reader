import type { VolumeMetadata } from '$lib/types';
import { driveApiClient, escapeNameForDriveQuery } from './sync/providers/google-drive/api-client';
import { unifiedCloudManager } from './sync/unified-cloud-manager';
import type { ProviderType } from './sync/provider-interface';

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
