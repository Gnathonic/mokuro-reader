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
  readonly supportsWorkerUpload = false;
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
    let permission: string;
    try {
      // @ts-expect-error — requestPermission is Chromium-only, not in all TS lib.dom targets
      permission = await stored.requestPermission({ mode: 'readwrite' });
    } catch (error) {
      // Handle is dead (folder deleted/moved) — clear it so login() offers a fresh picker.
      console.warn('Stored filesystem handle is unusable; clearing:', error);
      this.hasStoredHandle = false;
      await clearRootHandle().catch(() => {});
      clearActiveProviderKey();
      throw new ProviderError(
        'The previously chosen folder no longer exists — choose a folder again',
        'filesystem',
        'NOT_CONFIGURED'
      );
    }
    if (permission !== 'granted') {
      // Keep the stored handle — user may grant on a later attempt
      throw new ProviderError('Permission was not granted', 'filesystem', 'PERMISSION_DENIED');
    }
    this.rootHandle = stored;
    setActiveProviderKey('filesystem');
    console.log(`✅ Filesystem provider reconnected to folder "${stored.name}"`);
  }

  private async restoreHandle(): Promise<void> {
    let stored: FileSystemDirectoryHandle | null = null;
    try {
      stored = await loadRootHandle();
    } catch (error) {
      // IndexedDB read failed (transient) — keep config; a reload can retry.
      console.warn('Failed to load stored filesystem handle:', error);
      return;
    }
    if (!stored) return;
    this.hasStoredHandle = true;
    try {
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
      // queryPermission threw: the handle itself is dead (folder deleted or
      // moved). Clear it so the user gets a fresh picker instead of a
      // Reconnect button that can never succeed.
      console.warn('Stored filesystem handle is unusable; clearing:', error);
      this.hasStoredHandle = false;
      await clearRootHandle().catch(() => {});
      clearActiveProviderKey();
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

  /** Refresh provider-manager status after an in-provider state change
   *  (dynamic import avoids a circular dependency — same as WebDAV). */
  private notifyStatusChanged(): void {
    import('../../provider-manager').then(({ providerManager }) => {
      providerManager.updateStatus();
    });
  }

  /**
   * Convert raw File System Access API failures into typed ProviderErrors.
   * NOT_FOUND code + "not found" message are load-bearing: unified-cloud-manager
   * keys idempotent deletes off the code, and unified-sync-service sniffs the
   * message for missing-file-is-fine paths. Matches on error.name (not
   * instanceof DOMException) so cross-realm exceptions classify too.
   */
  private toProviderError(error: unknown, operation: string, path: string): ProviderError {
    if (error instanceof ProviderError) return error;
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotFoundError') {
      return new ProviderError(
        `${operation} failed: '${path}' not found`,
        'filesystem',
        'NOT_FOUND'
      );
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      // Permission revoked mid-session — flip to needs-reconnect so the UI
      // stops pretending we're connected.
      this.rootHandle = null;
      this.notifyStatusChanged();
      return new ProviderError(
        `${operation} failed: folder permission was revoked`,
        'filesystem',
        'PERMISSION_REVOKED',
        true
      );
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new ProviderError(`${operation} failed: ${message}`, 'filesystem', 'OPERATION_FAILED');
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
    try {
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
    } catch (error) {
      throw this.toProviderError(error, 'List', '');
    }
  }

  async uploadFile(
    path: string,
    blob: UploadPayload,
    _description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    try {
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
    } catch (error) {
      throw this.toProviderError(error, 'Upload', path);
    }
  }

  async downloadFile(
    file: CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    try {
      this.requireRoot();
      const fileHandle = await this.resolveFileHandle(file.fileId, { create: false });
      const data = await fileHandle.getFile();
      onProgress?.(data.size, data.size);
      console.log(`✅ Downloaded ${file.path} from filesystem`);
      return data;
    } catch (error) {
      throw this.toProviderError(error, 'Download', file.path);
    }
  }

  async deleteFile(file: CloudFileMetadata): Promise<void> {
    try {
      this.requireRoot();
      const parentPath = getParentPath(file.fileId);
      const filename = getBasename(file.fileId);
      const parent = parentPath
        ? await this.resolveDirectoryHandle(parentPath, { create: false })
        : this.requireRoot();
      await parent.removeEntry(filename);
      console.log(`✅ Deleted ${file.path} from filesystem`);
    } catch (error) {
      throw this.toProviderError(error, 'Delete', file.path);
    }
  }

  async renameFile(file: CloudFileMetadata, newPath: string): Promise<CloudFileMetadata> {
    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    try {
      this.requireRoot();
      if (file.path === normalizedNewPath) {
        return file;
      }

      // Read source
      let sourceFile: File;
      try {
        const sourceHandle = await this.resolveFileHandle(file.fileId, { create: false });
        sourceFile = await sourceHandle.getFile();
      } catch (error) {
        if (error instanceof Error && error.name === 'NotFoundError') {
          // Idempotent retry: copy-then-delete isn't atomic, so a prior attempt
          // may have completed. Source gone + destination matching the source's
          // recorded size = already renamed (same convergence rule as WebDAV).
          const converged = await this.findConvergedRename(file, normalizedNewPath);
          if (converged) return converged;
        }
        throw error;
      }

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
    } catch (error) {
      throw this.toProviderError(error, 'Rename', file.path);
    }
  }

  /**
   * Check whether a rename already completed in a prior attempt: destination
   * exists and its size matches the source's recorded size. Returns its
   * metadata, or null when there is no matching destination.
   */
  private async findConvergedRename(
    file: CloudFileMetadata,
    normalizedNewPath: string
  ): Promise<CloudFileMetadata | null> {
    try {
      const destHandle = await this.resolveFileHandle(normalizedNewPath, { create: false });
      const destFile = await destHandle.getFile();
      if (typeof file.size === 'number' && destFile.size === file.size) {
        console.log(`↩️ ${normalizedNewPath} already at destination (idempotent retry)`);
        return {
          provider: 'filesystem',
          fileId: normalizedNewPath,
          path: normalizedNewPath,
          modifiedTime: new Date(destFile.lastModified).toISOString(),
          size: destFile.size
        };
      }
    } catch {
      // No destination either — caller falls through to the typed NOT_FOUND.
    }
    return null;
  }

  async renameFolder(oldPath: string, newPath: string): Promise<CloudFileMetadata[]> {
    try {
      return await this.renameFolderInner(oldPath, newPath);
    } catch (error) {
      throw this.toProviderError(error, 'Rename folder', oldPath);
    }
  }

  private async renameFolderInner(oldPath: string, newPath: string): Promise<CloudFileMetadata[]> {
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

    // Best-effort cleanup of the now-empty old folder.
    // Skip when the new path nests inside the old folder (e.g. "Series" -> "Series/Archive"):
    // the renamed files now live under the old folder, so a recursive delete would destroy
    // the very files we just wrote.
    const newNestsUnderOld = normalizedNew.startsWith(`${normalizedOld}/`);
    if (!newNestsUnderOld) {
      try {
        const parentPath = getParentPath(normalizedOld);
        const parent = parentPath
          ? await this.resolveDirectoryHandle(parentPath, { create: false })
          : this.requireRoot();
        await parent.removeEntry(getBasename(normalizedOld), { recursive: true });
      } catch {
        // Already gone or never existed — fine
      }
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
    // navigator.storage.estimate() reports the browser-origin quota, which has
    // nothing to do with the chosen folder's free disk space. Report "unknown"
    // rather than a misleading number; the UI hides bars for null totals.
    return { used: 0, total: null, available: null };
  }
}

export const filesystemProvider = new FilesystemProvider();

// Self-register cache when module is loaded (same pattern as MEGA/WebDAV)
import { cacheManager } from '../../cache-manager';
import { filesystemCache } from './filesystem-cache';
cacheManager.registerCache('filesystem', filesystemCache);
