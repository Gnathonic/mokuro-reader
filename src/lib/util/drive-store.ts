import { writable, derived } from 'svelte/store';
import type { Writable } from 'svelte/store';
import { driveApiRequest } from './api-helpers';

// Define types for Google Drive data
export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
};

export type DriveFolder = DriveFile & {
  isFolder: true;
};

export type DriveSeries = {
  folderId: string;
  folderName: string;
  volumes: {
    [volumeTitle: string]: {
      fileId: string;
      fileName: string;
      lastModified?: string;
    }
  };
};

export type DriveStoreData = {
  isLoggedIn: boolean;
  accessToken: string;
  readerFolderId: string;
  series: {
    [seriesTitle: string]: DriveSeries
  };
  lastUpdated: number;
};

// Initialize the store with default values
const initialDriveData: DriveStoreData = {
  isLoggedIn: false,
  accessToken: '',
  readerFolderId: '',
  series: {},
  lastUpdated: 0
};

// Try to load only auth data from localStorage, not series data
function loadDriveData(): DriveStoreData {
  try {
    // Only load the token and reader folder ID from localStorage
    const savedToken = localStorage.getItem('gdrive_token');
    const savedReaderFolderId = localStorage.getItem('gdrive_reader_folder_id');

    if (savedToken) {
      return {
        ...initialDriveData,
        isLoggedIn: true,
        accessToken: savedToken,
        readerFolderId: savedReaderFolderId || '',
        lastUpdated: Date.now()
      };
    }
  } catch (error) {
    console.error('Error loading drive auth data from localStorage:', error);
  }

  return initialDriveData;
}

// Create the writable store
const driveStore: Writable<DriveStoreData> = writable(loadDriveData());

// Subscribe to changes and save only auth data to localStorage
driveStore.subscribe((data) => {
  try {
    // Only save the token and reader folder ID to localStorage
    if (data.accessToken) {
      localStorage.setItem('gdrive_token', data.accessToken);
    } else {
      localStorage.removeItem('gdrive_token');
    }

    if (data.readerFolderId) {
      localStorage.setItem('gdrive_reader_folder_id', data.readerFolderId);
    } else {
      localStorage.removeItem('gdrive_reader_folder_id');
    }
  } catch (error) {
    console.error('Error saving drive auth data to localStorage:', error);
  }
});

// Helper functions to update the store
export function setDriveToken(accessToken: string, readerFolderId: string) {
  driveStore.update(data => ({
    ...data,
    isLoggedIn: !!accessToken,
    accessToken,
    readerFolderId,
    lastUpdated: Date.now()
  }));
}

export function clearDriveToken() {
  driveStore.update(data => ({
    ...data,
    isLoggedIn: false,
    accessToken: '',
    series: {}, // Clear series data when logging out
    lastUpdated: Date.now()
  }));
}

/**
 * Fetches all series and volumes data from Google Drive in a single operation
 * and updates the store with the results
 * @param accessToken The Google Drive access token
 * @param readerFolderId The ID of the mokuro-reader folder
 */
