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
  private _isReadOnly: boolean = false;
  private _supportsDepthInfinity: boolean | null = null; // null = unknown, will probe on first use

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

  /**
   * Check if the WebDAV connection is read-only (no write permissions)
   */
  get isReadOnly(): boolean {
    return this._isReadOnly;
  }

  /**
   * Mark the provider as read-only (called when a write operation fails with permission error)
   * Also triggers a status update to refresh the UI
   */
  markAsReadOnly(): void {
    if (!this._isReadOnly) {
      console.log('📖 WebDAV marked as read-only due to write operation failure');
      this._isReadOnly = true;

      // Trigger status update to refresh UI (import dynamically to avoid circular deps)
      import('../../provider-manager').then(({ providerManager }) => {
        providerManager.updateStatus();
      });
    }
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
        ? this._isReadOnly
          ? 'Connected to WebDAV (read-only)'
          : 'Connected to WebDAV'
        : hasCredentials
          ? 'Configured (not connected)'
          : 'Not configured',
      isReadOnly: this._isReadOnly
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

      // Check write permissions via OPTIONS request
      this._isReadOnly = !(await this.checkWritePermissions(
        normalizedUrl,
        username || '',
        password || ''
      ));
      if (this._isReadOnly) {
        console.log('📖 WebDAV server is read-only (no PUT/DELETE/MKCOL permissions)');
      }

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

      // Classify error type for detailed modal guidance
      // CORS, SSL, and DNS errors all appear as opaque network errors from fetch()
      // Browser shows "Failed to fetch" or "NetworkError" - specific cause only visible in DevTools console
      const isOpaqueNetworkError =
        (errorMessage.includes('Failed to fetch') ||
          errorMessage.includes('NetworkError') ||
          errorMessage.includes('Network request failed') ||
          errorMessage.includes('Load failed')) &&
        !errorMessage.includes('401') &&
        !errorMessage.includes('403') &&
        !errorMessage.includes('404') &&
        !errorMessage.includes('timeout') &&
        !errorMessage.includes('abort');

      const isAuthError =
        errorMessage.includes('401') ||
        errorMessage.includes('403') ||
        errorMessage.includes('Unauthorized') ||
        errorMessage.includes('Forbidden');

      const isConnectionError =
        errorMessage.includes('404') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('abort') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('ECONNREFUSED');

      // Determine error type and user message
      let userMessage = errorMessage;
      let webdavErrorType: import('../../provider-interface').WebDAVErrorType = 'unknown';

      if (isOpaqueNetworkError) {
        userMessage = 'Network error - check browser console (F12) for details';
        webdavErrorType = 'network';
      } else if (isAuthError) {
        userMessage = 'Authentication failed - check your credentials';
        webdavErrorType = 'auth';
      } else if (isConnectionError) {
        userMessage = 'Could not connect to server';
        webdavErrorType = 'connection';
      }

      throw new ProviderError(
        userMessage,
        'webdav',
        'LOGIN_FAILED',
        isAuthError,
        isConnectionError || isOpaqueNetworkError,
        webdavErrorType
      );
    }
  }

  async logout(): Promise<void> {
    this.client = null;
    this._supportsDepthInfinity = null; // Reset for next connection (may be different server)

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
    this._supportsDepthInfinity = null; // Reset for next connection
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

  /**
   * Check if the server allows write operations
   * Returns true if write is allowed (or if we can't determine)
   *
   * Uses tiered approach:
   * 1. Try PROPFIND with DAV:current-user-privilege-set (most accurate for ACL-enabled servers)
   * 2. Fall back to OPTIONS request to check Allow header
   * 3. If both are inconclusive → assume write access
   * 4. Actual write operations will mark as read-only if they fail with permission errors
   */
  private async checkWritePermissions(
    baseUrl: string,
    username: string,
    password: string
  ): Promise<boolean> {
    const url = `${baseUrl}${MOKURO_FOLDER}/`;
    const headers: HeadersInit = {
      'Content-Type': 'application/xml'
    };

    if (username || password) {
      headers['Authorization'] = 'Basic ' + btoa(`${username}:${password}`);
    }

    // Try PROPFIND with current-user-privilege-set first (RFC 3744 - WebDAV ACL)
    try {
      console.log('[WebDAV] Checking user privileges via PROPFIND for:', url);

      const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-privilege-set/>
  </D:prop>
</D:propfind>`;

      const response = await fetch(url, {
        method: 'PROPFIND',
        headers: {
          ...headers,
          Depth: '0'
        },
        body: propfindBody
      });

      console.log('[WebDAV] PROPFIND response status:', response.status);

      if (response.ok || response.status === 207) {
        const text = await response.text();
        console.log('[WebDAV] PROPFIND response:', text.substring(0, 500));

        // Check if the property returned 404 (server doesn't support ACL extension)
        // This is different from having no privileges - it means we can't determine from PROPFIND
        if (text.includes('current-user-privilege-set') && text.includes('404')) {
          console.log(
            '[WebDAV] Server does not support ACL (current-user-privilege-set returned 404), falling back to OPTIONS'
          );
          // Fall through to OPTIONS check
        } else {
          // Server supports ACL - check for actual privileges
          // Look for privilege elements like <D:write/>, <D:read/>, <D:all/>, etc.
          const hasWritePrivilege =
            text.includes('<D:write') ||
            text.includes('<write') ||
            text.includes(':write/>') ||
            text.includes('<D:all') ||
            text.includes('<all') ||
            text.includes(':all/>');

          const hasReadPrivilege =
            text.includes('<D:read') || text.includes('<read') || text.includes(':read/>');

          // Only consider read-only if we found privileges and read is present but write is not
          if (hasReadPrivilege && !hasWritePrivilege) {
            console.log(
              '[WebDAV] PROPFIND indicates read-only access (has read but no write privileges)'
            );
            return false;
          }

          if (hasWritePrivilege) {
            console.log('[WebDAV] PROPFIND confirms write access');
            return true;
          }

          // If we got a response but couldn't parse privileges clearly, fall through to OPTIONS
          console.log('[WebDAV] PROPFIND response unclear, falling back to OPTIONS');
        }
      }
    } catch (error) {
      console.log('[WebDAV] PROPFIND failed, falling back to OPTIONS:', error);
    }

    // Fall back to OPTIONS request
    try {
      console.log('[WebDAV] Checking write permissions via OPTIONS for:', url);

      const response = await fetch(url, {
        method: 'OPTIONS',
        headers: { Authorization: headers['Authorization'] || '' }
      });

      console.log('[WebDAV] OPTIONS response status:', response.status);

      if (!response.ok) {
        // If OPTIONS fails, assume full access (fail open for usability)
        console.warn('[WebDAV] OPTIONS request failed, assuming full write access');
        return true;
      }

      const allowHeader = response.headers.get('Allow');
      console.log('[WebDAV] Allow header:', allowHeader);

      // If Allow header is missing or empty, assume full access
      // Not all servers return an Allow header on OPTIONS
      if (!allowHeader || allowHeader.trim() === '') {
        console.log('[WebDAV] No Allow header present, assuming full write access');
        return true;
      }

      const allowedMethods = allowHeader
        .split(',')
        .map((m) => m.trim().toUpperCase())
        .filter((m) => m.length > 0);

      // If the header exists but has no valid methods, assume full access
      if (allowedMethods.length === 0) {
        console.log('[WebDAV] Allow header empty, assuming full write access');
        return true;
      }

      // Need PUT for uploads, DELETE for deletions, MKCOL for creating folders
      const hasPut = allowedMethods.includes('PUT');
      const hasDelete = allowedMethods.includes('DELETE');
      const hasMkcol = allowedMethods.includes('MKCOL');

      const hasWrite = hasPut && hasDelete && hasMkcol;

      console.log(
        `[WebDAV] Permissions: PUT=${hasPut}, DELETE=${hasDelete}, MKCOL=${hasMkcol}, hasWrite=${hasWrite}`
      );

      return hasWrite;
    } catch (error) {
      // If we can't check, assume full access (fail open for usability)
      console.warn('[WebDAV] Failed to check write permissions:', error);
      return true;
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

      const client = this.client;

      // Try Depth: infinity first if we haven't determined it's unsupported
      // Only use depth infinity on mokuro-reader folder (not root) for performance + safety
      if (this._supportsDepthInfinity !== false) {
        try {
          const files = await this.listWithDepthInfinity(client);
          // Success - server supports depth infinity
          if (this._supportsDepthInfinity === null) {
            console.log('[WebDAV] Server supports Depth: infinity - using fast listing');
            this._supportsDepthInfinity = true;
          }
          console.log(`✅ Listed ${files.length} files from WebDAV (depth infinity)`);
          return files;
        } catch (error) {
          // Depth infinity not supported - fall back to recursive
          const errorMessage = error instanceof Error ? error.message : String(error);
          // 403 Forbidden, 400 Bad Request, or specific "depth infinity" errors indicate no support
          const isDepthInfinityError =
            errorMessage.includes('403') ||
            errorMessage.includes('400') ||
            errorMessage.includes('infinity') ||
            errorMessage.includes('Depth') ||
            errorMessage.includes('propfind');

          if (isDepthInfinityError && this._supportsDepthInfinity === null) {
            console.log(
              '[WebDAV] Server does not support Depth: infinity - falling back to recursive listing'
            );
            this._supportsDepthInfinity = false;
          } else if (this._supportsDepthInfinity === null) {
            // Unknown error on first try - still fall back but don't cache the result
            console.warn(
              '[WebDAV] Depth: infinity failed with unexpected error, trying recursive:',
              errorMessage
            );
          } else {
            // Re-throw if we thought it was supported but it failed
            throw error;
          }
        }
      }

      // Fall back to manual recursive folder traversal
      const allFiles: import('../../provider-interface').CloudFileMetadata[] = [];

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

      console.log(`✅ Listed ${allFiles.length} files from WebDAV (recursive)`);
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

  /**
   * List all files using Depth: infinity PROPFIND (single request)
   * Only used on mokuro-reader folder, not root, for performance and safety
   */
  private async listWithDepthInfinity(
    client: WebDAVClient
  ): Promise<import('../../provider-interface').CloudFileMetadata[]> {
    // Use deep option which sets Depth: infinity
    const contents = (await client.getDirectoryContents(MOKURO_FOLDER, {
      deep: true
    })) as Array<{
      type: string;
      filename: string;
      basename: string;
      lastmod: string;
      size: number;
    }>;

    const allFiles: import('../../provider-interface').CloudFileMetadata[] = [];

    for (const item of contents) {
      if (item.type === 'file') {
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

    return allFiles;
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

      // Use direct fetch with Blob body for large file support
      // blob.arrayBuffer() fails for files >1GB due to contiguous memory allocation limits
      // fetch() can stream Blobs without loading the entire file into memory
      const uploadUrl = this.client.getFileUploadLink(fullPath);

      // Get auth headers from the client (includes Authorization header)
      const clientHeaders = this.client.getHeaders();
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        body: blob,
        headers: {
          ...Object.fromEntries(clientHeaders.entries()),
          'Content-Type': 'application/octet-stream'
        }
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
      }

      console.log(`✅ Uploaded ${path} to WebDAV`);
      return fullPath;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check for permission errors - mark as read-only
      // 401 = Unauthorized (read-only token), 403 = Forbidden, 405 = Method Not Allowed
      if (
        errorMessage.includes('401') ||
        errorMessage.includes('403') ||
        errorMessage.includes('405') ||
        errorMessage.includes('Unauthorized') ||
        errorMessage.includes('Forbidden') ||
        errorMessage.includes('Method Not Allowed') ||
        errorMessage.includes('Permission denied')
      ) {
        this.markAsReadOnly();
        throw new ProviderError(
          'Write permission denied - server is read-only',
          'webdav',
          'PERMISSION_DENIED',
          false,
          false,
          'permission'
        );
      }

      throw new ProviderError(
        `Failed to upload file: ${errorMessage}`,
        'webdav',
        'UPLOAD_FAILED',
        false,
        true,
        'unknown'
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check for permission errors - mark as read-only
      // 401 = Unauthorized (read-only token), 403 = Forbidden, 405 = Method Not Allowed
      if (
        errorMessage.includes('401') ||
        errorMessage.includes('403') ||
        errorMessage.includes('405') ||
        errorMessage.includes('Unauthorized') ||
        errorMessage.includes('Forbidden') ||
        errorMessage.includes('Method Not Allowed') ||
        errorMessage.includes('Permission denied')
      ) {
        this.markAsReadOnly();
        throw new ProviderError(
          'Delete permission denied - server is read-only',
          'webdav',
          'PERMISSION_DENIED',
          false,
          false,
          'permission'
        );
      }

      throw new ProviderError(
        `Failed to delete file: ${errorMessage}`,
        'webdav',
        'DELETE_FAILED',
        false,
        true,
        'unknown'
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
