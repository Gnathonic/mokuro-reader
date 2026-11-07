import {
  GOOGLE_DRIVE_CONFIG,
  driveApiBase,
  driveUploadBase,
  type DriveChange,
  type DriveFile
} from './constants';
import { tokenManager } from './token-manager';
import { backendAuthEnabled } from './auth-backend';
import { loadGapiScript } from './google-scripts';
import {
  classifyDriveFailure,
  driveFailureOf,
  driveHttpErrorFromXhr,
  driveRefusal,
  driveStorageFullError,
  withDriveRetry,
  type DriveFailureKind,
  type DriveRetryOptions
} from '../../core/providers/drive-http';

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
  /**
   * A change-feed request (`changes.*`) Drive answered with an HTTP status
   * other than 401: the feed is not available to this session. See
   * `handleFeedFailure`.
   */
  feedUnavailable?: true;

  constructor(
    message: string,
    public readonly status?: number,
    public readonly isNetworkError = false,
    public readonly reason?: string,
    public readonly kind?: DriveFailureKind,
    /** Refused for a token a re-auth has since replaced (see `retryStaleTokenRefusal`). */
    public readonly staleToken = false
  ) {
    super(message);
    this.name = 'DriveApiError';
  }
}

/** Requests that CREATE a file or folder retry rate limits only: a 5xx may have created it. */
const rateLimitOnly = (kind: DriveFailureKind) => kind === 'rate-limit';

/** One gapi request, retried on its own (see `handleApiCall`). */
type DriveRequest = <R>(
  call: () => Promise<R>,
  retryOn?: DriveRetryOptions['retryOn']
) => Promise<R>;

/**
 * Backend mode: make sure the held token has a few minutes left before a
 * request goes out (renewed through the session cookie when not). Implicit
 * mode: nothing, and no extra tick before the request.
 */
function beforeRequest<R>(send: () => Promise<R>): Promise<R> {
  if (!backendAuthEnabled()) return send();
  return tokenManager.getAccessToken().then(send);
}

/** The token the manager holds now. */
function getCurrentToken(): string {
  let token = '';
  tokenManager.token.subscribe((value) => {
    token = value;
  })();
  return token;
}

/**
 * Run `run` once more when it was refused for a token a re-auth has since
 * replaced: the token held now has not been tried, and a 401 created nothing,
 * so even a create is safe to send again. Once only — a second refusal is
 * the held token's own, and takes the auth path (or, if yet another re-auth
 * replaced it meanwhile, is thrown).
 */
async function retryStaleTokenRefusal<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof DriveApiError && error.staleToken)) throw error;
    console.log('Retrying with the token a re-auth has since put in place');
    return run();
  }
}

/**
 * Handle authentication errors (401/403) with auto re-auth support
 * Extracted to be reusable across api-client and provider
 *
 * @param status HTTP status code
 * @param retryOnAuth Whether to allow retry (prevents infinite loops)
 * @param sentWith The token the refused request carried, when known
 * @throws DriveApiError with appropriate message
 */
async function handleAuthError(
  status: number,
  retryOnAuth = true,
  sentWith?: string
): Promise<never> {
  // A request sent before a re-auth replaced its token comes back refused
  // after the new one is in: that refusal is the old token's. Re-authing again
  // would be a second sign-in for nothing (a second popup), and clearing would
  // drop the token that works; the caller sends it again with the held token.
  const held = getCurrentToken();
  if (sentWith !== undefined && held !== '' && sentWith !== held) {
    console.log('API call refused a token a re-auth has since replaced');
    throw new DriveApiError(
      'Authentication expired. Please try again.',
      status,
      false,
      undefined,
      'auth',
      true
    );
  }

  console.log('API call failed with auth error, token may be expired');

  // Backend mode: renew through the session cookie and send the call again
  // (once: `retryStaleTokenRefusal`), with no popup and nothing cleared. When
  // no renewal is possible the manager has already put up Reconnect.
  if (backendAuthEnabled()) {
    const renewal = await tokenManager.renewRejectedToken(sentWith ?? held);
    if (renewal.kind === 'renewed') {
      throw new DriveApiError(
        'Authentication renewed. Please try again.',
        status,
        false,
        undefined,
        'auth',
        true
      );
    }
    throw new DriveApiError(
      renewal.kind === 'transient'
        ? 'Google Drive sign-in is temporarily unavailable. Will retry later.'
        : 'Google Drive session expired. Reconnect to continue.',
      status,
      false,
      undefined,
      'auth'
    );
  }

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
      false,
      undefined,
      'auth'
    );
  }

  // If auto re-auth is disabled, clear the token and throw error
  console.log('⚠️ Auto re-auth disabled or retryOnAuth=false, clearing token');
  tokenManager.clearToken();

  if (retryOnAuth) {
    throw new DriveApiError(
      'Authentication expired. Please sign in again.',
      status,
      false,
      undefined,
      'auth'
    );
  }

  throw new DriveApiError('Authentication error', status, false, undefined, 'auth');
}

