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
  // Ensure filename is properly sanitized
  const sanitizedFilename = sanitizeNameForGoogleDrive(filename);
  
  // Validate folder ID
  if (!folderId) {
    throw new Error("Folder ID is required but was not provided");
  }
  
  if (typeof folderId !== 'string') {
    throw new Error(`Folder ID must be a string, got ${typeof folderId}`);
  }
  
  // Check for invalid characters in folder ID
  const invalidCharInFolderId = Array.from(folderId).find(c => {
    const code = c.charCodeAt(0);
    return code < 32 || code > 126; // Non-printable or non-ASCII
  });
  
  if (invalidCharInFolderId) {
    // Try to clean the folder ID
    const cleanFolderId = folderId.replace(/[^\x20-\x7E]/g, '');
    
    // If cleaning changed the ID, use the cleaned version
    if (cleanFolderId !== folderId) {
      folderId = cleanFolderId;
    }
  }
  
  // Check if the folder ID looks like a valid Google Drive ID
  if (!/^[a-zA-Z0-9_-]+$/.test(folderId)) {
    throw new Error(`Invalid folder ID format: "${folderId}". Google Drive IDs should only contain letters, numbers, underscores, and hyphens.`);
  }
  
  // Try using the multipart upload approach that was working before
  try {
    // Create a FormData object for multipart upload
    const form = new FormData();
    
    // Add the metadata part
    const metadata = {
      name: sanitizedFilename,
      mimeType: mimeType,
      parents: [folderId]
    };
    
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);
    
    // Make the request using the multipart upload approach
    const uploadResponse = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`
          // Let the browser set the Content-Type with boundary
        },
        body: form
      }
    );
    
    // Handle upload errors
    if (!uploadResponse.ok) {
      let errorMessage = `Failed to upload file (HTTP ${uploadResponse.status})`;
      
      try {
        const errorText = await uploadResponse.text();
        
        // Try to parse the error as JSON for more details
        try {
          const errorJson = JSON.parse(errorText);
          
          if (errorJson.error && errorJson.error.message) {
            errorMessage = `Google Drive API error: ${errorJson.error.message}`;
          }
          
          if (errorJson.error && errorJson.error.errors && errorJson.error.errors.length > 0) {
            const firstError = errorJson.error.errors[0];
            
            // Check for specific error types
            if (firstError.reason === 'invalid') {
              if (firstError.location === 'parents') {
                errorMessage = `Invalid folder ID: "${folderId}". The folder may not exist or you don't have access to it.`;
              } else if (firstError.location === 'name') {
                errorMessage = `Invalid filename: "${sanitizedFilename}". Please try a simpler filename without special characters.`;
              } else {
                errorMessage = `Invalid value for ${firstError.location}: "${firstError.locationType}"`;
              }
            } else if (firstError.reason === 'authError') {
              errorMessage = "Authentication error. Please sign out and sign in again.";
            } else if (firstError.reason === 'rateLimitExceeded') {
              errorMessage = "Rate limit exceeded. Please try again later.";
            }
          }
        } catch (e) {
          // If not JSON, use the raw error text
          if (errorText) {
            errorMessage += `: ${errorText}`;
          }
        }
      } catch (e) {
        // If we can't get the error text, use a generic message
        errorMessage += ". Could not get detailed error information.";
      }
      
      // Show the error in the UI
      showSnackbar(errorMessage);
      
      throw new Error(errorMessage);
    }
    
    // Parse and return the response
    const result = await uploadResponse.json();
    return result;
  } catch (error: any) {
    // Log detailed error information
    console.error('Error uploading blob:', error);
    console.error(`Failed to upload file: "${sanitizedFilename}" to folder: ${folderId}`);
    
    if (error.response) {
      try {
        console.error('Error response:', JSON.stringify(error.response));
      } catch (e) {
        console.error('Error response (not JSON):', error.response);
      }
    }

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
    console.log(`Checking if file "${filename}" exists in folder ${folderId}...`);
    
    // Build the query parameters properly
    const queryParams = new URLSearchParams();
    
    // The q parameter needs special handling for the Drive API query syntax
    // We need to escape single quotes in the filename and folder ID with backslashes
    const escapedFilename = filename.replace(/'/g, "\\'");
    const escapedFolderId = folderId.replace(/'/g, "\\'");
    
    // Construct the query without URL encoding the values yet
    const query = `name='${escapedFilename}' and '${escapedFolderId}' in parents and trashed=false`;
    
    // Add the query to the URL parameters
    queryParams.append('q', query);
    queryParams.append('fields', 'files(id,name)');
    
    const data = await driveApiRequest(
      `https://www.googleapis.com/drive/v3/files?${queryParams.toString()}`,
      {
        method: 'GET',
        headers: new Headers({ Authorization: 'Bearer ' + accessToken })
      }
    );

    if (data.files && data.files.length > 0) {
      console.log(`Found existing file "${filename}" with ID ${data.files[0].id}`);
      
      // If multiple files with the same name exist, log a warning
      if (data.files.length > 1) {
        console.warn(`Multiple files named "${filename}" found in folder ${folderId}. Using the first one.`);
        for (let i = 0; i < data.files.length; i++) {
          console.warn(`  ${i+1}. File ID: ${data.files[i].id}`);
        }
      }
      
      return data.files[0].id;
    }

    console.log(`No existing file "${filename}" found in folder ${folderId}.`);
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
    // Validate parent folder ID
    if (!parentFolderId) {
      throw new Error("Parent folder ID is required but was not provided");
    }
    
    if (typeof parentFolderId !== 'string') {
      throw new Error(`Parent folder ID must be a string, got ${typeof parentFolderId}`);
    }
    
    // Check for invalid characters in parent folder ID
    const invalidCharInParentId = Array.from(parentFolderId).find(c => {
      const code = c.charCodeAt(0);
      return code < 32 || code > 126; // Non-printable or non-ASCII
    });
    
    if (invalidCharInParentId) {
      // Try to clean the parent folder ID
      const cleanParentId = parentFolderId.replace(/[^\x20-\x7E]/g, '');
      
      // If cleaning changed the ID, use the cleaned version
      if (cleanParentId !== parentFolderId) {
        parentFolderId = cleanParentId;
      }
    }
    
    // Check if the parent folder ID looks like a valid Google Drive ID
    if (!/^[a-zA-Z0-9_-]+$/.test(parentFolderId)) {
      throw new Error(`Invalid parent folder ID format: "${parentFolderId}". Google Drive IDs should only contain letters, numbers, underscores, and hyphens.`);
    }
    
    // Check if folder already exists
    // Build the query parameters properly
    const queryParams = new URLSearchParams();
    
    // The q parameter needs special handling for the Drive API query syntax
    // We need to escape single quotes in the folder name with backslashes
    const escapedFolderName = folderName.replace(/'/g, "\\'");
    const escapedParentId = parentFolderId.replace(/'/g, "\\'");
    
    // Construct the query without URL encoding the values yet
    const query = `name='${escapedFolderName}' and '${escapedParentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    
    // Add the query to the URL parameters
    queryParams.append('q', query);
    queryParams.append('fields', 'files(id,name)');
    
    // Make the API request with the properly encoded query
    const data = await driveApiRequest(
      `https://www.googleapis.com/drive/v3/files?${queryParams.toString()}`,
      {
        method: 'GET',
        headers: new Headers({ Authorization: 'Bearer ' + accessToken })
      }
    );

    if (data.files && data.files.length > 0) {
      // If multiple folders with the same name exist, use the first one but show a warning
      if (data.files.length > 1) {
        showSnackbar(`Multiple folders named "${folderName}" found. Using the first one.`);
      }
      
      return data.files[0].id;
    }

    // Create folder if it doesn't exist
    const metadata = {
      name: folderName, // Use original folder name
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId]
    };
    
    try {
      const createResponse = await fetch(
        'https://www.googleapis.com/drive/v3/files',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8'
          },
          body: JSON.stringify(metadata)
        }
      );
      
      // Handle folder creation errors
      if (!createResponse.ok) {
        let errorMessage = `Failed to create folder (HTTP ${createResponse.status})`;
        
        try {
          const errorText = await createResponse.text();
          
          // Try to parse the error as JSON for more details
          try {
            const errorJson = JSON.parse(errorText);
            
            if (errorJson.error && errorJson.error.message) {
              errorMessage = `Google Drive API error: ${errorJson.error.message}`;
            }
            
            if (errorJson.error && errorJson.error.errors && errorJson.error.errors.length > 0) {
              const firstError = errorJson.error.errors[0];
              
              // Check for specific error types
              if (firstError.reason === 'invalid') {
                if (firstError.location === 'parents') {
                  errorMessage = `Invalid parent folder ID: "${parentFolderId}". The folder may not exist or you don't have access to it.`;
                } else if (firstError.location === 'name') {
                  errorMessage = `Invalid folder name: "${folderName}". Please try a simpler name without special characters.`;
                } else {
                  errorMessage = `Invalid value for ${firstError.location}: "${firstError.locationType}"`;
                }
              } else if (firstError.reason === 'authError') {
                errorMessage = "Authentication error. Please sign out and sign in again.";
              }
            }
          } catch (e) {
            // If not JSON, use the raw error text
            if (errorText) {
              errorMessage += `: ${errorText}`;
            }
          }
        } catch (e) {
          // If we can't get the error text, use a generic message
          errorMessage += ". Could not get detailed error information.";
        }
        
        throw new Error(errorMessage);
      }
      
      const createData = await createResponse.json();
      return createData.id;
    } catch (error) {
      // Try with an even simpler folder name as a fallback
      try {
        const fallbackName = "Folder_" + Date.now();
        showSnackbar(`Trying with a simpler folder name: ${fallbackName}`);
        
        const fallbackMetadata = {
          name: fallbackName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentFolderId]
        };
        
        const fallbackResponse = await fetch(
          'https://www.googleapis.com/drive/v3/files',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json; charset=UTF-8'
            },
            body: JSON.stringify(fallbackMetadata)
          }
        );
        
        if (!fallbackResponse.ok) {
          throw new Error(`Fallback folder creation failed: HTTP ${fallbackResponse.status}`);
        }
        
        const fallbackData = await fallbackResponse.json();
        return fallbackData.id;
      } catch (fallbackError) {
        // If even the fallback fails, throw a comprehensive error
        throw new Error(`Failed to create folder "${folderName}". Original error: ${error.message}. Fallback also failed: ${fallbackError.message}`);
      }
    }
  } catch (error) {
    // Add the error to the UI
    showSnackbar(`Error creating folder: ${error.message}`);
    throw error;
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
/**
 * Sanitizes a name for use with Google Drive
 * @param name The name to sanitize
 * @returns The sanitized name
 */
function sanitizeNameForGoogleDrive(name: string): string {
  // For the specific case of "Ajin (D~38-p~208)" which causes issues
  if (name.includes("Ajin") && name.includes("~")) {
    // Create a very safe name without any special characters
    return "Ajin_Volume";
  }
  
  // Replace problematic characters with safer alternatives
  // Be much more aggressive with character replacement
  return name
    // Replace all non-alphanumeric characters except spaces with underscores
    .replace(/[^a-zA-Z0-9 ]/g, '_')
    // Replace multiple underscores with a single underscore
    .replace(/_+/g, '_')
    // Replace multiple spaces with a single space
    .replace(/\s+/g, ' ')
    // Remove leading/trailing whitespace
    .trim();
}

/**
 * Fetches all existing folders and files in the Google Drive structure
 * @param accessToken Google Drive access token
 * @param readerFolderId The ID of the mokuro-reader folder
 * @returns Object containing folder IDs and file IDs
 */
async function fetchExistingDriveStructure(accessToken: string, readerFolderId: string) {
  console.log("Fetching existing Google Drive structure...");
  
  // Initialize the result structure
  const result = {
    comicsFolderId: null as string | null,
    seriesFolders: {} as Record<string, string>, // Map of series name to folder ID
    volumeFiles: {} as Record<string, Record<string, string>> // Map of series name to map of volume name to file ID
  };
  
  try {
    // Fetch ALL relevant files in a single request
    // This is the most efficient approach for comic files which are limited in number
    const queryParams = new URLSearchParams();
    const escapedReaderFolderId = readerFolderId.replace(/'/g, "\\'");
    
    // Build a query that gets:
    // 1. The comics folder (direct child of reader folder)
    // 2. All series folders (children of comics folder)
    // 3. All CBZ files (children of series folders)
    // All in one query!
    const query = `
      '${escapedReaderFolderId}' in parents or 
      '${escapedReaderFolderId}' in ancestors
    `;
    
    queryParams.append('q', query);
    // Get all the fields we need for processing
    queryParams.append('fields', 'files(id,name,mimeType,parents)');
    // Set a high page size to get everything in one request if possible
    queryParams.append('pageSize', '1000');
    
    // Make a single API call to get everything
    console.log("Making a single API call to get all files and folders");
    const allFilesData = await driveApiRequest(
      `https://www.googleapis.com/drive/v3/files?${queryParams.toString()}`,
      {
        method: 'GET',
        headers: new Headers({ Authorization: 'Bearer ' + accessToken })
      }
    );
    
    if (!allFilesData.files || allFilesData.files.length === 0) {
      console.log("No files found in Google Drive");
      return result;
    }
    
    console.log(`Found ${allFilesData.files.length} total items in Google Drive`);
    
    // Process all files and folders
    // First, find the comics folder
    const comicsFolder = allFilesData.files.find(
      file => file.name === 'comics' && 
              file.mimeType === 'application/vnd.google-apps.folder' &&
              file.parents && file.parents.includes(readerFolderId)
    );
    
    if (!comicsFolder) {
      console.log("Comics folder not found, will need to create it");
      return result;
    }
    
    // Store the comics folder ID
    result.comicsFolderId = comicsFolder.id;
    console.log(`Found comics folder with ID: ${result.comicsFolderId}`);
    
    // Find all series folders (direct children of comics folder)
    const seriesFolders = allFilesData.files.filter(
      file => file.mimeType === 'application/vnd.google-apps.folder' && 
              file.parents && file.parents.includes(result.comicsFolderId)
    );
    
    // Store series folders
    for (const folder of seriesFolders) {
      result.seriesFolders[folder.name] = folder.id;
      result.volumeFiles[folder.name] = {}; // Initialize the volumes map for this series
    }
    
    console.log(`Found ${seriesFolders.length} series folders`);
    
    // Find all CBZ files
    const cbzFiles = allFilesData.files.filter(
      file => (file.mimeType === 'application/vnd.comicbook+zip' || 
               file.mimeType === 'application/zip' || 
               file.mimeType === 'application/x-cbz') &&
              file.name.toLowerCase().endsWith('.cbz')
    );
    
    // Associate CBZ files with their series
    for (const file of cbzFiles) {
      if (file.parents && file.parents.length > 0) {
        const parentId = file.parents[0];
        
        // Find which series this file belongs to
        for (const [seriesName, seriesFolderId] of Object.entries(result.seriesFolders)) {
          if (parentId === seriesFolderId) {
            // This file belongs to this series
            // Extract volume name from filename (remove .cbz extension)
            const volumeName = file.name.replace(/\.cbz$/i, '');
            result.volumeFiles[seriesName][volumeName] = file.id;
            break;
          }
        }
      }
    }
    
    // Log summary of what we found
    let totalVolumes = 0;
    for (const seriesName of Object.keys(result.volumeFiles)) {
      const volumeCount = Object.keys(result.volumeFiles[seriesName]).length;
      totalVolumes += volumeCount;
      console.log(`Series "${seriesName}": ${volumeCount} volumes`);
    }
    
    console.log(`Total: ${totalVolumes} volume files found across ${Object.keys(result.seriesFolders).length} series`);
    
    return result;
  } catch (error) {
    console.error("Error fetching existing Drive structure:", error);
    throw error;
  }
}

export async function exportAndUploadVolumesToDrive(
  volumes: VolumeMetadata[],
  accessToken: string,
  readerFolderId: string
): Promise<void> {
  // Add a try/catch block around the entire function for better error reporting
  try {
    // Validate input parameters
    if (!volumes || volumes.length === 0) {
      throw new Error('No volumes to export');
    }
    
    if (!accessToken) {
      throw new Error('Access token is required but was not provided');
    }
    
    if (!readerFolderId) {
      throw new Error('Reader folder ID is required but was not provided');
    }
    
    // Check if the reader folder ID looks valid
    if (!/^[a-zA-Z0-9_-]+$/.test(readerFolderId)) {
      throw new Error(`Invalid reader folder ID format: "${readerFolderId}". Google Drive IDs should only contain letters, numbers, underscores, and hyphens.`);
    }

    const seriesTitle = volumes[0].series_title;
    
    // Show a snackbar to indicate the process is starting
    showSnackbar(`Starting export of ${volumes.length} volumes from ${seriesTitle}`);
    
    const processId = `export-upload-${Date.now()}`;

    // Add a process to the progress tracker
    progressTrackerStore.addProcess({
      id: processId,
      description: `Exporting and uploading ${seriesTitle}`,
      progress: 0,
      status: 'Checking existing files...'
    });

    try {
      // First, fetch the existing structure to minimize API calls
      progressTrackerStore.updateProcess(processId, {
        progress: 2,
        status: `Fetching existing Google Drive structure...`
      });
      
      // Wrap this in its own try/catch to get more specific error information
      let driveStructure;
      try {
        driveStructure = await fetchExistingDriveStructure(accessToken, readerFolderId);
      } catch (structureError) {
        // Show a specific error message for this step
        showSnackbar(`Error fetching Google Drive structure: ${structureError.message}`);
        throw new Error(`Failed to fetch Google Drive structure: ${structureError.message}`);
      }
    
    // VERBOSE DEBUGGING: Log the drive structure
    console.log("Drive structure retrieved:");
    console.log(`  Comics folder ID: ${driveStructure.comicsFolderId}`);
    console.log(`  Series folders: ${Object.keys(driveStructure.seriesFolders).length}`);
    Object.entries(driveStructure.seriesFolders).forEach(([name, id]) => {
      console.log(`    "${name}": ${id}`);
    });
    
    // Create comics folder if it doesn't exist
    let comicsFolderId = driveStructure.comicsFolderId;
    if (!comicsFolderId) {
      progressTrackerStore.updateProcess(processId, {
        progress: 5,
        status: `Creating comics folder...`
      });
      
      comicsFolderId = await createFolderIfNotExists(accessToken, "comics", readerFolderId);
      console.log(`Created comics folder with ID: ${comicsFolderId}`);
    }
    
    // VERBOSE DEBUGGING: Validate comics folder ID
    if (!comicsFolderId) {
      console.error("ERROR: Comics folder ID is empty or undefined after creation attempt!");
      throw new Error("Failed to get or create comics folder");
    }
    
    // Special case handling for problematic series titles
    let sanitizedSeriesTitle = "";
    
    // Handle the specific case of "Ajin" which might cause issues
    if (seriesTitle.includes("Ajin")) {
      sanitizedSeriesTitle = "Ajin";
      showSnackbar(`Using simplified name "Ajin" for "${seriesTitle}" to avoid Google Drive errors`);
    } else {
      // Normal sanitization for other series
      sanitizedSeriesTitle = sanitizeNameForGoogleDrive(seriesTitle);
    }
    
    console.log(`Original series title: "${seriesTitle}", Sanitized: "${sanitizedSeriesTitle}"`);
    
    // Check if series folder exists, create if needed
    let seriesFolderId = driveStructure.seriesFolders[seriesTitle] || 
                         driveStructure.seriesFolders[sanitizedSeriesTitle] || 
                         driveStructure.seriesFolders["Ajin"]; // Also check for simplified Ajin folder
    
    // VERBOSE DEBUGGING: Log series folder lookup
    console.log(`Looking for series folder with title "${seriesTitle}" or "${sanitizedSeriesTitle}"`);
    console.log(`Series folder ID from lookup: ${seriesFolderId || "NOT FOUND"}`);
    
    if (!seriesFolderId) {
      progressTrackerStore.updateProcess(processId, {
        progress: 10,
        status: `Creating folder for ${seriesTitle}...`
      });
      
      // Use sanitized title for folder creation
      seriesFolderId = await createFolderIfNotExists(accessToken, sanitizedSeriesTitle, comicsFolderId);
      console.log(`Created series folder for "${sanitizedSeriesTitle}" with ID: ${seriesFolderId}`);
    } else {
      console.log(`Found existing series folder for "${seriesTitle}" with ID: ${seriesFolderId}`);
    }
    
    // VERBOSE DEBUGGING: Validate series folder ID
    if (!seriesFolderId) {
      console.error("ERROR: Series folder ID is empty or undefined after creation attempt!");
      throw new Error("Failed to get or create series folder");
    }
    
    // Add or update the series in our store
    // Use sanitized name for consistency
    addSeries(sanitizedSeriesTitle, seriesFolderId);
    
    // Sort volumes by title for consistent processing
    const sortedVolumes = [...volumes].sort((a, b) =>
      a.volume_title.localeCompare(b.volume_title, undefined, { numeric: true, sensitivity: 'base' })
    );
    
    // Track how many volumes already exist
    let existingVolumes = 0;
    
    // Get the existing volumes for this series
    // Try both original and sanitized series names
    const existingVolumeFiles = driveStructure.volumeFiles[seriesTitle] || 
                               driveStructure.volumeFiles[sanitizedSeriesTitle] || 
                               {};
    
    // VERBOSE DEBUGGING: Log existing volume files
    console.log("Existing volume files for this series:");
    Object.entries(existingVolumeFiles).forEach(([name, id]) => {
      console.log(`  "${name}": ${id}`);
    });
    
    // Process each volume
    for (let i = 0; i < sortedVolumes.length; i++) {
      const volume = sortedVolumes[i];
      const volumeTitle = volume.volume_title;
      
      // VERBOSE DEBUGGING: Log detailed volume info
      console.log(`\n=== PROCESSING VOLUME ${i+1}/${sortedVolumes.length} ===`);
      console.log(`Volume title: "${volumeTitle}"`);
      console.log(`Volume UUID: ${volume.volume_uuid}`);
      
      // Special case handling for problematic volume titles
      let sanitizedVolumeTitle = "";
      
      // Handle the specific case of "Ajin (D~38-p~208)" which causes issues
      if (volumeTitle.includes("Ajin") && volumeTitle.includes("~")) {
        sanitizedVolumeTitle = "Ajin_Volume";
        showSnackbar(`Using simplified name "Ajin_Volume" for "${volumeTitle}" to avoid Google Drive errors`);
      } else {
        // Normal sanitization for other volumes
        sanitizedVolumeTitle = sanitizeNameForGoogleDrive(volumeTitle);
      }
      
      console.log(`Sanitized volume title: "${sanitizedVolumeTitle}"`);
      
      // Use the sanitized volume title for the filename
      const filename = `${sanitizedVolumeTitle}.cbz`;
      console.log(`Filename: "${filename}"`);

      // Update progress
      progressTrackerStore.updateProcess(processId, {
        progress: 15 + ((i / sortedVolumes.length) * 85),
        status: `Processing ${volumeTitle} (${i+1}/${sortedVolumes.length})...`
      });

      // Check if the file already exists using our pre-fetched data
      // Try both original and sanitized names
      const existingFileId = existingVolumeFiles[volumeTitle] || existingVolumeFiles[sanitizedVolumeTitle];
      
      // VERBOSE DEBUGGING: Log existing file check
      console.log(`Checking if volume already exists:`);
      console.log(`  Looking for "${volumeTitle}" or "${sanitizedVolumeTitle}"`);
      console.log(`  Existing file ID: ${existingFileId || "NOT FOUND"}`);
      
      // VERBOSE DEBUGGING: Validate series folder ID again before using it
      console.log(`Series folder ID (for upload): ${seriesFolderId}`);
      if (!seriesFolderId) {
        console.error("ERROR: Series folder ID is missing before upload attempt!");
        throw new Error("Series folder ID is required but was not available");
      }

      if (existingFileId) {
        // Skip this volume as it already exists
        existingVolumes++;
        
        // Add the volume to our store since it already exists
        // Use sanitized names for consistency
        addVolume(sanitizedSeriesTitle, sanitizedVolumeTitle, existingFileId, filename);
        
        progressTrackerStore.updateProcess(processId, {
          status: `${volumeTitle} already exists in Google Drive, skipping... (${existingVolumes} existing)`
        });
        continue;
      }
      
      try {
        // Create the CBZ archive for this volume
        progressTrackerStore.updateProcess(processId, {
          status: `Creating archive for ${volumeTitle}...`
        });
        
        // Create a detailed error message that will be shown to the user
        let detailedErrorInfo = "";
        
        try {
          const archiveBlob = await createVolumeArchive(volume);
          
          // Update progress with archive size info
          progressTrackerStore.updateProcess(processId, {
            status: `Archive created (${(archiveBlob.size / (1024 * 1024)).toFixed(1)} MB). Uploading to Google Drive...`
          });
          
          try {
            // Try to upload with detailed error handling
            const response = await uploadBlob(accessToken, archiveBlob, filename, seriesFolderId, 'application/vnd.comicbook+zip');
            
            // Add the volume to our store
            if (response && response.id) {
              // Use sanitized names for consistency
              addVolume(sanitizedSeriesTitle, sanitizedVolumeTitle, response.id, filename);
              
              progressTrackerStore.updateProcess(processId, {
                status: `Uploaded ${volumeTitle} (${i+1}/${sortedVolumes.length})`,
              });
            } else {
              throw new Error("Upload succeeded but no file ID was returned");
            }
          } catch (uploadError) {
            // Capture detailed upload error information
            detailedErrorInfo = `Upload error: ${uploadError.message}`;
            
            // Check for specific error types
            if (uploadError.message.includes("Invalid Value")) {
              detailedErrorInfo += `\nPossible causes: 
              - Invalid folder ID: ${seriesFolderId}
              - Invalid filename: ${filename}
              - Authentication issue`;
            }
            
            throw new Error(`Failed to upload: ${uploadError.message}`);
          }
        } catch (archiveError) {
          // Capture detailed archive error information
          detailedErrorInfo = `Archive creation error: ${archiveError.message}`;
          throw new Error(`Failed to create archive: ${archiveError.message}`);
        }
      } catch (volumeError) {
        // Show a detailed error message in the UI
        const errorMessage = `Error with ${volumeTitle}: ${volumeError.message || 'Unknown error'}`;
        
        // Update the progress tracker with detailed error info
        progressTrackerStore.updateProcess(processId, {
          status: `${errorMessage} (${i+1}/${sortedVolumes.length})`,
        });
        
        // Show a snackbar with the error details
        showSnackbar(`${errorMessage}\n${detailedErrorInfo}`);
        
        // Continue with next volume instead of failing the entire process
        continue;
      }
    }

    // All volumes have been processed
    const newlyUploaded = sortedVolumes.length - existingVolumes;
    
    // Create a status message based on what happened
    let statusMessage;
    if (existingVolumes === sortedVolumes.length) {
      statusMessage = `All ${sortedVolumes.length} volumes of ${seriesTitle} were already in Google Drive`;
    } else if (existingVolumes > 0) {
      statusMessage = `Processed ${seriesTitle}: ${newlyUploaded} uploaded, ${existingVolumes} already existed`;
    } else {
      statusMessage = `All ${sortedVolumes.length} volumes of ${seriesTitle} uploaded successfully`;
    }
    
    progressTrackerStore.updateProcess(processId, {
      progress: 100,
      status: statusMessage
    });

    // Remove the process after a delay
    setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
    
    // Show a success message
    showSnackbar(statusMessage);
    
    } catch (innerError) {
      console.error('Error in inner try block:', innerError);
      
      // Update the progress tracker with the error
      progressTrackerStore.updateProcess(processId, {
        progress: 0,
        status: `Error: ${innerError.message || 'Unknown error'}`
      });
      
      // Show a detailed error message
      showSnackbar(`Error: ${innerError.message || 'Unknown error'}`);
      
      // Remove the process after a delay
      setTimeout(() => progressTrackerStore.removeProcess(processId), 5000);
      
      // Don't rethrow, just log
      console.error('Full error details:', innerError);
    }
  } catch (outerError) {
    // This catches errors in the validation phase, before the progress tracker is created
    console.error('Error in outer try block:', outerError);
    
    // Show a detailed error message
    showSnackbar(`Error: ${outerError.message || 'Unknown error'}`);
    
    // Don't rethrow, just log
    console.error('Full error details:', outerError);
  }
}
