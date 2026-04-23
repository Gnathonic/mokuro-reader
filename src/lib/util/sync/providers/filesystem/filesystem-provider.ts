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
import { isFilesystemProviderSupported } from './feature-detect';
import { saveRootHandle, loadRootHandle, clearRootHandle } from './handle-store';
import { splitPathSegments, isSyncableFile, getBasename, getParentPath } from './filesystem-paths';

export class FilesystemProvider implements SyncProvider {
  readonly type = 'filesystem' as const;
  readonly name = 'Local Folder';
  readonly supportsWorkerDownload = false;
  readonly uploadConcurrencyLimit = 4;
  readonly downloadConcurrencyLimit = 4;

  private rootHandle: FileSystemDirectoryHandle | null = null;
  private hasStoredHandle = false;
  private initPromise: Promise<void>;

  constructor() {
    if (browser && isFilesystemProviderSupported()) {
      this.initPromise = this.restoreHandle();
    } else {
      this.initPromise = Promise.resolve();
    }
  }

  async whenReady(): Promise<void> {
    await this.initPromise;
  }

  isAuthenticated(): boolean {
    return this.rootHandle !== null;
  }

  getStatus(): ProviderStatus {
    return {
      isAuthenticated: this.isAuthenticated(),
      hasStoredCredentials: this.hasStoredHandle,
      needsAttention: this.hasStoredHandle && !this.isAuthenticated(),
      statusMessage: this.isAuthenticated()
        ? `Connected to folder "${this.rootHandle?.name ?? ''}"`
        : this.hasStoredHandle
          ? 'Folder permission needs to be reconnected'
          : 'Not configured'
    };
  }

  async login(_credentials?: ProviderCredentials): Promise<void> {
    if (!browser || !isFilesystemProviderSupported()) {
      throw new ProviderError(
        'File System Access API is not available in this browser',
        'filesystem',
        'UNSUPPORTED'
      );
    }

    let handle: FileSystemDirectoryHandle;
    try {
      // @ts-expect-error — File System Access API is Chromium-only, no lib.dom typing in all TS targets
      handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (error) {
      // User cancelled the picker or permission dismissed
      const message = error instanceof Error ? error.message : 'Folder selection cancelled';
      throw new ProviderError(message, 'filesystem', 'PICKER_CANCELLED');
    }

    // @ts-expect-error — requestPermission is Chromium-only, not in all TS lib.dom targets
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      throw new ProviderError(
        'Read-write permission was not granted for the selected folder',
        'filesystem',
        'PERMISSION_DENIED'
      );
    }

    this.rootHandle = handle;
    this.hasStoredHandle = true;
    await saveRootHandle(handle);
    setActiveProviderKey('filesystem');
    console.log(`✅ Filesystem provider connected to folder "${handle.name}"`);
  }

  async logout(): Promise<void> {
    this.rootHandle = null;
    this.hasStoredHandle = false;
    await clearRootHandle();
    clearActiveProviderKey();
    console.log('Filesystem provider logged out');
  }

  /**
   * Re-attempt to acquire read-write permission on the previously stored handle.
   * Must be called from a user-gesture event handler (button click).
   * Returns true on success, false if the user denied or the handle is invalid.
   */
  async reauthenticate(): Promise<void> {
    if (!this.hasStoredHandle) {
      throw new ProviderError('No stored folder to reconnect', 'filesystem', 'NOT_CONFIGURED');
    }
    const stored = await loadRootHandle();
    if (!stored) {
      this.hasStoredHandle = false;
      throw new ProviderError('Stored folder reference is missing', 'filesystem', 'NOT_CONFIGURED');
    }
    // @ts-expect-error — requestPermission is Chromium-only, not in all TS lib.dom targets
    const permission = await stored.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      // Keep the stored handle — user may grant on a later attempt
      throw new ProviderError('Permission was not granted', 'filesystem', 'PERMISSION_DENIED');
    }
    this.rootHandle = stored;
    setActiveProviderKey('filesystem');
    console.log(`✅ Filesystem provider reconnected to folder "${stored.name}"`);
  }

  private async restoreHandle(): Promise<void> {
    try {
      const stored = await loadRootHandle();
      if (!stored) return;
      this.hasStoredHandle = true;
      // @ts-expect-error — queryPermission is Chromium-only, not in all TS lib.dom targets
      const permission = await stored.queryPermission({ mode: 'readwrite' });
      if (permission === 'granted') {
        this.rootHandle = stored;
        console.log(`✅ Filesystem provider restored folder "${stored.name}"`);
      } else if (permission === 'denied') {
        // Clear on outright denial
        this.hasStoredHandle = false;
        await clearRootHandle();
        clearActiveProviderKey();
      }
      // 'prompt' → leave rootHandle null; UI will show "Reconnect"
    } catch (error) {
      console.warn('Failed to restore filesystem handle:', error);
    }
  }

  // Placeholder bodies — filled in by Task 9
  async listCloudVolumes(): Promise<CloudFileMetadata[]> {
    throw new Error('not implemented yet');
  }

  async uploadFile(
    _path: string,
    _blob: UploadPayload,
    _description?: string,
    _onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    throw new Error('not implemented yet');
  }

  async downloadFile(
    _file: CloudFileMetadata,
    _onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    throw new Error('not implemented yet');
  }

  async deleteFile(_file: CloudFileMetadata): Promise<void> {
    throw new Error('not implemented yet');
  }

  async renameFile(_file: CloudFileMetadata, _newPath: string): Promise<CloudFileMetadata> {
    throw new Error('not implemented yet');
  }

  async renameFolder(_oldPath: string, _newPath: string): Promise<CloudFileMetadata[]> {
    throw new Error('not implemented yet');
  }

  async deleteSeriesFolder(_seriesTitle: string): Promise<void> {
    throw new Error('not implemented yet');
  }

  async getStorageQuota(): Promise<StorageQuota> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
      return { used: 0, total: null, available: null };
    }
    const estimate = await navigator.storage.estimate();
    const used = estimate.usage ?? 0;
    const total = estimate.quota ?? null;
    const available = total !== null ? total - used : null;
    return { used, total, available };
  }
}

export const filesystemProvider = new FilesystemProvider();

// Self-register cache when module is loaded (same pattern as MEGA/WebDAV)
import { cacheManager } from '../../cache-manager';
import { filesystemCache } from './filesystem-cache';
cacheManager.registerCache('filesystem', filesystemCache);