export async function fetchAllDriveData(accessToken: string, readerFolderId: string) {
  if (!accessToken || !readerFolderId) {
    console.error('Cannot fetch Drive data: Missing token or folder ID');
    return;
  }

  try {
    // First, find the comics folder
    // Properly escape single quotes in the query by doubling them
    const comicsFolderQuery = `name='comics' and '${readerFolderId.replace(/'/g, "\\'")}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    
    const comicsFolderData = await driveApiRequest(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(comicsFolderQuery)}&fields=files(id,name)`,
      {
        method: 'GET',
        headers: new Headers({ Authorization: 'Bearer ' + accessToken })
      }
    );
    
    // If comics folder doesn't exist yet, return empty data
    if (!comicsFolderData.files || comicsFolderData.files.length === 0) {
      console.log('Comics folder not found in Google Drive');
      driveStore.update(data => ({
        ...data,
        series: {},
        lastUpdated: Date.now()
      }));
      return {};
    }
    
    const comicsFolderId = comicsFolderData.files[0].id;
    
    // Get all folders and CBZ files in a single query
    // This query finds:
    // 1. All folders that are direct children of the comics folder
    // 2. All CBZ files that are in any folder within the comics folder
    // Properly escape single quotes in the query by escaping them
    const safeComicsFolderId = comicsFolderId.replace(/'/g, "\\'");
    const query = `
      ('${safeComicsFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false) or
      ('${safeComicsFolderId}' in ancestors and (mimeType='application/vnd.comicbook+zip' or mimeType='application/zip' or mimeType='application/x-cbz') and trashed=false)
    `;

    const data = await driveApiRequest(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query.trim())}&fields=files(id,name,mimeType,parents)&pageSize=1000`,
      {
        method: 'GET',
        headers: new Headers({ Authorization: 'Bearer ' + accessToken })
      },
      {
        // Use more retries for this important query
        maxRetries: 5,
        // Use longer initial backoff
        initialBackoffMs: 1000
      }
    );
    const files = data.files || [];

    // Separate folders and CBZ files
    const folders = files.filter(file =>
      file.mimeType === 'application/vnd.google-apps.folder' &&
      file.parents && file.parents.includes(comicsFolderId)
    );

    const cbzFiles = files.filter(file =>
      file.mimeType === 'application/vnd.comicbook+zip' ||
      file.mimeType === 'application/zip' ||
      file.mimeType === 'application/x-cbz'
    );

    // Create a map of folder IDs to folder names for quick lookup
    const folderMap = new Map();
    folders.forEach(folder => {
      folderMap.set(folder.id, folder.name);
    });

    // Create the series map
    const seriesMap: { [seriesTitle: string]: DriveSeries } = {};

    // Initialize series entries for all folders
    folders.forEach(folder => {
      seriesMap[folder.name] = {
        folderId: folder.id,
        folderName: folder.name,
        volumes: {}
      };
    });

    // Process all CBZ files and add them to their respective series
    cbzFiles.forEach(file => {
      // Find which folder (series) this file belongs to
      const parentId = file.parents?.[0];
      if (!parentId) return;

      // Get the series name from the folder map
      const seriesTitle = folderMap.get(parentId);
      if (!seriesTitle) return; // Not a direct child of a series folder

      const fileName = file.name;
      const volumeTitle = fileName.replace(/\.cbz$/i, '');

      // Add the volume to its series
      if (seriesMap[seriesTitle]) {
        seriesMap[seriesTitle].volumes[volumeTitle] = {
          fileId: file.id,
          fileName: fileName,
          lastModified: new Date().toISOString()
        };
      }
    });

    // Update the store with all the data at once
    driveStore.update(data => ({
      ...data,
      series: seriesMap,
      lastUpdated: Date.now()
    }));

    return seriesMap;
  } catch (error) {
    console.error('Error fetching Drive data:', error);
    throw error;
  }
}

// These functions now only update the in-memory store, not localStorage
export function addSeries(seriesTitle: string, folderId: string) {
  driveStore.update(data => {
    const updatedSeries = { ...data.series };

    // Create or update the series entry
    updatedSeries[seriesTitle] = {
      folderId,
      folderName: seriesTitle,
      volumes: updatedSeries[seriesTitle]?.volumes || {}
    };

    return {
      ...data,
      series: updatedSeries,
      lastUpdated: Date.now()
    };
  });
}

export function addVolume(seriesTitle: string, volumeTitle: string, fileId: string, fileName: string) {
  driveStore.update(data => {
    const updatedSeries = { ...data.series };

    // Ensure the series exists
    if (!updatedSeries[seriesTitle]) {
      return data; // Series doesn't exist, can't add volume
    }

    // Create or update the volume entry
    const series = { ...updatedSeries[seriesTitle] };
    const volumes = { ...series.volumes };

    volumes[volumeTitle] = {
      fileId,
      fileName,
      lastModified: new Date().toISOString()
    };

    series.volumes = volumes;
    updatedSeries[seriesTitle] = series;

    return {
      ...data,
      series: updatedSeries,
      lastUpdated: Date.now()
    };
  });
}

export function removeSeries(seriesTitle: string) {
  driveStore.update(data => {
    const updatedSeries = { ...data.series };

    // Remove the series
    delete updatedSeries[seriesTitle];

    return {
      ...data,
      series: updatedSeries,
      lastUpdated: Date.now()
    };
  });
}

export function removeVolume(seriesTitle: string, volumeTitle: string) {
  driveStore.update(data => {
    const updatedSeries = { ...data.series };

    // Ensure the series exists
    if (!updatedSeries[seriesTitle]) {
      return data; // Series doesn't exist, nothing to remove
    }

    // Remove the volume
    const series = { ...updatedSeries[seriesTitle] };
    const volumes = { ...series.volumes };

    delete volumes[volumeTitle];

    // If no volumes left, remove the series too
    if (Object.keys(volumes).length === 0) {
      delete updatedSeries[seriesTitle];
    } else {
      series.volumes = volumes;
      updatedSeries[seriesTitle] = series;
    }

    return {
      ...data,
      series: updatedSeries,
      lastUpdated: Date.now()
    };
  });
}

// Derived store to check if a series is fully backed up
export function isSeriesBackedUp(seriesTitle: string, volumeTitles: string[]) {
  return derived(driveStore, ($driveStore) => {
    // Check if the series exists in Drive
    const series = $driveStore.series[seriesTitle];
    if (!series) return false;

    // Check if all volumes are backed up
    return volumeTitles.every(volumeTitle => !!series.volumes[volumeTitle]);
  });
}

// Derived store to check if a specific volume is backed up
export function isVolumeBackedUp(seriesTitle: string, volumeTitle: string) {
  return derived(driveStore, ($driveStore) => {
    // Check if the series and volume exist in Drive
    const series = $driveStore.series[seriesTitle];
    if (!series) return false;

    return !!series.volumes[volumeTitle];
  });
}

// Export the store
export default driveStore;