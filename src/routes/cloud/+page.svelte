<script lang="ts">
  import { run } from 'svelte/legacy';

  import { processFiles } from '$lib/upload';
  import { parseVolumesFromJson, profiles, volumes } from '$lib/settings';
  import { miscSettings, updateMiscSetting } from '$lib/settings/misc';

  import { promptConfirmation, showSnackbar, uploadFile } from '$lib/util';
  import { Badge, Button, Toggle } from 'flowbite-svelte';
  import { onMount } from 'svelte';
  import { GoogleSolid } from 'flowbite-svelte-icons';
  import { progressTrackerStore } from '$lib/util/progress-tracker';

  interface Props {
    accessToken?: string;
  }

  let { accessToken = $bindable('') }: Props = $props();

  // Helper function to handle errors consistently
  async function handleDriveError(error: any, context: string, retryFn?: () => Promise<any>) {
    // Check if it's a connectivity issue
    const errorMessage = error.toString().toLowerCase();
    const isConnectivityError =
      errorMessage.includes('network') ||
      errorMessage.includes('connection') ||
      errorMessage.includes('offline') ||
      errorMessage.includes('internet');

    // Check if it's a token expiration issue
    const isTokenExpired = 
      errorMessage.includes('invalid_grant') || 
      errorMessage.includes('invalid_token') || 
      errorMessage.includes('unauthorized') || 
      errorMessage.includes('auth') || 
      errorMessage.includes('401');

    if (isTokenExpired && retryFn) {
      console.log('Token expired, attempting to refresh and retry operation');
      try {
        // Use our helper function to refresh the token and retry the operation
        await refreshTokenAndRetry(retryFn);
        return;
      } catch (refreshError) {
        console.error('Failed to refresh token:', refreshError);
        logout();
        showSnackbar(`Error refreshing authentication: ${refreshError.message || 'Unknown error'}`);
      }
    } else if (isConnectivityError) {
      showSnackbar('Connection error: Please check your internet connection');
    } else {
      // Log the user out for other non-connectivity errors
      logout();
      showSnackbar(`Error ${context}: ${error.message || 'Unknown error'}`);
    }

    console.error(`${context} error:`, error);
  }

  const CLIENT_ID = import.meta.env.VITE_GDRIVE_CLIENT_ID;
  const API_KEY = import.meta.env.VITE_GDRIVE_API_KEY;

  const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
  // Use drive.file scope with offline access
  const SCOPES = 'https://www.googleapis.com/auth/drive.file';

  const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
  const READER_FOLDER = 'mokuro-reader';
  const VOLUME_DATA_FILE = 'volume-data.json';
  const PROFILES_FILE = 'profiles.json';

  const type = 'application/json';

  let tokenClient: any;
  let readerFolderId = '';
  let volumeDataId = $state('');
  let profilesId = $state('');

  // This variable is used to track if we're connected to Google Drive
  // and is used in the UI to show/hide the login button

  // We no longer need to store the access token in localStorage
  // as we're only storing the refresh token now

  async function getFileSize(fileId: string): Promise<number> {
    try {
      const { result } = await gapi.client.drive.files.get({
        fileId: fileId,
        fields: 'size'
      });
      return parseInt(result.size || '0', 10);
    } catch (error) {
      console.error('Error getting file size:', error);
      return 0;
    }
  }

  function xhrDownloadFileIdWithTracking(
    fileId: string,
    fileName: string,
    progressCallback: (loaded: number) => void
  ) {
    return new Promise<Blob>(async (resolve, reject) => {
      try {
        const { access_token } = gapi.auth.getToken();
        const xhr = new XMLHttpRequest();

        // Get file size before starting download
        const size = await getFileSize(fileId);

        xhr.open('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
        xhr.setRequestHeader('Authorization', `Bearer ${access_token}`);
        xhr.responseType = 'blob';

        xhr.onprogress = ({ loaded }) => {
          // Call the progress callback with the loaded bytes
          progressCallback(loaded);
        };

        xhr.onabort = (event) => {
          console.warn(`xhr ${fileId}: download aborted at ${event.loaded} of ${size}`);
          showSnackbar('Download failed');
          reject(new Error('Download aborted'));
        };

        xhr.onerror = async (event) => {
          console.error(`xhr ${fileId}: download error at ${event.loaded} of ${size}`);
          
          // Check if this might be an authorization error (401)
          if (xhr.status === 401) {
            console.log('Token expired during download, attempting to refresh');
            try {
              // Use our helper function to refresh the token and retry the download
              const blob = await refreshTokenAndRetry(() => 
                xhrDownloadFileIdWithTracking(fileId, fileName, progressCallback)
              );
              resolve(blob);
              return;
            } catch (refreshError) {
              console.error('Failed to refresh token during download:', refreshError);
              showSnackbar('Authentication error. Please log in again.');
              reject(new Error('Authentication error'));
              return;
            }
          }
          
          showSnackbar('Download failed');
          reject(new Error('Error downloading file'));
        };

        xhr.onload = async () => {
          // Check for HTTP error status codes
          if (xhr.status >= 400) {
            if (xhr.status === 401) {
              // Handle unauthorized error (token expired)
              console.log('Token expired during download (status 401), attempting to refresh');
              
              try {
                // Use our helper function to refresh the token and retry the download
                const blob = await refreshTokenAndRetry(() => 
                  xhrDownloadFileIdWithTracking(fileId, fileName, progressCallback)
                );
                resolve(blob);
                return;
              } catch (refreshError) {
                console.error('Failed to refresh token during download:', refreshError);
                showSnackbar('Authentication error. Please log in again.');
                reject(new Error('Authentication error'));
                return;
              }
            } else {
              reject(new Error(`HTTP error ${xhr.status}`));
              return;
            }
          }
          
          resolve(xhr.response);
        };

        xhr.ontimeout = (event) => {
          console.warn(`xhr ${fileId}: download timeout after ${event.loaded} of ${size}`);
          showSnackbar('Download timed out');
          reject(new Error('Timeout downloading file'));
        };

        xhr.send();
      } catch (error) {
        // Handle any errors that occur during setup
        await handleDriveError(error, 'downloading file', async () => {
          // Retry the download after token refresh
          return xhrDownloadFileIdWithTracking(fileId, fileName, progressCallback);
        });
        reject(error);
      }
    });
  }

  // Keep this function for backward compatibility with other parts of the code
  function xhrDownloadFileId(fileId: string, fileName: string) {
    return xhrDownloadFileIdWithTracking(fileId, fileName, () => {});
  }

  export async function connectDrive(resp?: any) {
    if (resp?.error !== undefined) {
      localStorage.removeItem('gdrive_refresh_token');
      accessToken = '';
      throw resp;
    }

    // Set the access token in memory
    accessToken = resp?.access_token;
    
    // Store the refresh token in localStorage if provided
    if (resp?.refresh_token) {
      localStorage.setItem('gdrive_refresh_token', resp.refresh_token);
      console.log('Refresh token stored');
    }

    const processId = 'connect-drive';
    progressTrackerStore.addProcess({
      id: processId,
      description: 'Connecting to Google Drive',
      progress: 0,
      status: 'Initializing connection...'
    });

    try {
      progressTrackerStore.updateProcess(processId, {
        progress: 20,
        status: 'Checking for reader folder...'
      });

      const { result: readerFolderRes } = await gapi.client.drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${READER_FOLDER}'`,
        fields: 'files(id)'
      });

      if (readerFolderRes.files?.length === 0) {
        progressTrackerStore.updateProcess(processId, {
          progress: 40,
          status: 'Creating reader folder...'
        });

        const { result: createReaderFolderRes } = await gapi.client.drive.files.create({
          resource: { mimeType: FOLDER_MIME_TYPE, name: READER_FOLDER },
          fields: 'id'
        });

        readerFolderId = createReaderFolderRes.id || '';
      } else {
        const id = readerFolderRes.files?.[0]?.id || '';
        readerFolderId = id || '';
      }

      progressTrackerStore.updateProcess(processId, {
        progress: 60,
        status: 'Checking for volume data...'
      });

      const { result: volumeDataRes } = await gapi.client.drive.files.list({
        q: `'${readerFolderId}' in parents and name='${VOLUME_DATA_FILE}'`,
        fields: 'files(id, name)'
      });

      if (volumeDataRes.files?.length !== 0) {
        volumeDataId = volumeDataRes.files?.[0].id || '';
      }

      progressTrackerStore.updateProcess(processId, {
        progress: 80,
        status: 'Checking for profiles...'
      });

      const { result: profilesRes } = await gapi.client.drive.files.list({
        q: `'${readerFolderId}' in parents and name='${PROFILES_FILE}'`,
        fields: 'files(id, name)'
      });

      if (profilesRes.files?.length !== 0) {
        profilesId = profilesRes.files?.[0].id || '';
      }

      progressTrackerStore.updateProcess(processId, {
        progress: 100,
        status: 'Connected successfully'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);

      if (accessToken) {
        showSnackbar('Connected to Google Drive');
      }
    } catch (error) {
      progressTrackerStore.updateProcess(processId, {
        progress: 0,
        status: 'Connection failed'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
      
      // Pass a retry function to handleDriveError
      await handleDriveError(error, 'connecting to Google Drive', async () => {
        return connectDrive({ access_token: accessToken });
      });
    }
  }

  function signIn() {
    // Always show the account picker to allow switching accounts
    // Request offline access to get a refresh token
    tokenClient.requestAccessToken({ 
      prompt: 'consent',
      access_type: 'offline'
    });
  }

  export function logout() {
    // Get refresh token before clearing
    const refreshToken = localStorage.getItem('gdrive_refresh_token');
    
    // Remove refresh token from localStorage
    localStorage.removeItem('gdrive_refresh_token');

    // Clear the access token from memory
    accessToken = '';

    // Revoke the tokens with Google to ensure account picker shows up next time
    if (gapi.client.getToken()) {
      const token = gapi.client.getToken().access_token;
      // Clear the token from gapi client
      gapi.client.setToken(null);

      // Revoke the access token with Google's OAuth service
      fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }).catch((error) => {
        console.error('Error revoking access token:', error);
      });
      
      // Also revoke the refresh token if we have one
      if (refreshToken) {
        fetch(`https://oauth2.googleapis.com/revoke?token=${refreshToken}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }).catch((error) => {
          console.error('Error revoking refresh token:', error);
        });
      }
    }
  }

  // Helper function to refresh token and retry an operation
  async function refreshTokenAndRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      // Request a new token using the refresh token
      const refreshToken = localStorage.getItem('gdrive_refresh_token');
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      console.log('Refreshing token and retrying operation');
      
      // Create a promise that will resolve when the token is refreshed
      const tokenRefreshPromise = new Promise<void>((resolve, reject) => {
        // Store the original callback
        const originalCallback = tokenClient.callback;
        
        // Override the callback temporarily
        tokenClient.callback = (resp) => {
          // Restore the original callback
          tokenClient.callback = originalCallback;
          
          if (resp?.error) {
            reject(new Error(`Token refresh failed: ${resp.error}`));
          } else {
            // Call the original callback to update the token
            if (originalCallback) originalCallback(resp);
            resolve();
          }
        };
        
        // Request a new access token without prompting the user
        tokenClient.requestAccessToken({ prompt: '' });
      });
      
      // Wait for the token to be refreshed
      await tokenRefreshPromise;
      
      // Wait a moment for the token to be applied
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Retry the operation with the new token
      return await operation();
    } catch (error) {
      console.error('Error refreshing token and retrying:', error);
      throw error;
    }
  }
  
  // Function to clear service worker cache for Google Drive downloads
  async function clearServiceWorkerCache() {
    if ('caches' in window) {
      try {
        console.log('Clearing service worker cache for Google Drive downloads...');
        
        // Get all cache keys
        const cacheKeys = await caches.keys();
        console.log('Found caches:', cacheKeys);
        
        for (const cacheName of cacheKeys) {
          const cache = await caches.open(cacheName);
          
          // Get all cache entries
          const requests = await cache.keys();
          console.log(`Cache ${cacheName} has ${requests.length} entries`);
          
          // Filter for Google Drive API requests
          const driveRequests = requests.filter(request => 
            request.url.includes('googleapis.com/drive') || 
            request.url.includes('alt=media')
          );
          
          console.log(`Found ${driveRequests.length} Google Drive API requests in cache ${cacheName}`);
          
          // Delete each Google Drive API request from the cache
          for (const request of driveRequests) {
            console.log(`Deleting cached request: ${request.url}`);
            await cache.delete(request);
          }
        }
        
        console.log('Service worker cache cleared for Google Drive downloads');
      } catch (error) {
        console.error('Error clearing service worker cache:', error);
      }
    }
  }

  onMount(() => {
    // Clear service worker cache for Google Drive downloads
    clearServiceWorkerCache();
    
    gapi.load('client', async () => {
      try {
        await gapi.client.init({
          apiKey: API_KEY,
          discoveryDocs: [DISCOVERY_DOC]
        });

        // Initialize token client after gapi client is ready
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SCOPES,
          callback: connectDrive,
          // Request offline access to get a refresh token
          access_type: 'offline'
        });

        // Try to restore using the refresh token
        const savedRefreshToken = localStorage.getItem('gdrive_refresh_token');
        if (savedRefreshToken) {
          try {
            console.log('Found saved refresh token, requesting new access token');
            // Request a new access token using the refresh token
            // This will call the connectDrive callback with a new access token
            tokenClient.requestAccessToken({ prompt: '' });
          } catch (error) {
            console.error('Failed to use refresh token:', error);
            // If there's an error with the refresh token, we'll need to re-authenticate
            localStorage.removeItem('gdrive_refresh_token');
          }
        }
      } catch (error) {
        await handleDriveError(error, 'initializing Google Drive');
      }
    });

    gapi.load('picker', () => {});
  });

  function createPicker() {
    // Create a view for ZIP/CBZ files
    const docsView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes(
        'application/zip,application/x-zip-compressed,application/vnd.comicbook+zip,application/x-cbz'
      )
      .setMode(google.picker.DocsViewMode.LIST)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setParent(readerFolderId);

    // Create a view specifically for folders
    const folderView = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setSelectFolderEnabled(true)
      .setParent(readerFolderId);

    const picker = new google.picker.PickerBuilder()
      .addView(docsView)
      .addView(folderView)
      .setOAuthToken(accessToken)
      .setAppId(CLIENT_ID)
      .setDeveloperKey(API_KEY)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setCallback(pickerCallback)
      .build();
    picker.setVisible(true);
  }

  async function listFilesInFolder(folderId) {
    try {
      const { result } = await gapi.client.drive.files.list({
        q: `'${folderId}' in parents and (mimeType='application/zip' or mimeType='application/x-zip-compressed' or mimeType='application/vnd.comicbook+zip' or mimeType='application/x-cbz' or mimeType='application/vnd.google-apps.folder')`,
        fields: 'files(id, name, mimeType)',
        pageSize: 1000
      });

      return result.files || [];
    } catch (error) {
      // Check if it's a token expiration issue
      const errorMessage = error.toString().toLowerCase();
      const isTokenExpired = 
        errorMessage.includes('invalid_grant') || 
        errorMessage.includes('invalid_token') || 
        errorMessage.includes('unauthorized') || 
        errorMessage.includes('auth') || 
        errorMessage.includes('401');
      
      if (isTokenExpired) {
        try {
          // Use our helper function to refresh the token and retry the operation
          return await refreshTokenAndRetry(() => listFilesInFolder(folderId));
        } catch (refreshError) {
          console.error('Failed to refresh token:', refreshError);
          await handleDriveError(refreshError, 'refreshing token for listing files');
          return [];
        }
      } else {
        // Handle other types of errors
        await handleDriveError(error, 'listing files in folder');
        return [];
      }
    }
  }

  // Pass the scanProcessId as a parameter
  async function processFolder(folderId, folderName, scanProcessId) {
    const files = await listFilesInFolder(folderId);
    const allFiles = [];

    // Process each file in the folder
    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Update the scan process with subfolder information
      progressTrackerStore.updateProcess(scanProcessId, {
        status: `Scanning ${folderName} (${i + 1}/${files.length}): ${file.name}`
      });

      if (file.mimeType === 'application/vnd.google-apps.folder') {
        // Recursively process subfolders - pass the same scanProcessId
        const subfolderFiles = await processFolder(file.id, file.name, scanProcessId);
        allFiles.push(...subfolderFiles);
      } else {
        // Add file to the list
        allFiles.push(file);
      }
    }

    return allFiles;
  }

  async function downloadAndProcessFiles(
    fileList: { id: string; name: string; mimeType: string }[],
    existingProcessId?: string
  ) {
    // Import the worker pool dynamically
    const { WorkerPool } = await import('$lib/util/worker-pool');

    // Use the existing processId if provided, otherwise create a new one
    const overallProcessId =
      existingProcessId ||
      `download-batch-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Sort files by name
    const sortedFiles = fileList.sort((a, b) => a.name.localeCompare(b.name));

    // First, get the total size of all files to download
    let totalBytesToDownload = 0;
    let fileSizes: { [fileId: string]: number } = {};

    // If we're using a new process ID (not continuing from scanning), create a new tracker
    if (!existingProcessId) {
      progressTrackerStore.addProcess({
        id: overallProcessId,
        description: `Downloading ${sortedFiles.length} files`,
        status: `Calculating total size...`,
        progress: 0,
        bytesLoaded: 0,
        totalBytes: 1 // Temporary value until we know the real total
      });
    } else {
      // Update the existing tracker
      progressTrackerStore.updateProcess(overallProcessId, {
        status: `Calculating total size...`,
        // Keep the progress at 30% (after scanning phase)
        progress: 30
      });
    }

    try {
      // Get file sizes in parallel using Promise.all
      const sizePromises = sortedFiles.map((file) => getFileSize(file.id));
      const sizes = await Promise.all(sizePromises);

      // Store sizes in the map and calculate total
      sortedFiles.forEach((file, index) => {
        const size = sizes[index];
        fileSizes[file.id] = size;
        totalBytesToDownload += size;
      });
    } catch (error) {
      console.error('Error calculating total size:', error);
      // Continue anyway with what we have
    }

    // Update the progress tracker with the total size
    progressTrackerStore.updateProcess(overallProcessId, {
      status: `Preparing to download ${sortedFiles.length} files`,
      totalBytes: totalBytesToDownload,
      bytesLoaded: 0
    });

    // Create a worker pool for parallel downloads
    // Use navigator.hardwareConcurrency to determine optimal number of workers
    // but limit to a reasonable number to avoid overwhelming the browser
    let maxWorkers;
    let memoryLimitMB;
    
    if ($miscSettings.throttleDownloads) {
      // Throttled mode with reasonable limits
      maxWorkers = Math.min(navigator.hardwareConcurrency || 4, 6);
      // Set memory threshold to 500MB to prevent excessive memory usage on mobile devices
      // This is not a hard limit - tasks that individually need more than 500MB can still run
      // It just prevents starting new tasks when the current pool already exceeds 500MB
      memoryLimitMB = 500; // 500 MB memory threshold
      console.log(
        `Throttled downloads: Using ${maxWorkers} workers and ${memoryLimitMB}MB memory threshold`
      );
    } else {
      // Unthrottled mode, use more workers and disable memory limits
      maxWorkers = Math.min(navigator.hardwareConcurrency || 4, 12);
      memoryLimitMB = 100000; // Very high memory limit (100GB) effectively disables the constraint
      console.log(`Unthrottled downloads: Using ${maxWorkers} workers with no memory limit`);
    }
    
    const workerPool = new WorkerPool(undefined, maxWorkers, memoryLimitMB);

    // Track download progress
    const fileProgress: { [fileId: string]: number } = {};
    let completedFiles = 0;
    let failedFiles = 0;
    const processedFiles: { [fileId: string]: boolean } = {};

    // Function to update overall progress
    const updateOverallProgress = () => {
      let totalLoaded = 0;

      // Sum up progress from all files
      for (const fileId in fileProgress) {
        totalLoaded += fileProgress[fileId];
      }

      // Calculate progress percentage
      let progressPercentage;

      if (existingProcessId) {
        // If we're using an existing process ID, scale the download progress to 30-100%
        // Download phase is 30-100% of the total progress
        progressPercentage = 30 + (totalLoaded / totalBytesToDownload) * 70;
      } else {
        // If this is a standalone download, use the full 0-100% range
        progressPercentage = (totalLoaded / totalBytesToDownload) * 100;
      }

      // Update the progress tracker
      progressTrackerStore.updateProcess(overallProcessId, {
        progress: progressPercentage,
        bytesLoaded: totalLoaded,
        status: `Downloaded ${completedFiles} of ${sortedFiles.length} files (${failedFiles} failed)`
      });
    };

    // Create a promise that resolves when all downloads are complete
    return new Promise<void>((resolve) => {
      // Function to check if all downloads are complete
      const checkAllComplete = () => {
        // Log current memory usage
        const memUsage = workerPool.memoryUsage;
        console.log(
          `Memory usage: ${(memUsage.current / (1024 * 1024)).toFixed(2)}MB / ${(memUsage.max / (1024 * 1024)).toFixed(2)}MB (${memUsage.percentUsed.toFixed(2)}%)`
        );

        if (completedFiles + failedFiles === sortedFiles.length) {
          // All files have been processed
          workerPool.terminate();

          // Clear service worker cache to free up storage
          clearServiceWorkerCache().then(() => {
            console.log('Service worker cache cleared after downloads');
          }).catch(error => {
            console.error('Error clearing service worker cache after downloads:', error);
          });

          // Update the process to show completion
          progressTrackerStore.updateProcess(overallProcessId, {
            status: `All downloads complete (${failedFiles} failed)`,
            progress: 100,
            bytesLoaded: totalBytesToDownload
          });

          // Only auto-remove the tracker if it's not part of a larger process
          if (!existingProcessId) {
            setTimeout(() => progressTrackerStore.removeProcess(overallProcessId), 3000);
          }

          resolve();
        }
      };

      // Add each file to the worker pool
      for (const fileInfo of sortedFiles) {
        // Initialize progress for this file
        fileProgress[fileInfo.id] = 0;

        // Create a task for the worker pool
        // Estimate memory requirement based on file size
        // We need memory for:
        // 1. The downloaded file (fileSizes[fileInfo.id])
        // 2. Processing overhead (typically 2-3x the file size for decompression)
        const fileSize = fileSizes[fileInfo.id] || 0;
        const memoryRequirement = Math.max(
          // Estimate memory needed: file size + processing overhead
          // Use at least 50MB as a minimum requirement
          fileSize * 3, // 3x file size for processing overhead
          50 * 1024 * 1024 // Minimum 50MB
        );

        console.log(
          `Adding task for ${fileInfo.name} with estimated memory requirement: ${(memoryRequirement / (1024 * 1024)).toFixed(2)}MB`
        );

        workerPool.addTask({
          id: fileInfo.id,
          memoryRequirement,
          data: {
            fileId: fileInfo.id,
            fileName: fileInfo.name,
            accessToken
          },
          onProgress: (data) => {
            // Update progress for this file
            fileProgress[fileInfo.id] = data.loaded;
            updateOverallProgress();
          },
          onComplete: async (data, releaseMemory) => {
            try {
              console.log(`Received complete message for ${data.fileName}`, {
                entriesCount: data.entries?.length
              });

              console.log(`Processing ${data.entries.length} decompressed entries from ${data.fileName}`);
              
              // Create File objects for each entry
              const files = data.entries.map(entry => {
                return new File([entry.data], entry.filename);
              });
              
              console.log(`Created ${files.length} file objects from decompressed entries`);
              
              // Process all the files
              await processFiles(files);
              console.log(`Successfully processed ${files.length} decompressed files from ${data.fileName}`);

              // Mark as completed
              completedFiles++;
              fileProgress[fileInfo.id] = fileSizes[fileInfo.id] || 0;
              processedFiles[fileInfo.id] = true;

              updateOverallProgress();
              checkAllComplete();
            } catch (error) {
              console.error(`Error processing ${data.fileName}:`, error);
              showSnackbar(`Failed to process ${data.fileName}`);

              // Mark as failed
              failedFiles++;
              processedFiles[fileInfo.id] = true;

              updateOverallProgress();
              checkAllComplete();
            } finally {
              releaseMemory();
            }
          },
          onError: (data) => {
            console.error(`Error downloading ${fileInfo.name}:`, data.error);
            showSnackbar(`Failed to download ${fileInfo.name}`);

            // Mark as failed but count the size as downloaded for progress calculation
            failedFiles++;
            fileProgress[fileInfo.id] = fileSizes[fileInfo.id] || 0;
            processedFiles[fileInfo.id] = true;

            updateOverallProgress();
            checkAllComplete();
          }
        });
      }

      // If there are no files, resolve immediately
      if (sortedFiles.length === 0) {
        progressTrackerStore.updateProcess(overallProcessId, {
          status: 'No files to download',
          progress: 100
        });

        // Only auto-remove the tracker if it's not part of a larger process
        if (!existingProcessId) {
          setTimeout(() => progressTrackerStore.removeProcess(overallProcessId), 3000);
        }

        resolve();
      }
    });
  }

  async function pickerCallback(data: google.picker.ResponseObject) {
    try {
      if (data[google.picker.Response.ACTION] == google.picker.Action.PICKED) {
        const docs = data[google.picker.Response.DOCUMENTS];

        if (docs.length === 0) return;

        // Create a unique ID for this entire process (scanning + downloading)
        const processId = `download-process-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        // Create a single progress tracker for the entire process
        progressTrackerStore.addProcess({
          id: processId,
          description: `Processing ${docs.length} items`,
          progress: 0,
          status: 'Starting scan...'
        });

        // Collect all files to download
        let allFiles = [];

        try {
          // First, identify folders and regular files
          for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];

            // Update progress based on how many items we've processed
            // Scanning phase is 0-30% of the total progress
            const scanProgress = (i / docs.length) * 30;

            if (doc.mimeType === 'application/vnd.google-apps.folder') {
              // Process folder to get all files inside
              progressTrackerStore.updateProcess(processId, {
                progress: scanProgress,
                status: `Scanning folder: ${doc.name}`
              });

              // Pass the processId to processFolder
              const folderFiles = await processFolder(doc.id, doc.name, processId);
              allFiles.push(...folderFiles);
            } else {
              // Add regular file
              allFiles.push(doc);
            }
          }

          // Filter out any non-zip files that might have been included in folders
          allFiles = allFiles.filter((file) => {
            const mimeType = file.mimeType.toLowerCase();
            return mimeType.includes('zip') || mimeType.includes('cbz');
          });

          if (allFiles.length === 0) {
            progressTrackerStore.updateProcess(processId, {
              progress: 100,
              status: 'No compatible files found'
            });
            setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
            showSnackbar('No compatible files found');
            return;
          }

          // Update progress to show we're moving to download phase
          progressTrackerStore.updateProcess(processId, {
            progress: 30,
            status: `Found ${allFiles.length} files to download`
          });

          // Download and process all files - pass the existing processId
          await downloadAndProcessFiles(allFiles, processId);

          // After the entire process is complete, set a timeout to remove the progress tracker
          setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
        } catch (error) {
          // Update the progress tracker to show the error
          progressTrackerStore.updateProcess(processId, {
            progress: 0,
            status: 'Process failed'
          });
          setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
          throw error; // Re-throw to be caught by the outer catch block
        }
      }
    } catch (error) {
      handleDriveError(error, 'processing files');
    }
  }

  async function onUploadVolumeData() {
    const metadata = {
      mimeType: type,
      name: VOLUME_DATA_FILE,
      parents: [volumeDataId ? null : readerFolderId]
    };

    const processId = 'upload-volume-data';
    progressTrackerStore.addProcess({
      id: processId,
      description: 'Uploading volume data',
      progress: 0,
      status: 'Starting upload...'
    });

    try {
      // Update progress to show it's in progress
      progressTrackerStore.updateProcess(processId, {
        progress: 50,
        status: 'Uploading...'
      });

      const res = await uploadFile({
        accessToken,
        fileId: volumeDataId,
        metadata,
        localStorageId: 'volumes',
        type
      });

      volumeDataId = res.id;

      progressTrackerStore.updateProcess(processId, {
        progress: 100,
        status: 'Upload complete'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);

      if (volumeDataId) {
        showSnackbar('Volume data uploaded');
      }
    } catch (error) {
      progressTrackerStore.updateProcess(processId, {
        progress: 0,
        status: 'Upload failed'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
      handleDriveError(error, 'uploading volume data');
    }
  }

  async function onUploadProfiles() {
    const metadata = {
      mimeType: type,
      name: PROFILES_FILE,
      parents: [profilesId ? null : readerFolderId]
    };

    const processId = 'upload-profiles';
    progressTrackerStore.addProcess({
      id: processId,
      description: 'Uploading profiles',
      progress: 0,
      status: 'Starting upload...'
    });

    try {
      // Update progress to show it's in progress
      progressTrackerStore.updateProcess(processId, {
        progress: 50,
        status: 'Uploading...'
      });

      const res = await uploadFile({
        accessToken,
        fileId: profilesId,
        metadata,
        localStorageId: 'profiles',
        type
      });

      profilesId = res.id;

      progressTrackerStore.updateProcess(processId, {
        progress: 100,
        status: 'Upload complete'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);

      if (profilesId) {
        showSnackbar('Profiles uploaded');
      }
    } catch (error) {
      progressTrackerStore.updateProcess(processId, {
        progress: 0,
        status: 'Upload failed'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
      handleDriveError(error, 'uploading profiles');
    }
  }

  async function onDownloadVolumeData() {
    const processId = 'download-volume-data';
    progressTrackerStore.addProcess({
      id: processId,
      description: 'Downloading volume data',
      progress: 0,
      status: 'Starting download...'
    });

    try {
      // Update progress to show it's in progress
      progressTrackerStore.updateProcess(processId, {
        progress: 50,
        status: 'Downloading...'
      });

      const { body } = await gapi.client.drive.files.get({
        fileId: volumeDataId,
        alt: 'media'
      });

      const downloaded = parseVolumesFromJson(body);

      volumes.update((prev) => {
        return {
          ...prev,
          ...downloaded
        };
      });

      progressTrackerStore.updateProcess(processId, {
        progress: 100,
        status: 'Download complete'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);

      showSnackbar('Volume data downloaded');
    } catch (error) {
      progressTrackerStore.updateProcess(processId, {
        progress: 0,
        status: 'Download failed'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
      handleDriveError(error, 'downloading volume data');
    }
  }

  async function onDownloadProfiles() {
    const processId = 'download-profiles';
    progressTrackerStore.addProcess({
      id: processId,
      description: 'Downloading profiles',
      progress: 0,
      status: 'Starting download...'
    });

    try {
      // Update progress to show it's in progress
      progressTrackerStore.updateProcess(processId, {
        progress: 50,
        status: 'Downloading...'
      });

      const { body } = await gapi.client.drive.files.get({
        fileId: profilesId,
        alt: 'media'
      });

      const downloaded = JSON.parse(body);

      profiles.update((prev) => {
        return {
          ...prev,
          ...downloaded
        };
      });

      progressTrackerStore.updateProcess(processId, {
        progress: 100,
        status: 'Download complete'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);

      showSnackbar('Profiles downloaded');
    } catch (error) {
      progressTrackerStore.updateProcess(processId, {
        progress: 0,
        status: 'Download failed'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
      handleDriveError(error, 'downloading profiles');
    }
  }
</script>

<svelte:head>
  <title>Cloud</title>
</svelte:head>

<div class="p-2 h-[90svh]">
  {#if accessToken}
    <div class="flex justify-between items-center gap-6 flex-col">
      <div class="flex justify-between items-center w-full max-w-3xl">
        <h2 class="text-3xl font-semibold text-center pt-2">Google Drive:</h2>
        <Button color="red" on:click={logout}>Log out</Button>
      </div>
      <p class="text-center">
        Add your zipped manga files (ZIP or CBZ) to the <span class="text-primary-700"
          >{READER_FOLDER}</span
        > folder in your Google Drive.
      </p>
      <p class="text-center text-sm text-gray-500">
        You can select multiple ZIP/CBZ files or entire folders at once.
      </p>
      <div class="flex flex-col gap-4 w-full max-w-3xl">
        <Button color="blue" on:click={createPicker}>Download Manga</Button>
        
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <Toggle 
              size="small" 
              checked={$miscSettings.throttleDownloads} 
              on:change={() => updateMiscSetting('throttleDownloads', !$miscSettings.throttleDownloads)}
            >
              <span class="flex items-center gap-2">
                Throttle downloads for stability
              </span>
            </Toggle>
          </div>
          <p class="text-xs text-gray-500 ml-1">
            Helps prevent crashes on low memory devices or for extremely large downloads.
          </p>
        </div>
        
        <div class="flex-col gap-2 flex">
          <Button
            color="dark"
            on:click={() => promptConfirmation('Upload volume data?', onUploadVolumeData)}
          >
            Upload volume data
          </Button>
          {#if volumeDataId}
            <Button
              color="alternative"
              on:click={() =>
                promptConfirmation('Download and overwrite volume data?', onDownloadVolumeData)}
            >
              Download volume data
            </Button>
          {/if}
        </div>
        <div class="flex-col gap-2 flex">
          <Button
            color="dark"
            on:click={() => promptConfirmation('Upload profiles?', onUploadProfiles)}
          >
            Upload profiles
          </Button>
          {#if profilesId}
            <Button
              color="alternative"
              on:click={() =>
                promptConfirmation('Download and overwrite profiles?', onDownloadProfiles)}
            >
              Download profiles
            </Button>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <div class="flex justify-center pt-0 sm:pt-32">
      <button
        class="w-full border rounded-lg border-slate-600 p-10 border-opacity-50 hover:bg-slate-800 max-w-3xl"
        onclick={signIn}
      >
        <div class="flex sm:flex-row flex-col gap-2 items-center justify-center">
          <GoogleSolid size="lg" />
          <h2 class="text-lg">Connect to Google Drive</h2>
        </div>
      </button>
    </div>
  {/if}
</div>
