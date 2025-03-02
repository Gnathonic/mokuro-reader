import { writable, derived } from 'svelte/store';
import type { Writable } from 'svelte/store';

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

// Try to load data from localStorage
function loadDriveData(): DriveStoreData {
  try {
    const savedData = localStorage.getItem('drive_store');
    if (savedData) {
      const parsedData = JSON.parse(savedData);
      
      // Check if the token is still valid (stored within the last 24 hours)
      const tokenAge = Date.now() - (parsedData.lastUpdated || 0);
      const tokenExpired = tokenAge > 24 * 60 * 60 * 1000; // 24 hours
      
      if (tokenExpired) {
        // Token is expired, clear it
        return {
          ...initialDriveData,
          series: parsedData.series || {} // Keep series data
        };
      }
      
      return {
        ...initialDriveData,
        ...parsedData,
        isLoggedIn: !!parsedData.accessToken
      };
    }
  } catch (error) {
    console.error('Error loading drive data from localStorage:', error);
  }
  
  return initialDriveData;
}

// Create the writable store
const driveStore: Writable<DriveStoreData> = writable(loadDriveData());

// Subscribe to changes and save to localStorage
driveStore.subscribe((data) => {
  try {
    localStorage.setItem('drive_store', JSON.stringify({
      ...data,
      lastUpdated: data.lastUpdated || Date.now()
    }));
  } catch (error) {
    console.error('Error saving drive data to localStorage:', error);
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
    lastUpdated: Date.now()
  }));
}

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