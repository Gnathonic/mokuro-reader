import { browser } from '$app/environment';
import type {
  SyncProvider,
  ProviderCredentials,
  ProviderStatus,
  CloudFileMetadata,
  StorageQuota,
  UploadPayload
} from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import { setActiveProviderKey, clearActiveProviderKey } from '../../provider-detection';
import { ONEDRIVE_CONFIG } from './constants';
import { onedriveTokenManager } from './token-manager';
import {
  createFolder,
  deleteItem,
  getDriveQuota,
  getItemByPath,
  listChildren,
  patchItem
} from './graph-client';
import { getCloudProviderCore } from '../../core/cloud-provider-core-registry';
import { isSyncableFile } from '../../syncable-file';

export class OneDriveProvider implements SyncProvider {
  readonly type = 'onedrive' as const;
  readonly name = 'OneDrive';
  readonly supportsWorkerDownload = true;
  readonly supportsWorkerUpload = true;
  readonly uploadConcurrencyLimit = 4;
  readonly downloadConcurrencyLimit = 4;

  private cloudCore = getCloudProviderCore('onedrive');
  private initPromise: Promise<void>;
  private initError: Error | null = null;

  constructor() {
    if (browser) {
      this.initPromise = onedriveTokenManager.initialize().catch((error) => {
        // A missing/invalid client id is a deployment misconfiguration, not
        // a "user never connected" state. Track it so getStatus() can say so.
        this.initError = error instanceof Error ? error : new Error(String(error));
        console.warn('OneDrive MSAL init failed:', error);
      });
    } else {
      this.initPromise = Promise.resolve();
    }
  }

  async whenReady(): Promise<void> {
    await this.initPromise;
  }

  isAuthenticated(): boolean {
    return onedriveTokenManager.isAuthenticated();
  }

  getStatus(): ProviderStatus {
    if (this.initError) {
      return {
        isAuthenticated: false,
        hasStoredCredentials: onedriveTokenManager.hasStoredCredentials(),
        needsAttention: false,
        statusMessage: `OneDrive initialization failed: ${this.initError.message}`
      };
    }
    const authenticated = this.isAuthenticated();
    const hasCredentials = onedriveTokenManager.hasStoredCredentials();
    let needsAttention = false;
    onedriveTokenManager.needsAttention.subscribe((value) => {
      needsAttention = value;
    })();
    const name = onedriveTokenManager.getActiveAccountName();
    const statusMessage = authenticated
      ? needsAttention
        ? 'Session expired — re-authentication required'
        : name
          ? `Connected to OneDrive (${name})`
          : 'Connected to OneDrive'
      : hasCredentials
        ? 'Configured (not connected)'
        : 'Not configured';
    return {
      isAuthenticated: authenticated,
      hasStoredCredentials: hasCredentials,
      needsAttention,
      statusMessage
    };
  }

