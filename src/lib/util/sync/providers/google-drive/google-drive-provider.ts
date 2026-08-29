import { browser } from '$app/environment';
import type {
  SyncProvider,
  ProviderStatus,
  CloudFileMetadata,
  DriveFileMetadata,
  StorageQuota,
  UploadFileResult
} from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import { isCbzFile, isSidecarFile, isRootConfigFile } from '../../syncable-file';
import { tokenManager } from '$lib/util/sync/providers/google-drive/token-manager';
import {
  driveApiClient,
  escapeNameForDriveQuery
} from '$lib/util/sync/providers/google-drive/api-client';
import { driveFilesCache } from '$lib/util/sync/providers/google-drive/drive-files-cache';
import {
  GOOGLE_DRIVE_CONFIG,
  type DriveFile
} from '$lib/util/sync/providers/google-drive/constants';
import { findFile } from '$lib/util/backup';
import { cacheManager } from '../../cache-manager';
import { providerManager } from '../../provider-manager';
import { setActiveProviderKey, clearActiveProviderKey } from '../../provider-detection';
import type { FolderOperations, FolderInfo, FolderItem } from '../../folder-deduplicator';
import { getCloudProviderCore } from '../../core/cloud-provider-core-registry';

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
  readonly supportsWorkerUpload = true;
  readonly uploadConcurrencyLimit = 4;
  readonly downloadConcurrencyLimit = 4;

  private readerFolderId: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readerFolderPromise: Promise<string> | null = null; // Mutex for folder creation
  private cloudCore = getCloudProviderCore('google-drive');

  /**
   * Assign the reader-folder id AND tell the status store about it.
   *
   * `getStatus().accountScope` is a function of this field, and the app has
   * TWO readers of that scope: `cloud-cache-key.ts`'s `activeAccountScope()`,
   * which calls `getStatus()` live, and `account-scope-store.ts`'s
   * `activeAccountScopeStore`, which is derived from the status STORE. Every
   * cover-drawing surface joins the store into its claim key, while
   * `acquireCover`, `refreshCoverKeys` and `cover-persist.ts` all use the live
   * read.
   *
   * Setting this field silently makes the two disagree: the live read starts
   * saying `google-drive:<folderId>` while the store still says
   * `google-drive:default`, so covers are WRITTEN and REFRESHED under the new
   * scope while every already-mounted card is still holding a handle under
   * the old one — a permanently blank cover that no re-request can repair,
   * because `refreshCoverKeys` cannot even find the holder's entry. Drive is
   * the only provider whose scope resolves lazily like this; every other one
   * has its discriminator at login.
   *
   * So the field is never assigned directly. Notifying only on a real change
   * keeps this off the hot path — `ensureReaderFolder` short-circuits on the
   * cached id long before it gets here.
   */
  private setReaderFolderId(folderId: string | null): void {
    if (this.readerFolderId === folderId) return;
    this.readerFolderId = folderId;
    providerManager.updateStatus();
  }

  private getAccessToken(): string {
    let token = '';
    tokenManager.token.subscribe((value) => {
      token = value;
    })();
    return token;
  }

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
      statusMessage,
      // this.readerFolderId is per-account (the mokuro-reader folder Drive
      // resolves/creates for the connected account) and non-secret, so it's a
      // real per-account discriminator once ensureReaderFolder() has resolved
      // it at least once. Before that first resolution (e.g. immediately
      // after login, before any operation has called ensureReaderFolder()),
      // there is nothing to key on yet, so this narrow window falls back to
      // the coarse 'default' scope — which does NOT distinguish between two
      // different Google accounts used in sequence in that window.
      accountScope: authenticated
        ? this.readerFolderId
          ? `google-drive:${this.readerFolderId}`
          : 'google-drive:default'
        : undefined
    };
  }

  async login(): Promise<void> {
    try {
      if (!browser) {
        throw new Error('Google Drive auth only works in browser');
      }

      // The consent-screen OAuth flow below lets the user pick a DIFFERENT
      // Google account without an explicit logout first. Drop any previous
      // account's cached reader-folder id up front — on both this instance
      // and driveFilesCache — so a fresh authorization always re-resolves
      // the folder for whichever account just authorized, and getStatus()
      // never reports a stale account's folder id as this account's scope.
      // driveFilesCache.clear() is the same reset logout's cacheManager.clearAll()
      // performs on this cache; reused directly here rather than adding a
      // second way to clear the same state. readerFolderPromise is cleared
      // too: otherwise a resolution still in flight from the previous
      // account is handed straight to the next ensureReaderFolder() caller
      // via the mutex check below (a resolution issued right after login()
      // routinely races this).
      this.setReaderFolderId(null);
      driveFilesCache.clear();
      this.readerFolderPromise = null;

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
    this.setReaderFolderId(null);
    this.initializePromise = null; // Reset initialization state
    // Clear the active provider key
    clearActiveProviderKey();
    console.log('Google Drive logged out');
  }

  async reauthenticate(): Promise<void> {
    tokenManager.reAuthenticate();
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
      const READER_FOLDER_NAME = GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER;
      const folderNames = new Map<string, string>();
      const cbzFiles: any[] = [];
      const sidecarFiles: any[] = [];
      const jsonFiles: any[] = [];

      for (const item of allItems) {
        if (item.mimeType === GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER) {
          folderNames.set(item.id, item.name);
        } else if (isCbzFile(item.name)) {
          cbzFiles.push(item);
        } else if (isSidecarFile(item.name)) {
          sidecarFiles.push(item);
        } else if (isRootConfigFile(item.name)) {
          jsonFiles.push(item);
        }
      }

      console.log(
        `Found ${cbzFiles.length} CBZ files, ${sidecarFiles.length} sidecar files, ${jsonFiles.length} JSON files, and ${folderNames.size} folders`
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

      // Add sidecar files (same parent-path resolution as CBZ files)
      for (const file of sidecarFiles) {
        const parentId = file.parents?.[0];
        const parentName = parentId ? folderNames.get(parentId) : null;
        if (!parentName) continue;

        const path = `${parentName}/${file.name}`;
        cloudVolumes.push({
          provider: 'google-drive',
          fileId: file.id,
          path,
          modifiedTime: file.modifiedTime || new Date().toISOString(),
          size: file.size ? parseInt(file.size) : 0,
          description: file.description,
          parentId,
          name: file.name
        });
      }

      // Add JSON files. Root config files are keyed by BASENAME alone, so one
      // living in a SERIES folder (a nested catalog.json, say) must keep its
      // full path — cached at the bare name it would shadow the real root file
      // and readers would fetch the wrong one. Matches MEGA's
      // `isJson && pathParts.length === 0` guard.
      for (const file of jsonFiles) {
        const parentId = file.parents?.[0];
        const parentName = parentId ? folderNames.get(parentId) : undefined;
        const isInSeriesFolder = !!parentName && parentName !== READER_FOLDER_NAME;

        cloudVolumes.push({
          provider: 'google-drive',
          fileId: file.id,
          path: isInSeriesFolder ? `${parentName}/${file.name}` : file.name,
          modifiedTime: file.modifiedTime || new Date().toISOString(),
          size: file.size ? parseInt(file.size) : 0,
          description: file.description,
          parentId,
          name: file.name
        });
      }

      console.log(
        `✅ Listed ${cloudVolumes.length} files from Google Drive (${cbzFiles.length} CBZ, ${sidecarFiles.length} sidecars, ${jsonFiles.length} JSON)`
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

  async uploadFile(
    path: string,
    blob: Blob,
    description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<UploadFileResult> {
    // Legacy contract: a full cache refetch rides every ordinary upload (see
    // `performUpload`). Callers that don't need to read anything back use
    // `blindUploadFile` instead.
    return this.performUpload(path, blob, description, onProgress, true);
  }

  /**
   * The write-and-forget upload (`SyncProvider.blindUploadFile`): identical to
   * `uploadFile` minus the whole-account cache refetch — a full paged
   * `files.list` walk (13+ round trips on a 12,500-file library) that a caller
   * like the sidecar backfill, which converges through the unified layer's
   * targeted cache add, has no use for.
   */
  async blindUploadFile(
    path: string,
    blob: Blob,
    description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<UploadFileResult> {
    return this.performUpload(path, blob, description, onProgress, false);
  }

  private async performUpload(
    path: string,
    blob: Blob,
    description: string | undefined,
    onProgress: ((loaded: number, total: number) => void) | undefined,
    refreshCache: boolean
  ): Promise<UploadFileResult> {
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
      const lowerFileName = fileName.toLowerCase();
      const mimeType = lowerFileName.endsWith('.json')
        ? 'application/json'
        : lowerFileName.endsWith('.webp')
          ? 'image/webp'
          : lowerFileName.endsWith('.jpg') || lowerFileName.endsWith('.jpeg')
            ? 'image/jpeg'
            : 'application/x-cbz';

      // Ensure folder structure exists
      const rootFolderId = await this.ensureReaderFolder();
      let targetFolderId = rootFolderId;

      if (seriesTitle) {
        targetFolderId = await this.ensureSeriesFolder(seriesTitle);
      }

      // Find existing file for replacement
      const existingFileId = await findFile(fileName, targetFolderId);

      // Upload (create or update) via shared provider core.
      const token = this.getAccessToken();
      if (!token) {
        throw new Error('No access token available');
      }
      const uploaded = await this.cloudCore.uploadFile({
        seriesTitle,
        filename: fileName,
        blob,
        credentials: {
          accessToken: token,
          seriesFolderId: targetFolderId
        },
        mimeType,
        existingFileId: existingFileId || undefined,
        onProgress
      });

      // The legacy whole-account refetch — `uploadFile` only. A blind upload
      // skips it: the unified layer records the upload in the cache with a
      // TARGETED add built from this upload's own response metadata
      // (`uploadCacheEntry`), which is all convergence needs.
      if (refreshCache) {
        await driveFilesCache.fetch();
      }

      // Update file description if provided
      if (description) {
        await driveApiClient.updateFileDescription(uploaded.fileId, description);
      }

      console.log(`✅ Uploaded ${fileName} to Google Drive (${uploaded.fileId})`);
      return uploaded;
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
      const token = this.getAccessToken();
      if (!token) {
        throw new Error('No access token available');
      }
      const data = await this.cloudCore.downloadFile({
        fileId,
        credentials: { accessToken: token },
        onProgress: onProgress || (() => {})
      });
      const blob = new Blob([data], { type: 'application/zip' });
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
      // Typed NOT_FOUND: DriveApiError carries the HTTP status; a 404 on a
      // fileId-based delete means the file is already gone. The shared layer
      // treats that as converged — by code only, never message text.
      if ((error as { status?: number })?.status === 404) {
        throw new ProviderError(`File not found: ${file.path}`, 'google-drive', 'NOT_FOUND');
      }
      throw new ProviderError(
        `Failed to delete volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'google-drive',
        'DELETE_FAILED',
        false,
        true
      );
    }
  }

  async renameFile(file: CloudFileMetadata, newPath: string): Promise<DriveFileMetadata> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
    }

    await this.ensureInitialized();

    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (file.path === normalizedNewPath) {
      return file as DriveFileMetadata;
    }

    try {
      const pathParts = normalizedNewPath.split('/');
      const newFileName = pathParts.pop() || normalizedNewPath;
      const newSeriesTitle = pathParts.join('/');
      const targetFolderId = newSeriesTitle
        ? await this.ensureSeriesFolder(newSeriesTitle)
        : await this.ensureReaderFolder();

      const existingTargetId = await findFile(newFileName, targetFolderId);
      if (existingTargetId && existingTargetId !== file.fileId) {
        throw new ProviderError(
          `Target file already exists at '${normalizedNewPath}'`,
          'google-drive',
          'TARGET_EXISTS'
        );
      }

      const driveFile = file as DriveFileMetadata;
      const oldParentId =
        driveFile.parentId ||
        (file.path.includes('/')
          ? (await this.findFolderByPath(file.path.split('/').slice(0, -1).join('/')))?.id
          : null);

      const updated = await driveApiClient.updateFileMetadata(
        file.fileId,
        { name: newFileName },
        {
          addParents: oldParentId && oldParentId !== targetFolderId ? targetFolderId : undefined,
          removeParents: oldParentId && oldParentId !== targetFolderId ? oldParentId : undefined,
          fields: 'id,name,parents,modifiedTime,size,description'
        }
      );

      return {
        provider: 'google-drive',
        fileId: updated.id || file.fileId,
        path: normalizedNewPath,
        // `fields=` above asks for modifiedTime explicitly, so the fallback is
        // near-unreachable — but a fallback that fabricates a client time MUST
        // carry the provisional flag, or a stamp built from it would publish a
        // clock we invented (the exact defect the rename door closed).
        modifiedTime: updated.modifiedTime || file.modifiedTime || new Date().toISOString(),
        ...(updated.modifiedTime || file.modifiedTime ? {} : { modifiedTimeProvisional: true }),
        size: updated.size ? parseInt(updated.size, 10) : file.size,
        description: updated.description ?? file.description,
        parentId: updated.parents?.[0] || targetFolderId,
        name: updated.name || newFileName
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      // Typed NOT_FOUND: a 404 on the fileId-based move means the source is
      // gone (deleted elsewhere / stale cached id). The shared rename layer
      // treats this as a GENUINE failure — never "already moved".
      if ((error as { status?: number })?.status === 404) {
        throw new ProviderError(`File not found: ${file.path}`, 'google-drive', 'NOT_FOUND');
      }
      throw new ProviderError(
        `Failed to rename file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'google-drive',
        'RENAME_FAILED',
        false,
        true
      );
    }
  }

  async renameFolder(oldPath: string, newPath: string): Promise<DriveFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'google-drive', 'NOT_AUTHENTICATED', true);
    }

    await this.ensureInitialized();

    const normalizedOldPath = oldPath.replace(/^\/+|\/+$/g, '');
    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (normalizedOldPath === normalizedNewPath) {
      return driveFilesCache.getDriveFilesBySeries(normalizedOldPath);
    }

    try {
      const existingFiles = driveFilesCache.getDriveFilesBySeries(normalizedOldPath);
      if (existingFiles.length === 0) {
        return [];
      }

      const folder = await this.findFolderByPath(normalizedOldPath);
      if (!folder) {
        throw new ProviderError(
          `Series folder '${normalizedOldPath}' not found`,
          'google-drive',
          'FOLDER_NOT_FOUND'
        );
      }

      const targetFolder = await this.findFolderByPath(normalizedNewPath);
      if (targetFolder && targetFolder.id !== folder.id) {
        throw new ProviderError(
          `Target series folder already exists at '${normalizedNewPath}'`,
          'google-drive',
          'TARGET_EXISTS'
        );
      }

      const pathParts = normalizedNewPath.split('/');
      const newFolderName = pathParts.pop() || normalizedNewPath;
      const newParentPath = pathParts.join('/');
      const targetParentId = newParentPath
        ? await this.ensureSeriesFolder(newParentPath)
        : await this.ensureReaderFolder();

      await driveApiClient.updateFileMetadata(
        folder.id,
        { name: newFolderName },
        {
          addParents:
            folder.parentId && folder.parentId !== targetParentId ? targetParentId : undefined,
          removeParents:
            folder.parentId && folder.parentId !== targetParentId ? folder.parentId : undefined,
          fields: 'id,name,parents'
        }
      );

      return existingFiles.map((existingFile) => ({
        ...existingFile,
        path: `${normalizedNewPath}${existingFile.path.slice(normalizedOldPath.length)}`
      }));
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        `Failed to rename series folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'google-drive',
        'RENAME_FAILED',
        false,
        true
      );
    }
  }

  /**
   * Remove a series directory only if the SERVER confirms it is empty — never
   * a blind recursive delete (Drive folder deletion is recursive). Emptiness
   * is checked with a live files.list query for the folder's children, NOT
   * the cached listing, which can lag behind a just-completed rename.
   */
  async removeDirectoryIfEmpty(relativePath: string): Promise<void> {
    if (!this.isAuthenticated()) return;

    const normalized = relativePath.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;

    try {
      await this.ensureInitialized();

      const folder = await this.findFolderByPath(normalized);
      if (!folder) return;

      // Server-side emptiness check: live children query against the folder id.
      const children = await driveApiClient.listFiles(
        `'${folder.id}' in parents and trashed=false`,
        'files(id)'
      );
      if (children.length > 0) return;

      await driveApiClient.deleteFile(folder.id);
      console.log(`✅ Pruned empty series folder '${normalized}' from Google Drive`);
    } catch (error) {
      // Best-effort: an orphaned empty directory is harmless.
      console.warn(`Could not prune Google Drive folder '${normalized}':`, error);
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

    const folders = await this.listFoldersNamed(parentId, folderName, 'files(id,name,createdTime)');

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
   * Every folder in `parentId` whose name IS `folderName` — with "is"
   * meaning the same unicode text, not the same bytes.
   *
   * THIS IS THE DUPLICATE-FOLDER FAUCET, so it is worth being explicit about.
   * Its only caller that can write is `findOrCreateFolder`, which CREATES a
   * folder when this returns nothing. A name query that misses a folder which
   * really is there therefore does not fail — it silently forks the series
   * into two folders, and everything downstream that keys on the folder name
   * (the reconcile pass's `hasSidecar`, the series index, the cover
   * resolution) then sees a folder full of archives with no `series.json`
   * next to an empty folder holding only the `series.json`, forever, because
   * the writes keep landing in the wrong one.
   *
   * Two ways the old inline query could miss:
   *
   * 1. ESCAPING. It hand-rolled the quote/backslash escape that
   *    `escapeNameForDriveQuery` exists for (and that `util/backup.ts` uses).
   *    Now it calls the shared helper — one definition, not three.
   * 2. UNICODE FORM, which the escape never covered. `name='…'` is a
   *    byte-wise comparison, and a folder name that has been through a
   *    decomposing filesystem comes back NFD while the local title stays NFC.
   *    Japanese titles with dakuten/handakuten are the common case: が is one
   *    code point in NFC and two in NFD, and the two never match each other.
   *
   * So the exact query stays as the FAST path — one cheap indexed query, the
   * normal answer — and a miss falls back to listing the parent's folders and
   * comparing NFC-folded. That fallback costs one query per parent and only
   * runs when the alternative was to create a duplicate. Case is deliberately
   * NOT folded: cloud storage is case-sensitive, and `Berserk/` and
   * `berserk/` really are two folders.
   */
  private async listFoldersNamed(
    parentId: string,
    folderName: string,
    fields: string
  ): Promise<DriveFile[]> {
    const parentClause = parentId === 'root' ? "'root' in parents" : `'${parentId}' in parents`;
    const folderClause = `${parentClause} and mimeType='${GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER}' and trashed=false`;

    const exact = await driveApiClient.listFiles(
      `name='${escapeNameForDriveQuery(folderName)}' and ${folderClause}`,
      fields
    );
    if (exact.length > 0) return exact;

    const wanted = folderName.normalize('NFC');
    const all = await driveApiClient.listFiles(folderClause, fields);
    const matches = all.filter((folder) => (folder.name ?? '').normalize('NFC') === wanted);
    if (matches.length > 0) {
      console.log(
        `[GoogleDrive] '${folderName}' is stored under a different unicode form; reusing the existing folder`
      );
    }
    return matches;
  }

  private async findFolder(
    parentId: string,
    folderName: string
  ): Promise<{ id: string; parentId: string | null; name: string } | null> {
    const folders = await this.listFoldersNamed(
      parentId,
      folderName,
      'files(id,name,parents,createdTime)'
    );

    if (folders.length === 0) {
      return null;
    }

    folders.sort((a, b) => {
      const dateA = new Date(a.createdTime || 0).getTime();
      const dateB = new Date(b.createdTime || 0).getTime();
      return dateA - dateB;
    });

    const folder = folders[0];
    return {
      id: folder.id,
      name: folder.name,
      parentId: folder.parents?.[0] || null
    };
  }

  private async findFolderByPath(
    folderPath: string
  ): Promise<{ id: string; parentId: string | null; name: string } | null> {
    const normalizedPath = folderPath.replace(/^\/+|\/+$/g, '');
    if (!normalizedPath) {
      const rootFolderId = await this.ensureReaderFolder();
      return {
        id: rootFolderId,
        name: GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER,
        parentId: 'root'
      };
    }

    const rootFolderId = await this.ensureReaderFolder();
    let currentFolder: { id: string; parentId: string | null; name: string } | null = {
      id: rootFolderId,
      name: GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER,
      parentId: 'root'
    };

    for (const part of normalizedPath.split('/').filter(Boolean)) {
      currentFolder = await this.findFolder(currentFolder.id, part);
      if (!currentFolder) {
        return null;
      }
    }

    return currentFolder;
  }

  private async ensureFolderPath(folderPath: string): Promise<string> {
    const normalizedPath = folderPath.replace(/^\/+|\/+$/g, '');
    const rootFolderId = await this.ensureReaderFolder();
    if (!normalizedPath) {
      return rootFolderId;
    }

    let currentParentId = rootFolderId;
    for (const part of normalizedPath.split('/').filter(Boolean)) {
      currentParentId = await this.findOrCreateFolder(currentParentId, part);
    }

    return currentParentId;
  }

  /**
   * Get folder operations interface for the FolderDeduplicator
   * Returns an object that implements FolderOperations
   */
  getFolderOperations(): FolderOperations {
    return {
      rootFolderName: GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER,

      listFolders: async (): Promise<FolderInfo[]> => {
        await this.ensureInitialized();
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

      listFolderContents: async (folderId: string): Promise<FolderItem[]> => {
        await this.ensureInitialized();
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

      moveItem: async (itemId: string, newParentId: string, oldParentId: string): Promise<void> => {
        await this.ensureInitialized();
        await driveApiClient.moveFile(itemId, newParentId, oldParentId);
      },

      deleteFolder: async (folderId: string): Promise<void> => {
        await this.ensureInitialized();
        await driveApiClient.deleteFile(folderId);
      },

      deleteFile: async (fileId: string): Promise<void> => {
        await this.ensureInitialized();
        await driveApiClient.deleteFile(fileId);
      },

      onRootFolderConfirmed: (folderId: string): void => {
        this.setReaderFolderId(folderId);
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
      this.setReaderFolderId(cachedFolderId);
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
        this.setReaderFolderId(recheckFolderId);
        return recheckFolderId;
      }

      // Find or create the folder (dedup handled separately by FolderDeduplicator)
      const folderId = await this.findOrCreateFolder(
        'root',
        GOOGLE_DRIVE_CONFIG.FOLDER_NAMES.READER
      );

      // Store in both caches
      this.setReaderFolderId(folderId);
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
    return this.ensureFolderPath(seriesTitle);
  }

  async getWorkerUploadCredentials(): Promise<Record<string, any>> {
    let token = '';
    tokenManager.token.subscribe((value) => {
      token = value;
    })();
    return { accessToken: token };
  }

  async prepareUploadTarget(seriesTitle: string): Promise<Record<string, any>> {
    const seriesFolderId = await this.ensureSeriesFolder(seriesTitle);
    return { seriesFolderId };
  }

  async getWorkerDownloadCredentials(_fileId: string): Promise<Record<string, any>> {
    let token = '';
    tokenManager.token.subscribe((value) => {
      token = value;
    })();
    return { accessToken: token };
  }
}

export const googleDriveProvider = new GoogleDriveProvider();

// Self-register cache when module is loaded
cacheManager.registerCache('google-drive', driveFilesCache);
