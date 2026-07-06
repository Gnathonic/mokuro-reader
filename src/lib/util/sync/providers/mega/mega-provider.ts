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
import { megaCache } from './mega-cache';
import { cacheManager } from '../../cache-manager';
import { setActiveProviderKey, clearActiveProviderKey } from '../../provider-detection';
import { isCbzFile, isSidecarFile, isRootConfigFile } from '../../syncable-file';
import type { FolderOperations, FolderInfo, FolderItem } from '../../folder-deduplicator';
import {
  isMfaRequiredError,
  isSessionExpiredError,
  isAuthRejectionError,
  sanitizeSessionBlob,
  encodeMegaKey,
  type MegaSessionBlob
} from './mega-session';

interface MegaCredentials {
  email: string;
  password: string;
  /** One-time TOTP code for 2FA-enabled accounts. Never persisted. */
  secondFactorCode?: string;
}

const STORAGE_KEYS = {
  /** Sanitized Storage.toJSON() blob (sid + master key). The only persisted secret. */
  SESSION: 'mega_session',
  // Legacy keys — read for migration, removed on first successful login.
  EMAIL: 'mega_email',
  PASSWORD: 'mega_password',
  FOLDER_PATH: 'mega_folder_path'
};

const MOKURO_FOLDER = 'mokuro-reader';
const VOLUME_DATA_FILE = 'volume-data.json';
const PROFILES_FILE = 'profiles.json';
function getUploadPayloadSize(payload: UploadPayload): number {
  if (payload instanceof Blob) return payload.size;
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  return payload.byteLength;
}