  async login(_credentials?: ProviderCredentials): Promise<void> {
    if (!browser) {
      throw new ProviderError('OneDrive only works in browser', 'onedrive', 'BROWSER_ONLY');
    }
    // If the user just returned from a redirect-flow login, MSAL has already
    // populated the account during initialize(). Skip the redirect dance and
    // finalize the connection.
    await onedriveTokenManager.initialize();
    if (onedriveTokenManager.isAuthenticated()) {
      try {
        await this.ensureMokuroFolder();
        setActiveProviderKey('onedrive');
        console.log('✅ OneDrive login completed (post-redirect)');
        return;
      } catch (error) {
        throw new ProviderError(
          `OneDrive login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'onedrive',
          'LOGIN_FAILED',
          true
        );
      }
    }
    // Set the active provider key BEFORE the redirect so on return the
    // provider lazy-loads via the active_cloud_provider key path and
    // initialize() (which calls handleRedirectPromise) runs to complete auth.
    setActiveProviderKey('onedrive');
    try {
      await onedriveTokenManager.login(); // Navigates the window away
    } catch (error) {
      // Roll back the active key if the redirect itself failed
      clearActiveProviderKey();
      throw new ProviderError(
        `OneDrive login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'onedrive',
        'LOGIN_FAILED',
        true
      );
    }
  }

  async logout(): Promise<void> {
    // Clear the active-provider key BEFORE the token manager's logout —
    // logoutRedirect() navigates the window away and nothing after it runs.
    clearActiveProviderKey();
    console.log('OneDrive logged out');
    await onedriveTokenManager.logout();
  }

  async reauthenticate(): Promise<void> {
    await onedriveTokenManager.reauthenticate();
  }

  // Coalesce concurrent folder creation (MEGA pattern): parallel uploads into
  // a new series must not each POST createFolder — Graph 409s on the losers.
  private mokuroFolderPromise: Promise<string> | null = null;
  private seriesFolderPromises = new Map<string, Promise<string>>();

  /**
   * createFolder uses conflictBehavior 'fail'; if ANOTHER client (worker,
   * second tab) won the race, re-fetch and return the existing folder.
   */
  private async createFolderTolerant(parentPath: string, name: string): Promise<string> {
    const token = await onedriveTokenManager.getAccessToken();
    try {
      const created = await createFolder(token, parentPath, name);
      return created.id;
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'GRAPH_409') {
        const fullPath = parentPath ? `${parentPath}/${name}` : name;
        const existing = await getItemByPath(token, fullPath);
        if (existing) return existing.id;
      }
      throw error;
    }
  }

  private async ensureMokuroFolder(): Promise<string> {
    const token = await onedriveTokenManager.getAccessToken();
    const existing = await getItemByPath(token, ONEDRIVE_CONFIG.MOKURO_FOLDER);
    if (existing) return existing.id;

    if (this.mokuroFolderPromise) return this.mokuroFolderPromise;
    this.mokuroFolderPromise = (async () => {
      try {
        const id = await this.createFolderTolerant('', ONEDRIVE_CONFIG.MOKURO_FOLDER);
        console.log(`Created ${ONEDRIVE_CONFIG.MOKURO_FOLDER} folder in OneDrive`);
        return id;
      } finally {
        this.mokuroFolderPromise = null;
      }
    })();
    return this.mokuroFolderPromise;
  }

  private async ensureSeriesFolder(seriesTitle: string): Promise<string> {
    const token = await onedriveTokenManager.getAccessToken();
    const path = `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${seriesTitle}`;
    const existing = await getItemByPath(token, path);
    if (existing) return existing.id;

    const inFlight = this.seriesFolderPromises.get(seriesTitle);
    if (inFlight) return inFlight;

    const promise = (async () => {
      try {
        await this.ensureMokuroFolder();
        return await this.createFolderTolerant(ONEDRIVE_CONFIG.MOKURO_FOLDER, seriesTitle);
      } finally {
        this.seriesFolderPromises.delete(seriesTitle);
      }
    })();
    this.seriesFolderPromises.set(seriesTitle, promise);
    return promise;
  }

  async listCloudVolumes(): Promise<CloudFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const token = await onedriveTokenManager.getAccessToken();

    const results: CloudFileMetadata[] = [];

    // If the root mokuro folder doesn't exist yet, there's nothing to list.
    // Probe it once here (getItemByPath cleanly returns null on 404) rather than
    // swallowing 404s inside the recursive walk — a 404 raised while listing a
    // deep subfolder means missing data, not "empty library", and must surface
    // so a later progress sync can't overwrite good data with a truncated set.
    const root = await getItemByPath(token, ONEDRIVE_CONFIG.MOKURO_FOLDER);
    if (!root) {
      console.log('OneDrive mokuro folder does not exist yet; nothing to list');
      return results;
    }

    const walk = async (path: string): Promise<void> => {
      const children = await listChildren(token, path);
      for (const item of children) {
        const childPath = path ? `${path}/${item.name}` : item.name;
        if (item.folder) {
          await walk(childPath);
        } else if (item.file) {
          const relative = childPath.replace(`${ONEDRIVE_CONFIG.MOKURO_FOLDER}/`, '');
          if (!isSyncableFile(relative)) continue;
          results.push({
            provider: 'onedrive',
            fileId: item.id,
            path: relative,
            modifiedTime: item.lastModifiedDateTime ?? new Date().toISOString(),
            size: item.size ?? 0
          });
        }
      }
    };

