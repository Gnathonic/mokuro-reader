import { writable, derived } from 'svelte/store';
import { driveApiClient } from './api-client';
import { GOOGLE_DRIVE_CONFIG } from './constants';
import { unifiedCloudManager } from '../../unified-cloud-manager';
import type { CloudCache } from '../../cloud-cache-interface';
import type { DriveFileMetadata } from '../../provider-interface';

// Re-export for convenience
export type { DriveFileMetadata };

/**
 * In-memory representation of Google Drive's mokuro-reader folder state
 *
 * This cache mirrors the state of ALL .cbz files in Google Drive, serving two purposes:
 * 1. Detect backup status by checking if local volume paths exist in Drive (path collision check)
 * 2. Discover remote-only files for download placeholders (future feature)
 *
 * The cache is populated with a single bulk API call and lives only for the session.
 * It does NOT track local files - only what exists in Google Drive.
 *
 * Implements CloudCache interface for multi-provider architecture compatibility.
 */
class DriveFilesCacheManager implements CloudCache<DriveFileMetadata> {
  private cache = writable<Map<string, DriveFileMetadata[]>>(new Map());
  private isFetchingStore = writable<boolean>(false);
  private cacheLoadedStore = writable<boolean>(false);
  private fetchingFlag = false;
  private lastFetchTime: number | null = null;
  private readerFolderId: string | null = null;
  private fetchPromise: Promise<void> | null = null;

  get store() {
    // Return Map grouped by series for efficient series-based operations
    return this.cache;
  }

  get isFetchingState() {
    return this.isFetchingStore;
  }

  get cacheLoaded() {
    return this.cacheLoadedStore;
  }

  getVolumeDataFileId(): string | null {
    const files = this.getVolumeDataFiles();
    return files.length > 0 ? files[0].fileId : null;
  }

  getVolumeDataFiles(): DriveFileMetadata[] {
    let currentCache: Map<string, DriveFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();

    return currentCache.get(GOOGLE_DRIVE_CONFIG.FILE_NAMES.VOLUME_DATA) || [];
  }