/**
 * Exponential backoff with jitter for retrying MEGA API calls
 */
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 8,
  baseDelay: number = 500,
  operationName: string = 'operation'
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // Check if error is retryable (EAGAIN, rate limit, temporary congestion)
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isRetryable =
        errorMessage.includes('EAGAIN') ||
        errorMessage.includes('congestion') ||
        errorMessage.includes('rate') ||
        errorMessage.includes('429');

      if (!isRetryable || attempt === maxRetries) {
        // Non-retryable error or max retries reached
        throw error;
      }

      // Calculate exponential backoff with jitter
      // Formula: delay = baseDelay * 2^attempt + random(0, 1000)
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const jitter = Math.random() * 1000;
      const delay = exponentialDelay + jitter;

      console.warn(
        `${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMessage}. Retrying in ${Math.round(delay)}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/** megajs surfaces a server-side missing node as `ENOENT (-9)`. */
function isMegaNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ENOENT') || message.includes('(-9)');
}

/** megajs surfaces a full account as `EOVERQUOTA (-17)`. */
function isMegaOverQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('EOVERQUOTA') || message.includes('(-17)');
}

/**
 * Smart retry wrapper for MEGA operations that may fail due to stale cache
 * When two devices sync back and forth, file IDs change but local cache is stale
 * This wrapper detects ENOENT errors, refreshes the cache, and retries once
 */
async function retryWithCacheRefresh<T>(
  operation: () => Promise<T>,
  operationName: string = 'operation',
  forceReload?: () => Promise<void>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if error is ENOENT (file/object not found)
    const isStaleCache =
      errorMessage.includes('ENOENT') ||
      errorMessage.includes('not found') ||
      errorMessage.includes('Object');

    if (isStaleCache) {
      console.warn(
        `${operationName} failed with ENOENT - cache may be stale. Waiting for MEGA to sync and retrying...`
      );

      // Give MEGA time to propagate server changes to storage.files
      // MEGA.js updates storage.files via events, but server changes take time
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Force reload of MEGA's storage.files if provided
      if (forceReload) {
        await forceReload();
      }

      // Refresh our app's cloud cache from MEGA's now-fresh storage.files
      // Skip reinitialize since forceReload already did that
      await megaCache.fetch(true);

      // Retry the operation once with fresh cache
      try {
        return await operation();
      } catch (retryError) {
        console.error(`${operationName} failed again after cache refresh:`, retryError);
        throw retryError;
      }
    }

    // Non-stale-cache error, throw immediately
    throw error;
  }
}

export class MegaProvider implements SyncProvider {
  readonly type = 'mega' as const;
  readonly name = 'MEGA';
  readonly supportsWorkerDownload = true; // Workers download owned nodes via sid + per-file key
  readonly supportsWorkerUpload = true;
  readonly uploadConcurrencyLimit = 6;
  readonly downloadConcurrencyLimit = 6;

  private storage: any = null;
  private mokuroFolder: any = null;
  private needsReconnect = false;
  private reconnectEmail: string | null = null;
  private initPromise: Promise<void>;

  // Mutexes preventing concurrent uploads from racing to create the same folder.
  // Without these, N parallel uploads each find no folder and call mkdir N times.
  private mokuroFolderPromise: Promise<any> | null = null;
  private seriesFolderPromises = new Map<string, Promise<any>>();

  private cacheRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Reactive cache: megajs's sc stream applies every change (ours AND other
   * devices') to storage.files and emits these events. A debounced rebuild
   * from that now-authoritative tree keeps the UI cache — and therefore the
   * GUI, which subscribes to it — in sync without any forced refreshes.
   * The unified manager's incremental cache updates still give instant
   * feedback for our own operations; this converges everything shortly after.
   */
  private attachChangeListeners(storage: any): void {
    const schedule = () => {
      if (this.cacheRefreshTimer) clearTimeout(this.cacheRefreshTimer);
      this.cacheRefreshTimer = setTimeout(() => {
        this.cacheRefreshTimer = null;
        if (this.storage !== storage) return; // logged out / replaced
        megaCache.fetch(true).catch((err) => {
          console.error('[MEGA] reactive cache refresh failed:', err);
        });
      }, 500);
    };
    for (const event of ['add', 'move', 'delete', 'update']) {
      storage.on(event, schedule);
    }
  }

  constructor() {
    if (browser) {
      this.initPromise = this.restorePersistedSession();
    } else {
      this.initPromise = Promise.resolve();
    }
  }

  /**
   * Wait for provider initialization to complete
   * Use this to ensure credentials have been restored before checking authentication
   */
  async whenReady(): Promise<void> {
    await this.initPromise;
  }

  isAuthenticated(): boolean {
    return this.storage !== null;
  }

  getStatus(): ProviderStatus {
    const hasSession = !!(browser && localStorage.getItem(STORAGE_KEYS.SESSION));
    const hasLegacy = !!(
      browser &&
      localStorage.getItem(STORAGE_KEYS.EMAIL) &&
      localStorage.getItem(STORAGE_KEYS.PASSWORD)
    );
    const isConnected = this.isAuthenticated();

    return {
      isAuthenticated: isConnected,
      hasStoredCredentials: hasSession || hasLegacy,
      needsAttention: this.needsReconnect,
      statusMessage: isConnected
        ? 'Connected to MEGA'
        : this.needsReconnect
          ? 'MEGA session expired — please reconnect'
          : hasSession || hasLegacy
            ? 'Configured (not connected)'
            : 'Not configured'
    };
  }

  /** Drop the stored session and flag the UI to prompt for reconnect (password never stored). */
  private markSessionExpired(): void {
    // Capture email for reconnect pre-fill before clearing.
    if (browser && !this.reconnectEmail) {
      const sessionRaw = localStorage.getItem(STORAGE_KEYS.SESSION);
      if (sessionRaw) {
        try {
          this.reconnectEmail = JSON.parse(sessionRaw)?.options?.email ?? null;
        } catch {
          /* ignore */
        }
      }
      this.reconnectEmail = this.reconnectEmail ?? localStorage.getItem(STORAGE_KEYS.EMAIL);
    }

    this.storage = null;
    this.mokuroFolder = null;
    this.needsReconnect = true;

    if (browser) {
      localStorage.removeItem(STORAGE_KEYS.SESSION);
      // Keep active_cloud_provider so the UI still shows MEGA in a needs-attention state.
    }
  }

  /** Email captured for reconnect pre-fill (mirrors WebDAV's getLastUsername). */
  getLastUsername(): string | null {
    if (this.reconnectEmail) return this.reconnectEmail;
    if (!browser) return null;
    const sessionRaw = localStorage.getItem(STORAGE_KEYS.SESSION);
    if (sessionRaw) {
      try {
        return JSON.parse(sessionRaw)?.options?.email ?? null;
      } catch {
        return null;
      }
    }
    return localStorage.getItem(STORAGE_KEYS.EMAIL);
  }

  async login(credentials?: ProviderCredentials): Promise<void> {
    if (!credentials || !credentials.email || !credentials.password) {
      throw new ProviderError('Email and password are required', 'mega', 'INVALID_CREDENTIALS');
    }

    const { email, password, secondFactorCode } = credentials as MegaCredentials;

    try {
      // Dynamically import megajs to reduce initial bundle size
      const { Storage } = await import('megajs');

      // Fresh interactive login. The constructor cb fires after the tree loads
      // (autoload:true), so the Storage is ready once this promise resolves.
      // keepalive:true runs megajs's server-change (sc) long-poll: it is what
      // applies moves/deletes to the local tree and emits the add/move/delete/
      // update events our reactive cache listens to. (The old "sc handler
      // crashes on delete events" was self-inflicted: we manually removed
      // nodes from storage.files, so the later sc delete packet found no node
      // and crashed on `.parent`. The manual removals are gone.)
      const storage: any = await new Promise((resolve, reject) => {
        const s = new Storage(
          { email, password, secondFactorCode, autoload: true, keepalive: true } as any,
          (error: Error | null) => (error ? reject(error) : resolve(s))
        );
      });

      this.storage = storage;
      this.attachChangeListeners(storage);
      await this.ensureMokuroFolder();
      this.persistSession();
      this.needsReconnect = false;
      this.reconnectEmail = email;
      setActiveProviderKey('mega');
      console.log('✅ MEGA login successful');
    } catch (error) {
      this.storage = null;
      this.mokuroFolder = null;

      if (isMfaRequiredError(error)) {
        throw new ProviderError(
          'MEGA requires a two-factor authentication code',
          'mega',
          'MFA_REQUIRED',
          false
        );
      }

      throw new ProviderError(
        `MEGA login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'LOGIN_FAILED',
        true
      );
    }
  }

  /** Persist the current session as a sanitized toJSON() blob; drop legacy keys. */
  private persistSession(): void {
    if (!browser || !this.storage) return;
    const blob: MegaSessionBlob = sanitizeSessionBlob(this.storage.toJSON());
    localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(blob));
    localStorage.removeItem(STORAGE_KEYS.EMAIL);
    localStorage.removeItem(STORAGE_KEYS.PASSWORD);
  }

  async logout(): Promise<void> {
    this.storage = null;
    this.mokuroFolder = null;
    this.needsReconnect = false;
    this.reconnectEmail = null;

    if (browser) {
      localStorage.removeItem(STORAGE_KEYS.SESSION);
      localStorage.removeItem(STORAGE_KEYS.EMAIL);
      localStorage.removeItem(STORAGE_KEYS.PASSWORD);
      localStorage.removeItem(STORAGE_KEYS.FOLDER_PATH);
    }

    clearActiveProviderKey();
    console.log('MEGA logged out');
  }

  /** Rebuild an authenticated Storage from a saved session blob (no password, no login round-trip). */
  private async restoreSession(blob: MegaSessionBlob): Promise<void> {
    const { Storage } = await import('megajs');
    // Force keepalive:true (overriding blobs persisted while the sc poll was
    // disabled): the sc stream keeps the local tree in sync and feeds the
    // reactive cache events. See login() for why the old crash is gone.
    const storage: any = Storage.fromJSON({
      ...(blob as any),
      options: { ...((blob as any).options ?? {}), keepalive: true }
    });
    // fromJSON does no network and loads no tree; reload populates root + files.
    // A dead session throws ESID here.
    await storage.reload(true);
    this.storage = storage;
    this.attachChangeListeners(storage);
    this.mokuroFolder = null;
    await this.ensureMokuroFolder();
    this.needsReconnect = false;
    this.reconnectEmail = (blob.options && (blob.options as any).email) || this.reconnectEmail;
    setActiveProviderKey('mega');
  }

  /** Restore on app load: session blob first, then one-time legacy email/password migration. */
  async restorePersistedSession(): Promise<void> {
    if (!browser) return;

    const sessionRaw = localStorage.getItem(STORAGE_KEYS.SESSION);
    if (sessionRaw) {
      try {
        await this.restoreSession(JSON.parse(sessionRaw) as MegaSessionBlob);
        console.log('Restored MEGA session from stored token');
      } catch (error) {
        if (isSessionExpiredError(error) || isAuthRejectionError(error)) {
          console.error('Stored MEGA session invalid; reconnect required');
          this.markSessionExpired();
        } else {
          console.warn('Failed to restore MEGA session (temporary error), will retry:', error);
        }
      }
      return;
    }

    // Legacy migration: log in with stored email/password, which persists a session blob
    // and removes the password (see login()/persistSession()).
    const email = localStorage.getItem(STORAGE_KEYS.EMAIL);
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);
    if (email && password) {
      try {
        await this.login({ email, password });
        console.log('Migrated MEGA legacy credentials to session token');
      } catch (error) {
        if (isMfaRequiredError(error)) {
          // Account enabled 2FA after the password was stored — cannot migrate silently.
          this.reconnectEmail = email;
          this.markSessionExpired();
        } else if (isAuthRejectionError(error)) {
          this.reconnectEmail = email;
          this.markSessionExpired();
        } else {
          console.warn('MEGA migration deferred (temporary error), keeping legacy creds:', error);
        }
      }
    }
  }

  /**
   * Refresh the file-tree cache by rebuilding the session from the stored token.
   * No password and no re-login round-trip — fromJSON + reload only.
   */
  private async reinitialize(): Promise<void> {
    if (!browser) return;

    // No live session to refresh — fall back to restoring from the stored token.
    if (!this.storage) {
      await this.restorePersistedSession();
      return;
    }

    try {
      // Refresh the file tree on the EXISTING session, in place.
      //
      // We must NOT rebuild the storage and close the old one: megajs
      // `storage.close()` issues `{a:'sml'}`, which TERMINATES the session sid
      // server-side. Every storage (login, restore, reinitialize, upload worker)
      // reuses the one persisted sid, so closing any of them invalidates the
      // stored token and makes every later request fail with ESID (-15).
      //
      // Two megajs reload() quirks force extra work here:
      // - reload() attaches a NEW api 'sc' handler on every call without
      //   removing the old one. Stacked handlers process each server packet
      //   N times, and a re-processed delete splices with indexOf === -1,
      //   silently removing an unrelated sibling from the tree.
      // - reload() only ADDS nodes (_importFile skips known handles) and the
      //   sc delete handler never removes nodes from storage.files, so a node
      //   deleted server-side survives every reload as a permanent "ghost"
      //   that fails all later operations with ENOENT (-9). Rebuild from an
      //   empty map so the reloaded tree exactly mirrors the server.
      this.storage.api?.removeAllListeners?.('sc');
      const previousFiles = this.storage.files;
      this.storage.files = {};
      try {
        await this.storage.reload(true);
      } catch (error) {
        // Keep the old (stale but usable) tree if the reload didn't complete.
        this.storage.files = previousFiles;
        throw error;
      }
      this.mokuroFolder = null;
      console.log('✅ MEGA cache reinitialized (fresh in-place reload)');
    } catch (error) {
      if (isSessionExpiredError(error)) {
        this.markSessionExpired();
        return;
      }
      // Transient error: keep the existing storage so we don't appear logged out.
      console.warn('Continuing with potentially stale MEGA cache:', error);
    }
  }

  private async ensureMokuroFolder(): Promise<any> {
    // Fast path: folder already exists in storage cache.
    const existing = this.findMokuroFolder();
    if (existing) {
      this.mokuroFolder = existing;
      return existing;
    }

    // Coalesce concurrent calls so only one mkdir runs.
    if (this.mokuroFolderPromise) {
      return this.mokuroFolderPromise;
    }

    this.mokuroFolderPromise = (async () => {
      try {
        // Re-check after acquiring the mutex; another caller may have created it.
        const recheck = this.findMokuroFolder();
        if (recheck) {
          this.mokuroFolder = recheck;
          return recheck;
        }

        const folder = await this.createFolder(MOKURO_FOLDER);
        console.log('Created mokuro-reader folder in MEGA');
        this.mokuroFolder = folder;
        return folder;
      } catch (error) {
        console.error('ensureMokuroFolder error:', error);
        throw new ProviderError(
          `Failed to ensure mokuro folder exists: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'mega',
          'FOLDER_ERROR'
        );
      } finally {
        this.mokuroFolderPromise = null;
      }
    })();

    return this.mokuroFolderPromise;
  }

  private findMokuroFolder(): any | null {
    const files = Object.values(this.storage.files || {});
    return files.find((f: any) => f.name === MOKURO_FOLDER && f.directory) || null;
  }

  private listFolder(folder: any): Promise<any[]> {
    return new Promise((resolve, reject) => {
      // Get all files from storage
      const files = Object.values(this.storage.files || {});

      // Filter files that are children of this folder
      const children = files.filter((f: any) => f.parent === folder);
      resolve(children);
    });
  }

  private createFolder(name: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.storage.mkdir(name, (error: Error | null, folder: any) => {
        if (error) {
          reject(error);
        } else {
          resolve(folder);
        }
      });
    });
  }

  private getNodeById(fileId: string): any | null {
    const files = Object.values(this.storage.files || {});
    return files.find((f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory) || null;
  }

  private async findFolderByPath(folderPath: string, rootFolder: any): Promise<any | null> {
    const pathParts = folderPath.split('/').filter(Boolean);
    let currentFolder = rootFolder;

    for (const folderName of pathParts) {
      const children = await this.listFolder(currentFolder);
      const nextFolder = children.find((f: any) => f.name === folderName && f.directory);
      if (!nextFolder) {
        return null;
      }
      currentFolder = nextFolder;
    }

    return currentFolder;
  }

  private buildRenamedCloudFile(
    file: CloudFileMetadata,
    nextPath: string,
    fileId?: string,
    modifiedTime?: string
  ): CloudFileMetadata {
    return {
      ...file,
      fileId: fileId || file.fileId,
      path: nextPath,
      modifiedTime: modifiedTime || new Date().toISOString()
    };
  }

  // VOLUME STORAGE METHODS

  async listCloudVolumes(
    skipReinitialize = false
  ): Promise<import('../../provider-interface').CloudFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    try {
      // Only reinitialize if needed (cache miss, initial load)
      // Skip for post-operation refreshes where storage.files is already fresh
      if (!skipReinitialize) {
        await this.reinitialize();
      }
      await this.ensureMokuroFolder();

      // Get all files from storage
      const files = Object.values(this.storage.files || {});

      // Find ALL mokuro-reader folders (there may be multiple from different sessions)
      // Note: We don't check parent because MEGA's root folder location varies by account/locale
      const mokuroFolders = files.filter((f: any) => f.name === MOKURO_FOLDER && f.directory);

      // Filter CBZ and JSON files that are in ANY mokuro-reader folder or its subfolders
      const allFiles: import('../../provider-interface').CloudFileMetadata[] = [];

      for (const file of files) {
        // Skip non-files
        if ((file as any).directory) continue;

        // Check if file is a CBZ, sidecar, or JSON
        const name = (file as any).name || '';
        const isCbz = isCbzFile(name);
        const isSidecar = isSidecarFile(name);
        const isJson = isRootConfigFile(name);

        if (!isCbz && !isSidecar && !isJson) continue;

        // Check if file is in ANY mokuro-reader folder or subfolder
        let parent = (file as any).parent;
        let pathParts: string[] = [];
        let foundMokuroRoot = false;
        let isInTrash = false;

        // Walk up the tree to build path and verify it's under a mokuro-reader folder
        while (parent) {
          // Check if any parent is the Rubbish Bin (trash)
          if (parent.name === 'Rubbish Bin') {
            isInTrash = true;
            break;
          }

          // Check if this parent is ANY mokuro-reader folder
          const isMokuroFolder = mokuroFolders.some((mf: any) => mf === parent);
          if (isMokuroFolder) {
            foundMokuroRoot = true;
            break;
          }
          if (parent.name) {
            pathParts.unshift(parent.name);
          }
          parent = parent.parent;
        }

        // Skip files in trash
        if (isInTrash) continue;

        // If we found mokuro root, this file is under a mokuro-reader folder
        if (foundMokuroRoot) {
          // For JSON files in the mokuro root, use just the filename as path
          // For CBZ files, build full path as "SeriesTitle/VolumeTitle.cbz"
          let path: string;
          if (isJson && pathParts.length === 0) {
            // JSON file directly in mokuro folder
            path = name;
          } else {
            // CBZ file or JSON in subfolder
            pathParts.push(name);
            path = pathParts.join('/');
          }

          // Get file metadata
          const fileId = (file as any).nodeId || (file as any).id || '';
          const modifiedTime = (file as any).timestamp
            ? new Date((file as any).timestamp * 1000).toISOString()
            : new Date().toISOString();
          const size = (file as any).size || 0;

          allFiles.push({
            provider: 'mega',
            fileId,
            path,
            modifiedTime,
            size
          });
        }
      }

      console.log(`✅ Listed ${allFiles.length} files from MEGA`);
      return allFiles;
    } catch (error) {
      throw new ProviderError(
        `Failed to list cloud volumes: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'LIST_FAILED',
        false,
        true
      );
    }
  }

  async uploadFile(
    path: string,
    blob: UploadPayload,
    description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    const payloadSize = getUploadPayloadSize(blob);
    try {
      if (onProgress) {
        onProgress(0, payloadSize);
      }
      // Wrap upload in retry logic to handle stale cache
      const fileId = await retryWithCacheRefresh(
        async () => {
          const mokuroFolder = await this.ensureMokuroFolder();

          // Parse path: "SeriesTitle/VolumeTitle.cbz"
          const pathParts = path.split('/');
          const fileName = pathParts.pop() || path;
          const seriesFolderName = pathParts.join('/');

          // Find or create series folder if path includes subfolder
          let targetFolder = mokuroFolder;
          if (seriesFolderName) {
            targetFolder = await this.ensureSeriesFolder(seriesFolderName, mokuroFolder);
          }

          let buffer: Uint8Array;
          if (blob instanceof Uint8Array) {
            buffer = blob;
          } else if (blob instanceof ArrayBuffer) {
            buffer = new Uint8Array(blob);
          } else {
            const arrayBuffer = await blob.arrayBuffer();
            buffer = new Uint8Array(arrayBuffer);
          }

          const children = await this.listFolder(targetFolder);

          // Replace semantics: delete EVERY same-name copy (MEGA allows
          // duplicate names, so racing uploads can leave several). Do NOT
          // remove them from storage.files manually — the sc stream delivers
          // the delete and megajs applies it; a manual removal makes the
          // later sc packet crash on a missing node (the original "keepalive
          // crash"). A copy can also be a ghost — deleted server-side but
          // never evicted from storage.files by megajs — so a server
          // "already gone" answer means converged, not failed.
          const existingFiles = children.filter((f: any) => f.name === fileName && !f.directory);
          for (const existingFile of existingFiles) {
            await new Promise<void>((resolve, reject) => {
              existingFile.delete(true, (error: Error | null) => {
                if (error && !isMegaNotFoundError(error)) reject(error);
                else resolve();
              });
            });
          }

          // Upload new file
          const uploadedFileId = await new Promise<string>((resolve, reject) => {
            const uploadStream = targetFolder.upload(
              {
                name: fileName,
                size: buffer.length
              },
              buffer,
              (error: Error | null, file: any) => {
                if (error) {
                  reject(error);
                } else {
                  const fileId = file?.nodeId || file?.id || '';
                  if (onProgress) {
                    onProgress(buffer.length, buffer.length);
                  }
                  console.log(`✅ Uploaded ${fileName} to MEGA (${fileId})`);
                  resolve(fileId);
                }
              }
            );
            if (onProgress && uploadStream && typeof uploadStream.on === 'function') {
              uploadStream.on('progress', (progress: any) => {
                const loaded = Number(progress?.bytesUploaded ?? progress?.bytesLoaded ?? 0);
                const total = Number(progress?.bytesTotal ?? buffer.length);
                onProgress(loaded, total > 0 ? total : buffer.length);
              });
            }
          });
          return uploadedFileId;
        },
        `Upload ${path} to MEGA`,
        () => this.reinitialize()
      );
      // No cache rebuild here: uploads emit a local 'add' event (megajs adds
      // the node from the API response), which the change listeners turn into
      // a debounced refresh. A mid-operation rebuild would clobber the
      // manager's incremental cache updates with a not-yet-synced tree.

      return fileId;
    } catch (error) {
      // Typed QUOTA_EXCEEDED with a message users can act on, instead of
      // megajs's raw "EOVERQUOTA (-17): Request over quota".
      if (isMegaOverQuotaError(error)) {
        throw new ProviderError(
          'MEGA storage is full — free up space or upgrade your plan',
          'mega',
          'QUOTA_EXCEEDED'
        );
      }
      throw new ProviderError(
        `Failed to upload volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
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
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    // Extract file ID from metadata
    const fileId = file.fileId;

    try {
      // Find the file by ID
      const files = Object.values(this.storage.files || {});
      const megaFile = files.find(
        (f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory
      );

      if (!megaFile) {
        throw new Error('File not found');
      }

      return new Promise((resolve, reject) => {
        const fileObj = megaFile as any;

        // Use download with progress callback if provided
        if (onProgress) {
          // MEGA.js download supports progress via stream options
          const stream = fileObj.download({ returnCiphertext: false });

          const chunks: Uint8Array[] = [];
          let loaded = 0;
          const total = fileObj.size || 0;

          stream.on('data', (chunk: Uint8Array) => {
            chunks.push(chunk);
            loaded += chunk.length;
            onProgress(loaded, total);
          });

          stream.on('end', () => {
            // Combine all chunks into a single Uint8Array
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const combined = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
              combined.set(chunk, offset);
              offset += chunk.length;
            }

            const blob = new Blob([combined], { type: 'application/zip' });
            console.log(`✅ Downloaded ${fileObj.name} from MEGA`);
            resolve(blob);
          });

          stream.on('error', (error: Error) => {
            reject(error);
          });
        } else {
          // Simple download without progress
          fileObj.download((error: Error | null, data: Uint8Array) => {
            if (error) {
              reject(error);
            } else {
              // Convert to standard Uint8Array to satisfy TypeScript
              const standardArray = new Uint8Array(Array.from(data));
              const blob = new Blob([standardArray], { type: 'application/zip' });
              console.log(`✅ Downloaded ${fileObj.name} from MEGA`);
              resolve(blob);
            }
          });
        }
      });
    } catch (error) {
      throw new ProviderError(
        `Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'DOWNLOAD_FAILED',
        false,
        true
      );
    }
  }

  async deleteFile(file: CloudFileMetadata): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    // Extract file ID from metadata
    const fileId = file.fileId;

    try {
      // Wrap delete in retry logic to handle stale cache
      await retryWithCacheRefresh(
        async () => {
          // Find the file by ID
          const files = Object.values(this.storage.files || {});
          const megaFile = files.find(
            (f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory
          );

          if (!megaFile) {
            // Typed: the shared layer treats an already-gone DELETE target as
            // converged, and relies on this code (never message text).
            throw new ProviderError(`File not found: ${file.path}`, 'mega', 'NOT_FOUND');
          }

          return new Promise<void>((resolve, reject) => {
            (megaFile as any).delete(true, (error: Error | null) => {
              if (error) {
                reject(error);
              } else {
                console.log(`✅ Deleted file from MEGA (${fileId})`);
                resolve();
                // No manual storage.files cleanup: the sc stream applies the
                // delete (and a manual removal would crash its handler). The
                // caller's cache update + the change listeners keep the UI
                // current.
              }
            });
          });
        },
        `Delete file ${fileId} from MEGA`,
        () => this.reinitialize()
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        `Failed to delete volume CBZ: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'DELETE_FAILED',
        false,
        true
      );
    }
  }

  async renameFile(file: CloudFileMetadata, newPath: string): Promise<CloudFileMetadata> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (file.path === normalizedNewPath) {
      return file;
    }

    try {
      return await retryWithCacheRefresh(
        async () => {
          const megaFile = this.getNodeById(file.fileId);
          if (!megaFile) {
            // Typed NOT_FOUND: the source node is gone (deleted elsewhere or a
            // stale cached id). The shared rename layer treats this as a
            // GENUINE failure — never "already moved" — so it must be
            // distinguishable from other rename errors by code, not message.
            throw new ProviderError(`File not found: ${file.path}`, 'mega', 'NOT_FOUND');
          }

          const pathParts = normalizedNewPath.split('/');
          const newFileName = pathParts.pop() || normalizedNewPath;
          const newSeriesPath = pathParts.join('/');
          const mokuroFolder = await this.ensureMokuroFolder();
          const targetFolder = newSeriesPath
            ? await this.ensureSeriesFolder(newSeriesPath, mokuroFolder)
            : mokuroFolder;

          const targetChildren = await this.listFolder(targetFolder);
          const existingTarget = targetChildren.find(
            (child: any) =>
              !child.directory &&
              child.name === newFileName &&
              child !== megaFile &&
              child.nodeId !== megaFile.nodeId &&
              child.id !== megaFile.id
          );
          if (existingTarget) {
            throw new ProviderError(
              `Target file already exists at '${normalizedNewPath}'`,
              'mega',
              'TARGET_EXISTS'
            );
          }

          if (megaFile.parent !== targetFolder) {
            await megaFile.moveTo(targetFolder);
            // megajs applies moves to the local tree only when the sc packet
            // arrives (seconds later). Mirror it now so checks later in this
            // same operation — collision lookups, empty-folder pruning — see
            // the true state. Safe: the sc handler no-ops when the parent
            // already matches.
            const oldParent = megaFile.parent;
            if (oldParent?.children) {
              const idx = oldParent.children.indexOf(megaFile);
              if (idx >= 0) oldParent.children.splice(idx, 1);
            }
            megaFile.parent = targetFolder;
            if (Array.isArray(targetFolder.children)) {
              targetFolder.children.push(megaFile);
            } else {
              targetFolder.children = [megaFile];
            }
          }
          if (megaFile.name !== newFileName) {
            await megaFile.rename(newFileName);
          }

          const nextFileId = megaFile.nodeId || megaFile.id || file.fileId;
          return this.buildRenamedCloudFile(file, normalizedNewPath, nextFileId);
        },
        `Rename file ${file.fileId} in MEGA`,
        () => this.reinitialize()
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        `Failed to rename file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'RENAME_FAILED',
        false,
        true
      );
    }
  }

  async renameFolder(oldPath: string, newPath: string): Promise<CloudFileMetadata[]> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    const normalizedOldPath = oldPath.replace(/^\/+|\/+$/g, '');
    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (normalizedOldPath === normalizedNewPath) {
      return megaCache.getBySeries(normalizedOldPath);
    }

    const existingFiles = megaCache.getBySeries(normalizedOldPath);
    if (existingFiles.length === 0) {
      return [];
    }

    try {
      await retryWithCacheRefresh(
        async () => {
          const mokuroFolder = await this.ensureMokuroFolder();
          const sourceFolder = await this.findFolderByPath(normalizedOldPath, mokuroFolder);
          if (!sourceFolder) {
            throw new ProviderError(
              `Series folder '${normalizedOldPath}' not found`,
              'mega',
              'FOLDER_NOT_FOUND'
            );
          }

          const existingTargetFolder = await this.findFolderByPath(normalizedNewPath, mokuroFolder);
          if (existingTargetFolder && existingTargetFolder !== sourceFolder) {
            throw new ProviderError(
              `Target series folder already exists at '${normalizedNewPath}'`,
              'mega',
              'TARGET_EXISTS'
            );
          }

          const pathParts = normalizedNewPath.split('/');
          const newFolderName = pathParts.pop() || normalizedNewPath;
          const newParentPath = pathParts.join('/');
          const targetParent = newParentPath
            ? await this.ensureSeriesFolder(newParentPath, mokuroFolder)
            : mokuroFolder;

          const targetChildren = await this.listFolder(targetParent);
          const conflictingFolder = targetChildren.find(
            (child: any) =>
              child.directory &&
              child.name === newFolderName &&
              child !== sourceFolder &&
              child.nodeId !== sourceFolder.nodeId &&
              child.id !== sourceFolder.id
          );
          if (conflictingFolder) {
            throw new ProviderError(
              `Target series folder already exists at '${normalizedNewPath}'`,
              'mega',
              'TARGET_EXISTS'
            );
          }

          if (sourceFolder.parent !== targetParent) {
            await sourceFolder.moveTo(targetParent);
          }
          if (sourceFolder.name !== newFolderName) {
            await sourceFolder.rename(newFolderName);
          }
        },
        `Rename series folder '${normalizedOldPath}' in MEGA`,
        () => this.reinitialize()
      );

      return existingFiles.map((file) =>
        this.buildRenamedCloudFile(
          file,
          `${normalizedNewPath}${file.path.slice(normalizedOldPath.length)}`,
          file.fileId,
          file.modifiedTime
        )
      );
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        `Failed to rename series folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'RENAME_FAILED',
        false,
        true
      );
    }
  }

  /**
   * Delete an entire series folder
   */
  /**
   * Remove a series directory only if the SERVER confirms it is empty — never
   * a blind recursive delete (folder.delete on MEGA is recursive). Emptiness
   * is checked with a live `f` API query for the folder's nodes, NOT the local
   * tree, which can lag behind just-completed moves until the sc packet lands.
   */
  async removeDirectoryIfEmpty(relativePath: string): Promise<void> {
    if (!this.isAuthenticated()) return;

    const normalized = relativePath.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;

    try {
      const mokuroFolder = await this.ensureMokuroFolder();
      const children = await this.listFolder(mokuroFolder);
      const target = children.find((f: any) => f.directory && f.name === normalized);
      if (!target?.nodeId) return;

      // Server-side emptiness check: list the folder's own nodes.
      const response: any = await new Promise((resolve, reject) => {
        this.storage.api.request(
          { a: 'f', c: 1, n: target.nodeId },
          (error: Error | null, result: any) => (error ? reject(error) : resolve(result))
        );
      });
      const nodes: any[] = Array.isArray(response?.f) ? response.f : [];
      const hasContents = nodes.some((n: any) => n.h !== target.nodeId);
      if (hasContents) {
        console.log(
          `MEGA folder '${normalized}' not pruned: server still reports ${nodes.length - 1} node(s)`
        );
        return;
      }

      await new Promise<void>((resolve, reject) => {
        target.delete(true, (error: Error | null) => (error ? reject(error) : resolve()));
      });
      console.log(`✅ Pruned empty series folder '${normalized}' from MEGA`);
    } catch (error) {
      // Best-effort: an orphaned empty directory is harmless.
      console.warn(`Could not prune MEGA folder '${normalized}':`, error);
    }
  }

  async deleteSeriesFolder(seriesTitle: string): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    try {
      // Wrap delete in retry logic to handle stale cache
      await retryWithCacheRefresh(
        async () => {
          const mokuroFolder = await this.ensureMokuroFolder();

          // Find the series folder
          const children = await this.listFolder(mokuroFolder);
          const seriesFolder = children.find((f: any) => f.name === seriesTitle && f.directory);

          if (!seriesFolder) {
            console.log(`Series folder '${seriesTitle}' not found in MEGA`);
            return;
          }

          // Delete the folder (recursive delete)
          await new Promise<void>((resolve, reject) => {
            seriesFolder.delete(true, (error: Error | null) => {
              if (error) {
                reject(error);
              } else {
                console.log(`✅ Deleted series folder '${seriesTitle}' from MEGA`);
                resolve();
              }
            });
          });
        },
        `Delete series folder '${seriesTitle}' from MEGA`,
        () => this.reinitialize()
      );
      // Cache upkeep is the caller's incremental updates + the sc-driven
      // change listeners; a rebuild here races the not-yet-synced tree.
    } catch (error) {
      throw new ProviderError(
        `Failed to delete series folder: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'DELETE_FAILED',
        false,
        true
      );
    }
  }

  /**
   * Get storage quota information from MEGA
   * Returns used, total, and available storage in bytes
   */
  async getStorageQuota(): Promise<StorageQuota> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    try {
      // Use getAccountInfo() for accurate quota information
      const info = await this.storage.getAccountInfo();

      const used = info.spaceUsed || 0;
      const total = info.spaceTotal || null;

      return {
        used,
        total,
        available: total !== null ? total - used : null
      };
    } catch (error) {
      throw new ProviderError(
        `Failed to get storage quota: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'QUOTA_FETCH_FAILED',
        false,
        true
      );
    }
  }

  async getWorkerUploadCredentials(): Promise<Record<string, any>> {
    if (!browser) return {};
    const session = localStorage.getItem(STORAGE_KEYS.SESSION);
    if (!session) return {};
    return { megaSession: session };
  }

  async prepareUploadTarget(seriesTitle: string): Promise<Record<string, any>> {
    // Create the series folder once here (coalesced by ensureSeriesFolder's mutex) and pass
    // its node id to the upload workers. Workers must NOT mkdir — each worker has its own
    // Storage tree, so parallel mkdir would create duplicate series folders.
    const mokuroFolder = await this.ensureMokuroFolder();
    const seriesFolder = await this.ensureSeriesFolder(seriesTitle, mokuroFolder);
    const nodeId = seriesFolder?.nodeId ?? seriesFolder?.id;
    return nodeId ? { megaSeriesFolderNodeId: nodeId } : {};
  }

  async getWorkerDownloadCredentials(fileId: string): Promise<Record<string, any>> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }
    const node = this.getNodeById(fileId);
    if (!node || !node.key) {
      throw new ProviderError(
        `MEGA node not found or missing key: ${fileId}`,
        'mega',
        'NODE_NOT_FOUND',
        false,
        true
      );
    }
    // sid authorizes the owned-node download; the per-file key decrypts it.
    // The download worker never receives the account master key.
    return {
      sid: this.storage.sid,
      nodeId: node.nodeId,
      fileKey: encodeMegaKey(node.key as Uint8Array)
    };
  }

  /**
   * Ensure a series folder exists (may be nested path like "Series/Subseries")
   */
  private async ensureSeriesFolder(folderPath: string, mokuroFolder: any): Promise<any> {
    // Coalesce concurrent ensureSeriesFolder calls for the same path so parallel
    // uploads to one series don't each mkdir the same intermediate folders.
    const key = folderPath;
    const inFlight = this.seriesFolderPromises.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      try {
        const pathParts = folderPath.split('/').filter(Boolean);
        let currentFolder = mokuroFolder;

        for (const folderName of pathParts) {
          const children = await this.listFolder(currentFolder);
          let subfolder = children.find((f: any) => f.name === folderName && f.directory);

          if (!subfolder) {
            subfolder = await new Promise((resolve, reject) => {
              currentFolder.mkdir(folderName, (error: Error | null, folder: any) => {
                if (error) reject(error);
                else resolve(folder);
              });
            });
            console.log(`Created folder: ${folderName}`);
          }

          currentFolder = subfolder;
        }

        return currentFolder;
      } finally {
        this.seriesFolderPromises.delete(key);
      }
    })();

    this.seriesFolderPromises.set(key, promise);
    return promise;
  }

  private getFileNodeId(file: any): string | null {
    return file?.nodeId || file?.id || null;
  }

  /**
   * MEGA.js mutates node.parent only when the server's 'sc' (state-change) action
   * stream arrives — the API callback for moveTo/delete fires earlier. Without
   * waiting for the event, subsequent listFolders() reads stale parent refs and
   * dedup pass 2 fails to group the now-sibling duplicates.
   */
  private waitForNodeEvent(node: any, eventName: string, timeoutMs = 5000): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const handler = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        if (typeof node.off === 'function') node.off(eventName, handler);
        else if (typeof node.removeListener === 'function') node.removeListener(eventName, handler);
        console.warn(`[MEGA] '${eventName}' event timeout after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
      node.once(eventName, handler);
    });
  }

  private isInTrash(file: any): boolean {
    let parent = file?.parent;
    while (parent) {
      if (parent.name === 'Rubbish Bin') return true;
      parent = parent.parent;
    }
    return false;
  }

  private findNodeById(id: string): any | null {
    const files = Object.values(this.storage?.files || {}) as any[];
    return files.find((f: any) => this.getFileNodeId(f) === id) || null;
  }

  /**
   * FolderOperations interface used by FolderDeduplicator to merge duplicate folders.
   */
  getFolderOperations(): FolderOperations {
    return {
      rootFolderName: MOKURO_FOLDER,

      listFolders: async (): Promise<FolderInfo[]> => {
        await this.initPromise;
        if (!this.storage) return [];
        const files = Object.values(this.storage.files || {}) as any[];

        const folders: FolderInfo[] = [];
        for (const f of files) {
          if (!f.directory) continue;
          if (this.isInTrash(f)) continue;
          const id = this.getFileNodeId(f);
          if (!id) continue;
          const parentId = f.parent ? this.getFileNodeId(f.parent) : null;
          folders.push({
            id,
            name: f.name,
            parentId,
            createdTime: f.timestamp ? new Date(f.timestamp * 1000).toISOString() : undefined
          });
        }
        return folders;
      },

      listFolderContents: async (folderId: string): Promise<FolderItem[]> => {
        await this.initPromise;
        if (!this.storage) return [];
        const target = this.findNodeById(folderId);
        if (!target) return [];

        const files = Object.values(this.storage.files || {}) as any[];
        const items: FolderItem[] = [];
        for (const f of files) {
          if (f.parent !== target) continue;
          const id = this.getFileNodeId(f);
          if (!id) continue;
          items.push({ id, name: f.name, isFolder: !!f.directory });
        }
        return items;
      },

      moveItem: async (itemId, newParentId, _oldParentId): Promise<void> => {
        const item = this.findNodeById(itemId);
        const newParent = this.findNodeById(newParentId);
        if (!item) throw new Error(`MEGA dedup: item ${itemId} not found`);
        if (!newParent) throw new Error(`MEGA dedup: parent ${newParentId} not found`);
        const stateSynced = this.waitForNodeEvent(item, 'move');
        await item.moveTo(newParent);
        await stateSynced;
      },

      deleteFolder: async (folderId): Promise<void> => {
        const folder = this.findNodeById(folderId);
        if (!folder) return;
        const stateSynced = this.waitForNodeEvent(folder, 'delete');
        await new Promise<void>((resolve, reject) => {
          folder.delete(true, (error: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        });
        await stateSynced;
        // MEGA.js doesn't always remove from storage.files; clean up manually.
        delete this.storage.files[folderId];
      },

      deleteFile: async (fileId): Promise<void> => {
        const file = this.findNodeById(fileId);
        if (!file) return;
        const stateSynced = this.waitForNodeEvent(file, 'delete');
        await new Promise<void>((resolve, reject) => {
          file.delete(true, (error: Error | null) => {
            if (error) reject(error);
            else resolve();
          });
        });
        await stateSynced;
        delete this.storage.files[fileId];
      },

      onRootFolderConfirmed: (folderId): void => {
        const canonical = this.findNodeById(folderId);
        if (canonical) {
          this.mokuroFolder = canonical;
        }
      }
    };
  }
}

export const megaProvider = new MegaProvider();

// Self-register cache when module is loaded
cacheManager.registerCache('mega', megaCache);