    await walk(ONEDRIVE_CONFIG.MOKURO_FOLDER);
    console.log(`✅ Listed ${results.length} files from OneDrive`);
    return results;
  }

  async uploadFile(
    path: string,
    blob: UploadPayload,
    _description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const seriesTitle = path.split('/').slice(0, -1).join('/');
    const filename = path.split('/').pop() ?? path;
    if (seriesTitle) await this.ensureSeriesFolder(seriesTitle);
    else await this.ensureMokuroFolder();

    const credentials = await this.getWorkerUploadCredentials();
    const blobToUpload =
      blob instanceof Blob
        ? blob
        : blob instanceof ArrayBuffer
          ? new Blob([blob])
          : new Blob([new Uint8Array(blob).buffer as ArrayBuffer]);
    let fileId: string;
    try {
      fileId = await this.cloudCore.uploadFile({
        // onedrive-core prefixes its own mokuro-reader root, so pass just the
        // bare series title here.
        seriesTitle,
        filename,
        blob: blobToUpload,
        credentials,
        onProgress
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ProviderError(
        `OneDrive upload failed: ${message}`,
        'onedrive',
        'UPLOAD_FAILED',
        /\b401\b/.test(message),
        /network|timed out|\b429\b|\b5\d\d\b/i.test(message)
      );
    }
    console.log(`✅ Uploaded ${path} to OneDrive`);
    return fileId;
  }

  async downloadFile(
    file: CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const credentials = await this.getWorkerDownloadCredentials(file.fileId);
    let buffer: ArrayBuffer;
    try {
      buffer = await this.cloudCore.downloadFile({
        fileId: file.fileId,
        credentials,
        onProgress: onProgress || (() => {})
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ProviderError(
        `OneDrive download failed: ${message}`,
        'onedrive',
        'DOWNLOAD_FAILED',
        /\b401\b/.test(message),
        /network|timed out|\b429\b|\b5\d\d\b/i.test(message)
      );
    }
    return new Blob([buffer], { type: 'application/zip' });
  }

  async deleteFile(file: CloudFileMetadata): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const token = await onedriveTokenManager.getAccessToken();
    await deleteItem(token, file.fileId);
    console.log(`✅ Deleted ${file.path} from OneDrive`);
  }

  async renameFile(file: CloudFileMetadata, newPath: string): Promise<CloudFileMetadata> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const normalizedNew = newPath.replace(/^\/+|\/+$/g, '');
    if (file.path === normalizedNew) return file;

    const token = await onedriveTokenManager.getAccessToken();
    const newFilename = normalizedNew.split('/').pop() ?? normalizedNew;
    const newParent = normalizedNew.split('/').slice(0, -1).join('/');
    const destFolderPath = newParent
      ? `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${newParent}`
      : ONEDRIVE_CONFIG.MOKURO_FOLDER;

    if (newParent) {
      await this.ensureSeriesFolder(newParent);
    } else {
      await this.ensureMokuroFolder();
    }

    const destParentItem = await getItemByPath(token, destFolderPath);
    if (!destParentItem) {
      throw new ProviderError(
        `Destination folder '${destFolderPath}' could not be resolved`,
        'onedrive',
        'NOT_FOUND'
      );
    }

    const updated = await patchItem(token, file.fileId, {
      name: newFilename,
      parentReference: { id: destParentItem.id }
    });

    return {
      provider: 'onedrive',
      fileId: updated.id,
      path: normalizedNew,
      modifiedTime: updated.lastModifiedDateTime ?? new Date().toISOString(),
      size: updated.size ?? file.size
    };
  }

  async renameFolder(oldPath: string, newPath: string): Promise<CloudFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const normalizedOld = oldPath.replace(/^\/+|\/+$/g, '');
    const normalizedNew = newPath.replace(/^\/+|\/+$/g, '');
    if (normalizedOld === normalizedNew) {
      return (await this.listCloudVolumes()).filter((f) => f.path.startsWith(`${normalizedOld}/`));
    }

    const token = await onedriveTokenManager.getAccessToken();
    const sourcePath = `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${normalizedOld}`;
    const sourceItem = await getItemByPath(token, sourcePath);
    if (!sourceItem) {
      throw new ProviderError(
        `Source folder '${normalizedOld}' not found`,
        'onedrive',
        'NOT_FOUND'
      );
    }

    const newParent = normalizedNew.split('/').slice(0, -1).join('/');
    const newName = normalizedNew.split('/').pop() ?? normalizedNew;
    const destParentPath = newParent
      ? `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${newParent}`
      : ONEDRIVE_CONFIG.MOKURO_FOLDER;
    if (newParent) await this.ensureSeriesFolder(newParent);
    const destParentItem = await getItemByPath(token, destParentPath);
    if (!destParentItem) {
      throw new ProviderError(
        `Destination parent '${destParentPath}' could not be resolved`,
        'onedrive',
        'NOT_FOUND'
      );
    }

    await patchItem(token, sourceItem.id, {
      name: newName,
      parentReference: { id: destParentItem.id }
    });

    const all = await this.listCloudVolumes();
    return all.filter((f) => f.path.startsWith(`${normalizedNew}/`));
  }

  async deleteSeriesFolder(seriesTitle: string): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const normalized = seriesTitle.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;
    const token = await onedriveTokenManager.getAccessToken();
    const path = `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${normalized}`;
    const item = await getItemByPath(token, path);
    if (!item) return;
    await deleteItem(token, item.id);
    console.log(`✅ Deleted series folder '${seriesTitle}' from OneDrive`);
  }

  /**
   * Remove a series directory only if the SERVER confirms it is empty — never
   * a blind recursive delete (Graph folder deletion is recursive). Best-effort:
   * an orphaned empty directory is harmless.
   */
  async removeDirectoryIfEmpty(relativePath: string): Promise<void> {
    if (!this.isAuthenticated()) return;
    const normalized = relativePath.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;
    try {
      const token = await onedriveTokenManager.getAccessToken();
      const path = `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${normalized}`;
      const item = await getItemByPath(token, path);
      if (!item || !item.folder) return;
      const children = await listChildren(token, path);
      if (children.length > 0) return;
      await deleteItem(token, item.id);
      console.log(`✅ Pruned empty series folder '${normalized}' from OneDrive`);
    } catch (error) {
      console.warn(`Could not prune OneDrive folder '${normalized}':`, error);
    }
  }

  async getStorageQuota(): Promise<StorageQuota> {
    if (!this.isAuthenticated()) {
      return { used: 0, total: null, available: null };
    }
    const token = await onedriveTokenManager.getAccessToken();
    const quota = await getDriveQuota(token);
    return {
      used: quota.used,
      total: quota.total || null,
      available: quota.remaining ?? null
    };
  }

  /**
   * Called by backup-queue before worker upload starts. We ensure the
   * destination series folder exists so the worker's createUploadSession
   * call doesn't 404 on a missing parent.
   */
  async prepareUploadTarget(seriesTitle: string): Promise<void> {
    if (!this.isAuthenticated()) return;
    if (seriesTitle) {
      await this.ensureSeriesFolder(seriesTitle);
    } else {
      await this.ensureMokuroFolder();
    }
  }

  async getWorkerUploadCredentials(): Promise<Record<string, any>> {
    const accessToken = await onedriveTokenManager.getAccessToken();
    return { accessToken };
  }

  async getWorkerDownloadCredentials(_fileId: string): Promise<Record<string, any>> {
    const accessToken = await onedriveTokenManager.getAccessToken();
    return { accessToken };
  }
}

export const onedriveProvider = new OneDriveProvider();

// Self-register cache when module is loaded (same pattern as other providers)
import { cacheManager } from '../../cache-manager';
import { onedriveCache } from './onedrive-cache';
cacheManager.registerCache('onedrive', onedriveCache);
