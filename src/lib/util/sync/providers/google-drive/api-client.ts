import { GOOGLE_DRIVE_CONFIG, type DriveFile } from './constants';
import { tokenManager } from './token-manager';

/**
 * Escapes special characters in file/folder names for use in Google Drive API queries.
 *
 * Google Drive query syntax requires:
 * - Backslashes to be escaped as \\
 * - Single quotes to be escaped as \'
 *
 * @param name The file or folder name to escape
 * @returns The escaped name safe for use in Drive API queries
 *
 * @example
 * escapeNameForDriveQuery("Haven't You Heard") // returns "Haven\'t You Heard"
 * escapeNameForDriveQuery("Path\\to\\file") // returns "Path\\\\to\\\\file"
 */
export function escapeNameForDriveQuery(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

class DriveApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly isNetworkError = false
  ) {
    super(message);
    this.name = 'DriveApiError';
  }
}

/**
 * Handle authentication errors (401/403) with auto re-auth support
 * Extracted to be reusable across api-client and provider
 *
 * @param status HTTP status code
 * @param retryOnAuth Whether to allow retry (prevents infinite loops)
 * @throws DriveApiError with appropriate message
 */
async function handleAuthError(status: number, retryOnAuth = true): Promise<never> {
  console.log('API call failed with auth error, token may be expired');

  // Check if auto re-auth is enabled
  const { miscSettings } = await import('$lib/settings/misc');
  const { get: getStore } = await import('svelte/store');
  const { showSnackbar } = await import('$lib/util/snackbar');

  const settings = getStore(miscSettings);
  console.log('🔍 Auto re-auth check:', {
    gdriveAutoReAuth: settings.gdriveAutoReAuth,
    retryOnAuth,
    willAttemptReauth: settings.gdriveAutoReAuth && retryOnAuth
  });

  if (settings.gdriveAutoReAuth && retryOnAuth) {
    console.log('🚀 Auto re-auth enabled, triggering re-authentication...');
    showSnackbar('Session expired. Re-authenticating...');

    // Trigger re-authentication WITHOUT clearing the token first
    // This prevents the app from entering "logged out" state during re-auth
    // The token will be replaced when re-auth succeeds
    // If re-auth fails/is cancelled, the token will be cleared in the callback
    tokenManager.reAuthenticate();

    // Still throw the error to fail the current operation
    // The user mentioned we don't need retry logic since syncs
    // happen as part of the connection flow after re-auth
    throw new DriveApiError(
      'Authentication expired. Re-authentication in progress...',
      status,
      false
    );
  }

  // If auto re-auth is disabled, clear the token and throw error
  console.log('⚠️ Auto re-auth disabled or retryOnAuth=false, clearing token');
  tokenManager.clearToken();

  if (retryOnAuth) {
    throw new DriveApiError('Authentication expired. Please sign in again.', status, false);
  }

  throw new DriveApiError('Authentication error', status, false);
}

class DriveApiClient {
  private isInitialized = false;

