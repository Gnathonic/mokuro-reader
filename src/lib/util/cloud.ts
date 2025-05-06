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
  // ULTRA VERBOSE DEBUGGING: Log all input parameters with character codes
  console.log("=== UPLOAD BLOB FUNCTION CALLED ===");
  console.log(`Original filename: "${filename}"`);
  console.log("Filename character codes:", Array.from(filename).map(c => `${c} (${c.charCodeAt(0)})`).join(', '));
  
  console.log(`Folder ID: "${folderId}"`);
  console.log("Folder ID character codes:", Array.from(folderId).map(c => `${c} (${c.charCodeAt(0)})`).join(', '));
  
  console.log(`MIME type: "${mimeType}"`);
  console.log(`Blob size: ${blob.size} bytes`);
  console.log(`Blob type: ${blob.type}`);
  
  // Ensure filename is properly sanitized
  const sanitizedFilename = sanitizeNameForGoogleDrive(filename);
  console.log(`Sanitized filename: "${sanitizedFilename}"`);
  console.log("Sanitized filename character codes:", Array.from(sanitizedFilename).map(c => `${c} (${c.charCodeAt(0)})`).join(', '));
  
  // ULTRA VERBOSE DEBUGGING: Validate folder ID
  if (!folderId) {
    console.error("ERROR: Folder ID is empty or undefined!");
    throw new Error("Folder ID is required but was not provided");
  }
  
  if (typeof folderId !== 'string') {
    console.error(`ERROR: Folder ID is not a string! Type: ${typeof folderId}, Value:`, folderId);
    throw new Error(`Folder ID must be a string, got ${typeof folderId}`);
  }
  
  // ULTRA VERBOSE DEBUGGING: Check for invalid characters in folder ID
  const invalidCharInFolderId = Array.from(folderId).find(c => {
    const code = c.charCodeAt(0);
    return code < 32 || code > 126; // Non-printable or non-ASCII
  });
  
  if (invalidCharInFolderId) {
    console.error(`ERROR: Folder ID contains invalid character: ${invalidCharInFolderId} (${invalidCharInFolderId.charCodeAt(0)})`);
    // Try to clean the folder ID
    const cleanFolderId = folderId.replace(/[^\x20-\x7E]/g, '');
    console.error(`Cleaned folder ID: ${cleanFolderId}`);
    // Continue with the cleaned ID
    folderId = cleanFolderId;
  }
  
  // Try a completely different approach - use a simple metadata-only request first
  try {
    // Step 1: Create a metadata-only file entry
    console.log("Step 1: Creating file metadata");
    
    const metadata = {
      name: sanitizedFilename,
      mimeType: mimeType,
      parents: [folderId]
    };
    
    // Log the metadata being sent
    console.log(`Upload metadata: ${JSON.stringify(metadata)}`);
    
    // ULTRA VERBOSE DEBUGGING: Log the full request details
    console.log("Making metadata request to:", 'https://www.googleapis.com/drive/v3/files');
    console.log("Request headers:", {
      'Authorization': 'Bearer [TOKEN REDACTED]',
      'Content-Type': 'application/json; charset=UTF-8'
    });
    
    // ULTRA VERBOSE DEBUGGING: Check for invalid JSON
    try {
      const metadataJson = JSON.stringify(metadata);
      console.log("Request body:", metadataJson);
      
      // Validate the JSON by parsing it back
      JSON.parse(metadataJson);
    } catch (jsonError) {
      console.error("ERROR: Invalid JSON metadata:", jsonError);
      // Try to create a clean version of the metadata
      const cleanMetadata = {
        name: sanitizedFilename.replace(/[^\x20-\x7E]/g, '_'),
        mimeType: mimeType,
        parents: [folderId.replace(/[^\x20-\x7E]/g, '')]
      };
      console.error("Using cleaned metadata:", JSON.stringify(cleanMetadata));
      metadata.name = cleanMetadata.name;
      metadata.parents = cleanMetadata.parents;
    }
    
    // ULTRA VERBOSE DEBUGGING: Try a direct API call with XMLHttpRequest for more detailed error info
    console.log("Making metadata request with XMLHttpRequest for better error details");
    
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://www.googleapis.com/drive/v3/files', false); // Synchronous for debugging
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
    
    try {
      xhr.send(JSON.stringify(metadata));
      console.log(`XHR Status: ${xhr.status} ${xhr.statusText}`);
      console.log(`XHR Response: ${xhr.responseText}`);
    } catch (xhrError) {
      console.error("XHR Error:", xhrError);
    }
    
    const metadataResponse = await fetch(
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
    
    // VERBOSE DEBUGGING: Log the response status and headers
    console.log(`Metadata response status: ${metadataResponse.status} ${metadataResponse.statusText}`);
    console.log("Metadata response headers:");
    metadataResponse.headers.forEach((value, key) => {
      console.log(`  ${key}: ${value}`);
    });
    
    if (!metadataResponse.ok) {
      const errorText = await metadataResponse.text();
      console.error("Failed to create file metadata. Response:", errorText);
      
      // Try to parse the error as JSON for more details
      try {
        const errorJson = JSON.parse(errorText);
        console.error("Parsed error JSON:", errorJson);
        
        if (errorJson.error && errorJson.error.errors) {
          console.error("Detailed errors:", errorJson.error.errors);
          
          // Check for specific error types
          const invalidValueError = errorJson.error.errors.find(e => e.reason === 'invalid');
          if (invalidValueError) {
            console.error("INVALID VALUE ERROR DETAILS:", invalidValueError);
            console.error("Invalid field:", invalidValueError.location);
            console.error("Invalid value:", invalidValueError.locationType);
          }
        }
      } catch (e) {
        console.error("Error response is not valid JSON");
      }
      
      throw new Error(`Failed to create file metadata: ${metadataResponse.status} ${errorText}`);
    }
    
    const fileData = await metadataResponse.json();
    console.log("Metadata response data:", fileData);
    
    const fileId = fileData.id;
    
    if (!fileId) {
      throw new Error("No file ID returned from metadata creation");
    }
    
    console.log(`Created file metadata with ID: ${fileId}`);
    
    // Step 2: Upload the file content
    console.log("Step 2: Uploading file content");
    
    // VERBOSE DEBUGGING: Log the content upload request details
    console.log("Making content upload request to:", `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`);
    console.log("Content upload headers:", {
      'Authorization': 'Bearer [TOKEN REDACTED]',
      'Content-Type': blob.type
    });
    console.log("Content upload body: [BLOB DATA]");
    
    const uploadResponse = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': blob.type
        },
        body: blob
      }
    );
    
    // VERBOSE DEBUGGING: Log the upload response status and headers
    console.log(`Content upload response status: ${uploadResponse.status} ${uploadResponse.statusText}`);
    console.log("Content upload response headers:");
    uploadResponse.headers.forEach((value, key) => {
      console.log(`  ${key}: ${value}`);
    });
    
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error("Failed to upload file content. Response:", errorText);
      
      // Try to parse the error as JSON for more details
      try {
        const errorJson = JSON.parse(errorText);
        console.error("Parsed error JSON:", errorJson);
        
        if (errorJson.error && errorJson.error.errors) {
          console.error("Detailed errors:", errorJson.error.errors);
        }
      } catch (e) {
        console.error("Error response is not valid JSON");
      }
      
      throw new Error(`Failed to upload file content: ${uploadResponse.status} ${errorText}`);
    }
    
    // Parse and return the response
    const result = await uploadResponse.json();
    console.log("Upload successful, file ID:", result.id);
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
    // ULTRA VERBOSE DEBUGGING: Log all input parameters with character codes
    console.log("=== CREATE FOLDER IF NOT EXISTS FUNCTION CALLED ===");
    console.log(`Folder name: "${folderName}"`);
    console.log("Folder name character codes:", Array.from(folderName).map(c => `${c} (${c.charCodeAt(0)})`).join(', '));
    
    console.log(`Parent folder ID: "${parentFolderId}"`);
    console.log("Parent folder ID character codes:", Array.from(parentFolderId).map(c => `${c} (${c.charCodeAt(0)})`).join(', '));
    
    // ULTRA VERBOSE DEBUGGING: Validate parent folder ID
    if (!parentFolderId) {
      console.error("ERROR: Parent folder ID is empty or undefined!");
      throw new Error("Parent folder ID is required but was not provided");
    }
    
    if (typeof parentFolderId !== 'string') {
      console.error(`ERROR: Parent folder ID is not a string! Type: ${typeof parentFolderId}, Value:`, parentFolderId);
      throw new Error(`Parent folder ID must be a string, got ${typeof parentFolderId}`);
    }
    
    // ULTRA VERBOSE DEBUGGING: Check for invalid characters in parent folder ID
    const invalidCharInParentId = Array.from(parentFolderId).find(c => {
      const code = c.charCodeAt(0);
      return code < 32 || code > 126; // Non-printable or non-ASCII
    });
    
    if (invalidCharInParentId) {
      console.error(`ERROR: Parent folder ID contains invalid character: ${invalidCharInParentId} (${invalidCharInParentId.charCodeAt(0)})`);
      // Try to clean the parent folder ID
      const cleanParentId = parentFolderId.replace(/[^\x20-\x7E]/g, '');
      console.error(`Cleaned parent folder ID: ${cleanParentId}`);
      // Continue with the cleaned ID
      parentFolderId = cleanParentId;
    }
    
    // Check if folder already exists
    // Use proper URL parameter encoding for the query
    // We need to properly escape the folder name for the query string
    // The Google Drive API requires single quotes around string literals in queries
    
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
    
    // ULTRA VERBOSE DEBUGGING: Log the query
    console.log("Folder existence query:", query);
    console.log("Full URL:", `https://www.googleapis.com/drive/v3/files?${queryParams.toString()}`);
    
    // Make the API request with the properly encoded query
    const data = await driveApiRequest(
      `https://www.googleapis.com/drive/v3/files?${queryParams.toString()}`,
      {
        method: 'GET',
        headers: new Headers({ Authorization: 'Bearer ' + accessToken })
      }
    );
    
    // ULTRA VERBOSE DEBUGGING: Log the response
    console.log("Folder existence check response:", data);

    if (data.files && data.files.length > 0) {
      console.log(`Found existing folder "${folderName}" with ID ${data.files[0].id}`);
      
      // If multiple folders with the same name exist, log a warning
      if (data.files.length > 1) {
        console.warn(`Multiple folders named "${folderName}" found in parent ${parentFolderId}. Using the first one.`);
        for (let i = 0; i < data.files.length; i++) {
          console.warn(`  ${i+1}. Folder ID: ${data.files[i].id}`);
        }
      }
      
      return data.files[0].id;
    }
    
    console.log(`No existing folder "${folderName}" found, will create a new one.`);

    // Create folder if it doesn't exist
    const metadata = {
      name: folderName, // Use original folder name
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId]
    };
    
    // ULTRA VERBOSE DEBUGGING: Log the metadata
    console.log("Folder creation metadata:", JSON.stringify(metadata));
    
    // ULTRA VERBOSE DEBUGGING: Try a direct API call with XMLHttpRequest for more detailed error info
    console.log("Making folder creation request with XMLHttpRequest for better error details");
    
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://www.googleapis.com/drive/v3/files', false); // Synchronous for debugging
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
    
    try {
      xhr.send(JSON.stringify(metadata));
      console.log(`XHR Status: ${xhr.status} ${xhr.statusText}`);
      console.log(`XHR Response: ${xhr.responseText}`);
      
      // If successful, try to parse the response
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText);
          if (response.id) {
            console.log(`Successfully created folder with ID: ${response.id}`);
            return response.id;
          }
        } catch (e) {
          console.error("Error parsing XHR response:", e);
        }
      }
    } catch (xhrError) {
      console.error("XHR Error:", xhrError);
    }

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

    // For other errors, throw a more descriptive error with detailed information
    console.error('Detailed error creating folder:', error);
    console.error('Folder name:', folderName);
    console.error('Parent folder ID:', parentFolderId);
    
    // Try with an even simpler folder name as a fallback
    try {
      const fallbackName = "Folder_" + Date.now();
      console.log(`Attempting fallback with simple folder name: ${fallbackName}`);
      
      const fallbackMetadata = {
        name: fallbackName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId]
      };
      
      const fallbackData = await driveApiRequest(
        'https://www.googleapis.com/drive/v3/files',
        {
          method: 'POST',
          headers: new Headers({
            'Authorization': 'Bearer ' + accessToken,
            'Content-Type': 'application/json'
          }),
          body: JSON.stringify(fallbackMetadata)
        }
      );
      
      console.log('Successfully created fallback folder:', fallbackData);
      return fallbackData.id;
    } catch (fallbackError) {
      console.error('Even fallback folder creation failed:', fallbackError);
      throw new Error(`Failed to create folder. Original error: ${error.message || 'Unknown error'}. Fallback also failed.`);
    }
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
  // Replace problematic characters with safer alternatives
  return name
    // Replace characters that might cause issues in Google Drive API
    .replace(/[~]/g, '-') // Replace tilde with hyphen
    .replace(/[()[\]{}]/g, '_') // Replace parentheses and brackets with underscore
    .replace(/[<>:"/\\|?*]/g, '_') // Replace other invalid filename chars with underscore
    .replace(/\s+/g, ' ') // Replace multiple spaces with a single space
    .trim(); // Remove leading/trailing whitespace
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
  // VERBOSE DEBUGGING: Log all input parameters
  console.log("=== EXPORT AND UPLOAD VOLUMES FUNCTION CALLED ===");
  console.log(`Number of volumes: ${volumes?.length || 0}`);
  console.log(`Reader folder ID: "${readerFolderId}"`);
  
  if (!volumes || volumes.length === 0) {
    throw new Error('No volumes to export');
  }

  const seriesTitle = volumes[0].series_title;
  console.log(`Series title: "${seriesTitle}"`);
  
  // VERBOSE DEBUGGING: Log all volume titles
  console.log("Volume titles:");
  volumes.forEach((volume, index) => {
    console.log(`  ${index + 1}. "${volume.volume_title}"`);
  });
  
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
    
    const driveStructure = await fetchExistingDriveStructure(accessToken, readerFolderId);
    
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
    
    // Sanitize series title for Google Drive
    // Replace problematic characters with safer alternatives
    const sanitizedSeriesTitle = sanitizeNameForGoogleDrive(seriesTitle);
    console.log(`Original series title: "${seriesTitle}", Sanitized: "${sanitizedSeriesTitle}"`);
    
    // Check if series folder exists, create if needed
    let seriesFolderId = driveStructure.seriesFolders[seriesTitle] || driveStructure.seriesFolders[sanitizedSeriesTitle];
    
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
      
      // Sanitize volume title for Google Drive
      const sanitizedVolumeTitle = sanitizeNameForGoogleDrive(volumeTitle);
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
        
        // VERBOSE DEBUGGING: Log archive creation
        console.log(`Creating archive for volume "${volumeTitle}"...`);
        
        const archiveBlob = await createVolumeArchive(volume);
        
        // VERBOSE DEBUGGING: Log archive creation result
        console.log(`Archive created successfully:`);
        console.log(`  Size: ${archiveBlob.size} bytes`);
        console.log(`  Type: ${archiveBlob.type}`);

        // Upload the archive to Google Drive
        progressTrackerStore.updateProcess(processId, {
          status: `Uploading ${volumeTitle} to Google Drive...`
        });
        
        // VERBOSE DEBUGGING: Log upload attempt
        console.log(`Uploading archive to Google Drive...`);
        console.log(`  Filename: "${filename}"`);
        console.log(`  Series folder ID: ${seriesFolderId}`);
        console.log(`  MIME type: application/vnd.comicbook+zip`);

        const response = await uploadBlob(accessToken, archiveBlob, filename, seriesFolderId, 'application/vnd.comicbook+zip');

        // Add the volume to our store
        if (response && response.id) {
          // Use sanitized names for consistency
          addVolume(sanitizedSeriesTitle, sanitizedVolumeTitle, response.id, filename);
        }

        progressTrackerStore.updateProcess(processId, {
          status: `Uploaded ${volumeTitle} (${i+1}/${sortedVolumes.length})`,
        });
      } catch (volumeError) {
        console.error(`Error processing volume "${volumeTitle}":`, volumeError);
        progressTrackerStore.updateProcess(processId, {
          status: `Error with ${volumeTitle}: ${volumeError.message || 'Unknown error'} (${i+1}/${sortedVolumes.length})`,
        });
        
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
