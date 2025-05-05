import type { VolumeMetadata } from "$lib/types";
import { BlobReader, BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import { db } from "$lib/catalog/db";
import { progressTrackerStore } from "./progress-tracker";
import { addSeries, addVolume } from "./drive-store";
import { driveApiRequest, DriveErrorType } from "./api-helpers";

type FileInfo = {
  accessToken: string;
  metadata: any;
  fileId?: string;
  localStorageId: string;
  type: string;
}

const FILES_API_URL = 'https://www.googleapis.com/upload/drive/v3/files';

export async function uploadFile({ accessToken, fileId, localStorageId, metadata, type }: FileInfo) {
  console.log('uploadFile called with fileId:', fileId);
  console.log('uploadFile metadata:', metadata);
  
  const json = localStorage.getItem(localStorageId) || '';
  const blob = new Blob([json], { type });

  const form = new FormData();

  form.append('resource', new Blob([JSON.stringify(metadata)], { type }));
  form.append('file', blob);

  try {
    return await driveApiRequest(
      `${FILES_API_URL}${fileId ? `/${fileId}` : ''}?uploadType=multipart`,
      {
        method: fileId ? 'PATCH' : 'POST',
        headers: new Headers({ Authorization: 'Bearer ' + accessToken }),
        body: form
      }
    );
  } catch (error: any) {
    console.error('Error uploading file:', error);

    // Only throw auth errors, handle other errors gracefully
    if (error.errorType === DriveErrorType.AUTH_ERROR) {
      throw error;
    }

    // Return a partial success with error info
    return {
      error: true,
      message: error.message || 'Unknown error',
      errorType: error.errorType
    };
  }
}

/**
 * Uploads a blob to Google Drive
 * @param accessToken Google Drive access token
 * @param blob The blob to upload
 * @param filename The filename to use
 * @param folderId The folder ID to upload to
 * @param mimeType The MIME type of the file
 * @returns The response from the Google Drive API
 */
export async function uploadBlob(
  accessToken: string,
  blob: Blob,
  filename: string,
  folderId: string,
  mimeType: string = 'application/zip'
) {
  const form = new FormData();

  const metadata = {
    name: filename,
    mimeType: mimeType,
    parents: [folderId]
  };

  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  try {
    return await driveApiRequest(
      `${FILES_API_URL}?uploadType=multipart`,
      {
        method: 'POST',
        headers: new Headers({ Authorization: 'Bearer ' + accessToken }),
        body: form
      },
      {
        // Use more retries for uploads since they're more likely to fail
        maxRetries: 5,
        // Use longer initial backoff for large files
        initialBackoffMs: 2000
      }
    );
  } catch (error: any) {
    console.error('Error uploading blob:', error);

    // Only throw auth errors, handle other errors gracefully
    if (error.errorType === DriveErrorType.AUTH_ERROR) {
      throw error;
    }

    // Return a partial success with error info
    return {
      error: true,
      message: error.message || 'Unknown error',
      errorType: error.errorType
    };
  }
}

/**
 * Checks if a file exists in a Google Drive folder
 * @param accessToken Google Drive access token
 * @param filename The filename to check
 * @param folderId The folder ID to check in
 * @returns The file ID if it exists, null otherwise
 */
export async function checkFileExists(accessToken: string, filename: string, folderId: string): Promise<string | null> {
  try {
    const data = await driveApiRequest(
      `https://www.googleapis.com/drive/v3/files?q=name='${encodeURIComponent(filename)}' and '${folderId}' in parents and trashed=false&fields=files(id,name)`,
      {
        method: 'GET',
        headers: new Headers({ Authorization: 'Bearer ' + accessToken })
      }
    );

    if (data.files && data.files.length > 0) {
      return data.files[0].id;
    }

    return null;
  } catch (error: any) {
    console.error('Error checking if file exists:', error);

    // Only throw auth errors, handle other errors gracefully
    if (error.errorType === DriveErrorType.AUTH_ERROR) {
      throw error;
    }

    return null;
  }
}

/**
 * Creates a folder in Google Drive if it doesn't exist
 * @param accessToken Google Drive access token
 * @param folderName The name of the folder to create
 * @param parentFolderId The parent folder ID
 * @returns The folder ID
 */
export async function createFolderIfNotExists(accessToken: string, folderName: string, parentFolderId: string): Promise<string> {
  try {
    // Check if folder already exists
    const data = await driveApiRequest(
      `https://www.googleapis.com/drive/v3/files?q=name='${encodeURIComponent(folderName)}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
      {
        method: 'GET',
        headers: new Headers({ Authorization: 'Bearer ' + accessToken })
      }
    );

    if (data.files && data.files.length > 0) {
      return data.files[0].id;
    }

    // Create folder if it doesn't exist
    const metadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId]
    };

    const createData = await driveApiRequest(
      'https://www.googleapis.com/drive/v3/files',
      {
        method: 'POST',
        headers: new Headers({
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify(metadata)
      }
    );

    return createData.id;
  } catch (error: any) {
    console.error('Error creating folder:', error);

    // Only throw auth errors, handle other errors gracefully
    if (error.errorType === DriveErrorType.AUTH_ERROR) {
      throw error;
    }

    // For other errors, throw a more descriptive error
    throw new Error(`Failed to create folder "${folderName}": ${error.message || 'Unknown error'}`);
  }
}

/**
 * Adds a volume's files to a zip archive
 * @param zipWriter The ZipWriter instance
 * @param volume The volume metadata
 * @returns Promise resolving to an array of promises for adding files
 */
async function addVolumeToArchive(zipWriter: ZipWriter<Blob>, volume: VolumeMetadata) {
  // Get volume data from the database
  const volumeData = await db.volumes_data.get(volume.volume_uuid);
  if (!volumeData) {
    console.error(`Volume data not found for ${volume.volume_uuid}`);
    return [];
  }

  // Create mokuro data in the old format for compatibility
  const mokuroData = {
    version: volume.mokuro_version,
    title: volume.series_title,
    title_uuid: volume.series_uuid,
    volume: volume.volume_title,
    volume_uuid: volume.volume_uuid,
    pages: volumeData.pages,
    chars: volume.character_count
  };

  // Create folder name for images (same as mokuro file name without extension)
  const folderName = `${volume.volume_title}`;

  // Add image files inside the folder
  const imagePromises = volumeData.files ?
    Object.entries(volumeData.files).map(([filename, file]) => {
      return zipWriter.add(`${folderName}/${filename}`, new BlobReader(file));
    }) : [];

  // Add mokuro data file in the root directory (for both ZIP and CBZ)
  return [
    ...imagePromises,
    zipWriter.add(
      `${volume.volume_title}.mokuro`,
      new TextReader(JSON.stringify(mokuroData))
    )
  ];
}

/**
 * Creates a CBZ archive for a volume
 * @param volume The volume metadata
 * @returns Promise resolving to a Blob containing the CBZ archive
 */
export async function createVolumeArchive(volume: VolumeMetadata): Promise<Blob> {
  const zipWriter = new ZipWriter(new BlobWriter("application/zip"));

  // Add the volume to the archive
  const filePromises = await addVolumeToArchive(zipWriter, volume);

  // Wait for all files to be added
  await Promise.all(filePromises);

  // Close the archive and get the blob
  return await zipWriter.close();
}

/**
 * Exports and uploads volumes to Google Drive
 * @param volumes Array of volumes to export and upload
 * @param accessToken Google Drive access token
 * @param readerFolderId The ID of the mokuro-reader folder in Google Drive
 * @returns Promise that resolves when all volumes have been uploaded
 */
export async function exportAndUploadVolumesToDrive(
  volumes: VolumeMetadata[],
  accessToken: string,
  readerFolderId: string
): Promise<void> {
  if (!volumes || volumes.length === 0) {
    throw new Error('No volumes to export');
  }

  const seriesTitle = volumes[0].series_title;
  const processId = `export-upload-${Date.now()}`;

  // Add a process to the progress tracker
  progressTrackerStore.addProcess({
    id: processId,
    description: `Exporting and uploading ${seriesTitle}`,
    progress: 0,
    status: 'Creating folders...'
  });

  try {
    // First, create a "comics" folder if it doesn't exist
    progressTrackerStore.updateProcess(processId, {
      progress: 2,
      status: `Creating comics folder...`
    });
    
    const comicsFolderId = await createFolderIfNotExists(accessToken, "comics", readerFolderId);
    
    // Then create a folder for the series inside the comics folder
    progressTrackerStore.updateProcess(processId, {
      progress: 5,
      status: `Creating folder for ${seriesTitle}...`
    });

    const seriesFolderId = await createFolderIfNotExists(accessToken, seriesTitle, comicsFolderId);

    // Add the series to our store
    addSeries(seriesTitle, seriesFolderId);

    // Sort volumes by title for consistent processing
    const sortedVolumes = [...volumes].sort((a, b) =>
      a.volume_title.localeCompare(b.volume_title, undefined, { numeric: true, sensitivity: 'base' })
    );

    // Process each volume
    for (let i = 0; i < sortedVolumes.length; i++) {
      const volume = sortedVolumes[i];
      const volumeTitle = volume.volume_title;
      const filename = `${volumeTitle}.cbz`;

      // Update progress
      progressTrackerStore.updateProcess(processId, {
        progress: 5 + ((i / sortedVolumes.length) * 95),
        status: `Processing ${volumeTitle} (${i+1}/${sortedVolumes.length})...`
      });

      // Check if the file already exists in Google Drive
      const existingFileId = await checkFileExists(accessToken, filename, seriesFolderId);

      if (existingFileId) {
        // Skip this volume as it already exists
        progressTrackerStore.updateProcess(processId, {
          status: `${volumeTitle} already exists in Google Drive, skipping...`
        });
        continue;
      }

      // Create the CBZ archive for this volume
      progressTrackerStore.updateProcess(processId, {
        status: `Creating archive for ${volumeTitle}...`
      });

      const archiveBlob = await createVolumeArchive(volume);

      // Upload the archive to Google Drive
      progressTrackerStore.updateProcess(processId, {
        status: `Uploading ${volumeTitle} to Google Drive...`
      });

      const response = await uploadBlob(accessToken, archiveBlob, filename, seriesFolderId, 'application/vnd.comicbook+zip');

      // Add the volume to our store
      if (response && response.id) {
        addVolume(seriesTitle, volumeTitle, response.id, filename);
      }

      progressTrackerStore.updateProcess(processId, {
        status: `Uploaded ${volumeTitle} (${i+1}/${sortedVolumes.length})`,
      });
    }

    // All volumes have been processed
    progressTrackerStore.updateProcess(processId, {
      progress: 100,
      status: `All volumes of ${seriesTitle} processed successfully`
    });

    // Remove the process after a delay
    setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
  } catch (error) {
    console.error('Error exporting and uploading volumes:', error);

    // Update the progress tracker with the error
    progressTrackerStore.updateProcess(processId, {
      progress: 0,
      status: `Error: ${error.message || 'Unknown error'}`
    });

    // Remove the process after a delay
    setTimeout(() => progressTrackerStore.removeProcess(processId), 5000);

    throw error;
  }
}
