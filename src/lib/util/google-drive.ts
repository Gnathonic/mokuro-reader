import { parseVolumesFromJson, volumes } from '$lib/settings';
import { progressTrackerStore } from '$lib/util/progress-tracker';
import { showSnackbar } from '$lib/util/snackbar';
import { uploadFile } from '$lib/util/cloud';
import { writable, get } from 'svelte/store';

// Constants
export const CLIENT_ID = import.meta.env.VITE_GDRIVE_CLIENT_ID;
export const API_KEY = import.meta.env.VITE_GDRIVE_API_KEY;
export const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
export const SCOPES = 'https://www.googleapis.com/auth/drive.file';
export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const READER_FOLDER = 'mokuro-reader';
export const VOLUME_DATA_FILE = 'volume-data.json';
export const PROFILES_FILE = 'profiles.json';
export const FILE_TYPE = 'application/json';

// Stores
export const accessTokenStore = writable<string>('');
export const readerFolderIdStore = writable<string>('');
export const volumeDataIdStore = writable<string>('');
export const profilesIdStore = writable<string>('');
export const tokenClientStore = writable<any>(null);
export const isInitializedStore = writable<boolean>(false);

// Helper function to handle errors consistently
export function handleDriveError(error: any, context: string) {
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

// Initialize Google Drive API
export async function initGoogleDriveApi() {
  if (get(isInitializedStore)) {
    return;
  }

  return new Promise<void>((resolve, reject) => {
    try {
      // Load the Google API client
      gapi.load('client', async () => {
        try {
          await gapi.client.init({
            apiKey: API_KEY,
            discoveryDocs: [DISCOVERY_DOC]
          });

          // Initialize token client
          const tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: (resp: any) => {
              if (resp?.error !== undefined) {
                localStorage.removeItem('gdrive_token');
                accessTokenStore.set('');
                reject(resp);
                return;
              }

              const token = resp?.access_token || '';
              accessTokenStore.set(token);
              localStorage.setItem('gdrive_token', token);
              
              // After successful authentication, connect to Drive
              connectDrive(token)
                .then(() => resolve())
                .catch(reject);
            }
          });
          
          tokenClientStore.set(tokenClient);

          // Try to restore the saved token
          const savedToken = localStorage.getItem('gdrive_token');
          if (savedToken) {
            try {
              // Set the token in gapi client
              gapi.client.setToken({ access_token: savedToken });
              accessTokenStore.set(savedToken);
              
              // Connect to Drive with the saved token
              await connectDrive(savedToken);
              resolve();
            } catch (error) {
              console.error('Failed to restore saved token:', error);
              reject(error);
            }
          } else {
            // No saved token, but API is initialized
            isInitializedStore.set(true);
            resolve();
          }
        } catch (error) {
          handleDriveError(error, 'initializing Google Drive');
          reject(error);
        }
      });

      // Also load the picker API
      gapi.load('picker', () => {});
    } catch (error) {
      console.error('Error loading Google API:', error);
      reject(error);
    }
  });
}

// Connect to Google Drive
export async function connectDrive(token: string) {
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

    let readerFolderId = '';
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
    
    readerFolderIdStore.set(readerFolderId);

    progressTrackerStore.updateProcess(processId, {
      progress: 60,
      status: 'Checking for volume data...'
    });

    const { result: volumeDataRes } = await gapi.client.drive.files.list({
      q: `'${readerFolderId}' in parents and name='${VOLUME_DATA_FILE}'`,
      fields: 'files(id, name)'
    });

    let volumeDataId = '';
    if (volumeDataRes.files?.length !== 0) {
      volumeDataId = volumeDataRes.files?.[0].id || '';
    }
    
    volumeDataIdStore.set(volumeDataId);

    progressTrackerStore.updateProcess(processId, {
      progress: 80,
      status: 'Checking for profiles...'
    });

    const { result: profilesRes } = await gapi.client.drive.files.list({
      q: `'${readerFolderId}' in parents and name='${PROFILES_FILE}'`,
      fields: 'files(id, name)'
    });

    let profilesId = '';
    if (profilesRes.files?.length !== 0) {
      profilesId = profilesRes.files?.[0].id || '';
    }
    
    profilesIdStore.set(profilesId);

    progressTrackerStore.updateProcess(processId, {
      progress: 100,
      status: 'Connected successfully'
    });
    setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);

    if (token) {
      showSnackbar('Connected to Google Drive');
      
      // Check if we need to sync after login
      const syncAfterLogin = localStorage.getItem('sync_after_login');
      if (syncAfterLogin === 'true') {
        // Clear the flag
        localStorage.removeItem('sync_after_login');
        // Perform sync
        setTimeout(() => syncReadProgress(), 500);
      }
    }
    
    isInitializedStore.set(true);
  } catch (error) {
    progressTrackerStore.updateProcess(processId, {
      progress: 0,
      status: 'Connection failed'
    });
    setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
    handleDriveError(error, 'connecting to Google Drive');
    throw error;
  }
}

