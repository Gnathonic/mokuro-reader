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

  private requireRoot(): FileSystemDirectoryHandle {
    if (!this.rootHandle) {
      throw new ProviderError(
        'Filesystem provider is not connected',
        'filesystem',
        'NOT_AUTHENTICATED',
        true
      );
    }
    return this.rootHandle;
  }

  private async resolveDirectoryHandle(
    relativePath: string,
    options: { create: boolean }
  ): Promise<FileSystemDirectoryHandle> {
    const segments = splitPathSegments(relativePath);
    let handle: FileSystemDirectoryHandle = this.requireRoot();
    for (const segment of segments) {
      handle = await handle.getDirectoryHandle(segment, { create: options.create });
    }
    return handle;
  }

  private async resolveFileHandle(
    relativePath: string,
    options: { create: boolean }
  ): Promise<FileSystemFileHandle> {
    const parentPath = getParentPath(relativePath);
    const filename = getBasename(relativePath);
    if (!filename) {
      throw new ProviderError(`Invalid file path '${relativePath}'`, 'filesystem', 'INVALID_PATH');
    }
    const parent = parentPath
      ? await this.resolveDirectoryHandle(parentPath, { create: options.create })
      : this.requireRoot();
    return parent.getFileHandle(filename, { create: options.create });
  }

  private async *walkDirectory(
    dir: FileSystemDirectoryHandle,
    prefix: string
  ): AsyncGenerator<{ path: string; fileHandle: FileSystemFileHandle }> {
    // @ts-expect-error — values() is defined on FileSystemDirectoryHandle at runtime; TS lib may not have it
    for await (const entry of dir.values()) {
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        yield* this.walkDirectory(entry as FileSystemDirectoryHandle, entryPath);
      } else if (entry.kind === 'file') {
        yield { path: entryPath, fileHandle: entry as FileSystemFileHandle };
      }
    }
  }

  async listCloudVolumes(): Promise<CloudFileMetadata[]> {
    const root = this.requireRoot();
    const results: CloudFileMetadata[] = [];
    for await (const { path, fileHandle } of this.walkDirectory(root, '')) {
      if (!isSyncableFile(path)) continue;
      const file = await fileHandle.getFile();
      results.push({
        provider: 'filesystem',
        fileId: path,
        path,
        modifiedTime: new Date(file.lastModified).toISOString(),
        size: file.size
      });
    }
    console.log(`✅ Listed ${results.length} files from filesystem provider`);
    return results;
  }

  async uploadFile(
    path: string,
    blob: UploadPayload,
    _description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    this.requireRoot();
    const fileHandle = await this.resolveFileHandle(path, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      const payload =
        blob instanceof Blob
          ? blob
          : blob instanceof ArrayBuffer
            ? new Blob([blob])
            : new Blob([new Uint8Array(blob).buffer as ArrayBuffer]);
      await writable.write(payload);
      onProgress?.(payload.size, payload.size);
    } finally {
      await writable.close();
    }
    console.log(`✅ Uploaded ${path} to filesystem`);
    return path;
  }

  async downloadFile(
    file: CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    this.requireRoot();
    const fileHandle = await this.resolveFileHandle(file.fileId, { create: false });
    const data = await fileHandle.getFile();
    onProgress?.(data.size, data.size);
    console.log(`✅ Downloaded ${file.path} from filesystem`);
    return data;
  }

  async deleteFile(file: CloudFileMetadata): Promise<void> {
    this.requireRoot();
    const parentPath = getParentPath(file.fileId);
    const filename = getBasename(file.fileId);
    const parent = parentPath
      ? await this.resolveDirectoryHandle(parentPath, { create: false })
      : this.requireRoot();
    await parent.removeEntry(filename);
    console.log(`✅ Deleted ${file.path} from filesystem`);
  }

  async renameFile(file: CloudFileMetadata, newPath: string): Promise<CloudFileMetadata> {
    this.requireRoot();
    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (file.path === normalizedNewPath) {
      return file;
    }

    // Read source
    const sourceHandle = await this.resolveFileHandle(file.fileId, { create: false });
    const sourceFile = await sourceHandle.getFile();

    // Write to destination
    const destHandle = await this.resolveFileHandle(normalizedNewPath, { create: true });
    const writable = await destHandle.createWritable();
    try {
      await writable.write(sourceFile);
    } finally {
      await writable.close();
    }

    // Delete source
    const sourceParentPath = getParentPath(file.fileId);
    const sourceParent = sourceParentPath
      ? await this.resolveDirectoryHandle(sourceParentPath, { create: false })
      : this.requireRoot();
    await sourceParent.removeEntry(getBasename(file.fileId));

    console.log(`✅ Renamed ${file.path} → ${normalizedNewPath} in filesystem`);
    const destFile = await destHandle.getFile();
    return {
      provider: 'filesystem',
      fileId: normalizedNewPath,
      path: normalizedNewPath,
      modifiedTime: new Date(destFile.lastModified).toISOString(),
      size: destFile.size
    };
  }

  async renameFolder(oldPath: string, newPath: string): Promise<CloudFileMetadata[]> {
    this.requireRoot();
    const normalizedOld = oldPath.replace(/^\/+|\/+$/g, '');
    const normalizedNew = newPath.replace(/^\/+|\/+$/g, '');
    if (normalizedOld === normalizedNew) {
      const all = await this.listCloudVolumes();
      return all.filter((f) => f.path.startsWith(`${normalizedOld}/`));
    }

    // List all files currently under the old folder and rename each one
    const all = await this.listCloudVolumes();
    const affected = all.filter((f) => f.path.startsWith(`${normalizedOld}/`));
    const renamed: CloudFileMetadata[] = [];
    for (const file of affected) {
      const suffix = file.path.slice(normalizedOld.length);
      const target = `${normalizedNew}${suffix}`;
      renamed.push(await this.renameFile(file, target));
    }

    // Best-effort cleanup of the now-empty old folder
    try {
      const parentPath = getParentPath(normalizedOld);
      const parent = parentPath
        ? await this.resolveDirectoryHandle(parentPath, { create: false })
        : this.requireRoot();
      await parent.removeEntry(getBasename(normalizedOld), { recursive: true });
    } catch {
      // Already gone or never existed — fine
    }

    console.log(`✅ Renamed folder ${normalizedOld} → ${normalizedNew} in filesystem`);
    return renamed;
  }

  async deleteSeriesFolder(seriesTitle: string): Promise<void> {
    const root = this.requireRoot();
    const normalized = seriesTitle.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;
    try {
      await root.removeEntry(normalized, { recursive: true });
      console.log(`✅ Deleted series folder '${seriesTitle}' from filesystem`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        console.log(`Series folder '${seriesTitle}' not found in filesystem`);
        return;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ProviderError(
        `Failed to delete series folder: ${message}`,
        'filesystem',
        'DELETE_FAILED'
      );
    }
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
