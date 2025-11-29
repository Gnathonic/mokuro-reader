import { browser } from '$app/environment';
import type {
  SyncProvider,
  ProviderCredentials,
  ProviderStatus,
  StorageQuota
} from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import { setActiveProviderKey, clearActiveProviderKey } from '../../provider-detection';
import type { WebDAVClient } from 'webdav';

interface WebDAVCredentials {
  serverUrl: string;
  username?: string;
  password?: string;
}

const STORAGE_KEYS = {
  SERVER_URL: 'webdav_server_url',
  USERNAME: 'webdav_username',
  PASSWORD: 'webdav_password'
};

const MOKURO_FOLDER = '/mokuro-reader';
const VOLUME_DATA_FILE = '/mokuro-reader/volume-data.json';
const PROFILES_FILE = '/mokuro-reader/profiles.json';

export class WebDAVProvider implements SyncProvider {
  readonly type = 'webdav' as const;
  readonly name = 'WebDAV';
  readonly supportsWorkerDownload = true; // Workers can download directly with Basic Auth
  readonly uploadConcurrencyLimit = 8; // WebDAV servers can typically handle more concurrent connections
  readonly downloadConcurrencyLimit = 8;

  private client: WebDAVClient | null = null;
  private initPromise: Promise<void>;

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
    return this.client !== null;
  }

  getStatus(): ProviderStatus {
    // Only serverUrl is required - username/password are optional for some servers
    const hasCredentials = !!(browser && localStorage.getItem(STORAGE_KEYS.SERVER_URL));
    const isConnected = this.isAuthenticated();

    return {
      isAuthenticated: isConnected,
      hasStoredCredentials: hasCredentials,
      needsAttention: false,
      statusMessage: isConnected
        ? 'Connected to WebDAV'
        : hasCredentials
          ? 'Configured (not connected)'
          : 'Not configured'
    };
  }

  async login(credentials?: ProviderCredentials): Promise<void> {
    // Only serverUrl is required - some servers support password-only auth (e.g., copyparty)
    if (!credentials || !credentials.serverUrl) {
      throw new ProviderError('Server URL is required', 'webdav', 'INVALID_CREDENTIALS');
    }

    const { serverUrl, username, password } = credentials as WebDAVCredentials;

    // Normalize server URL (remove trailing slash)
    const normalizedUrl = serverUrl.replace(/\/$/, '');

    try {
      // Dynamically import webdav to reduce initial bundle size
      const { createClient } = await import('webdav');

      // Create WebDAV client with optional credentials
      const clientOptions: { username?: string; password?: string } = {};
      if (username || password) {
        clientOptions.username = username || '';
        clientOptions.password = password || '';
      }
      this.client = createClient(normalizedUrl, clientOptions);

      // Test connection with timeout (Issue #206 Lesson #3)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      try {
        await this.client.getDirectoryContents('/', { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      // Ensure mokuro folder exists
      await this.ensureMokuroFolder();

      // Store credentials in localStorage (username/password are optional)
      if (browser) {
        localStorage.setItem(STORAGE_KEYS.SERVER_URL, normalizedUrl);
        if (username) {
          localStorage.setItem(STORAGE_KEYS.USERNAME, username);
        } else {
          localStorage.removeItem(STORAGE_KEYS.USERNAME);
        }
        if (password) {
          localStorage.setItem(STORAGE_KEYS.PASSWORD, password);
        } else {
          localStorage.removeItem(STORAGE_KEYS.PASSWORD);
        }
      }

      // Set the active provider key for lazy loading on next startup
      setActiveProviderKey('webdav');
      console.log('✅ WebDAV login successful');
    } catch (error) {
      this.client = null;

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Provide user-friendly error messages
      let userMessage = `WebDAV login failed: ${errorMessage}`;
      if (errorMessage.includes('401')) {
        userMessage = 'Invalid username or password';
      } else if (errorMessage.includes('404') || errorMessage.includes('ENOTFOUND')) {
        userMessage = 'Server not found. Check the server URL';
      } else if (errorMessage.includes('CORS')) {
        userMessage = 'CORS error. Your WebDAV server may need CORS configuration';
      } else if (errorMessage.includes('abort') || errorMessage.includes('timeout')) {
        userMessage = 'Connection timed out. Server may be unresponsive';
      }

      throw new ProviderError(userMessage, 'webdav', 'LOGIN_FAILED', true);
    }
  }

  async logout(): Promise<void> {
    this.client = null;

    if (browser) {
      // Keep URL and username for convenience (Issue #206 Lesson #10)
      // Only clear the password for security
      localStorage.removeItem(STORAGE_KEYS.PASSWORD);
    }

    // Clear the active provider key
    clearActiveProviderKey();
    console.log('WebDAV logged out');
  }

  /**
   * Get the last used server URL (for pre-filling login form)
   */
  getLastServerUrl(): string | null {
    return browser ? localStorage.getItem(STORAGE_KEYS.SERVER_URL) : null;
  }

  /**
   * Get the last used username (for pre-filling login form)
   */
  getLastUsername(): string | null {
    return browser ? localStorage.getItem(STORAGE_KEYS.USERNAME) : null;
  }

  /**
   * Clear all stored credentials (for full logout)
   */
  clearAllCredentials(): void {
    if (browser) {
      localStorage.removeItem(STORAGE_KEYS.SERVER_URL);
      localStorage.removeItem(STORAGE_KEYS.USERNAME);
      localStorage.removeItem(STORAGE_KEYS.PASSWORD);
    }
  }

  private async loadPersistedCredentials(): Promise<void> {
    if (!browser || typeof localStorage === 'undefined') return;

    const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
    const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);

    // Use active_cloud_provider to determine if we should restore
    // This properly handles anonymous connections (no password) vs logged out state
    const activeProvider = localStorage.getItem('active_cloud_provider');
    const shouldRestore = activeProvider === 'webdav' && serverUrl;

    if (shouldRestore) {
      try {
        await this.login({
          serverUrl,
          username: username || undefined,
          password: password || undefined
        });
        console.log('Restored WebDAV session from stored credentials');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Only clear credentials if they're actually invalid (wrong credentials/URL)
        // Don't clear on network errors or temporary server issues
        const isAuthError =
          errorMessage.includes('401') ||
          errorMessage.includes('403') ||
          errorMessage.includes('unauthorized') ||
          errorMessage.includes('authentication') ||
          errorMessage.includes('credentials');

        if (isAuthError) {
          console.error('WebDAV credentials invalid, clearing stored credentials');
          this.clearAllCredentials();
          clearActiveProviderKey();
        } else {
          // Temporary error - keep credentials for retry later
          console.warn(
            'Failed to restore WebDAV session (temporary error), will retry on next sync:',
            errorMessage
          );
        }
      }
    }
  }

  private async ensureMokuroFolder(): Promise<void> {
    if (!this.client) return;

    try {
      const exists = await this.client.exists(MOKURO_FOLDER);

      if (!exists) {
        await this.client.createDirectory(MOKURO_FOLDER);
        console.log('Created mokuro-reader folder in WebDAV');
      }
    } catch (error) {
      throw new ProviderError(
        `Failed to ensure mokuro folder exists: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'webdav',
        'FOLDER_ERROR'
      );
    }
  }

  // GENERIC FILE OPERATIONS

  async listCloudVolumes(): Promise<import('../../provider-interface').CloudFileMetadata[]> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      // Ensure mokuro folder exists first
      await this.ensureMokuroFolder();

      const allFiles: import('../../provider-interface').CloudFileMetadata[] = [];
      const client = this.client;

      // Manual recursive folder traversal (Issue #206 Lesson #2)
      // Avoid Depth: infinity which some servers reject
      const processFolder = async (folderPath: string): Promise<void> => {
        const contents = (await client.getDirectoryContents(folderPath)) as Array<{
          type: string;
          filename: string;
          basename: string;
          lastmod: string;
          size: number;
        }>;

        for (const item of contents) {
          if (item.type === 'directory') {
            // Recurse into subdirectories
            await processFolder(item.filename);
          } else {
            const name = item.basename.toLowerCase();
            // Include CBZ files and JSON config files
            if (
              name.endsWith('.cbz') ||
              item.basename === 'volume-data.json' ||
              item.basename === 'profiles.json'
            ) {
              // Build relative path from mokuro folder
              const relativePath = item.filename.replace(MOKURO_FOLDER + '/', '');

              allFiles.push({
                provider: 'webdav',
                fileId: item.filename, // Full WebDAV path as fileId
                path: relativePath,
                modifiedTime: item.lastmod || new Date().toISOString(),
                size: item.size || 0
              });
            }
          }
        }
      };

      await processFolder(MOKURO_FOLDER);

      console.log(`✅ Listed ${allFiles.length} files from WebDAV`);
      return allFiles;
    } catch (error) {
      throw new ProviderError(
        `Failed to list cloud volumes: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'webdav',
        'LIST_FAILED',
        false,
        true
      );
    }
  }

  async uploadFile(path: string, blob: Blob, description?: string): Promise<string> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      await this.ensureMokuroFolder();

      const fullPath = `${MOKURO_FOLDER}/${path}`;

      // Ensure parent directory exists for nested paths (e.g., "SeriesTitle/Volume.cbz")
      const pathParts = path.split('/');
      if (pathParts.length > 1) {
        const seriesFolder = pathParts.slice(0, -1).join('/');
        await this.ensureSeriesFolder(seriesFolder);
      }

      // Delete-before-upload pattern (Issue #206 Lesson #1 - CRITICAL)
      // Some servers (copyparty) don't overwrite on PUT, they rename and create duplicates
      try {
        const exists = await this.client.exists(fullPath);
        if (exists) {
          await this.client.deleteFile(fullPath);
        }
      } catch {
        // Ignore errors - file may not exist
      }

      // Convert Blob to ArrayBuffer and upload
      // Don't pass { overwrite: true } - it doesn't work reliably across servers
      const arrayBuffer = await blob.arrayBuffer();
      await this.client.putFileContents(fullPath, arrayBuffer);

      console.log(`✅ Uploaded ${path} to WebDAV`);
      return fullPath;
    } catch (error) {
      throw new ProviderError(
        `Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'webdav',
        'UPLOAD_FAILED',
        false,
        true
      );
    }
  }

  /**
   * Ensure a series folder exists under mokuro-reader
   */
  private async ensureSeriesFolder(folderPath: string): Promise<void> {
    if (!this.client) return;

    const fullPath = `${MOKURO_FOLDER}/${folderPath}`;
    try {
      const exists = await this.client.exists(fullPath);
      if (!exists) {
        await this.client.createDirectory(fullPath, { recursive: true });
        console.log(`Created series folder: ${folderPath}`);
      }
    } catch (error) {
      // Some servers throw if directory already exists, ignore that
      const errorMessage = error instanceof Error ? error.message : '';
      if (!errorMessage.includes('405') && !errorMessage.includes('already exists')) {
        throw error;
      }
    }
  }

  async downloadFile(
    file: import('../../provider-interface').CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      // For WebDAV, fileId is the full path
      const content = await this.client.getFileContents(file.fileId, {
        format: 'binary'
      });

      // Handle all possible response types (ArrayBuffer, typed arrays, etc.)
      let arrayBuffer: ArrayBuffer;
      if (content instanceof ArrayBuffer) {
        arrayBuffer = content;
      } else if (ArrayBuffer.isView(content)) {
        // Handle typed arrays (Uint8Array, etc.)
        // Create a new ArrayBuffer copy to avoid SharedArrayBuffer issues
        const view = content as Uint8Array;
        arrayBuffer = new Uint8Array(view).buffer as ArrayBuffer;
      } else {
        arrayBuffer = content as ArrayBuffer;
      }

      // Convert to Blob
      const blob = new Blob([arrayBuffer], { type: 'application/zip' });
      console.log(`✅ Downloaded ${file.path} from WebDAV`);
      return blob;
    } catch (error) {
      throw new ProviderError(
        `Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'webdav',
        'DOWNLOAD_FAILED',
        false,
        true
      );
    }
  }

  async deleteFile(file: import('../../provider-interface').CloudFileMetadata): Promise<void> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      // For WebDAV, fileId is the full path
      await this.client.deleteFile(file.fileId);
      console.log(`✅ Deleted ${file.path} from WebDAV`);
    } catch (error) {
      throw new ProviderError(
        `Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'webdav',
        'DELETE_FAILED',
        false,
        true
      );
    }
  }

  /**
   * Get storage quota information from WebDAV server
   * Returns used, total, and available storage in bytes
   * Note: Not all WebDAV servers support quota reporting (RFC 4331)
   */
  async getStorageQuota(): Promise<StorageQuota> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      // WebDAV library's getQuota() returns DiskQuota | ResponseDataDetailed<DiskQuota | null>
      const response = await this.client.getQuota();

      // Handle ResponseDataDetailed wrapper (when details option is used)
      const quota =
        response && typeof response === 'object' && 'data' in response ? response.data : response;

      if (quota && typeof quota === 'object' && 'used' in quota) {
        const used = (quota as { used?: number; available?: number }).used || 0;
        const available = (quota as { used?: number; available?: number }).available ?? null;
        const total = available !== null ? used + available : null;

        return {
          used,
          total,
          available
        };
      }

      // Server doesn't provide quota info
      return {
        used: 0,
        total: null,
        available: null
      };
    } catch {
      // Many WebDAV servers don't support quota - return unknown
      return {
        used: 0,
        total: null,
        available: null
      };
    }
  }
}

export const webdavProvider = new WebDAVProvider();

// Self-register cache when module is loaded (same pattern as MEGA provider)
import { cacheManager } from '../../cache-manager';
import { webdavCache } from './webdav-cache';
cacheManager.registerCache('webdav', webdavCache);