// Sign in to Google Drive
export function signIn() {
  const tokenClient = get(tokenClientStore);
  if (tokenClient) {
    // Always show the account picker to allow switching accounts
    tokenClient.requestAccessToken({ prompt: 'consent' });
  } else {
    showSnackbar('Google Drive API not initialized');
    // Try to initialize
    initGoogleDriveApi().catch(error => {
      console.error('Failed to initialize Google Drive API:', error);
    });
  }
}

// Log out from Google Drive
export function logout() {
  // Remove token from localStorage
  localStorage.removeItem('gdrive_token');

  // Clear the token from memory
  accessTokenStore.set('');

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
    }).catch((error) => {
      console.error('Error revoking token:', error);
    });
  }
}

// Sync read progress between local storage and Google Drive
export async function syncReadProgress() {
  // If not authenticated, prompt login first
  if (!get(accessTokenStore)) {
    // Store that we want to sync after login
    localStorage.setItem('sync_after_login', 'true');
    signIn();
    return;
  }
  
  // If not initialized, initialize first
  if (!get(isInitializedStore)) {
    try {
      await initGoogleDriveApi();
    } catch (error) {
      console.error('Failed to initialize Google Drive API:', error);
      showSnackbar('Failed to initialize Google Drive API');
      return;
    }
  }

  const processId = 'sync-volume-data';
  progressTrackerStore.addProcess({
    id: processId,
    description: 'Syncing read progress',
    progress: 0,
    status: 'Starting sync...'
  });

  try {
    // Step 1: Download cloud volume data if it exists
    let cloudVolumes = {};
    const volumeDataId = get(volumeDataIdStore);
    
    if (volumeDataId) {
      progressTrackerStore.updateProcess(processId, {
        progress: 20,
        status: 'Downloading cloud data...'
      });

      try {
        const { body } = await gapi.client.drive.files.get({
          fileId: volumeDataId,
          alt: 'media'
        });
        cloudVolumes = parseVolumesFromJson(body);
      } catch (error) {
        console.error('Error downloading cloud volume data:', error);
        // Continue with empty cloud volumes if download fails
      }
    }

    // Step 2: Get local volume data
    progressTrackerStore.updateProcess(processId, {
      progress: 40,
      status: 'Merging data...'
    });

    let localVolumes = {};
    volumes.subscribe(value => {
      localVolumes = { ...value };
    })();

    // Step 3: Merge the data, keeping the newer records based on lastProgressUpdate
    const mergedVolumes = {};
    
    // Process all volume IDs from both sources
    const allVolumeIds = new Set([
      ...Object.keys(localVolumes),
      ...Object.keys(cloudVolumes)
    ]);
    
    allVolumeIds.forEach(volumeId => {
      const localVolume = localVolumes[volumeId];
      const cloudVolume = cloudVolumes[volumeId];
      
      // If volume exists only in one source, use that one
      if (!localVolume) {
        mergedVolumes[volumeId] = cloudVolume;
      } else if (!cloudVolume) {
        mergedVolumes[volumeId] = localVolume;
      } else {
        // Both exist, compare lastProgressUpdate dates
        const localDate = new Date(localVolume.lastProgressUpdate).getTime();
        const cloudDate = new Date(cloudVolume.lastProgressUpdate).getTime();
        
        // Keep the newer record
        mergedVolumes[volumeId] = localDate >= cloudDate ? localVolume : cloudVolume;
      }
    });
    
    // Step 4: Update local volume data with merged data
    progressTrackerStore.updateProcess(processId, {
      progress: 60,
      status: 'Updating local data...'
    });
    
    volumes.update(() => mergedVolumes);
    
    // Step 5: Upload merged data to cloud
    progressTrackerStore.updateProcess(processId, {
      progress: 80,
      status: 'Uploading merged data...'
    });
    
    const metadata = {
      mimeType: FILE_TYPE,
      name: VOLUME_DATA_FILE,
      parents: [volumeDataId ? null : get(readerFolderIdStore)]
    };
    
    const res = await uploadFile({
      accessToken: get(accessTokenStore),
      fileId: volumeDataId,
      metadata,
      localStorageId: 'volumes',
      type: FILE_TYPE
    });
    
    volumeDataIdStore.set(res.id);
    
    progressTrackerStore.updateProcess(processId, {
      progress: 100,
      status: 'Sync complete'
    });
    setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
    
    showSnackbar('Read progress synced successfully');
  } catch (error) {
    progressTrackerStore.updateProcess(processId, {
      progress: 0,
      status: 'Sync failed'
    });
    setTimeout(() => progressTrackerStore.removeProcess(processId), 3000);
    handleDriveError(error, 'syncing read progress');
  }
}