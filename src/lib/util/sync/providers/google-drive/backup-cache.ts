import { writable } from 'svelte/store';
import { driveApiClient } from './api-client';
import { GOOGLE_DRIVE_CONFIG } from './constants';

export interface BackupFileMetadata {
  fileId: string;
  name: string;
  modifiedTime: string;
  path: string; // Constructed path like "series/volume.cbz"
}

class BackupCacheManager {
  private cache = writable<Map<string, BackupFileMetadata>>(new Map());
  private isFetching = false;
  private lastFetchTime: number | null = null;

  get store() {
    return this.cache;
  }

  /**
   * Fetch metadata for ALL .cbz files in the mokuro-reader folder
   * and cache them in memory for the session
   */
  async fetchAllBackups(): Promise<void> {
    if (this.isFetching) {
      console.log('Backup cache fetch already in progress');
      return;
    }

    this.isFetching = true;
    try {
      console.log('Fetching all backup metadata from Google Drive...');

      // Find the mokuro-reader folder
      const folderResponse = await driveApiClient.listFiles(
        `name='${GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER}' and mimeType='${GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER}' and trashed=false`,
        'id, name'
      );

      if (!folderResponse || folderResponse.length === 0) {
        console.log('No mokuro-reader folder found, cache is empty');
        this.cache.set(new Map());
        this.lastFetchTime = Date.now();
        return;
      }

      const appFolderId = folderResponse[0].id;

      // Recursively list all .cbz files in the folder structure
      const allFiles = await this.listAllCbzFiles(appFolderId);

      const cacheMap = new Map<string, BackupFileMetadata>();

      for (const file of allFiles) {
        if (file.path) {
          cacheMap.set(file.path, file);
        }
      }

      console.log(`Cached ${cacheMap.size} backup files`);
      this.cache.set(cacheMap);
      this.lastFetchTime = Date.now();
    } catch (error) {
      console.error('Failed to fetch backup cache:', error);
      // Don't clear cache on error, keep stale data
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Recursively list all .cbz files and build their paths
   */
  private async listAllCbzFiles(
    folderId: string,
    parentPath: string = ''
  ): Promise<BackupFileMetadata[]> {
    const files: BackupFileMetadata[] = [];

    // Get all items in this folder
    const response = await driveApiClient.listFiles(
      `'${folderId}' in parents and trashed=false`,
      'id, name, mimeType, modifiedTime'
    );

    if (!response) return files;

    for (const item of response) {
      // Skip items without required fields
      if (!item.name || !item.id || !item.mimeType || !item.modifiedTime) {
        continue;
      }

      const currentPath = parentPath ? `${parentPath}/${item.name}` : item.name;

      if (item.mimeType === GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER) {
        // Recurse into subfolders
        const subFiles = await this.listAllCbzFiles(item.id, currentPath);
        files.push(...subFiles);
      } else if (item.name.endsWith('.cbz')) {
        files.push({
          fileId: item.id,
          name: item.name,
          modifiedTime: item.modifiedTime,
          path: currentPath
        });
      }
    }

    return files;
  }

  /**
   * Check if a volume is backed up by constructing its expected path
   */
  isBackedUp(seriesTitle: string, volumeTitle: string): boolean {
    let currentCache: Map<string, BackupFileMetadata> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();

    const expectedPath = `${seriesTitle}/${volumeTitle}.cbz`;
    return currentCache.has(expectedPath);
  }

  /**
   * Get backup metadata for a specific volume
   */
  getBackupMetadata(seriesTitle: string, volumeTitle: string): BackupFileMetadata | undefined {
    let currentCache: Map<string, BackupFileMetadata> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();

    const expectedPath = `${seriesTitle}/${volumeTitle}.cbz`;
    return currentCache.get(expectedPath);
  }

  /**
   * Add or update a backup entry in the cache after successful upload
   */
  updateCache(seriesTitle: string, volumeTitle: string, metadata: BackupFileMetadata): void {
    this.cache.update((cache) => {
      const expectedPath = `${seriesTitle}/${volumeTitle}.cbz`;
      const newCache = new Map(cache);
      newCache.set(expectedPath, metadata);
      return newCache;
    });
  }

  /**
   * Clear the entire cache (useful for sign out)
   */
  clearCache(): void {
    this.cache.set(new Map());
    this.lastFetchTime = null;
  }

  /**
   * Get time since last fetch (for debugging/UI)
   */
  getLastFetchTime(): number | null {
    return this.lastFetchTime;
  }
}

export const backupCacheManager = new BackupCacheManager();
