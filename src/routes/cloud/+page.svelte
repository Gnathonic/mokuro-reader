<script lang="ts">
  import { run } from 'svelte/legacy';
  import { processFiles } from '$lib/upload';
  import { parseVolumesFromJson } from '$lib/settings';
  import { formatBytes, showSnackbar, uploadFile, promptConfirmation } from '$lib/util';
  import { Button, Toggle } from 'flowbite-svelte';
  import { onMount } from 'svelte';
  import { CloudArrowUpSolid, GoogleSolid } from 'flowbite-svelte-icons';
  import { profiles, volumes } from '$lib/settings';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import { catalog } from '$lib/catalog';
  import { exportAndUploadVolumesToDrive } from '$lib/util/cloud';
  import driveStore, { setDriveToken, clearDriveToken, fetchAllDriveData } from '$lib/util/drive-store';
  import { DriveErrorType } from '$lib/util/api-helpers';
  import { writable } from 'svelte/store';

  let accessToken = '';
  let volumeDataId = '';
  let autoSyncEnabled = localStorage.getItem('gdrive_auto_sync') === 'true';
  let lastLocalUpdate = 0;
  let syncInProgress = false;
  
  // Create a store for auto sync setting
  const autoSync = writable(autoSyncEnabled);
  
  // Update localStorage when auto sync setting changes
  autoSync.subscribe(value => {
    autoSyncEnabled = value;
    localStorage.setItem('gdrive_auto_sync', value.toString());
  });
  
  // Subscribe to volumes store to detect changes
  volumes.subscribe(value => {
    const currentTime = Date.now();
    
    // Only trigger sync if:
    // 1. Auto sync is enabled
    // 2. We're logged in to Google Drive
    // 3. We have a volume data ID
    // 4. There's been a meaningful time gap since last update (to avoid loops)
    // 5. We're not already syncing
    if (autoSyncEnabled && 
        $driveStore.isLoggedIn && 
        volumeDataId && 
        currentTime - lastLocalUpdate > 2000 &&
        !syncInProgress) {
      
      console.log('Auto sync triggered by local update');
      lastLocalUpdate = currentTime;
      onSyncVolumeData(true); // Pass true to indicate this is an auto sync
    }
  });

  // Helper function to handle errors consistently
  function handleDriveError(error: any, context: string) {
    console.error(`${context} error:`, error);

    // If the error has been processed by our API helpers
    if (error.errorType) {
      switch (error.errorType) {
        case DriveErrorType.AUTH_ERROR:
          // Log the user out for auth errors
          logout();
          showSnackbar(`Authentication error: Please log in again`);
          break;

        case DriveErrorType.CONNECTION_ERROR:
          showSnackbar('Connection error: Please check your internet connection');
          break;

        case DriveErrorType.RATE_LIMIT:
          showSnackbar('Rate limit exceeded: Please try again later');
          break;

        default:
          showSnackbar(`Error ${context}: ${error.message || 'Unknown error'}`);
      }
      return;
    }

    // Legacy error handling for errors not processed by our API helpers
    const errorMessage = error.toString().toLowerCase();
    const isConnectivityError =
      errorMessage.includes('network') ||
      errorMessage.includes('connection') ||
      errorMessage.includes('offline') ||
      errorMessage.includes('internet');

    if (!isConnectivityError) {
      // Only log out for auth-related errors
      if (
        errorMessage.includes('auth') ||
        errorMessage.includes('token') ||
        errorMessage.includes('permission') ||
        errorMessage.includes('access') ||
        errorMessage.includes('unauthorized') ||
        errorMessage.includes('forbidden')
      ) {
        logout();
        showSnackbar(`Authentication error: Please log in again`);
      } else {
        showSnackbar(`Error ${context}: ${error.message || 'Unknown error'}`);
      }
    } else {
      showSnackbar('Connection error: Please check your internet connection');
    }
  }

  const CLIENT_ID = import.meta.env.VITE_GDRIVE_CLIENT_ID;
  const API_KEY = import.meta.env.VITE_GDRIVE_API_KEY;

  const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
  const SCOPES = 'https://www.googleapis.com/auth/drive.file';

  const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
  const READER_FOLDER = 'mokuro-reader';
  const VOLUME_DATA_FILE = 'volume-data.json';
  const PROFILES_FILE = 'profiles.json';

  const type = 'application/json';

  let tokenClient: any;
  let readerFolderId = '';
  // volumeDataId is already declared at the top of the file
  let profilesId = '';
  let backingUp = false;

  // This variable is used to track if we're connected to Google Drive
  // and is used in the UI to show/hide the login button

  $: if (accessToken) {
    localStorage.setItem('gdrive_token', accessToken);
  }

  // Subscribe to the drive store to keep accessToken in sync
  $: if ($driveStore.accessToken && !accessToken) {
    accessToken = $driveStore.accessToken;
  }

  async function onBackupAllSeries() {
    if (!$driveStore.isLoggedIn || !accessToken) {
      showSnackbar('Please connect to Google Drive first');
      return;
    }

    if (!$catalog || $catalog.length === 0) {
      showSnackbar('No series to backup');
      return;
    }

    try {
      backingUp = true;

      // Create a master process for tracking overall progress
      const masterProcessId = `backup-all-series-${Date.now()}`;
      progressTrackerStore.addProcess({
        id: masterProcessId,
        description: `Backing up all series to Google Drive`,
        progress: 0,
        status: `Preparing to backup ${$catalog.length} series...`
      });

      // Process each series one by one
      for (let i = 0; i < $catalog.length; i++) {
        const series = $catalog[i];
        const seriesTitle = series.volumes[0]?.series_title || 'Unknown Series';
        const volumeTitles = series.volumes.map(vol => vol.volume_title);

        // Check if this series is already fully backed up
        // Since we're now fetching data on demand, we need to check the current state
        const isFullyBackedUp = volumeTitles.every(volumeTitle =>
          !!$driveStore.series[seriesTitle]?.volumes[volumeTitle]
        );

        if (isFullyBackedUp) {
          // Skip this series as it's already backed up
          progressTrackerStore.updateProcess(masterProcessId, {
            progress: ((i + 1) / $catalog.length) * 100,
            status: `${seriesTitle} already backed up (${i+1}/${$catalog.length})...`
          });
          continue;
        }

        // Update master progress
        progressTrackerStore.updateProcess(masterProcessId, {
          progress: (i / $catalog.length) * 100,
          status: `Processing ${seriesTitle} (${i+1}/${$catalog.length})...`
        });

        // Export and upload this series
        await exportAndUploadVolumesToDrive(series.volumes, accessToken, readerFolderId);
      }

      // All series have been processed
      progressTrackerStore.updateProcess(masterProcessId, {
        progress: 100,
        status: `All ${$catalog.length} series backed up successfully`
      });

      // Remove the process after a delay
      setTimeout(() => progressTrackerStore.removeProcess(masterProcessId), 3000);

      showSnackbar('All series backed up to Google Drive');
    } catch (error) {
      console.error('Error backing up all series:', error);
      showSnackbar(`Error backing up series: ${error.message || 'Unknown error'}`);
    } finally {
      backingUp = false;
    }
  }

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

  function xhrDownloadFileIdWithTracking(fileId: string, fileName: string, progressCallback: (loaded: number) => void) {
    return new Promise<Blob>(async (resolve, reject) => {
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

      xhr.onerror = (event) => {
        console.error(`xhr ${fileId}: download error at ${event.loaded} of ${size}`);
        showSnackbar('Download failed');
        reject(new Error('Error downloading file'));
      };

      xhr.onload = () => {
        resolve(xhr.response);
      };

      xhr.ontimeout = (event) => {
        console.warn(`xhr ${fileId}: download timeout after ${event.loaded} of ${size}`);
        showSnackbar('Download timed out');
        reject(new Error('Timeout downloading file'));
      };

      xhr.send();
    });
  }

  // Keep this function for backward compatibility with other parts of the code
  function xhrDownloadFileId(fileId: string, fileName: string) {
    return xhrDownloadFileIdWithTracking(fileId, fileName, () => {});
  }

  export async function connectDrive(resp?: any) {
    if (resp?.error !== undefined) {
      localStorage.removeItem('gdrive_token');
      accessToken = '';
      clearDriveToken();
      throw resp;
    }

    accessToken = resp?.access_token;

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

      // Update the drive store with the token and reader folder ID
      setDriveToken(accessToken, readerFolderId);

      progressTrackerStore.updateProcess(processId, {
        progress: 60,
        status: 'Checking for volume data...'
      });

      // Search for volume data files with more detailed fields including modifiedTime
      const { result: volumeDataRes } = await gapi.client.drive.files.list({
        q: `'${readerFolderId}' in parents and name='${VOLUME_DATA_FILE}' and trashed=false`,
        fields: 'files(id, name, modifiedTime, createdTime)',
        orderBy: 'modifiedTime desc'
      });

      console.log('Volume data search results:', volumeDataRes);
      
      if (volumeDataRes.files?.length !== 0) {
        // Use the most recently modified file if multiple exist
        volumeDataId = volumeDataRes.files[0].id;
        console.log('Found volume data file with ID:', volumeDataId);
        
        // If multiple files were found, log a warning
        if (volumeDataRes.files.length > 1) {
          console.warn(`Found ${volumeDataRes.files.length} volume data files. Using the most recent one.`);
          
          // Log all found files for debugging
          volumeDataRes.files.forEach((file, index) => {
            console.log(`File ${index + 1}:`, file);
          });
        }
      } else {
        console.log('No volume data file found in folder:', readerFolderId);
      }

      progressTrackerStore.updateProcess(processId, {
        progress: 70,
        status: 'Checking for profiles...'
      });

      const { result: profilesRes } = await gapi.client.drive.files.list({
        q: `'${readerFolderId}' in parents and name='${PROFILES_FILE}'`,
        fields: 'files(id, name)'
      });

      if (profilesRes.files?.length !== 0) {
        profilesId = profilesRes.files?.[0].id || '';
      }

      // Fetch all series and volumes data in a single operation
      progressTrackerStore.updateProcess(processId, {
        progress: 80,
        status: 'Fetching backed up series data...'
      });

      await fetchAllDriveData(accessToken, readerFolderId);

      progressTrackerStore.updateProcess(processId, {
        progress: 100,
        status: 'Connected successfully'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);

      if (accessToken) {
        showSnackbar('Connected to Google Drive');
        
        // If auto sync is enabled, trigger a sync after connection
        if (autoSyncEnabled && volumeDataId) {
          // Wait a moment to ensure everything is initialized
          setTimeout(() => {
            console.log('Auto sync triggered on page load');
            onSyncVolumeData(true);
          }, 1000);
        }
      }
    } catch (error) {
      progressTrackerStore.updateProcess(processId, {
        progress: 0,
        status: 'Connection failed'
      });
      setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
      handleDriveError(error, 'connecting to Google Drive');
    }
  }

  // Function to sign in to Google Drive
  function signIn() {
    // Always show the account picker to allow switching accounts
    tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  // Function to log out from Google Drive
  function logout() {
    // Remove token from localStorage
    localStorage.removeItem('gdrive_token');

    // Clear the token from memory
    accessToken = '';

    // Clear the token from our store
    clearDriveToken();

    // Revoke the token with Google to ensure account picker shows up next time
    if (gapi.client.getToken()) {
      const token = gapi.client.getToken().access_token;
      // Clear the token from gapi client
      gapi.client.setToken(null);

      // Revoke the token with Google's OAuth service
      fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }).catch(error => {
        console.error('Error revoking token:', error);
      });
    }
  }

  // Function to create a picker for selecting files from Google Drive
  function createPicker() {
    // Create a view for ZIP/CBZ files
    const docsView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes('application/zip,application/x-zip-compressed,application/vnd.comicbook+zip,application/x-cbz')
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

  // Initialize Google Drive API on component mount
  onMount(() => {
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
          callback: connectDrive
        });

        // Try to restore the token from our store or localStorage
        const storedToken = $driveStore.accessToken || localStorage.getItem('gdrive_token');
        if (storedToken) {
          try {
            // Set the token in gapi client
            gapi.client.setToken({ access_token: storedToken });
            accessToken = storedToken;

            // If we have a reader folder ID in the store, use it
            if ($driveStore.readerFolderId) {
              readerFolderId = $driveStore.readerFolderId;

              // Fetch all Drive data to update our backup status
              await fetchAllDriveData(storedToken, readerFolderId);
            }

            await connectDrive({ access_token: storedToken });
          } catch (error) {
            console.error('Failed to restore saved token:', error);
            // Token will be cleared in connectDrive if there's an error
          }
        }
      } catch (error) {
        handleDriveError(error, 'initializing Google Drive');
      }
    });

    gapi.load('picker', () => {});
  });

  // Function to download and process files from Google Drive
  async function downloadAndProcessFiles(fileList: { id: string; name: string; mimeType: string }[], existingProcessId?: string) {
    // Import the worker pool dynamically
    const { WorkerPool } = await import('$lib/util/worker-pool');

    // Use the existing processId if provided, otherwise create a new one
    const overallProcessId = existingProcessId ||
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
      const sizePromises = sortedFiles.map(file => getFileSize(file.id));
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
    const maxWorkers = Math.min(navigator.hardwareConcurrency || 4, 6);
    // Set memory threshold to 500MB to prevent excessive memory usage on mobile devices
    // This is not a hard limit - tasks that individually need more than 500MB can still run
    // It just prevents starting new tasks when the current pool already exceeds 500MB
    const memoryLimitMB = 500; // 500 MB memory threshold
    console.log(`Creating worker pool with ${maxWorkers} workers and ${memoryLimitMB}MB memory threshold`);
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
        progressPercentage = 30 + ((totalLoaded / totalBytesToDownload) * 70);
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
        console.log(`Memory usage: ${(memUsage.current / (1024 * 1024)).toFixed(2)}MB / ${(memUsage.max / (1024 * 1024)).toFixed(2)}MB (${memUsage.percentUsed.toFixed(2)}%)`);

        if (completedFiles + failedFiles === sortedFiles.length) {
          // All files have been processed
          workerPool.terminate();

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

        console.log(`Adding task for ${fileInfo.name} with estimated memory requirement: ${(memoryRequirement / (1024 * 1024)).toFixed(2)}MB`);

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
                dataType: typeof data.data,
                dataSize: data.data.byteLength,
                hasData: !!data.data
              });

              // Create a Blob from the ArrayBuffer
              const blob = new Blob([data.data]);
              console.log(`Created blob of size ${blob.size} bytes`);

              // Create a File object from the blob
              const file = new File([blob], data.fileName);
              console.log(`Created file object: ${file.name}, size: ${file.size} bytes`);

              // Process the file
              await processFiles([file]);
              console.log(`Successfully processed file: ${file.name}`);

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
              releaseMemory()
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

  // Function to list files in a folder
  async function listFilesInFolder(folderId) {
    try {
      const { result } = await gapi.client.drive.files.list({
        q: `'${folderId}' in parents and (mimeType='application/zip' or mimeType='application/x-zip-compressed' or mimeType='application/vnd.comicbook+zip' or mimeType='application/x-cbz' or mimeType='application/vnd.google-apps.folder')`,
        fields: 'files(id, name, mimeType)',
        pageSize: 1000
      });

      return result.files || [];
    } catch (error) {
      handleDriveError(error, 'listing files in folder');
      return [];
    }
  }

  // Function to process a folder recursively
  async function processFolder(folderId, folderName, scanProcessId) {
    const files = await listFilesInFolder(folderId);
    const allFiles = [];

    // Process each file in the folder
    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Update the scan process with subfolder information
      progressTrackerStore.updateProcess(scanProcessId, {
        status: `Scanning ${folderName} (${i+1}/${files.length}): ${file.name}`
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
          allFiles = allFiles.filter(file => {
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


  async function onUploadProfiles() {
    // Only include parents if we're creating a new file
    const metadata = {
      mimeType: type,
      name: PROFILES_FILE
    };
    
    // Only add parents when creating a new file (not updating an existing one)
    if (!profilesId) {
      metadata.parents = [readerFolderId];
    }

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

  async function onSyncVolumeData(isAutoSync = false) {
    // If a sync is already in progress, don't start another one
    if (syncInProgress) {
      return;
    }
    
    syncInProgress = true;
    const processId = isAutoSync ? `auto-sync-volume-data-${Date.now()}` : 'sync-volume-data';
    
    // Only show progress for manual syncs
    if (!isAutoSync) {
      progressTrackerStore.addProcess({
        id: processId,
        description: 'Syncing volume data',
        progress: 0,
        status: 'Starting sync...'
      });
    }
    
    try {
      // If we don't have a volume data ID, try to find it first
      if (!volumeDataId && readerFolderId) {
        console.log('No volumeDataId found, searching for existing volume data files...');
        
        // Search for volume data files
        const { result: volumeDataRes } = await gapi.client.drive.files.list({
          q: `'${readerFolderId}' in parents and name='${VOLUME_DATA_FILE}' and trashed=false`,
          fields: 'files(id, name, modifiedTime, createdTime)',
          orderBy: 'modifiedTime desc'
        });
        
        if (volumeDataRes.files?.length !== 0) {
          if (volumeDataRes.files.length === 1) {
            // If only one file exists, use it
            volumeDataId = volumeDataRes.files[0].id;
            console.log('Found one volume data file with ID:', volumeDataId);
          } else {
            // If multiple files exist, merge them
            console.warn(`Found ${volumeDataRes.files.length} volume data files. Merging them...`);
            
            // Update progress
            progressTrackerStore.updateProcess(processId, {
              progress: 10,
              status: `Merging ${volumeDataRes.files.length} volume data files...`
            });
            
            // Start with an empty merged volumes object
            let mergedVolumes = {};
            
            // Process each file, starting with the oldest (reverse the order)
            const sortedFiles = [...volumeDataRes.files].reverse();
            
            for (let i = 0; i < sortedFiles.length; i++) {
              const file = sortedFiles[i];
              progressTrackerStore.updateProcess(processId, {
                progress: 10 + (i / sortedFiles.length * 10),
                status: `Processing file ${i+1} of ${sortedFiles.length}...`
              });
              
              try {
                // Download the file
                const { body } = await gapi.client.drive.files.get({
                  fileId: file.id,
                  alt: 'media'
                });
                
                // Parse the file contents
                const fileVolumes = parseVolumesFromJson(body);
                
                // Merge with our accumulated volumes
                for (const [id, volume] of Object.entries(fileVolumes)) {
                  if (!mergedVolumes[id]) {
                    // If volume doesn't exist in merged data, add it
                    mergedVolumes[id] = volume;
                  } else {
                    // If volume exists in both, keep the one with the most recent lastUpdated
                    const mergedLastUpdated = new Date(mergedVolumes[id].lastUpdated || 0).getTime();
                    const fileLastUpdated = new Date(volume.lastUpdated || 0).getTime();
                    
                    if (fileLastUpdated > mergedLastUpdated) {
                      mergedVolumes[id] = volume;
                    }
                  }
                }
              } catch (error) {
                console.error(`Error processing file ${file.id}:`, error);
                // Continue with the next file
              }
            }
            
            // Use the most recent file's ID for our update
            volumeDataId = volumeDataRes.files[0].id;
            console.log('Using most recent file ID for update:', volumeDataId);
            
            // Update local volumes with the merged data
            volumes.update(() => mergedVolumes);
            
            // Upload the merged data to the most recent file
            progressTrackerStore.updateProcess(processId, {
              progress: 25,
              status: 'Uploading merged data...'
            });
            
            const metadata = {
              mimeType: type,
              name: VOLUME_DATA_FILE
            };
            
            // Upload the merged data
            await uploadFile({
              accessToken,
              fileId: volumeDataId,
              metadata,
              localStorageId: 'volumes',
              type
            });
            
            // Delete all the old files except the most recent one
            progressTrackerStore.updateProcess(processId, {
              progress: 30,
              status: 'Cleaning up old files...'
            });
            
            for (let i = 1; i < volumeDataRes.files.length; i++) {
              try {
                await gapi.client.drive.files.delete({
                  fileId: volumeDataRes.files[i].id
                });
                console.log(`Deleted old volume data file: ${volumeDataRes.files[i].id}`);
              } catch (error) {
                console.error(`Error deleting file ${volumeDataRes.files[i].id}:`, error);
                // Continue with the next file
              }
            }
            
            console.log('Finished merging and cleaning up volume data files.');
          }
        } else {
          console.log('No existing volume data file found, will create a new one.');
        }
      }
      
      console.log('Starting sync with volumeDataId:', volumeDataId);

      // Step 1: Download volume data if it exists
      progressTrackerStore.updateProcess(processId, {
        progress: 40,
        status: 'Downloading remote data...'
      });

      let remoteVolumes = {};
      
      // Only try to download if the volume data file exists on Drive
      if (volumeDataId) {
        try {
          const { body } = await gapi.client.drive.files.get({
            fileId: volumeDataId,
            alt: 'media'
          });
          
          remoteVolumes = parseVolumesFromJson(body);
        } catch (error) {
          console.error('Error downloading volume data:', error);
          // Continue with empty remote volumes if download fails
        }
      }

      // Step 2: Merge local and remote volume data
      progressTrackerStore.updateProcess(processId, {
        progress: 60,
        status: 'Merging data...'
      });

      // Get current local volumes
      let localVolumes = {};
      volumes.subscribe(value => {
        localVolumes = value;
      })();

      // Create a merged volumes object
      const mergedVolumes = { ...localVolumes };

      // Merge in remote volumes, keeping the most recent version based on lastUpdated
      for (const [id, remoteVolume] of Object.entries(remoteVolumes)) {
        if (!mergedVolumes[id]) {
          // If volume doesn't exist locally, add it
          mergedVolumes[id] = remoteVolume;
        } else {
          // If volume exists in both, keep the one with the most recent lastUpdated
          const localLastUpdated = new Date(mergedVolumes[id].lastUpdated || 0).getTime();
          const remoteLastUpdated = new Date(remoteVolume.lastUpdated || 0).getTime();
          
          if (remoteLastUpdated > localLastUpdated) {
            mergedVolumes[id] = remoteVolume;
          }
        }
      }

      // Step 3: Update local store with merged data
      progressTrackerStore.updateProcess(processId, {
        progress: 75,
        status: 'Updating local data...'
      });

      volumes.update(() => mergedVolumes);

      // Step 4: Upload merged data back to Drive
      progressTrackerStore.updateProcess(processId, {
        progress: 90,
        status: 'Uploading merged data...'
      });

      // Only include parents if we're creating a new file
      const metadata = {
        mimeType: type,
        name: VOLUME_DATA_FILE
      };
      
      // Only add parents when creating a new file (not updating an existing one)
      if (!volumeDataId) {
        metadata.parents = [readerFolderId];
      }

      console.log('Uploading with fileId:', volumeDataId);
      
      const res = await uploadFile({
        accessToken,
        fileId: volumeDataId,
        metadata,
        localStorageId: 'volumes',
        type
      });
      
      console.log('Upload response:', res);
      
      volumeDataId = res.id;
      console.log('Updated volumeDataId:', volumeDataId);

      // Only update progress tracker for manual syncs
      if (!isAutoSync) {
        progressTrackerStore.updateProcess(processId, {
          progress: 100,
          status: 'Sync complete'
        });
        setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
        showSnackbar('Volume data synchronized successfully');
      } else {
        console.log('Auto sync completed successfully');
      }
    } catch (error) {
      // Always show errors, even for auto syncs
      if (!isAutoSync) {
        progressTrackerStore.updateProcess(processId, {
          progress: 0,
          status: 'Sync failed'
        });
        setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
      } else {
        // For auto sync, create a process only on error
        progressTrackerStore.addProcess({
          id: processId,
          description: 'Auto sync failed',
          progress: 0,
          status: 'Error during automatic synchronization'
        });
        setTimeout(() => progressTrackerStore.removeProcess(processId), 5000);
      }
      
      handleDriveError(error, 'syncing volume data');
    } finally {
      // Always reset the sync in progress flag
      syncInProgress = false;
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
        Add your zipped manga files (ZIP or CBZ) to the <span class="text-primary-700">{READER_FOLDER}</span> folder
        in your Google Drive.
      </p>
      <p class="text-center text-sm text-gray-500">
        You can select multiple ZIP/CBZ files or entire folders at once.
      </p>
      <div class="flex flex-col gap-4 w-full max-w-3xl">
        <Button color="blue" on:click={createPicker}>Download Manga</Button>
        <Button color="green" on:click={onBackupAllSeries} disabled={backingUp}>
          <CloudArrowUpSolid class="mr-2 h-5 w-5" />
          {backingUp ? 'Backing up...' : 'Backup All Series to Drive'}
        </Button>
        <div class="flex-col gap-2 flex">
          <Button
            color="dark"
            on:click={() => promptConfirmation('Sync volume data with Google Drive?', () => onSyncVolumeData(false))}
          >
            Sync volume data
          </Button>
          
          <div class="flex items-center gap-2 mt-2">
            <Toggle bind:checked={$autoSync} class="mr-2" />
            <span class="text-sm">Auto sync volume data</span>
          </div>
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
        on:click={signIn}
      >
        <div class="flex sm:flex-row flex-col gap-2 items-center justify-center">
          <GoogleSolid size="lg" />
          <h2 class="text-lg">Connect to Google Drive</h2>
        </div>
      </button>
    </div>
  {/if}
</div>
