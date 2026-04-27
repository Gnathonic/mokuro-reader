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
import type { FolderOperations, FolderInfo, FolderItem } from '../../folder-deduplicator';

interface MegaCredentials {
  email: string;
  password: string;
}

const STORAGE_KEYS = {
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
  readonly supportsWorkerDownload = true; // Workers can download via MEGA API from share links
  readonly uploadConcurrencyLimit = 6;
  readonly downloadConcurrencyLimit = 6;

  private storage: any = null;
  private mokuroFolder: any = null;
  private initPromise: Promise<void>;
  private workerShareLinksToCleanup = new Set<string>();
  private workerShareLinkMutex: Promise<void | { megaShareUrl: string }> = Promise.resolve();
  private static readonly WORKER_SHARE_LINK_THROTTLE_MS = 200;

  // Mutexes preventing concurrent uploads from racing to create the same folder.
  // Without these, N parallel uploads each find no folder and call mkdir N times.
  private mokuroFolderPromise: Promise<any> | null = null;
  private seriesFolderPromises = new Map<string, Promise<any>>();

  constructor() {
    if (browser) {
      this.initPromise = this.loadPersistedCredentials();
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
    const hasCredentials = !!(
      browser &&
      localStorage.getItem(STORAGE_KEYS.EMAIL) &&
      localStorage.getItem(STORAGE_KEYS.PASSWORD)
    );
    const isConnected = this.isAuthenticated();

    return {
      isAuthenticated: isConnected,
      hasStoredCredentials: hasCredentials,
      needsAttention: false,
      statusMessage: isConnected
        ? 'Connected to MEGA'
        : hasCredentials
          ? 'Configured (not connected)'
          : 'Not configured'
    };
  }

  async login(credentials?: ProviderCredentials): Promise<void> {
    if (!credentials || !credentials.email || !credentials.password) {
      throw new ProviderError('Email and password are required', 'mega', 'INVALID_CREDENTIALS');
    }

    const { email, password } = credentials as MegaCredentials;

    try {
      // Dynamically import megajs to reduce initial bundle size
      const { Storage } = await import('megajs');

      // Initialize MEGA storage
      this.storage = await new Promise((resolve, reject) => {
        const storage = new Storage(
          {
            email,
            password
          },
          (error: Error | null) => {
            if (error) {
              reject(error);
            } else {
              resolve(storage);
            }
          }
        );
      });

      // Wait for storage to be ready
      await this.waitForReady();

      // Ensure mokuro folder exists
      await this.ensureMokuroFolder();

      // Store credentials in localStorage
      if (browser) {
        localStorage.setItem(STORAGE_KEYS.EMAIL, email);
        localStorage.setItem(STORAGE_KEYS.PASSWORD, password);
      }

      // Set the active provider key for lazy loading on next startup
      setActiveProviderKey('mega');
      console.log('✅ MEGA login successful');
    } catch (error) {
      this.storage = null;
      this.mokuroFolder = null;

      throw new ProviderError(
        `MEGA login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'LOGIN_FAILED',
        true
      );
    }
  }

  async logout(): Promise<void> {
    this.storage = null;
    this.mokuroFolder = null;

    if (browser) {
      localStorage.removeItem(STORAGE_KEYS.EMAIL);
      localStorage.removeItem(STORAGE_KEYS.PASSWORD);
      localStorage.removeItem(STORAGE_KEYS.FOLDER_PATH);
    }

    // Clear the active provider key
    clearActiveProviderKey();
    console.log('MEGA logged out');
  }

  async loadPersistedCredentials(): Promise<void> {
    if (!browser) return;

    const email = localStorage.getItem(STORAGE_KEYS.EMAIL);
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);

    if (email && password) {
      try {
        await this.login({ email, password });
        console.log('Restored MEGA session from stored credentials');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Only clear credentials if they're actually invalid (wrong password/email)
        // Don't clear on network errors, rate limiting, or temporary server issues
        const isAuthError =
          errorMessage.includes('ENOENT') ||
          errorMessage.includes('incorrect') ||
          errorMessage.includes('invalid') ||
          errorMessage.includes('authentication failed') ||
          errorMessage.includes('wrong password');

        if (isAuthError) {
          console.error('MEGA credentials invalid, clearing stored credentials');
          this.logout();
        } else {
          // Temporary error - keep credentials for retry later
          console.warn(
            'Failed to restore MEGA session (temporary error), will retry on next sync:',
            errorMessage
          );
        }
      }
    }
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      // If storage is already ready, resolve immediately
      if (this.storage.ready) {
        resolve();
        return;
      }

      // Wait for ready event
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for MEGA storage to be ready'));
      }, 30000); // 30 second timeout

      this.storage.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });

      // Also listen for error events
      this.storage.once('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Reinitialize the MEGA connection to get a fresh storage cache
   * This is needed when files change on other devices and the cache becomes stale
   */
  private async reinitialize(): Promise<void> {
    if (!browser) return;

    // Save current credentials
    const email = localStorage.getItem(STORAGE_KEYS.EMAIL);
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);

    if (!email || !password) {
      console.warn('Cannot reinitialize MEGA: no stored credentials');
      return;
    }

    console.log('🔄 Reinitializing MEGA connection to refresh cache...');

    // Save current storage in case reconnection fails
    const oldStorage = this.storage;
    const oldMokuroFolder = this.mokuroFolder;

    // Clear current storage
    this.storage = null;
    this.mokuroFolder = null;

    // Reconnect with fresh credentials
    try {
      await this.login({ email, password });
      console.log('✅ MEGA connection reinitialized successfully');
    } catch (error) {
      // Restore previous connection on failure so user doesn't get logged out
      console.error('Failed to reinitialize MEGA, restoring previous connection:', error);
      this.storage = oldStorage;
      this.mokuroFolder = oldMokuroFolder;

      // Don't throw - allow operations to continue with stale cache
      // This prevents temporary network issues from appearing as logouts
      console.warn('Continuing with potentially stale MEGA cache');
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
        const isCbz = name.toLowerCase().endsWith('.cbz');
        const lowerName = name.toLowerCase();
        const isSidecar =
          lowerName.endsWith('.mokuro') ||
          lowerName.endsWith('.mokuro.gz') ||
          /\.(webp|jpe?g)$/i.test(lowerName);
        const isJson = name === 'volume-data.json' || name === 'profiles.json';

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

          // Check if file already exists
          const children = await this.listFolder(targetFolder);
          const existingFile = children.find((f: any) => f.name === fileName && !f.directory);

          // Delete existing file if found
          if (existingFile) {
            const existingFileId = existingFile.nodeId || existingFile.id;
            await new Promise<void>((resolve, reject) => {
              existingFile.delete(true, (error: Error | null) => {
                if (error) reject(error);
                else {
                  resolve();
                  // MEGA.js doesn't remove from storage.files, so we do it manually
                  // Done after resolve() to let MEGA.js finish its internal cleanup first
                  delete this.storage.files[existingFileId];
                }
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
      // Refresh cache from MEGA's internal storage.files (which auto-updates on upload)
      // Skip reinitialize since storage.files is already fresh
      await megaCache.fetch(true);

      return fileId;
    } catch (error) {
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
            throw new Error('File not found');
          }

          return new Promise<void>((resolve, reject) => {
            (megaFile as any).delete(true, (error: Error | null) => {
              if (error) {
                reject(error);
              } else {
                console.log(`✅ Deleted file from MEGA (${fileId})`);
                resolve();
                delete this.storage.files[fileId];
              }
            });
          });
        },
        `Delete file ${fileId} from MEGA`,
        () => this.reinitialize()
      );

      // Refresh cache from MEGA's internal storage.files (which auto-updates on delete)
      // Skip reinitialize since storage.files is already fresh
      await megaCache.fetch(true);
    } catch (error) {
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
            throw new Error('File not found');
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
   * Create a temporary share link for a file
   * Returns a public download URL that includes the decryption key
   * Uses exponential backoff to handle MEGA rate limiting
   *
   * IMPORTANT: MEGA likely reuses existing share links, so calling this multiple
   * times on the same file returns the same URL. This means orphaned links from
   * previous failed cleanup attempts are automatically reused - a self-healing behavior.
   */
  async createShareLink(fileId: string): Promise<string> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    try {
      // Wrap with cache refresh retry for stale cache, then backoff for rate limiting
      return await retryWithCacheRefresh(
        async () => {
          return await retryWithBackoff(
            async () => {
              // Find the file by ID
              const files = Object.values(this.storage.files || {});
              const file = files.find(
                (f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory
              );

              if (!file) {
                throw new Error('File not found');
              }

              return new Promise<string>((resolve, reject) => {
                // Create/get share link with decryption key (noKey: false is default)
                // NOTE: If file already has a share link, MEGA API likely returns the existing one
                (file as any).link((error: Error | null, url: string) => {
                  if (error) {
                    reject(error);
                  } else {
                    resolve(url);
                  }
                });
              });
            },
            8, // maxRetries
            500, // baseDelay (ms)
            `Create MEGA share link (${fileId})`
          );
        },
        `Create MEGA share link (${fileId})`,
        () => this.reinitialize()
      );
    } catch (error) {
      throw new ProviderError(
        `Failed to create share link: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'LINK_FAILED',
        false,
        true
      );
    }
  }

  /**
   * Delete a share link for a file
   * This removes the public share link to prevent clutter
   */
  async deleteShareLink(fileId: string): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError('Not authenticated', 'mega', 'NOT_AUTHENTICATED', true);
    }

    try {
      // Wrap delete in retry logic to handle stale cache
      await retryWithCacheRefresh(
        async () => {
          // Find the file by ID
          const files = Object.values(this.storage.files || {});
          const file = files.find(
            (f: any) => (f.nodeId === fileId || f.id === fileId) && !f.directory
          );

          if (!file) {
            throw new Error('File not found');
          }

          return new Promise<void>((resolve, reject) => {
            // Unshare the file (removes the share link)
            (file as any).unshare((error: Error | null) => {
              if (error) {
                reject(error);
              } else {
                console.log(`✅ Deleted MEGA share link for file ${fileId}`);
                resolve();
              }
            });
          });
        },
        `Delete MEGA share link for file ${fileId}`,
        () => this.reinitialize()
      );
    } catch (error) {
      throw new ProviderError(
        `Failed to delete share link: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'mega',
        'UNSHARE_FAILED',
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

      // Refresh cache from MEGA's internal storage.files (which auto-updates on delete)
      // Skip reinitialize since storage.files is already fresh
      await megaCache.fetch(true);
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
    const email = localStorage.getItem(STORAGE_KEYS.EMAIL);
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);
    return { megaEmail: email, megaPassword: password };
  }

  async prepareUploadTarget(seriesTitle: string): Promise<void> {
    const mokuroFolder = await this.ensureMokuroFolder();
    await this.ensureSeriesFolder(seriesTitle, mokuroFolder);
  }

  async getWorkerDownloadCredentials(fileId: string): Promise<Record<string, any>> {
    const result = await (this.workerShareLinkMutex = this.workerShareLinkMutex.then(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, MegaProvider.WORKER_SHARE_LINK_THROTTLE_MS)
      );

      const shareUrl = await this.createShareLink(fileId);
      this.workerShareLinksToCleanup.add(fileId);
      return { megaShareUrl: shareUrl };
    }));

    return result || {};
  }

  async cleanupWorkerDownload(fileId: string): Promise<void> {
    if (!this.workerShareLinksToCleanup.has(fileId)) return;

    try {
      await this.deleteShareLink(fileId);
    } catch (error) {
      console.warn(`Failed to cleanup MEGA share link for ${fileId}:`, error);
    } finally {
      this.workerShareLinksToCleanup.delete(fileId);
    }
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