  /**
   * Fetch metadata for ALL .cbz files in the mokuro-reader folder
   * and cache them in memory for the session
   */
  async fetchAllFiles(): Promise<void> {
    if (this.fetchingFlag) {
      console.log('Drive files cache fetch already in progress');
      // Return existing promise to allow callers to wait
      if (this.fetchPromise) {
        return this.fetchPromise;
      }
      return;
    }

    this.fetchingFlag = true;
    this.isFetchingStore.set(true);

    // Create promise for this fetch operation
    this.fetchPromise = (async () => {
      try {
        console.log('Fetching all Drive file metadata...');

        // Get only files owned by the user (guarantees edit permissions)
        // This filters out viewer-only shared files while keeping shared files with edit access that user owns
        const allItems = await driveApiClient.listFiles(
          `'me' in owners and trashed=false`,
          'files(id,name,mimeType,modifiedTime,size,parents,description)'
        );
        console.log('Found items:', allItems);

        // Count by file type
        const typeCounts: Record<string, number> = {};
        const cbzFiles: any[] = [];
        const volumeDataFiles: any[] = [];
        const profilesFiles: any[] = [];
        const folderNames = new Map<string, string>();
        const foundFolderNames: string[] = [];

        for (const item of allItems) {
          const ext =
            item.name && item.name.includes('.')
              ? item.name.split('.').pop() || 'no-extension'
              : 'no-extension';
          typeCounts[ext] = (typeCounts[ext] || 0) + 1;

          if (item.mimeType === GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER) {
            folderNames.set(item.id, item.name);
            foundFolderNames.push(item.name);

            // Capture mokuro-reader folder ID
            if (item.name === GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER) {
              this.readerFolderId = item.id;
              console.log('Found mokuro-reader folder ID:', item.id);
            }
          } else if (item.name.endsWith('.cbz')) {
            cbzFiles.push(item);
          } else if (item.name === GOOGLE_DRIVE_CONFIG.FILE_NAMES.VOLUME_DATA) {
            volumeDataFiles.push(item);
          } else if (item.name === GOOGLE_DRIVE_CONFIG.FILE_NAMES.PROFILES) {
            profilesFiles.push(item);
          }
        }

        // Log warning if duplicates found
        if (volumeDataFiles.length > 1) {
          console.warn(
            `Found ${volumeDataFiles.length} volume-data.json files - duplicates will be merged and cleaned up during sync`
          );
        }

        console.log('File type counts:', typeCounts);
        console.log(`Found ${cbzFiles.length} .cbz files and ${folderNames.size} folders`);
        console.log('Folder names:', foundFolderNames);

        // Build cache from files using the folder map
        // Group by series title (folder name) for efficient series-based operations
        const cacheMap = new Map<string, DriveFileMetadata[]>();

        // Add .cbz files (group by series title)
        for (const file of cbzFiles) {
          const parentId = file.parents?.[0];
          const parentName = parentId ? folderNames.get(parentId) : null;

          if (parentName) {
            const path = `${parentName}/${file.name}`;
            const metadata: DriveFileMetadata = {
              provider: 'google-drive',
              fileId: file.id,
              name: file.name,
              modifiedTime: file.modifiedTime || new Date().toISOString(),
              size: file.size ? parseInt(file.size) : 0,
              path: path,
              description: file.description,
              parentId: parentId
            };

            // Group by series title (parentName) instead of full path
            const existing = cacheMap.get(parentName);
            if (existing) {
              existing.push(metadata);
            } else {
              cacheMap.set(parentName, [metadata]);
            }
          }
        }

        // Add volume-data.json files as an array
        if (volumeDataFiles.length > 0) {
          const volumeDataMetadata = volumeDataFiles.map((file) => {
            console.log('Volume data file from API:', file);
            const metadata: DriveFileMetadata = {
              provider: 'google-drive',
              fileId: file.id,
              name: file.name,
              modifiedTime: file.modifiedTime || new Date().toISOString(),
              size: file.size ? parseInt(file.size) : 0,
              path: file.name
            };
            return metadata;
          });

          console.log('Cached volume data metadata:', volumeDataMetadata);
          cacheMap.set(GOOGLE_DRIVE_CONFIG.FILE_NAMES.VOLUME_DATA, volumeDataMetadata);
        }

        // Add profiles.json files as an array
        if (profilesFiles.length > 0) {
          const profilesMetadata = profilesFiles.map((file) => {
            console.log('Profiles file from API:', file);
            const metadata: DriveFileMetadata = {
              provider: 'google-drive',
              fileId: file.id,
              name: file.name,
              modifiedTime: file.modifiedTime || new Date().toISOString(),
              size: file.size ? parseInt(file.size) : 0,
              path: file.name
            };
            return metadata;
          });

          console.log('Cached profiles metadata:', profilesMetadata);
          cacheMap.set(GOOGLE_DRIVE_CONFIG.FILE_NAMES.PROFILES, profilesMetadata);
        }

        console.log(
          `Cached ${cbzFiles.length} .cbz files, ${volumeDataFiles.length} volume-data.json file(s), and ${profilesFiles.length} profiles.json file(s)`
        );
        this.cache.set(cacheMap);
        this.lastFetchTime = Date.now();
        this.cacheLoadedStore.set(true);
      } catch (error) {
        console.error('Failed to fetch Drive files cache:', error);
        console.error('Error details:', error);
        if (error instanceof Error) {
          console.error('Error message:', error.message);
          console.error('Error stack:', error.stack);
        }
        // Don't clear cache on error, keep stale data
      } finally {
        this.fetchingFlag = false;
        this.isFetchingStore.set(false);
        this.fetchPromise = null;

        // Check if sync was requested after login (do this in finally to ensure fetch is complete)
        const shouldSync =
          typeof window !== 'undefined' &&
          localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.SYNC_AFTER_LOGIN) === 'true';

        if (shouldSync) {
          console.log('Cache loaded, triggering requested sync...');
          localStorage.removeItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.SYNC_AFTER_LOGIN);

          unifiedCloudManager
            .syncProgress({ silent: false })
            .catch((err: Error) => console.error('Sync after login failed:', err));
        }
      }
    })();

    return this.fetchPromise;
  }

  /**
   * Get the mokuro-reader folder ID from cache
   * Waits for ongoing fetch if needed
   * Returns null if folder doesn't exist (needs to be created)
   */
  async getReaderFolderId(): Promise<string | null> {
    // If we have the folder ID cached, return it immediately
    if (this.readerFolderId) {
      return this.readerFolderId;
    }

    // If a fetch is in progress, wait for it to complete
    if (this.fetchPromise) {
      console.log('Waiting for cache fetch to complete...');
      await this.fetchPromise;
      return this.readerFolderId;
    }

    // Cache is loaded but no folder found - it needs to be created
    return null;
  }

  /**
   * Set the reader folder ID in cache (after creating the folder)
   */
  setReaderFolderId(folderId: string): void {
    this.readerFolderId = folderId;
  }

  /**
   * Recursively list all .cbz files and build their paths
   */
  private async listAllCbzFiles(
    folderId: string,
    parentPath: string = ''
  ): Promise<DriveFileMetadata[]> {
    const files: DriveFileMetadata[] = [];

    // Get all items in this folder
    const response = await driveApiClient.listFiles(
      `'${folderId}' in parents and trashed=false`,
      'id, name, mimeType, modifiedTime, size'
    );

    if (!response) return files;

    for (const item of response) {
      const currentPath = parentPath ? `${parentPath}/${item.name}` : item.name;

      if (item.mimeType === GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER) {
        // Recurse into subfolders
        const subFiles = await this.listAllCbzFiles(item.id, currentPath);
        files.push(...subFiles);
      } else if (item.name.endsWith('.cbz')) {
        files.push({
          provider: 'google-drive',
          fileId: item.id,
          name: item.name,
          modifiedTime: item.modifiedTime || new Date().toISOString(),
          size: item.size ? parseInt(item.size) : 0,
          path: currentPath
        });
      }
    }

    return files;
  }

  /**
   * Check if a file exists in Google Drive by path (parent/filename)
   * Used to determine if a local volume is already backed up
   */
  existsInDrive(seriesTitle: string, volumeTitle: string): boolean {
    let currentCache: Map<string, DriveFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();

    const path = `${seriesTitle}/${volumeTitle}.cbz`;
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.some((f) => f.path === path) || false;
  }

  /**
   * Get Drive file metadata by path (parent/filename)
   * Returns first file if there are duplicates
   */
  getDriveFile(seriesTitle: string, volumeTitle: string): DriveFileMetadata | undefined {
    let currentCache: Map<string, DriveFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();

    const path = `${seriesTitle}/${volumeTitle}.cbz`;
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.find((f) => f.path === path);
  }

  /**
   * Get ALL Drive file metadata by path (parent/filename)
   * Returns array of all files with this path (handles duplicates)
   */
  getDriveFiles(seriesTitle: string, volumeTitle: string): DriveFileMetadata[] {
    let currentCache: Map<string, DriveFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();

    const path = `${seriesTitle}/${volumeTitle}.cbz`;
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.filter((f) => f.path === path) || [];
  }

  /**
   * Get all files that exist in Drive
   * Future use: Discover remote-only volumes for download placeholders
   */
  getAllDriveFiles(): DriveFileMetadata[] {
    let currentCache: Map<string, DriveFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();

    const result: DriveFileMetadata[] = [];
    for (const files of currentCache.values()) {
      result.push(...files);
    }
    return result;
  }

  /**
   * Get all Drive files for a specific series
   * Future use: Show remote-only volumes in series view
   */
  getDriveFilesBySeries(seriesTitle: string): DriveFileMetadata[] {
    let currentCache: Map<string, DriveFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();

    // With series-grouped cache, just get the series directly (O(1) lookup)
    return currentCache.get(seriesTitle) || [];
  }

  /**
   * Add or update the Drive state after successful upload
   */
  addDriveFile(seriesTitle: string, volumeTitle: string, metadata: DriveFileMetadata): void {
    this.cache.update((cache) => {
      const newCache = new Map(cache);
      // Group by series title instead of full path
      const existing = newCache.get(seriesTitle);

      if (existing) {
        // Check if this file ID already exists, replace it
        const index = existing.findIndex((f) => f.fileId === metadata.fileId);
        if (index >= 0) {
          existing[index] = metadata;
        } else {
          existing.push(metadata);
        }
      } else {
        newCache.set(seriesTitle, [metadata]);
      }

      return newCache;
    });
  }

  /**
   * Remove specific file from cache by file ID
   */
  removeDriveFileById(fileId: string): void {
    this.cache.update((cache) => {
      const newCache = new Map(cache);

      for (const [path, files] of newCache.entries()) {
        const filtered = files.filter((f) => f.fileId !== fileId);
        if (filtered.length === 0) {
          newCache.delete(path);
        } else if (filtered.length !== files.length) {
          newCache.set(path, filtered);
        }
      }

      return newCache;
    });
  }

  /**
   * Remove from cache after deletion from Drive (removes all files with this path)
   */
  removeDriveFile(seriesTitle: string, volumeTitle: string): void {
    this.cache.update((cache) => {
      const path = `${seriesTitle}/${volumeTitle}.cbz`;
      const newCache = new Map(cache);
      const seriesFiles = newCache.get(seriesTitle);

      if (seriesFiles) {
        const filtered = seriesFiles.filter((f) => f.path !== path);
        if (filtered.length === 0) {
          newCache.delete(seriesTitle);
        } else {
          newCache.set(seriesTitle, filtered);
        }
      }

      return newCache;
    });
  }

  /**
   * Update file description in cache
   */
  updateFileDescription(fileId: string, description: string): void {
    this.cache.update((cache) => {
      const newCache = new Map(cache);

      for (const [path, files] of newCache.entries()) {
        const updated = files.map((file) =>
          file.fileId === fileId ? { ...file, description } : file
        );
        newCache.set(path, updated);
      }

      return newCache;
    });
  }

  /**
   * Clear the entire cache (useful for sign out)
   */
  clearCache(): void {
    this.cache.set(new Map());
    this.cacheLoadedStore.set(false);
    this.lastFetchTime = null;
    this.readerFolderId = null;
    this.fetchPromise = null;
  }

  /**
   * Get time since last fetch (for debugging/UI)
   */
  getLastFetchTime(): number | null {
    return this.lastFetchTime;
  }

  /**
   * Check if cache is currently being fetched
   */
  isFetchingCache(): boolean {
    return this.fetchingFlag;
  }

  // ========================================
  // CloudCache Interface Implementation
  // ========================================

  /**
   * Check if a file exists at the given path
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  has(path: string): boolean {
    let currentCache: Map<string, DriveFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();

    // Extract series title from path and find within that series
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.some((f) => f.path === path) || false;
  }

  /**
   * Get first file at the given path (for providers that support duplicates)
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  get(path: string): DriveFileMetadata | null {
    let currentCache: Map<string, DriveFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();

    // Extract series title from path and find within that series
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.find((f) => f.path === path) || null;
  }

  /**
   * Get all files at the given path (for duplicate detection)
   * @param path Full path like "SeriesTitle/VolumeTitle.cbz"
   */
  getAll(path: string): DriveFileMetadata[] {
    let currentCache: Map<string, DriveFileMetadata[]> = new Map();
    this.cache.subscribe((value) => {
      currentCache = value;
    })();

    // Extract series title from path and find all matches within that series
    const seriesTitle = path.split('/')[0];
    const seriesFiles = currentCache.get(seriesTitle);
    return seriesFiles?.filter((f) => f.path === path) || [];
  }

  /**
   * Get all files for a specific series
   * @param seriesTitle Series title to filter by
   */
  getBySeries(seriesTitle: string): DriveFileMetadata[] {
    return this.getDriveFilesBySeries(seriesTitle);
  }

  /**
   * Get all cached files
   */
  getAllFiles(): DriveFileMetadata[] {
    return this.getAllDriveFiles();
  }

  /**
   * Fetch fresh data from Google Drive and populate cache
   */
  async fetch(): Promise<void> {
    await this.fetchAllFiles();
  }

  /**
   * Clear all cached data
   */
  clear(): void {
    this.clearCache();
  }

  /**
   * Check if cache is currently being fetched
   */
  isFetching(): boolean {
    return this.isFetchingCache();
  }

  /**
   * Check if cache has been loaded at least once
   */
  isLoaded(): boolean {
    let loaded = false;
    this.cacheLoadedStore.subscribe((value) => {
      loaded = value;
    })();
    return loaded;
  }

  /**
   * Add a file to the cache (e.g., after upload)
   * @param path File path
   * @param metadata File metadata
   */
  add(path: string, metadata: DriveFileMetadata): void {
    // Parse path to get series and volume title
    const parts = path.split('/');
    if (parts.length === 2) {
      const seriesTitle = parts[0];
      const volumeTitle = parts[1].replace('.cbz', '');
      this.addDriveFile(seriesTitle, volumeTitle, metadata);
    }
  }

  /**
   * Remove a file from the cache by file ID
   * @param fileId Provider-specific file ID
   */
  removeById(fileId: string): void {
    this.removeDriveFileById(fileId);
  }

  /**
   * Update file metadata in the cache
   * @param fileId Provider-specific file ID
   * @param updates Partial metadata to update
   */
  update(fileId: string, updates: Partial<DriveFileMetadata>): void {
    // For now, only description updates are common
    // Can be extended for other fields if needed
    if (updates.description !== undefined) {
      this.updateFileDescription(fileId, updates.description);
    }

    // For other fields, update the cache directly
    this.cache.update((cache) => {
      const newCache = new Map(cache);

      for (const [path, files] of newCache.entries()) {
        const updated = files.map((file) =>
          file.fileId === fileId ? { ...file, ...updates } : file
        );
        newCache.set(path, updated);
      }

      return newCache;
    });
  }
}

export const driveFilesCache = new DriveFilesCacheManager();
