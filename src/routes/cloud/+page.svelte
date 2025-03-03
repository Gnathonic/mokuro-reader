<script lang="ts">
  import { processFiles } from '$lib/upload';
  import { parseVolumesFromJson } from '$lib/settings';

  /** @type {string} */
  export let accessToken = '';
  import { formatBytes, showSnackbar, uploadFile } from '$lib/util';
  import { Button } from 'flowbite-svelte';
  import { onMount } from 'svelte';
  import { promptConfirmation } from '$lib/util';
  import { CloudArrowUpSolid, GoogleSolid } from 'flowbite-svelte-icons';
  import { profiles, volumes } from '$lib/settings';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import { catalog } from '$lib/catalog';
  import { exportAndUploadVolumesToDrive } from '$lib/util/cloud';
  import driveStore, { setDriveToken, clearDriveToken, fetchAllDriveData } from '$lib/util/drive-store';
  import { DriveErrorType } from '$lib/util/api-helpers';
  
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
  let volumeDataId = '';
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
      
      const { result: volumeDataRes } = await gapi.client.drive.files.list({
        q: `'${readerFolderId}' in parents and name='${VOLUME_DATA_FILE}'`,
        fields: 'files(id, name)'
      });

      if (volumeDataRes.files?.length !== 0) {
        volumeDataId = volumeDataRes.files?.[0].id || '';
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
  
  // Function to scan Google Drive for existing series and volumes
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
