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
  patchItem,
  type DriveItem
} from './graph-client';
import { getCloudProviderCore } from '../../core/cloud-provider-core-registry';

function isSyncableFile(path: string): boolean {
  const lower = path.toLowerCase();
  const basename = lower.split('/').filter(Boolean).pop() ?? '';
  if (basename === 'volume-data.json' || basename === 'profiles.json') return true;
  return (
    basename.endsWith('.cbz') ||
    basename.endsWith('.mokuro') ||
    basename.endsWith('.mokuro.gz') ||
    basename.endsWith('.webp')
  );
}

export class OneDriveProvider implements SyncProvider {
  readonly type = 'onedrive' as const;
  readonly name = 'OneDrive';
  readonly supportsWorkerDownload = true;
  readonly supportsWorkerUpload = true;
  readonly uploadConcurrencyLimit = 4;
  readonly downloadConcurrencyLimit = 4;

  private cloudCore = getCloudProviderCore('onedrive');
  private initPromise: Promise<void>;

  constructor() {
    if (browser) {
      this.initPromise = onedriveTokenManager.initialize().catch((error) => {
        console.warn('OneDrive MSAL init failed (will retry on login):', error);
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
    try {
      await onedriveTokenManager.login();
      await this.ensureMokuroFolder();
      setActiveProviderKey('onedrive');
      console.log('✅ OneDrive login successful');
    } catch (error) {
      throw new ProviderError(
        `OneDrive login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'onedrive',
        'LOGIN_FAILED',
        true
      );
    }
  }

  async logout(): Promise<void> {
    await onedriveTokenManager.logout();
    clearActiveProviderKey();
    console.log('OneDrive logged out');
  }

  async reauthenticate(): Promise<void> {
    await onedriveTokenManager.reauthenticate();
  }

  private async ensureMokuroFolder(): Promise<string> {
    const token = await onedriveTokenManager.getAccessToken();
    const existing = await getItemByPath(token, ONEDRIVE_CONFIG.MOKURO_FOLDER);
    if (existing) return existing.id;
    const created = await createFolder(token, '', ONEDRIVE_CONFIG.MOKURO_FOLDER);
    console.log(`Created ${ONEDRIVE_CONFIG.MOKURO_FOLDER} folder in OneDrive`);
    return created.id;
  }

  private async ensureSeriesFolder(seriesTitle: string): Promise<string> {
    const token = await onedriveTokenManager.getAccessToken();
    const path = `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${seriesTitle}`;
    const existing = await getItemByPath(token, path);
    if (existing) return existing.id;
    await this.ensureMokuroFolder();
    const created = await createFolder(token, ONEDRIVE_CONFIG.MOKURO_FOLDER, seriesTitle);
    return created.id;
  }

  async listCloudVolumes(): Promise<CloudFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'onedrive', 'NOT_AUTHENTICATED', true);
    }
    const token = await onedriveTokenManager.getAccessToken();

    const results: CloudFileMetadata[] = [];

    const walk = async (path: string): Promise<void> => {
      const children = await listChildren(token, path).catch((error) => {
        // If the root mokuro folder doesn't exist, treat as empty
        if (error instanceof Error && error.message.includes('404')) {
          return [] as DriveItem[];
        }
        throw error;
      });
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
          : new Blob([blob.buffer as ArrayBuffer]);
    const fileId = await this.cloudCore.uploadFile({
      seriesTitle: `${ONEDRIVE_CONFIG.MOKURO_FOLDER}${seriesTitle ? `/${seriesTitle}` : ''}`,
      filename,
      blob: blobToUpload,
      credentials,
      onProgress
    });
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
    const buffer = await this.cloudCore.downloadFile({
      fileId: file.fileId,
      credentials,
      onProgress: onProgress || (() => {})
    });
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
