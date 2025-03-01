<script lang="ts">
  import { processFiles } from '$lib/upload';
  import { parseVolumesFromJson } from '$lib/settings';

  /** @type {string} */
  export let accessToken = '';
  import Loader from '$lib/components/Loader.svelte';
  import { formatBytes, showSnackbar, uploadFile } from '$lib/util';
  import { Button, P, Progressbar } from 'flowbite-svelte';
  import { onMount } from 'svelte';
  import { promptConfirmation } from '$lib/util';
  import { GoogleSolid } from 'flowbite-svelte-icons';
  import { profiles, volumes } from '$lib/settings';
  
  // Helper function to handle errors consistently
  function handleDriveError(error: any, context: string) {
    loadingMessage = '';
    
    // Check if it's a connectivity issue
    const errorMessage = error.toString().toLowerCase();
    const isConnectivityError = 
      errorMessage.includes('network') || 
      errorMessage.includes('connection') || 
      errorMessage.includes('offline') ||
      errorMessage.includes('internet');
    
    if (!isConnectivityError) {
      // Log the user out for non-connectivity errors
      logout();
      showSnackbar(`Error ${context}: ${error.message || 'Unknown error'}`);
    } else {
      showSnackbar('Connection error: Please check your internet connection');
    }
    
    console.error(`${context} error:`, error);
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

  let loadingMessage = '';

  let completed = 0;
  let totalSize = 0;
  let currentFileIndex = 0;
  let totalFiles = 0;
  $: progress = Math.floor((completed / totalSize) * 100).toString();
  $: fileProgress = Math.floor((currentFileIndex / totalFiles) * 100).toString();

  $: if (accessToken) {
    localStorage.setItem('gdrive_token', accessToken);
  }

  async function getFileSize(fileId: string): Promise<number> {
    try {
      const { result } = await gapi.client.drive.files.get({
        fileId: fileId,
        fields: 'size',
        supportsAllDrives: true
      });
      return parseInt(result.size || '0', 10);
    } catch (error) {
      console.error('Error getting file size:', error);
      return 0;
    }
  }

  function xhrDownloadFileId(fileId: string) {
    return new Promise<Blob>(async (resolve, reject) => {
      const { access_token } = gapi.auth.getToken();
      const xhr = new XMLHttpRequest();

      // Get file size before starting download
      const size = await getFileSize(fileId);
      completed = 0;
      totalSize = size;

      // Add supportsAllDrives parameter to support files in shared drives
      xhr.open('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
      xhr.setRequestHeader('Authorization', `Bearer ${access_token}`);
      xhr.responseType = 'blob';

      xhr.onprogress = ({ loaded }) => {
        completed = loaded;
        // Don't reset the loading message here
      };

      xhr.onabort = (event) => {
        console.warn(`xhr ${fileId}: download aborted at ${event.loaded} of ${totalSize}`);
        showSnackbar('Download failed');
        reject(new Error('Download aborted'));
      };

      xhr.onerror = (event) => {
        console.error(`xhr ${fileId}: download error at ${event.loaded} of ${totalSize}`);
        showSnackbar('Download failed');
        reject(new Error('Error downloading file'));
      };

      xhr.onload = () => {
        completed = 0;
        // Don't reset totalSize here
        resolve(xhr.response);
      };

      xhr.ontimeout = (event) => {
        console.warn(`xhr ${fileId}: download timeout after ${event.loaded} of ${totalSize}`);
        showSnackbar('Download timed out');
        reject(new Error('Timeout downloading file'));
      };

      xhr.send();
    });
  }

  export async function connectDrive(resp?: any) {
    if (resp?.error !== undefined) {
      localStorage.removeItem('gdrive_token');
      accessToken = '';
      throw resp;
    }

    accessToken = resp?.access_token;
    loadingMessage = 'Connecting to drive';

    try {
      const { result: readerFolderRes } = await gapi.client.drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${READER_FOLDER}'`,
        fields: 'files(id)'
      });

      if (readerFolderRes.files?.length === 0) {
        const { result: createReaderFolderRes } = await gapi.client.drive.files.create({
          resource: { mimeType: FOLDER_MIME_TYPE, name: READER_FOLDER },
          fields: 'id'
        });

        readerFolderId = createReaderFolderRes.id || '';
      } else {
        const id = readerFolderRes.files?.[0]?.id || '';

        readerFolderId = id || '';
      }

      const { result: volumeDataRes } = await gapi.client.drive.files.list({
        q: `'${readerFolderId}' in parents and name='${VOLUME_DATA_FILE}'`,
        fields: 'files(id, name)'
      });

      if (volumeDataRes.files?.length !== 0) {
        volumeDataId = volumeDataRes.files?.[0].id || '';
      }

      const { result: profilesRes } = await gapi.client.drive.files.list({
        q: `'${readerFolderId}' in parents and name='${PROFILES_FILE}'`,
        fields: 'files(id, name)'
      });

      if (profilesRes.files?.length !== 0) {
        profilesId = profilesRes.files?.[0].id || '';
      }

      loadingMessage = '';

      if (accessToken) {
        showSnackbar('Connected to Google Drive');
      }
    } catch (error) {
      handleDriveError(error, 'connecting to Google Drive');
    }
  }

  function signIn() {
    // Always show the account picker to allow switching accounts
    tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  export function logout() {
    // Remove token from localStorage
    localStorage.removeItem('gdrive_token');
    
    // Clear the token from memory
    accessToken = '';
    
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

        // Try to restore the saved token only after gapi client is initialized
        const savedToken = localStorage.getItem('gdrive_token');
        if (savedToken) {
          try {
            // Set the token in gapi client
            gapi.client.setToken({ access_token: savedToken });
            accessToken = savedToken;
            await connectDrive({ access_token: savedToken });
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
      
    // Create a view for shared drives
    const teamDriveView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes('application/zip,application/x-zip-compressed,application/vnd.comicbook+zip,application/x-cbz')
      .setMode(google.picker.DocsViewMode.LIST)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setEnableTeamDrives(true);
      
    // Create a view for folders in shared drives
    const teamDriveFolderView = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setSelectFolderEnabled(true)
      .setEnableTeamDrives(true);

    const picker = new google.picker.PickerBuilder()
      .addView(docsView)
      .addView(folderView)
      .addView(teamDriveView)
      .addView(teamDriveFolderView)
      .setOAuthToken(accessToken)
      .setAppId(CLIENT_ID)
      .setDeveloperKey(API_KEY)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .enableFeature(google.picker.Feature.SUPPORT_TEAM_DRIVES)
      .setCallback(pickerCallback)
      .build();
    picker.setVisible(true);
  }

  async function listFilesInFolder(folderId) {
    try {
      // First check if this is a shortcut
      try {
        const { result: fileInfo } = await gapi.client.drive.files.get({
          fileId: folderId,
          fields: 'mimeType,shortcutDetails',
          supportsAllDrives: true
        });
        
        // If this is a shortcut to a folder, use the target ID instead
        if (fileInfo.mimeType === 'application/vnd.google-apps.shortcut' && 
            fileInfo.shortcutDetails && 
            fileInfo.shortcutDetails.targetMimeType === 'application/vnd.google-apps.folder') {
          console.log(`Resolving shortcut ${folderId} to target ${fileInfo.shortcutDetails.targetId}`);
          folderId = fileInfo.shortcutDetails.targetId;
        }
      } catch (error) {
        console.warn('Error checking if folder is a shortcut:', error);
        // Continue with original folderId if we can't check
      }
      
      // First try to list files directly
      try {
        const { result } = await gapi.client.drive.files.list({
          q: `'${folderId}' in parents and (mimeType='application/zip' or mimeType='application/x-zip-compressed' or mimeType='application/vnd.comicbook+zip' or mimeType='application/x-cbz' or mimeType='application/vnd.google-apps.folder')`,
          fields: 'files(id, name, mimeType, shortcutDetails)',
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });
        
        // If we got files, return them
        if (result.files && result.files.length > 0) {
          console.log(`Found ${result.files.length} files in folder ${folderId}`);
          return result.files;
        }
      } catch (error) {
        console.warn(`Error listing files in folder ${folderId}:`, error);
        // Continue with alternative approach
      }
      
      // If we didn't get any files or there was an error, try a different approach
      // This is a workaround for Google Drive's handling of shortcuts
      console.log(`No files found directly in folder ${folderId}, trying alternative approach`);
      
      // Try to get all files that have this folder as a parent, including through shortcuts
      const { result: allFilesResult } = await gapi.client.drive.files.list({
        q: `(mimeType='application/zip' or mimeType='application/x-zip-compressed' or mimeType='application/vnd.comicbook+zip' or mimeType='application/x-cbz' or mimeType='application/vnd.google-apps.folder')`,
        fields: 'files(id, name, mimeType, shortcutDetails, parents)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      
      // Filter files that have the target folder as a parent
      const filesInFolder = (allFilesResult.files || []).filter(file => {
        if (!file.parents) return false;
        return file.parents.includes(folderId);
      });
      
      console.log(`Found ${filesInFolder.length} files in folder ${folderId} using alternative approach`);
      return filesInFolder;
    } catch (error) {
      handleDriveError(error, 'listing files in folder');
      return [];
    }
  }

  async function processFolder(folderId, folderName) {
    const files = await listFilesInFolder(folderId);
    const allFiles = [];
    
    // Process each file in the folder
    for (const file of files) {
      // Handle shortcuts to folders
      if (file.mimeType === 'application/vnd.google-apps.shortcut' && 
          file.shortcutDetails && 
          file.shortcutDetails.targetMimeType === 'application/vnd.google-apps.folder') {
        console.log(`Processing shortcut to folder: ${file.name}`);
        // Use the target folder ID for processing
        const subfolderFiles = await processFolder(file.shortcutDetails.targetId, file.name);
        allFiles.push(...subfolderFiles);
      }
      // Handle regular folders
      else if (file.mimeType === 'application/vnd.google-apps.folder') {
        // Recursively process subfolders
        const subfolderFiles = await processFolder(file.id, file.name);
        allFiles.push(...subfolderFiles);
      } 
      // Handle shortcuts to files
      else if (file.mimeType === 'application/vnd.google-apps.shortcut') {
        // Check if the shortcut points to a compatible file
        try {
          const { result: targetFile } = await gapi.client.drive.files.get({
            fileId: file.shortcutDetails.targetId,
            fields: 'id, name, mimeType',
            supportsAllDrives: true
          });
          
          const mimeType = targetFile.mimeType.toLowerCase();
          if (mimeType.includes('zip') || mimeType.includes('cbz')) {
            // Add the target file to the list with the shortcut's name
            allFiles.push({
              id: file.shortcutDetails.targetId,
              name: file.name,
              mimeType: targetFile.mimeType
            });
          }
        } catch (error) {
          console.warn(`Error resolving shortcut ${file.name}:`, error);
        }
      }
      else {
        // Add regular file to the list
        allFiles.push(file);
      }
    }
    
    return allFiles;
  }

  async function downloadAndProcessFiles(fileList: { id: string; name: string; mimeType: string }[]) {
    totalFiles = fileList.length;
    currentFileIndex = 0;
    
    for (const fileInfo of fileList.sort((a, b) => a.name.localeCompare(b.name))) {
      currentFileIndex++;
      loadingMessage = `Downloading file ${currentFileIndex} of ${totalFiles}: ${fileInfo.name}`;
      
      try {
        // Reset progress for each file
        completed = 0;
        totalSize = 0;
        
        const blob = await xhrDownloadFileId(fileInfo.id);
        const file = new File([blob], fileInfo.name);
        processFiles([file]);
      } catch (error) {
        console.error(`Error downloading ${fileInfo.name}:`, error);
        showSnackbar(`Failed to download ${fileInfo.name}`);
      }
    }
    
    loadingMessage = '';
    currentFileIndex = 0;
    totalFiles = 0;
    completed = 0;
    totalSize = 0;
  }

  async function pickerCallback(data: google.picker.ResponseObject) {
    try {
      if (data[google.picker.Response.ACTION] == google.picker.Action.PICKED) {
        const docs = data[google.picker.Response.DOCUMENTS];
        
        if (docs.length === 0) return;
        
        // Collect all files to download
        let allFiles = [];
        
        // First, identify folders, shortcuts, and regular files
        for (const doc of docs) {
          // Check if this is a shortcut to a folder
          if (doc.mimeType === 'application/vnd.google-apps.shortcut') {
            try {
              loadingMessage = `Checking shortcut: ${doc.name}`;
              console.log(`Processing shortcut: ${doc.name} (${doc.id})`);
              
              // Get the shortcut details to determine what it points to
              const { result: shortcutInfo } = await gapi.client.drive.files.get({
                fileId: doc.id,
                fields: 'shortcutDetails',
                supportsAllDrives: true
              });
              
              if (shortcutInfo.shortcutDetails) {
                const targetId = shortcutInfo.shortcutDetails.targetId;
                const targetMimeType = shortcutInfo.shortcutDetails.targetMimeType;
                
                console.log(`Shortcut ${doc.name} points to ${targetId} with type ${targetMimeType}`);
                
                // If it's a shortcut to a folder
                if (targetMimeType === 'application/vnd.google-apps.folder') {
                  loadingMessage = `Scanning folder (via shortcut): ${doc.name}`;
                  console.log(`Processing shortcut to folder: ${doc.name} (${targetId})`);
                  
                  // Try to get the folder directly first
                  try {
                    const { result: folderInfo } = await gapi.client.drive.files.get({
                      fileId: targetId,
                      fields: 'id,name,mimeType',
                      supportsAllDrives: true
                    });
                    
                    console.log(`Successfully retrieved folder info for ${folderInfo.name} (${folderInfo.id})`);
                    
                    // Process the folder
                    const folderFiles = await processFolder(targetId, doc.name);
                    console.log(`Found ${folderFiles.length} files in folder ${doc.name}`);
                    allFiles.push(...folderFiles);
                  } catch (folderError) {
                    console.error(`Error retrieving folder info for ${targetId}:`, folderError);
                    showSnackbar(`Error accessing folder: ${doc.name}`);
                  }
                } 
                // If it's a shortcut to a file
                else {
                  // Check if the target file is a compatible type
                  try {
                    const { result: targetFile } = await gapi.client.drive.files.get({
                      fileId: targetId,
                      fields: 'id, name, mimeType',
                      supportsAllDrives: true
                    });
                    
                    console.log(`Successfully retrieved file info for ${targetFile.name} (${targetFile.id})`);
                    
                    const mimeType = targetFile.mimeType.toLowerCase();
                    if (mimeType.includes('zip') || mimeType.includes('cbz')) {
                      // Add the target file to the list with the shortcut's name
                      allFiles.push({
                        id: targetId,
                        name: doc.name,
                        mimeType: targetFile.mimeType
                      });
                    }
                  } catch (fileError) {
                    console.error(`Error retrieving file info for ${targetId}:`, fileError);
                    showSnackbar(`Error accessing file: ${doc.name}`);
                  }
                }
              } else {
                console.warn(`Shortcut ${doc.name} has no shortcutDetails`);
                showSnackbar(`Invalid shortcut: ${doc.name}`);
              }
            } catch (error) {
              console.warn(`Error processing shortcut ${doc.name}:`, error);
              showSnackbar(`Error processing shortcut: ${doc.name}`);
              // Continue with other files
            }
          }
          // Regular folder
          else if (doc.mimeType === 'application/vnd.google-apps.folder') {
            // Process folder to get all files inside
            loadingMessage = `Scanning folder: ${doc.name}`;
            console.log(`Processing folder: ${doc.name} (${doc.id})`);
            const folderFiles = await processFolder(doc.id, doc.name);
            console.log(`Found ${folderFiles.length} files in folder ${doc.name}`);
            allFiles.push(...folderFiles);
          } else {
            // Add regular file
            console.log(`Adding regular file: ${doc.name} (${doc.id})`);
            allFiles.push(doc);
          }
        }
        
        // Filter out any non-zip files that might have been included in folders
        const filteredFiles = allFiles.filter(file => {
          const mimeType = file.mimeType.toLowerCase();
          return mimeType.includes('zip') || mimeType.includes('cbz');
        });
        
        console.log(`Found ${filteredFiles.length} compatible files out of ${allFiles.length} total files`);
        
        if (filteredFiles.length === 0) {
          showSnackbar('No compatible files found');
          loadingMessage = '';
          return;
        }
        
        // Download and process all files
        await downloadAndProcessFiles(filteredFiles);
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

    loadingMessage = 'Uploading volume data';

    try {
      const res = await uploadFile({
        accessToken,
        fileId: volumeDataId,
        metadata,
        localStorageId: 'volumes',
        type
      });

      volumeDataId = res.id;
      loadingMessage = '';

      if (volumeDataId) {
        showSnackbar('Volume data uploaded');
      }
    } catch (error) {
      handleDriveError(error, 'uploading volume data');
    }
  }

  async function onUploadProfiles() {
    const metadata = {
      mimeType: type,
      name: PROFILES_FILE,
      parents: [profilesId ? null : readerFolderId]
    };

    loadingMessage = 'Uploading profiles';

    try {
      const res = await uploadFile({
        accessToken,
        fileId: profilesId,
        metadata,
        localStorageId: 'profiles',
        type
      });

      profilesId = res.id;
      loadingMessage = '';

      if (profilesId) {
        showSnackbar('Profiles uploaded');
      }
    } catch (error) {
      handleDriveError(error, 'uploading profiles');
    }
  }

  async function onDownloadVolumeData() {
    loadingMessage = 'Downloading volume data';

    try {
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

      loadingMessage = '';
      showSnackbar('Volume data downloaded');
    } catch (error) {
      handleDriveError(error, 'downloading volume data');
    }
  }

  async function onDownloadProfiles() {
    loadingMessage = 'Downloading profiles';

    try {
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

      loadingMessage = '';
      showSnackbar('Profiles downloaded');
    } catch (error) {
      handleDriveError(error, 'downloading profiles');
    }
  }
</script>

<svelte:head>
  <title>Cloud</title>
</svelte:head>

<div class="p-2 h-[90svh]">
  {#if loadingMessage || completed > 0 || totalFiles > 0}
    <Loader>
      {#if totalFiles > 0 && currentFileIndex > 0}
        <P>{loadingMessage}</P>
        <P>File {currentFileIndex} of {totalFiles}</P>
        <Progressbar progress={fileProgress} />
        {#if completed > 0}
          <P class="mt-2">{formatBytes(completed)} / {formatBytes(totalSize)}</P>
          <Progressbar {progress} />
        {/if}
      {:else if completed > 0}
        <P>{formatBytes(completed)} / {formatBytes(totalSize)}</P>
        <Progressbar {progress} />
      {:else}
        {loadingMessage}
      {/if}
    </Loader>
  {:else if accessToken}
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