  /**
   * Wait for gapi global to be available (loaded from script tag)
   */
  private async waitForGapi(): Promise<void> {
    if (typeof gapi !== 'undefined' && typeof gapi.load === 'function') return;

    console.log('⏳ Waiting for Google API (gapi) to load...');
    const maxWait = 10000; // 10 seconds
    const start = Date.now();

    while (typeof gapi === 'undefined' || typeof gapi.load !== 'function') {
      if (Date.now() - start > maxWait) {
        throw new Error('Timeout waiting for Google API (gapi) to load');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    console.log('✅ Google API (gapi) loaded');
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Wait for gapi to be available first
    await this.waitForGapi();

    return new Promise((resolve, reject) => {
      gapi.load('client:picker', async () => {
        try {
          await gapi.client.init({
            apiKey: GOOGLE_DRIVE_CONFIG.API_KEY,
            discoveryDocs: [GOOGLE_DRIVE_CONFIG.DISCOVERY_DOC]
          });

          await tokenManager.initTokenClient();
          this.isInitialized = true;
          resolve();
        } catch (error) {
          reject(new DriveApiError('Failed to initialize Google Drive API', undefined, true));
        }
      });
    });
  }

  private async handleApiCall<T>(apiCall: () => Promise<T>, retryOnAuth = true): Promise<T> {
    try {
      return await apiCall();
    } catch (error: any) {
      console.error('Drive API error caught:', error);
      console.error('Error details - status:', error.status, 'message:', error.message);

      const isNetworkError =
        error.message?.toLowerCase().includes('network') ||
        error.message?.toLowerCase().includes('offline') ||
        error.status === 0;

      // Handle authentication errors
      if (!isNetworkError && (error.status === 401 || error.status === 403)) {
        await handleAuthError(error.status, retryOnAuth);
      }

      throw new DriveApiError(error.message || 'Unknown API error', error.status, isNetworkError);
    }
  }

  async listFiles(query: string, fields = 'files(id, name, mimeType)'): Promise<DriveFile[]> {
    return this.handleApiCall(async () => {
      const allFiles: DriveFile[] = [];
      let pageToken: string | undefined = undefined;

      do {
        const { result } = await gapi.client.drive.files.list({
          q: query,
          fields: `nextPageToken, ${fields}`,
          pageSize: 1000,
          pageToken
        });

        if (result.files) {
          allFiles.push(...(result.files as DriveFile[]));
        }

        pageToken = result.nextPageToken;
      } while (pageToken);

      return allFiles;
    });
  }

  async createFolder(name: string, parentId?: string): Promise<string> {
    return this.handleApiCall(async () => {
      const resource: any = {
        mimeType: GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER,
        name
      };

      if (parentId) {
        resource.parents = [parentId];
      }

      const { result } = await gapi.client.drive.files.create({
        resource,
        fields: 'id'
      });

      return result.id || '';
    });
  }

  /**
   * Download a file as Blob with progress tracking
   * Uses XMLHttpRequest for progress events, includes automatic auth error handling
   */
  async downloadFile(
    fileId: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    // Get current access token
    const token = this.getCurrentToken();
    if (!token) {
      throw new DriveApiError('No access token available', 401);
    }

    // First get file size for progress tracking
    let totalSize = 0;
    if (onProgress) {
      try {
        const metadata = await this.getFileMetadata(fileId, 'size');
        totalSize = parseInt(metadata.size || '0', 10);
      } catch (error) {
        // Size fetch failed, continue without total size
        console.warn('Could not fetch file size for progress tracking');
      }
    }

    // Download file with XMLHttpRequest for progress tracking
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.responseType = 'blob';

      xhr.onprogress = (event) => {
        if (onProgress && event.lengthComputable) {
          onProgress(event.loaded, totalSize || event.total);
        }
      };

      xhr.onload = async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response as Blob);
        } else if (xhr.status === 401 || xhr.status === 403) {
          // Handle authentication errors using shared helper
          try {
            await handleAuthError(xhr.status);
          } catch (error) {
            reject(error);
          }
        } else {
          reject(new DriveApiError(`HTTP error ${xhr.status}: ${xhr.statusText}`, xhr.status));
        }
      };

      xhr.onerror = () => reject(new DriveApiError('Network error during download', 0, true));
      xhr.ontimeout = () => reject(new DriveApiError('Download timed out', 0, true));
      xhr.onabort = () => reject(new DriveApiError('Download aborted', 0, true));

      xhr.send();
    });
  }

  /**
   * Upload a file (Blob) to Google Drive
   * Handles both create (no fileId) and update (with fileId) operations
   */
  async uploadFile(
    blob: Blob,
    metadata: { name: string; mimeType: string; parents?: string[] },
    fileId?: string
  ): Promise<{ id: string }> {
    return this.handleApiCall(async () => {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', blob);

      const url = `https://www.googleapis.com/upload/drive/v3/files${fileId ? `/${fileId}` : ''}?uploadType=multipart`;
      const token = tokenManager.isAuthenticated() ? this.getCurrentToken() : null;

      if (!token) {
        throw new DriveApiError('No valid token available');
      }

      const response = await fetch(url, {
        method: fileId ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: form
      });

      if (!response.ok) {
        throw new DriveApiError(`Upload failed: ${response.statusText}`, response.status);
      }

      return await response.json();
    });
  }

  async deleteFile(fileId: string): Promise<void> {
    return this.handleApiCall(async () => {
      await gapi.client.drive.files.delete({
        fileId
      });
    });
  }

  /**
   * Get file metadata
   * @param fileId The file ID
   * @param fields Comma-separated list of fields to retrieve (e.g., 'description', 'name,description')
   */
  async getFileMetadata(fileId: string, fields: string): Promise<any> {
    return this.handleApiCall(async () => {
      const { result } = await gapi.client.drive.files.get({
        fileId,
        fields
      });
      return result;
    });
  }

  /**
   * Update a file's description field
   * Used to store verified series title for sideloaded files
   */
  async updateFileDescription(fileId: string, description: string): Promise<void> {
    return this.handleApiCall(async () => {
      await gapi.client.drive.files.update({
        fileId,
        resource: { description },
        fields: 'id,description'
      });
    });
  }

  private getCurrentToken(): string {
    let token = '';
    tokenManager.token.subscribe((value) => {
      token = value;
    })();
    return token;
  }
}

export const driveApiClient = new DriveApiClient();
