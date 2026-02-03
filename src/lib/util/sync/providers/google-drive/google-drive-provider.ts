import { browser } from '$app/environment';
import type {
  SyncProvider,
  ProviderStatus,
  CloudFileMetadata,
  DriveFileMetadata,
  StorageQuota
} from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import { tokenManager } from '$lib/util/sync/providers/google-drive/token-manager';
import { driveApiClient } from '$lib/util/sync/providers/google-drive/api-client';
import { driveFilesCache } from '$lib/util/sync/providers/google-drive/drive-files-cache';
import { GOOGLE_DRIVE_CONFIG } from '$lib/util/sync/providers/google-drive/constants';
import { getOrCreateFolder, findFile } from '$lib/util/backup';
import { cacheManager } from '../../cache-manager';
import { setActiveProviderKey, clearActiveProviderKey } from '../../provider-detection';
import type { FolderOperations, FolderInfo, FolderItem } from '../../folder-deduplicator';

/**
 * Metadata for a file selected from the Google Drive file picker
 */
interface PickedFile {
  /** File ID in Google Drive */
  id: string;
  /** File name */
  name: string | undefined;
  /** MIME type */
  mimeType: string | undefined;
}

/**
 * Google Drive Provider
 *
 * Wraps existing Google Drive integration into the unified SyncProvider interface.
 * This allows Drive to work alongside MEGA and WebDAV providers.
 */
class GoogleDriveProvider implements SyncProvider {
  readonly type = 'google-drive' as const;
  readonly name = 'Google Drive';
  readonly supportsWorkerDownload = true; // Workers can download directly with access token
  readonly uploadConcurrencyLimit = 4;
  readonly downloadConcurrencyLimit = 4;

  private readerFolderId: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readerFolderPromise: Promise<string> | null = null; // Mutex for folder creation

  isAuthenticated(): boolean {
    return tokenManager.isAuthenticated();
  }

  /**
   * Ensure Drive API is initialized when we have auth credentials
   * This handles the case where app restarts with existing auth - we need to
   * initialize the API clients (gapi, tokenClient) even though we're already "authenticated"
   */
  private async ensureInitialized(): Promise<void> {
    // If we're already initializing, wait for that to complete
    if (this.initializePromise) {
      return this.initializePromise;
    }

    // If not authenticated, don't initialize
    if (!this.isAuthenticated()) {
      return;
    }

    // Check if already initialized by testing if gapi.client.drive exists
    if (typeof gapi !== 'undefined' && gapi.client?.drive) {
      return; // Already initialized
    }

    // Need to initialize - create promise and store it to prevent concurrent inits
    this.initializePromise = (async () => {
      try {
        console.log('🔧 Initializing Drive API for existing auth...');
        await driveApiClient.initialize();
        console.log('✅ Drive API initialized');
      } catch (error) {
        console.error('Failed to initialize Drive API:', error);
        this.initializePromise = null;
        throw error;
      }
    })();

    return this.initializePromise;
  }

  getStatus(): ProviderStatus {
    const authenticated = this.isAuthenticated();
    const hasCredentials =
      browser &&
      localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED) === 'true';

    // Get needsAttention from token manager (set when token expires/expiring)
    let needsAttention = false;
    tokenManager.needsAttention.subscribe((value) => {
      needsAttention = value;
    })();

    let statusMessage = 'Not connected';
    if (authenticated) {
      statusMessage = needsAttention
        ? 'Session expired - re-authentication required'
        : 'Connected to Google Drive';
    } else if (hasCredentials) {
      statusMessage = 'Configured (not connected)';
    } else {
      statusMessage = 'Not configured';
    }

