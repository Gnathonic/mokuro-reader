import { browser } from '$app/environment';
import type { SyncProvider, ProviderCredentials, ProviderStatus } from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import type { WebDAVClient } from 'webdav';

interface WebDAVCredentials {
  serverUrl: string;
  username: string;
  password: string;
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
  readonly uploadConcurrencyLimit = 2; // Conservative, depends on server capacity
  readonly downloadConcurrencyLimit = 2;

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
    const hasCredentials = !!(
      browser &&
      localStorage.getItem(STORAGE_KEYS.SERVER_URL) &&
      localStorage.getItem(STORAGE_KEYS.USERNAME) &&
      localStorage.getItem(STORAGE_KEYS.PASSWORD)
    );
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
    if (!credentials || !credentials.serverUrl || !credentials.username || !credentials.password) {
      throw new ProviderError(
        'Server URL, username, and password are required',
        'webdav',
        'INVALID_CREDENTIALS'
      );
    }

    const { serverUrl, username, password } = credentials as WebDAVCredentials;

    // Normalize server URL (remove trailing slash)
    const normalizedUrl = serverUrl.replace(/\/$/, '');

    try {
      // Dynamically import webdav to reduce initial bundle size
      const { createClient } = await import('webdav');

      // Create WebDAV client
      this.client = createClient(normalizedUrl, {
        username,
        password
      });

      // Test connection by getting server info
      await this.client.getDirectoryContents('/');

      // Ensure mokuro folder exists
      await this.ensureMokuroFolder();

      // Store credentials in localStorage
      if (browser) {
        localStorage.setItem(STORAGE_KEYS.SERVER_URL, normalizedUrl);
        localStorage.setItem(STORAGE_KEYS.USERNAME, username);
        localStorage.setItem(STORAGE_KEYS.PASSWORD, password);
      }

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
      }

      throw new ProviderError(userMessage, 'webdav', 'LOGIN_FAILED', true);
    }
  }

  async logout(): Promise<void> {
    this.client = null;

    if (browser) {
      localStorage.removeItem(STORAGE_KEYS.SERVER_URL);
      localStorage.removeItem(STORAGE_KEYS.USERNAME);
      localStorage.removeItem(STORAGE_KEYS.PASSWORD);
    }

    console.log('WebDAV logged out');
  }

  private async loadPersistedCredentials(): Promise<void> {
    if (!browser) return;

    const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
    const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);

    if (serverUrl && username && password) {
      try {
        await this.login({ serverUrl, username, password });
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
          this.logout();
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
      // TODO: Implement WebDAV listCloudVolumes
      console.warn('WebDAV listCloudVolumes not yet implemented');
      return [];
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

      // Convert Blob to ArrayBuffer
      const arrayBuffer = await blob.arrayBuffer();
      const fullPath = `${MOKURO_FOLDER}/${path}`;

      // Upload file
      await this.client.putFileContents(fullPath, arrayBuffer, {
        overwrite: true
      });

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

      // Convert to Blob
      const blob = new Blob([content as ArrayBuffer]);
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
}

export const webdavProvider = new WebDAVProvider();