/**
 * Did this failure already go down the auth path (re-auth started, or the
 * token cleared)? A caller with a fallback request must not send it: it would
 * fail the same way and start the re-auth a second time.
 */
export function isDriveAuthFailure(error: unknown): boolean {
  return (error as { kind?: unknown } | null)?.kind === 'auth';
}

class DriveApiClient {
  private isInitialized = false;

  /**
   * Wait for the gapi global. The script is injected on demand
   * (`google-scripts.ts`): usually its load is already in flight or done —
   * started at boot or when the cloud page opened — and this joins it; a load
   * that failed earlier is tried again here. gapi's load only: GIS failing
   * must not take the Drive client down with it (with the auth backend GIS is
   * just the popup fallback; `initTokenClient` waits for it on its own).
   */
  private async waitForGapi(): Promise<void> {
    if (typeof gapi !== 'undefined' && typeof gapi.load === 'function') return;

    console.log('⏳ Waiting for Google API (gapi) to load...');
    await loadGapiScript();
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

  /**
   * Run `apiCall`, whose gapi requests go through the `request` it is handed:
   * each request's rate limits and 5xx are retried on their own
   * (`withDriveRetry`), so a paged listing resumes at its page.
   */
  private handleApiCall<T>(
    apiCall: (request: DriveRequest) => Promise<T>,
    retryOnAuth = true
  ): Promise<T> {
    // A refusal of a replaced token runs the whole call again: a paged
    // listing restarts at its first page, and every other call is one request.
    return retryStaleTokenRefusal(() => this.runApiCall(apiCall, retryOnAuth));
  }

  private async runApiCall<T>(
    apiCall: (request: DriveRequest) => Promise<T>,
    retryOnAuth: boolean
  ): Promise<T> {
    // The token the last attempt went out with (gapi's, which a grant sets
    // together with the manager's).
    let sentWith: string | undefined;
    const request: DriveRequest = (call, retryOn) =>
      withDriveRetry(
        () =>
          beforeRequest(() => {
            sentWith = getCurrentToken();
            return call();
          }),
        { retryOn }
      );
    try {
      return await apiCall(request);
    } catch (error: any) {
      const failure = driveFailureOf(error);
      console.error('Drive API error caught:', error);
      console.error(
        'Error details - status:',
        error.status,
        'reason:',
        failure?.reason,
        'domain:',
        failure?.domain,
        'message:',
        error.message
      );

      const kind: DriveFailureKind | undefined =
        failure?.status !== undefined
          ? classifyDriveFailure(failure.status, failure.reason)
          : undefined;
      if (kind === 'quota') throw driveStorageFullError();

      const isNetworkError =
        error.message?.toLowerCase().includes('network') ||
        error.message?.toLowerCase().includes('offline') ||
        error.status === 0;

      // Only a real auth failure re-authenticates — a full account, a rate
      // limit that outlasted its retries, a Drive limit and a refusal Drive
      // meant all answer 403 too, and re-auth fixes none of them.
      if (!isNetworkError && kind === 'auth') {
        await handleAuthError(error.status, retryOnAuth, sentWith);
      }

      // gapi rejects with no `.message`, so its error's text alone would drop
      // the status and reason: name them, as the transport errors do.
      const detail: string | undefined = error.message || error.result?.error?.message;
      const message = failure?.status
        ? `${detail || 'Drive API error'}: ${failure.status}` +
          (failure.reason ? ` [${failure.reason}]` : '')
        : detail || 'Unknown API error';
      throw new DriveApiError(message, error.status, isNetworkError, failure?.reason, kind);
    }
  }

  async listFiles(query: string, fields = 'files(id, name, mimeType)'): Promise<DriveFile[]> {
    return this.handleApiCall(async (request) => {
      const allFiles: DriveFile[] = [];
      let pageToken: string | undefined = undefined;

      do {
        // Each page is retried on its own: a 429 on page N must not re-fetch
        // (and re-count) the pages already in hand.
        const { result } = await request(() =>
          gapi.client.drive.files.list({
            q: query,
            fields: `nextPageToken, ${fields}`,
            pageSize: 1000,
            pageToken
          })
        );

        if (result.files) {
          allFiles.push(...(result.files as DriveFile[]));
        }

        pageToken = result.nextPageToken;
      } while (pageToken);

      return allFiles;
    });
  }

  /**
   * The change feed's current position (`changes.getStartPageToken`): every
   * change made after this call is listed by {@link listChanges} from it.
   */
  async getStartPageToken(): Promise<string> {
    return this.handleFeedFailure((request) =>
      request(async () => {
        const { result } = await gapi.client.drive.changes.getStartPageToken({
          fields: 'startPageToken'
        });
        if (!result.startPageToken) throw new Error('Drive returned no start page token');
        return result.startPageToken;
      })
    );
  }

  /**
   * The change feed's failure rule. Only a 401 is auth (the token expired):
   * the shared re-auth path. A refusal that will not clear — a 403 the
   * general rule would call auth (no reason, `insufficientPermissions`: a
   * token that cannot read the feed), a named 403 refusal, a 404 — marks the
   * error `feedUnavailable`: the cache lists in full and stops asking the
   * feed until the next login (`drive-files-cache.ts`). A re-auth would mint
   * the same token and the next listing would prompt again. A rate limit or
   * 5xx that outlasted its retries clears by itself: neither, so only the
   * call that met it lists in full and the next one asks the feed again.
   * Failures without an HTTP status (offline) are neither, and neither is a
   * 400 on `changes.list` (`pageToken` given): Drive refused that POSITION,
   * and a full listing takes a fresh one.
   */
  private handleFeedFailure<T>(
    operation: (request: DriveRequest) => Promise<T>,
    pageToken?: string
  ): Promise<T> {
    // A 401 for a token a re-auth has since replaced runs the read again with
    // the held one, as every other call does (`retryStaleTokenRefusal`).
    return retryStaleTokenRefusal(() => this.runFeedCall(operation, pageToken));
  }

  private async runFeedCall<T>(
    operation: (request: DriveRequest) => Promise<T>,
    pageToken?: string
  ): Promise<T> {
    let sentWith: string | undefined;
    const request: DriveRequest = (call, retryOn) =>
      withDriveRetry(
        () =>
          beforeRequest(() => {
            sentWith = getCurrentToken();
            return call();
          }),
        { retryOn }
      );
    try {
      return await operation(request);
    } catch (error: any) {
      // A DriveHttpError or gapi's own rejection (`{ status, result }`) alike.
      const info = driveFailureOf(error);
      const status = info?.status || undefined;
      if (status === 401) await handleAuthError(status, true, sentWith);
      const kind = status ? classifyDriveFailure(status, info?.reason) : undefined;
      const detail: string | undefined = error?.message || error?.result?.error?.message;
      const failure = new DriveApiError(
        status
          ? `${detail || 'Drive API error'}: ${status}` + (info?.reason ? ` [${info.reason}]` : '')
          : detail || 'Unknown API error',
        status,
        !status,
        info?.reason,
        // Never `auth` past this point: only the 401 above is.
        kind === 'auth' ? 'other' : kind
      );
      const refusedPosition = pageToken !== undefined && status === 400;
      const passing = (k: DriveFailureKind) => k === 'rate-limit' || k === 'transient';
      if (status && kind && !refusedPosition && !passing(kind)) failure.feedUnavailable = true;
      throw failure;
    }
  }

  /**
   * Every change since `pageToken` (`changes.list`, removals included), paged
   * like {@link listFiles} — each page retried on its own, one auth path for
   * the whole walk — and the token the NEXT call starts from. `null` when the
   * log runs past `maxPages`: reading it would cost more than the listing it
   * stands in for. `fields` selects inside `changes(...)`.
   */
  async listChanges(
    pageToken: string,
    fields: string,
    maxPages = Infinity
  ): Promise<{ changes: DriveChange[]; newStartPageToken: string } | null> {
    return this.handleFeedFailure(async (request) => {
      const changes: DriveChange[] = [];
      let token = pageToken;
      for (let page = 1; ; page++) {
        if (page > maxPages) return null;
        const { result } = await request(() =>
          gapi.client.drive.changes.list({
            pageToken: token,
            pageSize: 1000,
            includeRemoved: true,
            fields: `nextPageToken,newStartPageToken,${fields}`
          })
        );
        if (result.changes) changes.push(...(result.changes as DriveChange[]));
        if (result.nextPageToken) {
          token = result.nextPageToken;
          continue;
        }
        if (!result.newStartPageToken) throw new Error('Drive change list ended without a token');
        return { changes, newStartPageToken: result.newStartPageToken };
      }
    }, pageToken);
  }

  /**
   * Does the server list anything live in a folder? One request for ONE
   * child — a yes/no question; `listFiles` would page the whole folder.
   * Ids never need escaping.
   */
  async folderHasChildren(folderId: string): Promise<boolean> {
    return this.handleApiCall(async (request) => {
      const { result } = await request(() =>
        gapi.client.drive.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: 'files(id)',
          pageSize: 1
        })
      );
      return (result.files?.length ?? 0) > 0;
    });
  }

  async createFolder(name: string, parentId?: string): Promise<string> {
    return this.handleApiCall(async (request) => {
      const resource: any = {
        mimeType: GOOGLE_DRIVE_CONFIG.MIME_TYPES.FOLDER,
        name
      };

      if (parentId) {
        resource.parents = [parentId];
      }

      const { result } = await request(
        () =>
          gapi.client.drive.files.create({
            resource,
            fields: 'id'
          }),
        // A 5xx may have made the folder already; a retry would make a duplicate.
        rateLimitOnly
      );

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
    if (!getCurrentToken()) {
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

    // Download file with XMLHttpRequest for progress tracking; a GET is
    // idempotent, so rate limits and 5xx are simply asked again. Each attempt
    // reads the token afresh: a re-auth can land during a backoff.
    return retryStaleTokenRefusal(() =>
      withDriveRetry(() =>
        beforeRequest(() => this.downloadOnce(fileId, getCurrentToken(), totalSize, onProgress))
      )
    );
  }

  private downloadOnce(
    fileId: string,
    token: string,
    totalSize: number,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${driveApiBase()}/drive/v3/files/${fileId}?alt=media`);
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
          return;
        }
        const error = await driveHttpErrorFromXhr(
          xhr,
          'HTTP error',
          `HTTP error ${xhr.status}: ${xhr.statusText}`
        );
        if (error.kind === 'auth') {
          // Handle authentication errors using shared helper
          try {
            await handleAuthError(xhr.status, true, token);
          } catch (authError) {
            reject(authError);
          }
        } else {
          reject(driveRefusal(error));
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
    fileId?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<{ id: string }> {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    const url = `${driveUploadBase()}/drive/v3/files${fileId ? `/${fileId}` : ''}?uploadType=multipart`;
    if (!tokenManager.isAuthenticated() || !getCurrentToken()) {
      throw new DriveApiError('No valid token available');
    }

    const send = () =>
      withDriveRetry(
        () =>
          new Promise<{ id: string }>((resolve, reject) => {
            // Read per attempt: a re-auth can land during a backoff, and the
            // next attempt must go out with the token held then.
            const token = getCurrentToken();
            const xhr = new XMLHttpRequest();
            xhr.open(fileId ? 'PATCH' : 'POST', url);
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            xhr.responseType = 'json';

            if (onProgress) {
              xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                  onProgress(event.loaded, event.total);
                }
              };
            }

            xhr.onload = async () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                const response = xhr.response;
                if (response && typeof response === 'object' && 'id' in response) {
                  resolve(response as { id: string });
                  return;
                }

                try {
                  const parsed = JSON.parse(xhr.responseText || '{}') as { id?: string };
                  if (parsed.id) {
                    resolve({ id: parsed.id });
                  } else {
                    reject(
                      new DriveApiError(
                        'Upload succeeded but response is missing file id',
                        xhr.status
                      )
                    );
                  }
                } catch {
                  reject(new DriveApiError('Upload response parsing failed', xhr.status));
                }
                return;
              }
              const error = await driveHttpErrorFromXhr(xhr, 'Upload failed');
              if (error.kind === 'auth') {
                try {
                  await handleAuthError(xhr.status, true, token);
                } catch (authError) {
                  reject(authError);
                }
              } else {
                reject(driveRefusal(error));
              }
            };

            xhr.onerror = () => reject(new DriveApiError('Network error during upload', 0, true));
            xhr.ontimeout = () => reject(new DriveApiError('Upload timed out', 0, true));
            xhr.onabort = () => reject(new DriveApiError('Upload aborted', 0, true));

            xhr.send(form);
          }),
        // Rate limits send the same form again. An update (PATCH) is idempotent;
        // a create may already exist after a 5xx.
        { retryOn: fileId ? undefined : rateLimitOnly }
      );
    // A 401 for a replaced token created nothing, so even a create goes again.
    // Backend mode renews a token about to expire before the first attempt.
    return retryStaleTokenRefusal(() => beforeRequest(send));
  }

  async deleteFile(fileId: string): Promise<void> {
    return this.handleApiCall(async (request) => {
      await request(() =>
        gapi.client.drive.files.delete({
          fileId
        })
      );
    });
  }

  /**
   * Move a file/folder to a new parent folder
   * Uses addParents/removeParents to move without copying
   */
  async moveFile(fileId: string, newParentId: string, oldParentId: string): Promise<void> {
    return this.handleApiCall(async (request) => {
      await request(() =>
        gapi.client.drive.files.update({
          fileId,
          addParents: newParentId,
          removeParents: oldParentId,
          fields: 'id,parents',
          resource: {} // Empty resource required by gapi types
        })
      );
    });
  }

  /**
   * Update Drive file metadata and optionally move it between folders.
   */
  async updateFileMetadata(
    fileId: string,
    resource: Record<string, any>,
    options?: {
      addParents?: string;
      removeParents?: string;
      fields?: string;
    }
  ): Promise<DriveFile> {
    return this.handleApiCall(async (request) => {
      const { result } = await request(() =>
        gapi.client.drive.files.update({
          fileId,
          resource,
          addParents: options?.addParents,
          removeParents: options?.removeParents,
          fields: options?.fields || 'id,name,parents,modifiedTime,size,description'
        })
      );
      return result as DriveFile;
    });
  }

  /**
   * Get file metadata
   * @param fileId The file ID
   * @param fields Comma-separated list of fields to retrieve (e.g., 'description', 'name,description')
   */
  async getFileMetadata(fileId: string, fields: string): Promise<any> {
    return this.handleApiCall(async (request) => {
      const { result } = await request(() =>
        gapi.client.drive.files.get({
          fileId,
          fields
        })
      );
      return result;
    });
  }

  /**
   * Update a file's description field
   * Used to store verified series title for sideloaded files
   */
  async updateFileDescription(fileId: string, description: string): Promise<void> {
    return this.handleApiCall(async (request) => {
      await request(() =>
        gapi.client.drive.files.update({
          fileId,
          resource: { description },
          fields: 'id,description'
        })
      );
    });
  }
}

export const driveApiClient = new DriveApiClient();