    return {
      isAuthenticated: authenticated,
      hasStoredCredentials: hasCredentials,
      needsAttention,
      statusMessage
    };
  }

  /**
   * Check if worker downloads are possible in the current context.
   * Google Drive API is always HTTPS, so no mixed content issues.
   */
  canUseWorkerDownload(): boolean {
    return true; // Google Drive API is always HTTPS
  }

  async login(): Promise<void> {
    try {
      if (!browser) {
        throw new Error('Google Drive auth only works in browser');
      }

      // Initialize Drive API if needed (this also initializes the token client)
      await driveApiClient.initialize();

      // Request OAuth token with full consent screen (initial login)
      tokenManager.requestNewToken(true);

      // Wait for token to be set
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Login timeout'));
        }, 60000); // 60 second timeout

        const unsubscribe = tokenManager.token.subscribe((token) => {
          if (token) {
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          }
        });
      });

      // Set the active provider key for lazy loading on next startup
      setActiveProviderKey('google-drive');
      console.log('✅ Google Drive login successful');
    } catch (error) {
      throw new ProviderError(
        `Google Drive login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'google-drive',
        'LOGIN_FAILED',
        true
      );
    }
  }

  async logout(): Promise<void> {
    // Use full logout (clears token + auth history) not just clearToken
    await tokenManager.logout();
    this.readerFolderId = null;
    this.initializePromise = null; // Reset initialization state
    // Clear the active provider key
    clearActiveProviderKey();
    console.log('Google Drive logged out');
  }

  // VOLUME STORAGE METHODS

  async listCloudVolumes(): Promise<CloudFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
    }

    // Ensure API is initialized before using it
    await this.ensureInitialized();

    try {
      console.log('Querying Google Drive for files...');

      // Query Drive API directly for all files owned by user
      const allItems = await driveApiClient.listFiles(
        `'me' in owners and trashed=false`,
        'files(id,name,mimeType,modifiedTime,size,parents,description)'
      );

      // Build folder map (folder ID -> folder name)
      const folderNames = new Map<string, string>();
      const cbzFiles: any[] = [];
      const jsonFiles: any[] = [];

      for (const item of allItems) {
        if (item.mimeType === GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER) {
          folderNames.set(item.id, item.name);
        } else if (item.name.endsWith('.cbz')) {
          cbzFiles.push(item);
        } else if (
          item.name === GOOGLE_DRIVE_CONFIG.FILE_NAMES.VOLUME_DATA ||
          item.name === GOOGLE_DRIVE_CONFIG.FILE_NAMES.PROFILES
        ) {
          jsonFiles.push(item);
        }
      }

      console.log(
        `Found ${cbzFiles.length} CBZ files, ${jsonFiles.length} JSON files, and ${folderNames.size} folders`
      );

      // Transform all files to DriveFileMetadata format with paths
      const cloudVolumes: DriveFileMetadata[] = [];

      // Add CBZ files (with parent folder in path)
      for (const file of cbzFiles) {
        const parentId = file.parents?.[0];
        const parentName = parentId ? folderNames.get(parentId) : null;

        // Only include files that have a parent folder (series folder)
        if (parentName) {
          const path = `${parentName}/${file.name}`;
          cloudVolumes.push({
            provider: 'google-drive',
            fileId: file.id,
            path: path,
            modifiedTime: file.modifiedTime || new Date().toISOString(),
            size: file.size ? parseInt(file.size) : 0,
            description: file.description,
            parentId: parentId,
            name: file.name
          });
        }
      }

      // Add JSON files (no parent folder in path, just filename)
      for (const file of jsonFiles) {
        cloudVolumes.push({
          provider: 'google-drive',
          fileId: file.id,
          path: file.name, // Just the filename for JSON files
          modifiedTime: file.modifiedTime || new Date().toISOString(),
          size: file.size ? parseInt(file.size) : 0,
          description: file.description,
          parentId: file.parents?.[0],
          name: file.name
        });
      }

      console.log(
        `✅ Listed ${cloudVolumes.length} files from Google Drive (${cbzFiles.length} CBZ, ${jsonFiles.length} JSON)`
      );
      return cloudVolumes;
    } catch (error) {
      throw new ProviderError(
        `Failed to list cloud volumes: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'google-drive',
        'LIST_FAILED',
        false,
        true
      );
    }
  }

  async uploadFile(path: string, blob: Blob, description?: string): Promise<string> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
    }

    // Ensure API is initialized before using it
    await this.ensureInitialized();

    try {
      // Parse path: "SeriesTitle/VolumeTitle.cbz" or "volume-data.json"
      const pathParts = path.split('/');
      const fileName = pathParts.pop() || path;
      const seriesTitle = pathParts.join('/');

      // Determine MIME type from extension
      const mimeType = fileName.endsWith('.json') ? 'application/json' : 'application/x-cbz';

      // Ensure folder structure exists
      const rootFolderId = await this.ensureReaderFolder();
      let targetFolderId = rootFolderId;

      if (seriesTitle) {
        targetFolderId = await getOrCreateFolder(seriesTitle, rootFolderId);
      }

      // Find existing file for replacement
      const existingFileId = await findFile(fileName, targetFolderId);

      // Upload (create or update)
      const metadata = {
        name: fileName,
        mimeType,
        ...(existingFileId ? {} : { parents: [targetFolderId] })
      };

      const result = await driveApiClient.uploadFile(blob, metadata, existingFileId || undefined);

      // Update cache
      await driveFilesCache.fetch();

      // Update file description if provided
      if (description) {
        await driveApiClient.updateFileDescription(result.id, description);
      }

      console.log(`✅ Uploaded ${fileName} to Google Drive (${result.id})`);
      return result.id;
    } catch (error) {
      throw new ProviderError(
        `Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'google-drive',
        'UPLOAD_FAILED',
        false,
        true
      );
    }
  }

  async downloadFile(
    file: CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
    }

    // Ensure API is initialized before using it
    await this.ensureInitialized();

    // Extract file ID from metadata
    const fileId = file.fileId;

    try {
      // Use api-client's downloadFile method (includes auth error handling)
      const blob = await driveApiClient.downloadFile(fileId, onProgress);
      console.log(`✅ Downloaded file from Google Drive (${fileId})`);
      return blob;
    } catch (error) {
      throw new ProviderError(
        `Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'google-drive',
        'DOWNLOAD_FAILED',
        false,
        true
      );
    }
  }

  async deleteFile(file: CloudFileMetadata): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
    }

    // Ensure API is initialized before using it
    await this.ensureInitialized();

    // Extract file ID from metadata
    const fileId = file.fileId;

    try {
      // Delete from Drive
      await driveApiClient.deleteFile(fileId);

      // Update cache
      const { driveFilesCache } = await import(
        '$lib/util/sync/providers/google-drive/drive-files-cache'
      );
      driveFilesCache.removeById(fileId);

      console.log(`✅ Deleted file from Google Drive (${fileId})`);
    } catch (error) {
      throw new ProviderError(
        `Failed to delete volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'google-drive',
        'DELETE_FAILED',
        false,
        true
      );
    }
  }

  /**
   * Delete an entire series folder
   */
  async deleteSeriesFolder(seriesTitle: string): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
    }

    // Ensure API is initialized before using it
    await this.ensureInitialized();

    try {
      // Get the folder ID from cache - files store their parent folder ID
      const seriesFiles = driveFilesCache.getDriveFilesBySeries(seriesTitle);

      if (seriesFiles.length === 0) {
        console.log(`No files found for series '${seriesTitle}' in cache`);
        return; // Nothing to delete
      }

      // Get folder ID from the first file's parentId
      const folderId = seriesFiles[0].parentId;

      if (!folderId) {
        // No parent ID stored - fall back to individual file deletion
        throw new ProviderError(
          `Series folder ID not found in cache for '${seriesTitle}'`,
          'google-drive',
          'FOLDER_NOT_FOUND',
          false,
          false
        );
      }

      // Delete the folder (this recursively deletes all contents)
      await driveApiClient.deleteFile(folderId);

      console.log(`✅ Deleted series folder '${seriesTitle}' from Google Drive`);
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        `Failed to delete series folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'google-drive',
        'DELETE_FAILED',
        false,
        true
      );
    }
  }

  /**
   * Show Google Drive file picker for selecting CBZ/ZIP files or folders
   * Opens the Google Picker UI, expands any selected folders, and returns all files
   */
  async showFilePicker(): Promise<PickedFile[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
    }

    // Ensure API is initialized before using it
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const showPicker = async () => {
        try {
          // Ensure reader folder exists first
          const readerFolderId = await this.ensureReaderFolder();

          // Get access token
          let token = '';
          tokenManager.token.subscribe((value) => {
            token = value;
          })();

          if (!token) {
            throw new Error('No access token available');
          }

          // Create a view for ZIP/CBZ files
          const docsView = new google.picker.DocsView(google.picker.ViewId.DOCS)
            .setMimeTypes(
              'application/zip,application/x-zip-compressed,application/vnd.comicbook+zip,application/x-cbz'
            )
            .setMode(google.picker.DocsViewMode.LIST)
            .setIncludeFolders(true)
            .setSelectFolderEnabled(true);

          // Set parent folder if we have one
          if (readerFolderId) {
            docsView.setParent(readerFolderId);
          }

          // Create a view specifically for folders
          const folderView = new google.picker.DocsView(
            google.picker.ViewId.FOLDERS
          ).setSelectFolderEnabled(true);

          if (readerFolderId) {
            folderView.setParent(readerFolderId);
          }

          // Create picker with callback
          const picker = new google.picker.PickerBuilder()
            .addView(docsView)
            .addView(folderView)
            .setOAuthToken(token)
            .setAppId(GOOGLE_DRIVE_CONFIG.CLIENT_ID)
            .setDeveloperKey(GOOGLE_DRIVE_CONFIG.API_KEY)
            .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
            .setCallback(async (data: google.picker.ResponseObject) => {
              try {
                if (data[google.picker.Response.ACTION] === google.picker.Action.PICKED) {
                  const docs = data[google.picker.Response.DOCUMENTS];
                  if (!docs) return;

                  // Expand folders and collect all files
                  const allFiles: PickedFile[] = [];

                  for (const doc of docs) {
                    const pickedFile = {
                      id: doc[google.picker.Document.ID],
                      name: doc[google.picker.Document.NAME],
                      mimeType: doc[google.picker.Document.MIME_TYPE]
                    };

                    if (pickedFile.mimeType === 'application/vnd.google-apps.folder') {
                      // Recursively process folder
                      const folderFiles = await this.listFilesInFolder(pickedFile.id);
                      allFiles.push(...folderFiles);
                    } else {
                      // Add regular file
                      allFiles.push(pickedFile);
                    }
                  }

                  // Filter to only ZIP/CBZ files
                  const zipFiles = allFiles.filter((file) => {
                    const mimeType = (file.mimeType || '').toLowerCase();
                    return mimeType.includes('zip') || mimeType.includes('cbz');
                  });

                  resolve(zipFiles);
                } else if (data[google.picker.Response.ACTION] === google.picker.Action.CANCEL) {
                  resolve([]); // User cancelled
                }
              } catch (error) {
                reject(
                  new ProviderError(
                    `Failed to process selected files: ${error instanceof Error ? error.message : 'Unknown error'}`,
                    'google-drive',
                    'PICKER_PROCESSING_FAILED',
                    false,
                    false
                  )
                );
              }
            })
            .build();

          picker.setVisible(true);
        } catch (error) {
          reject(
            new ProviderError(
              `Failed to show file picker: ${error instanceof Error ? error.message : 'Unknown error'}`,
              'google-drive',
              'PICKER_FAILED',
              false,
              false
            )
          );
        }
      };

      showPicker();
    });
  }

  /**
   * List all files in a folder recursively
   * Expands subfolders and returns all ZIP/CBZ files
   * Note: ensureInitialized() is already called by showFilePicker() before this is invoked
   */
  private async listFilesInFolder(folderId: string): Promise<PickedFile[]> {
    try {
      const files = await driveApiClient.listFiles(
        `'${folderId}' in parents and (mimeType='application/zip' or mimeType='application/x-zip-compressed' or mimeType='application/vnd.comicbook+zip' or mimeType='application/x-cbz' or mimeType='application/vnd.google-apps.folder') and trashed=false`,
        'files(id, name, mimeType)'
      );

      const allFiles: PickedFile[] = [];

      for (const file of files) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          // Recursively process subfolder
          const subfolderFiles = await this.listFilesInFolder(file.id);
          allFiles.push(...subfolderFiles);
        } else {
          // Add file
          allFiles.push({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType
          });
        }
      }

      return allFiles;
    } catch (error) {
      console.error('Error listing files in folder:', error);
      return [];
    }
  }

  /**
   * Convert picked files from file picker to full CloudFileMetadata objects
   * Fetches size and modifiedTime from Drive API for each file
   */
  async getCloudFileMetadata(
    pickedFiles: PickedFile[]
  ): Promise<import('../../provider-interface').CloudFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
    }

    // Ensure API is initialized before using it
    await this.ensureInitialized();

    try {
      // Fetch full metadata for each file in parallel
      const metadataPromises = pickedFiles.map(async (picked) => {
        const metadata = await driveApiClient.getFileMetadata(picked.id, 'name,size,modifiedTime');

        return {
          provider: 'google-drive' as const,
          fileId: picked.id,
          path: metadata.name, // Use filename as path (no folders for sideloaded files)
          modifiedTime: metadata.modifiedTime || new Date().toISOString(),
          size: parseInt(metadata.size || '0', 10)
        };
      });

      return await Promise.all(metadataPromises);
    } catch (error) {
      throw new ProviderError(
        `Failed to fetch file metadata: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'google-drive',
        'METADATA_FETCH_FAILED',
        false,
        false
      );
    }
  }

  /**
   * Get storage quota information from Google Drive
   * Returns used, total, and available storage in bytes
   */
  async getStorageQuota(): Promise<StorageQuota> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
    }

    await this.ensureInitialized();

    try {
      const response = await gapi.client.drive.about.get({
        fields: 'storageQuota'
      });

      const quota = response.result.storageQuota;
      if (!quota) {
        throw new Error('No storage quota information available');
      }

      const used = parseInt(quota.usage || '0', 10);
      const total = quota.limit ? parseInt(quota.limit, 10) : null;

      return {
        used,
        total,
        available: total !== null ? total - used : null
      };
    } catch (error) {
      throw new ProviderError(
        `Failed to get storage quota: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'google-drive',
        'QUOTA_FETCH_FAILED',
        false,
        true
      );
    }
  }

  /**
   * Find or create a folder with the given name in the given parent
   * Returns the first matching folder if multiple exist (dedup handled separately by FolderDeduplicator)
   *
   * @param parentId The parent folder ID, or 'root' for Drive root
   * @param folderName The folder name to find/create
   * @returns The folder ID
   */
  async findOrCreateFolder(parentId: string, folderName: string): Promise<string> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
    }

    await this.ensureInitialized();

    const escapedName = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const parentClause = parentId === 'root' ? "'root' in parents" : `'${parentId}' in parents`;

    // Query for folders with this name in the parent
    const folders = await driveApiClient.listFiles(
      `name='${escapedName}' and ${parentClause} and mimeType='${GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER}' and trashed=false`,
      'files(id,name,createdTime)'
    );

    if (folders.length === 0) {
      // No folder exists - create one
      console.log(`📁 Creating folder: ${folderName}`);
      return await driveApiClient.createFolder(
        folderName,
        parentId === 'root' ? undefined : parentId
      );
    }

    // Return first folder found (oldest if multiple - they'll be deduped later)
    if (folders.length > 1) {
      folders.sort((a, b) => {
        const dateA = new Date(a.createdTime || 0).getTime();
        const dateB = new Date(b.createdTime || 0).getTime();
        return dateA - dateB;
      });
      console.log(
        `⚠️ Found ${folders.length} folders named '${folderName}', using oldest (dedup will run later)`
      );
    }

    return folders[0].id;
  }

  /**
   * Get folder operations interface for the FolderDeduplicator
   * Returns an object that implements FolderOperations
   */
  getFolderOperations(): FolderOperations {
    const self = this;

    return {
      rootFolderName: GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER,

      async listFolders(): Promise<FolderInfo[]> {
        await self.ensureInitialized();
        const items = await driveApiClient.listFiles(
          `mimeType='${GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER}' and 'me' in owners and trashed=false`,
          'files(id,name,parents,createdTime)'
        );
        return items.map((item) => ({
          id: item.id,
          name: item.name,
          parentId: item.parents?.[0] || null,
          createdTime: item.createdTime
        }));
      },

      async listFolderContents(folderId: string): Promise<FolderItem[]> {
        await self.ensureInitialized();
        const items = await driveApiClient.listFiles(
          `'${folderId}' in parents and trashed=false`,
          'files(id,name,mimeType)'
        );
        return items.map((item) => ({
          id: item.id,
          name: item.name,
          isFolder: item.mimeType === GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER
        }));
      },

      async moveItem(itemId: string, newParentId: string, oldParentId: string): Promise<void> {
        await self.ensureInitialized();
        await driveApiClient.moveFile(itemId, newParentId, oldParentId);
      },

      async deleteFolder(folderId: string): Promise<void> {
        await self.ensureInitialized();
        await driveApiClient.deleteFile(folderId);
      },

      async deleteFile(fileId: string): Promise<void> {
        await self.ensureInitialized();
        await driveApiClient.deleteFile(fileId);
      },

      onRootFolderConfirmed(folderId: string): void {
        self.readerFolderId = folderId;
        driveFilesCache.setReaderFolderId(folderId);
      }
    };
  }

  /**
   * Ensure the mokuro-reader folder exists in Google Drive
   * Uses mutex to prevent race conditions from simultaneous calls
   * Public so backup-queue can use it instead of duplicating folder creation logic
   */
  async ensureReaderFolder(): Promise<string> {
    // Check local cache first (fast path for repeated calls within this provider)
    if (this.readerFolderId) {
      return this.readerFolderId;
    }

    // Get folder ID from shared cache (waits if fetch is in progress)
    const cachedFolderId = await driveFilesCache.getReaderFolderId();

    if (cachedFolderId) {
      // Found in cache
      this.readerFolderId = cachedFolderId;
      return cachedFolderId;
    }

    // If folder creation is already in progress, wait for it
    if (this.readerFolderPromise) {
      return this.readerFolderPromise;
    }

    // Folder doesn't exist or need to check for duplicates
    this.readerFolderPromise = (async () => {
      // Double-check cache after acquiring "lock" (another call might have finished)
      const recheckFolderId = await driveFilesCache.getReaderFolderId();
      if (recheckFolderId) {
        this.readerFolderId = recheckFolderId;
        return recheckFolderId;
      }

      // Find or create the folder (dedup handled separately by FolderDeduplicator)
      const folderId = await this.findOrCreateFolder(
        'root',
        GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER
      );

      // Store in both caches
      this.readerFolderId = folderId;
      driveFilesCache.setReaderFolderId(folderId);

      return folderId;
    })();

    try {
      return await this.readerFolderPromise;
    } finally {
      // Clear promise after completion so future calls can retry if needed
      this.readerFolderPromise = null;
    }
  }

  /**
   * Ensure a series folder exists uniquely within the mokuro-reader folder
   * Handles deduplication if multiple folders with the same name exist
   * Public so backup-queue can use it instead of duplicating logic
   */
  async ensureSeriesFolder(seriesTitle: string): Promise<string> {
    const rootFolderId = await this.ensureReaderFolder();
    return this.findOrCreateFolder(rootFolderId, seriesTitle);
  }
}

export const googleDriveProvider = new GoogleDriveProvider();

// Self-register cache when module is loaded
cacheManager.registerCache('google-drive', driveFilesCache);
