import { browser } from '$app/environment';
import type {
  SyncProvider,
  ProviderCredentials,
  ProviderStatus,
  StorageQuota,
  CloudFileMetadata
} from '../../provider-interface';
import { ProviderError } from '../../provider-interface';
import { setActiveProviderKey, clearActiveProviderKey } from '../../provider-detection';
import type { WebDAVClient } from 'webdav';
import { getCloudProviderCore } from '../../core/cloud-provider-core-registry';
import { webdavAuthOptions } from '../../core/providers/webdav-auth';
import { basicAuthHeader } from '$lib/util/base64';
import { fetchServerIdentity, type ServerPermissions } from './identity';
import { classifyWriteError, type WriteErrorKind } from './webdav-errors';

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
  /** Server-reported permissions (mokuro-bunko identity endpoint); null = unknown/generic server */
  private _capabilities: ServerPermissions | null = null;
  /** Set when stored credentials were rejected and the user must re-login */
  private _needsAttention = false;
  /** Whether the current session was established with a password */
  private _hasPassword = false;
  private cloudCore = getCloudProviderCore('webdav');

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
      this.notifyStatusChanged();
    }
  }

  /**
   * Mark the session as auth-failed: clear only the stored password (keep
   * server URL + username so the login form pre-fills) and flag the provider
   * as needing attention so the UI prompts a re-login.
   */
  private markAuthFailed(): void {
    if (browser) {
      localStorage.removeItem(STORAGE_KEYS.PASSWORD); // keep URL + username
    }
    this.setNeedsAttention();
  }

  private setNeedsAttention(): void {
    this._needsAttention = true;
    this.notifyStatusChanged();
  }

  /** Trigger status update to refresh UI (import dynamically to avoid circular deps) */
  private notifyStatusChanged(): void {
    import('../../provider-manager').then(({ providerManager }) => {
      providerManager.updateStatus();
    });
  }

  getStatus(): ProviderStatus {
    // Only serverUrl is required - username/password are optional for some servers
    const hasCredentials = !!(browser && localStorage.getItem(STORAGE_KEYS.SERVER_URL));
    const isConnected = this.isAuthenticated();

    return {
      isAuthenticated: isConnected,
      hasStoredCredentials: hasCredentials,
      needsAttention: this._needsAttention,
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

    // The only anonymous login is a fully blank one (browse a public server).
    // A username with no password is an incomplete credential — never a silent
    // anonymous read-only session. (Password-only auth, e.g. copyparty, is
    // fine: a password with no username still authenticates.)
    if (username && !password) {
      throw new ProviderError(
        'Password is required',
        'webdav',
        'INVALID_CREDENTIALS',
        false,
        false,
        'auth'
      );
    }

    // Normalize server URL (remove trailing slash)
    const normalizedUrl = serverUrl.replace(/\/$/, '');

    try {
      // Dynamically import webdav to reduce initial bundle size
      const { createClient } = await import('webdav');

      // Create WebDAV client with a UTF-8-safe Authorization header
      // (the webdav lib's own Basic-auth encoder corrupts non-ASCII credentials)
      this.client = createClient(normalizedUrl, webdavAuthOptions(username, password));

      // Test connection with timeout (Issue #206 Lesson #3)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      try {
        await this.client.getDirectoryContents('/', { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      this._hasPassword = !!password;

      // Ask the server who we are (mokuro-bunko >= 0.1.4 identity endpoint).
      // Runs BEFORE any write and BEFORE credential persistence so invalid
      // credentials throw without side effects. A bare PROPFIND "succeeds"
      // anonymously on mokuro-bunko, so it cannot detect bad credentials.
      const identity = await fetchServerIdentity(normalizedUrl, username, password);

      switch (identity.kind) {
        case 'invalid-credentials':
          throw new ProviderError(
            'Invalid username or password',
            'webdav',
            'AUTH_FAILED',
            true,
            false,
            'auth'
          );

        case 'rate-limited':
          throw new ProviderError(
            'Too many failed attempts - try again later',
            'webdav',
            'AUTH_FAILED',
            true,
            true,
            'auth'
          );

        case 'authenticated':
          // Permissions come straight from the server - skip OPTIONS guessing
          this._capabilities = identity.permissions;
          this._isReadOnly = !(
            identity.permissions.canWriteProgress || identity.permissions.canAddFiles
          );
          if (!this._isReadOnly) {
            await this.ensureMokuroFolder();
          }
          break;

        case 'anonymous':
          // mokuro-bunko, connected without credentials: read-only by definition
          this._capabilities = {
            canWriteProgress: false,
            canAddFiles: false,
            canModifyDelete: false
          };
          this._isReadOnly = true;
          break;

        case 'unsupported':
        default:
          // Generic WebDAV server (or older mokuro-bunko): keep the existing
          // heuristics byte-for-byte (copyparty/nextcloud/nginx compatibility)
          this._capabilities = null;

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
          break;
      }

      this._needsAttention = false;

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

      // AUTH_FAILED from the identity check is already fully classified and
      // must not be re-wrapped as generic LOGIN_FAILED. Every other error
      // (including ensureMokuroFolder's FOLDER_ERROR) falls through to the
      // message-based classifier below, exactly as on the pre-identity path,
      // so the modal type and restore handling keep their legacy behavior.
      if (error instanceof ProviderError && error.code === 'AUTH_FAILED') {
        throw error;
      }

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
    this._capabilities = null;
    this._hasPassword = false;
    this._needsAttention = false; // Deliberate logout - nothing to flag

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

    if (!shouldRestore) return;

    // A stored username WITHOUT a password marks a previously auth-failed
    // session (the password was cleared). Leave it logged out and flag for
    // re-login — never silently reconnect anonymously, which would hide that
    // sync has stopped. URL + username remain stored so the form pre-fills.
    if (username && !password) {
      this.setNeedsAttention();
      console.log('WebDAV session needs re-login (stored password was cleared)');
      return;
    }

    try {
      await this.login({
        serverUrl,
        username: username || undefined,
        password: password || undefined
      });
      console.log('Restored WebDAV session from stored credentials');
    } catch (error) {
      // Branch on the typed error - never on message substrings.
      // Retryable errors (isNetworkError, e.g. a rate-limited 429 from the
      // identity check) are NOT credential rejection: the stored password may
      // be perfectly valid while the server-side limiter is hot (shared NAT
      // being brute-forced, the user's own other tab), so it must survive
      // for a later retry (M-6).
      const isAuthFailure =
        error instanceof ProviderError &&
        !error.isNetworkError &&
        (error.code === 'AUTH_FAILED' || error.webdavErrorType === 'auth');

      if (isAuthFailure) {
        // Stale credentials: clear ONLY the password (keep server URL +
        // username, keep the provider active) so the UI prompts a re-login
        // instead of silently dropping the whole configuration. Do NOT
        // reconnect anonymously — a silent read-only fallback hides that
        // sync has stopped; leave the session logged out and flagged.
        console.error('WebDAV credentials rejected, clearing stored password');
        localStorage.removeItem(STORAGE_KEYS.PASSWORD);
        this.setNeedsAttention();
      } else {
        // Temporary error - keep credentials for retry later
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(
          'Failed to restore WebDAV session (temporary error), will retry on next sync:',
          errorMessage
        );
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
    const headers: Record<string, string> = {
      'Content-Type': 'application/xml'
    };

    if (password) {
      // UTF-8-safe encoding; header only when a password is set (anonymous otherwise)
      headers['Authorization'] = basicAuthHeader(username, password);
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
        headers: headers['Authorization'] ? { Authorization: headers['Authorization'] } : {}
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
            // Include CBZ files, sidecars, and JSON config files
            if (
              name.endsWith('.cbz') ||
              name.endsWith('.mokuro') ||
              name.endsWith('.mokuro.gz') ||
              /\.(webp|jpe?g)$/i.test(name) ||
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
        // Include CBZ files, sidecars, and JSON config files
        if (
          name.endsWith('.cbz') ||
          name.endsWith('.mokuro') ||
          name.endsWith('.mokuro.gz') ||
          /\.(webp|jpe?g)$/i.test(name) ||
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

  async uploadFile(
    path: string,
    blob: Blob,
    description?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      await this.ensureMokuroFolder();

      const pathParts = path.split('/');
      const filename = pathParts.pop() || path;
      const seriesTitle = pathParts.join('/');

      const credentials = await this.getWorkerUploadCredentials();
      const fileId = await this.cloudCore.uploadFile({
        seriesTitle,
        filename,
        blob,
        credentials,
        onProgress
      });

      console.log(`✅ Uploaded ${path} to WebDAV`);
      return fileId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      const kind = classifyWriteError(errorMessage);
      if (kind !== 'other') {
        this.handleWriteFailure(kind, 'Write permission denied - server is read-only');
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

  private buildWebDAVFileMetadata(
    file: CloudFileMetadata,
    path: string,
    modifiedTime?: string
  ): CloudFileMetadata {
    return {
      ...file,
      fileId: `${MOKURO_FOLDER}/${path}`,
      path,
      modifiedTime: modifiedTime || new Date().toISOString()
    };
  }

  /**
   * Central policy for failed write operations:
   * - 401 with a password-backed session: credentials were rejected -> clear
   *   the stored password and prompt re-login (NOT a read-only server)
   * - 403 when the server told us we CAN write progress: an isolated
   *   permission error (e.g. library upload as a registered user) -> clear
   *   message, but do NOT demote to read-only (that would hide progress sync)
   * - everything else (405, 403 on unknown/low capabilities, 401 on a
   *   credential-less session): legacy behavior - mark read-only
   */
  private handleWriteFailure(kind: WriteErrorKind, readOnlyMessage: string): never {
    if (kind === 'auth' && this._hasPassword) {
      this.markAuthFailed();
      throw new ProviderError(
        'Authentication failed - please sign in again',
        'webdav',
        'AUTH_FAILED',
        true,
        false,
        'auth'
      );
    }

    if (kind === 'permission' && this._capabilities?.canWriteProgress === true) {
      throw new ProviderError(
        'Your account does not have permission for this operation on this server',
        'webdav',
        'PERMISSION_DENIED',
        false,
        false,
        'permission'
      );
    }

    this.markAsReadOnly();
    throw new ProviderError(
      readOnlyMessage,
      'webdav',
      'PERMISSION_DENIED',
      false,
      false,
      'permission'
    );
  }

  async downloadFile(
    file: import('../../provider-interface').CloudFileMetadata,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    try {
      const credentials = await this.getWorkerDownloadCredentials(file.fileId);
      const arrayBuffer = await this.cloudCore.downloadFile({
        fileId: file.fileId,
        credentials,
        onProgress: onProgress || (() => {})
      });
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

      // Typed NOT_FOUND at the boundary where the status is unambiguous about
      // THIS operation's target — the shared layer relies on the code (never
      // message text) to treat an already-gone delete target as converged.
      if ((error as { status?: number })?.status === 404) {
        throw new ProviderError(`File not found: ${file.path}`, 'webdav', 'NOT_FOUND');
      }

      const kind = classifyWriteError(errorMessage);
      if (kind !== 'other') {
        this.handleWriteFailure(kind, 'Delete permission denied - server is read-only');
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

  async renameFile(file: CloudFileMetadata, newPath: string): Promise<CloudFileMetadata> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (file.path === normalizedNewPath) {
      return file;
    }

    const newPathParts = normalizedNewPath.split('/');
    newPathParts.pop();
    const destinationFolder = newPathParts.join('/');
    const destinationFullPath = `${MOKURO_FOLDER}/${normalizedNewPath}`;

    try {
      if (destinationFolder) {
        await this.ensureSeriesFolder(destinationFolder);
      } else {
        await this.ensureMokuroFolder();
      }

      if (await this.client.exists(destinationFullPath)) {
        // Idempotent retry: if our source is gone AND the occupant matches the
        // source's recorded size, a prior attempt moved it here — treat as
        // success. Drive/MEGA verify this case by file identity (id/nodeId);
        // WebDAV has no stable ids across moves, so size is the closest
        // identity proxy. Anything else — source still present, or an
        // occupant we can't match to the source — is a genuine conflict and
        // throws before any mutation.
        if (!(await this.client.exists(file.fileId))) {
          const destStat = await this.client.stat(destinationFullPath);
          const destSize = (
            'data' in (destStat as object)
              ? (destStat as { data: { size?: number } }).data
              : (destStat as { size?: number })
          )?.size;
          if (typeof file.size === 'number' && destSize === file.size) {
            console.log(`↩️ ${normalizedNewPath} already at destination (idempotent retry)`);
            return this.buildWebDAVFileMetadata(file, normalizedNewPath);
          }
        }
        throw new ProviderError(
          `Target file already exists at '${normalizedNewPath}'`,
          'webdav',
          'TARGET_EXISTS'
        );
      }

      await this.client.moveFile(file.fileId, destinationFullPath, { overwrite: false });
      console.log(`✅ Renamed ${file.path} to ${normalizedNewPath} in WebDAV`);
      return this.buildWebDAVFileMetadata(file, normalizedNewPath);
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      // Typed NOT_FOUND: the destination was verified absent above, so a 404
      // from the MOVE means the source is gone — a genuine failure the shared
      // layer must see as such (never "already moved").
      if ((error as { status?: number })?.status === 404) {
        throw new ProviderError(`File not found: ${file.path}`, 'webdav', 'NOT_FOUND');
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const kind = classifyWriteError(errorMessage);
      if (kind !== 'other') {
        this.handleWriteFailure(kind, 'Rename permission denied - server is read-only');
      }

      throw new ProviderError(
        `Failed to rename file: ${errorMessage}`,
        'webdav',
        'RENAME_FAILED',
        false,
        true,
        'unknown'
      );
    }
  }

  async renameFolder(oldPath: string, newPath: string): Promise<CloudFileMetadata[]> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    const normalizedOldPath = oldPath.replace(/^\/+|\/+$/g, '');
    const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, '');
    if (normalizedOldPath === normalizedNewPath) {
      const allFiles = await this.listCloudVolumes();
      return allFiles.filter((file) => file.path.startsWith(`${normalizedOldPath}/`));
    }

    const sourceFullPath = `${MOKURO_FOLDER}/${normalizedOldPath}`;
    const destinationFullPath = `${MOKURO_FOLDER}/${normalizedNewPath}`;
    const renamedFiles = (await this.listCloudVolumes())
      .filter((file) => file.path.startsWith(`${normalizedOldPath}/`))
      .map((file) =>
        this.buildWebDAVFileMetadata(
          file,
          `${normalizedNewPath}${file.path.slice(normalizedOldPath.length)}`,
          file.modifiedTime
        )
      );

    try {
      const newPathParts = normalizedNewPath.split('/');
      newPathParts.pop();
      const destinationParent = newPathParts.join('/');
      if (destinationParent) {
        await this.ensureSeriesFolder(destinationParent);
      } else {
        await this.ensureMokuroFolder();
      }

      if (await this.client.exists(destinationFullPath)) {
        throw new ProviderError(
          `Target series folder already exists at '${normalizedNewPath}'`,
          'webdav',
          'TARGET_EXISTS'
        );
      }

      await this.client.moveFile(sourceFullPath, destinationFullPath, { overwrite: false });
      console.log(
        `✅ Renamed series folder ${normalizedOldPath} to ${normalizedNewPath} in WebDAV`
      );
      return renamedFiles;
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const kind = classifyWriteError(errorMessage);
      if (kind !== 'other') {
        this.handleWriteFailure(kind, 'Rename permission denied - server is read-only');
      }

      throw new ProviderError(
        `Failed to rename series folder: ${errorMessage}`,
        'webdav',
        'RENAME_FAILED',
        false,
        true,
        'unknown'
      );
    }
  }

  async deleteSeriesFolder(seriesTitle: string): Promise<void> {
    if (!this.isAuthenticated() || !this.client) {
      throw new ProviderError('Not authenticated', 'webdav', 'NOT_AUTHENTICATED', true);
    }

    const normalizedSeriesTitle = seriesTitle.replace(/^\/+|\/+$/g, '');
    if (!normalizedSeriesTitle) return;

    const folderPath = `${MOKURO_FOLDER}/${normalizedSeriesTitle}`;

    try {
      const exists = await this.client.exists(folderPath);
      if (!exists) {
        console.log(`Series folder '${seriesTitle}' not found in WebDAV`);
        return;
      }

      // Prefer one collection DELETE request when supported by the server.
      await this.client.deleteFile(folderPath);
      console.log(`✅ Deleted series folder '${seriesTitle}' from WebDAV`);
      return;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // 401/403 go through the central write-failure policy; 405/409 fall
      // through to the per-file deletion fallback below (unchanged behavior)
      const kind = classifyWriteError(errorMessage);
      if (kind === 'auth' || kind === 'permission') {
        this.handleWriteFailure(kind, 'Delete permission denied - server is read-only');
      }

      const needsPerFileFallback =
        errorMessage.includes('405') ||
        errorMessage.includes('409') ||
        errorMessage.includes('Method Not Allowed') ||
        errorMessage.includes('Conflict');

      if (!needsPerFileFallback) {
        throw new ProviderError(
          `Failed to delete series folder: ${errorMessage}`,
          'webdav',
          'DELETE_FAILED',
          false,
          true,
          'unknown'
        );
      }
    }

    // Fallback path for servers that reject collection DELETE:
    // delete each archive first, then its sidecars.
    const allFiles = await this.listCloudVolumes();
    const seriesPrefix = `${normalizedSeriesTitle}/`;
    const seriesFiles = allFiles.filter((file) => file.path.startsWith(seriesPrefix));

    const getBasePath = (path: string): string => {
      const lower = path.toLowerCase();
      if (lower.endsWith('.cbz')) return path.slice(0, -4);
      if (lower.endsWith('.mokuro.gz')) return path.slice(0, -10);
      if (lower.endsWith('.mokuro')) return path.slice(0, -7);
      if (lower.endsWith('.jpeg')) return path.slice(0, -5);
      if (lower.endsWith('.webp')) return path.slice(0, -5);
      if (lower.endsWith('.jpg')) return path.slice(0, -4);
      return path;
    };

    const archives: CloudFileMetadata[] = [];
    const nonArchivesByBase = new Map<string, CloudFileMetadata[]>();
    for (const file of seriesFiles) {
      if (file.path.toLowerCase().endsWith('.cbz')) {
        archives.push(file);
        continue;
      }
      const base = getBasePath(file.path);
      const existing = nonArchivesByBase.get(base);
      if (existing) {
        existing.push(file);
      } else {
        nonArchivesByBase.set(base, [file]);
      }
    }

    const orderedSeriesFiles: CloudFileMetadata[] = [];
    for (const archive of archives) {
      orderedSeriesFiles.push(archive);
      const base = getBasePath(archive.path);
      const related = nonArchivesByBase.get(base);
      if (related && related.length > 0) {
        orderedSeriesFiles.push(...related);
        nonArchivesByBase.delete(base);
      }
    }
    for (const leftovers of nonArchivesByBase.values()) {
      orderedSeriesFiles.push(...leftovers);
    }

    for (const file of orderedSeriesFiles) {
      await this.deleteFile(file);
    }

    // Best-effort cleanup of now-empty series directory.
    try {
      await this.client.deleteFile(folderPath);
    } catch {
      // Some servers auto-remove empty collections, others keep them.
    }

    console.log(
      `✅ Deleted series '${seriesTitle}' from WebDAV (${orderedSeriesFiles.length} files via fallback)`
    );
  }

  /**
   * Remove a directory only if the SERVER confirms it is empty — never a blind
   * recursive delete. Used to prune a series folder left empty after a rename.
   */
  async removeDirectoryIfEmpty(relativePath: string): Promise<void> {
    if (!this.isAuthenticated() || !this.client) return;

    const normalized = relativePath.replace(/^\/+|\/+$/g, '');
    if (!normalized) return;

    const folderPath = `${MOKURO_FOLDER}/${normalized}`;
    try {
      // getDirectoryContents returns the folder's CHILDREN; empty = prunable.
      const contents = await this.client.getDirectoryContents(folderPath);
      const children = Array.isArray(contents)
        ? contents
        : ((contents as { data?: unknown[] })?.data ?? []);
      if (children.length === 0) {
        await this.client.deleteFile(folderPath);
      }
    } catch {
      // Folder gone already, listing unsupported, or server refused — harmless.
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

  async getWorkerUploadCredentials(): Promise<Record<string, any>> {
    if (!browser) return {};
    const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
    const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);
    return { webdavUrl: serverUrl, webdavUsername: username, webdavPassword: password };
  }

  async prepareUploadTarget(seriesTitle: string): Promise<void> {
    await this.ensureMokuroFolder();
    await this.ensureSeriesFolder(seriesTitle);
  }

  async getWorkerDownloadCredentials(_fileId: string): Promise<Record<string, any>> {
    if (!browser) return {};
    const serverUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
    const username = localStorage.getItem(STORAGE_KEYS.USERNAME);
    const password = localStorage.getItem(STORAGE_KEYS.PASSWORD);
    return { webdavUrl: serverUrl, webdavUsername: username, webdavPassword: password };
  }
}

export const webdavProvider = new WebDAVProvider();

// Self-register cache when module is loaded (same pattern as MEGA provider)
import { cacheManager } from '../../cache-manager';
import { webdavCache } from './webdav-cache';
cacheManager.registerCache('webdav', webdavCache);
