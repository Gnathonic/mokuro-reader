import type { UploadFileResult } from '$lib/util/sync/provider-interface';
import type {
  CloudCoreAuthRefresher,
  CloudCoreCredentials,
  CloudProviderCore
} from '../cloud-provider-core-types';
import { requireCredentialString } from '../cloud-provider-core-types';
import { driveApiBase, driveUploadBase } from '../../providers/google-drive/constants';
import { CLOUD_TEST_HOOKS, credentialBase } from '../../cloud-test-hooks';
import {
  DriveHttpError,
  driveHttpErrorFromResponse,
  driveHttpErrorFromXhr,
  driveRefusal,
  withDriveRetry,
  type DriveRetryFailure
} from './drive-http';

/** Why the attempt failed, in the few words the tray's "retrying" line has room for. */
function retryReason(failure: DriveRetryFailure): string {
  return failure.kind === 'rate-limit' ? 'rate limited' : `HTTP ${failure.status}`;
}

/** A failed step's {@link DriveHttpError.phase}, tagged where its answer is read. */
function inPhase(error: Error, phase: 'init' | 'status' | 'put'): Error {
  if (error instanceof DriveHttpError) error.phase = phase;
  return error;
}

function phaseOf(error: unknown): string | undefined {
  return error instanceof DriveHttpError ? error.phase : undefined;
}

/**
 * The final answer of a resumable session
 * (`fields=id,name,size,modifiedTime,version,parents`): the upload's receipt.
 */
function uploadResult(text: string): UploadFileResult {
  const result = JSON.parse(text);
  // Drive serializes `size` (and `version`, an int64) as strings in the file
  // resource.
  const size = Number(result.size);
  const version =
    typeof result.version === 'string' || typeof result.version === 'number'
      ? String(result.version)
      : undefined;
  const parentId =
    Array.isArray(result.parents) && typeof result.parents[0] === 'string'
      ? result.parents[0]
      : undefined;
  return {
    fileId: result.id,
    modifiedTime: typeof result.modifiedTime === 'string' ? result.modifiedTime : undefined,
    size: Number.isFinite(size) ? size : undefined,
    ...(version ? { revision: version } : {}),
    ...(parentId ? { parentId } : {}),
    ...(typeof result.name === 'string' ? { name: result.name } : {})
  };
}

/**
 * The access token for one transfer, renewed ONCE when Drive refuses it (401):
 * `refreshAuth` asks the session for a fresh one (a worker's request goes to
 * the main thread, `worker-auth-refresh.ts`), and the refused step runs again
 * with it. No refresher, or none to be had: the 401 stands. A transient
 * renewal failure (`TransientAuthRefreshError`) is thrown in its place, so the
 * failure never reads as a rejected sign-in.
 */
function renewingToken(
  credentials: CloudCoreCredentials,
  refreshAuth: CloudCoreAuthRefresher | undefined
) {
  let token = requireCredentialString(credentials, 'accessToken', 'Google Drive access token');
  let renewed = false;
  return async function withToken<T>(step: (accessToken: string) => Promise<T>): Promise<T> {
    try {
      return await step(token);
    } catch (error) {
      const refused = error instanceof DriveHttpError && error.status === 401;
      if (!refused || renewed || !refreshAuth) throw error;
      renewed = true;
      const fresh = await refreshAuth(`Bearer ${token}`);
      const next = fresh?.accessToken;
      if (typeof next !== 'string' || next === '' || next === token) throw error;
      token = next;
      return step(token);
    }
  };
}

/** Open a resumable session; its URI. */
async function openSession(
  uploadBase: string,
  existingFileId: string | undefined,
  accessToken: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const initResponse = await fetch(uploadBase, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });
  if (!initResponse.ok) {
    throw inPhase(
      driveRefusal(await driveHttpErrorFromResponse(initResponse, 'Upload init failed')),
      'init'
    );
  }
  const uploadUrl = initResponse.headers.get('Location');
  if (!uploadUrl) {
    throw new Error('No upload URL returned');
  }
  return uploadUrl;
}

type SessionState =
  | { kind: 'partial'; offset: number }
  | { kind: 'complete'; result: UploadFileResult }
  | { kind: 'gone' };

/**
 * Ask a resumable session how much of the file it holds: an empty PUT whose
 * Content-Range is a star and the file's size. 308 = incomplete, its
 * `Range: bytes=0-N` the bytes kept (none without one); 200/201 = the file
 * is already made; 404/410 = the session is gone. Any other answer is a
 * refusal like the init's, retried on the same rules.
 */
async function querySession(sessionUri: string, size: number): Promise<SessionState> {
  const response = await fetch(sessionUri, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes */${size}` }
  });
  if (response.status === 200 || response.status === 201) {
    return { kind: 'complete', result: uploadResult(await response.text()) };
  }
  if (response.status === 404 || response.status === 410) {
    await response.text().catch(() => '');
    return { kind: 'gone' };
  }
  if (response.status === 308) {
    await response.text().catch(() => '');
    const range = response.headers.get('Range');
    if (range === null) return { kind: 'partial', offset: 0 };
    const kept = /^bytes=0-(\d+)$/.exec(range.trim());
    const next = kept ? Number(kept[1]) + 1 : NaN;
    // An answer that names no byte we could send next: begin a clean session
    // rather than PUT a range the server would refuse.
    return Number.isSafeInteger(next) && next < size
      ? { kind: 'partial', offset: next }
      : { kind: 'gone' };
  }
  throw inPhase(
    driveRefusal(await driveHttpErrorFromResponse(response, 'Upload status query failed')),
    'status'
  );
}

/** PUT the file from `offset` on (the whole file at 0, as a single request). */
function putFrom(
  sessionUri: string,
  blob: Blob,
  offset: number,
  mimeType: string,
  onProgress: ((loaded: number, total: number) => void) | undefined
): Promise<UploadFileResult> {
  return new Promise<UploadFileResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', sessionUri);
    xhr.setRequestHeader('Content-Type', mimeType);
    if (offset > 0) {
      xhr.setRequestHeader('Content-Range', `bytes ${offset}-${blob.size - 1}/${blob.size}`);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(offset + event.loaded, blob.size);
      }
    };

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(uploadResult(xhr.responseText));
      } else {
        reject(inPhase(driveRefusal(await driveHttpErrorFromXhr(xhr, 'Upload failed')), 'put'));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));
    xhr.send(offset > 0 ? blob.slice(offset) : blob);
  });
}

export const googleDriveCore: CloudProviderCore = {
  async downloadFile({ fileId, credentials, onProgress, refreshAuth }): Promise<ArrayBuffer> {
    const withToken = renewingToken(credentials, refreshAuth);
    // A worker's bases come in its credentials (see cloudTestCredentials).
    const api = CLOUD_TEST_HOOKS
      ? credentialBase(credentials, 'driveApi', driveApiBase())
      : driveApiBase();

    // Each request retries rate limits (429, or a 403 naming one) and 5xx
    // on its own; a full account or a real auth failure is not retried (an
    // expired token is renewed once, `renewingToken`).
    const sizeResponse = await withToken((accessToken) =>
      withDriveRetry(async () => {
        const response = await fetch(`${api}/drive/v3/files/${fileId}?fields=size`, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        if (!response.ok) {
          throw driveRefusal(await driveHttpErrorFromResponse(response, 'Failed to get file size'));
        }
        return response;
      })
    );

    const sizeData = await sizeResponse.json();
    const totalSize = parseInt(sizeData.size, 10);

    // A GET is idempotent: a rejected attempt is simply asked again.
    return await withToken((accessToken) =>
      withDriveRetry(
        () =>
          new Promise<ArrayBuffer>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', `${api}/drive/v3/files/${fileId}?alt=media`);
            xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
            xhr.responseType = 'arraybuffer';

            xhr.onprogress = (event) => {
              onProgress(event.loaded, totalSize);
            };

            xhr.onerror = () => reject(new Error('Network error during download'));
            xhr.ontimeout = () => reject(new Error('Download timed out'));
            xhr.onabort = () => reject(new Error('Download aborted'));

            xhr.onload = async () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.response as ArrayBuffer);
              } else {
                reject(
                  driveRefusal(
                    await driveHttpErrorFromXhr(
                      xhr,
                      'HTTP error',
                      `HTTP error ${xhr.status}: ${xhr.statusText}`
                    )
                  )
                );
              }
            };

            xhr.send();
          })
      )
    );
  },

  async uploadFile({
    filename,
    blob,
    credentials,
    mimeType,
    existingFileId,
    onProgress,
    onRetry,
    refreshAuth
  }): Promise<UploadFileResult> {
    // Only the session init carries the token: the session URI it returns is
    // pre-authorized for the status queries and PUTs.
    const withToken = renewingToken(credentials, refreshAuth);
    const seriesFolderId = requireCredentialString(
      credentials,
      'seriesFolderId',
      'Google Drive series folder ID'
    );
    const uploadMimeType = mimeType || 'application/octet-stream';

    const metadata = {
      name: filename,
      mimeType: uploadMimeType,
      ...(existingFileId ? {} : { parents: [seriesFolderId] })
    };

    // `fields` on the session-init URL selects what the FINAL upload response
    // returns: the server's own `modifiedTime` (and authoritative `size`), the
    // file's `version` (the receipt's revision) and where it now lives
    // (`name`, `parents`) come back with the last PUT for free — no follow-up
    // metadata request needed.
    const responseFields = 'fields=id,name,size,modifiedTime,version,parents';
    const upload = CLOUD_TEST_HOOKS
      ? credentialBase(credentials, 'driveUpload', driveUploadBase())
      : driveUploadBase();
    const uploadBase = existingFileId
      ? `${upload}/drive/v3/files/${existingFileId}?uploadType=resumable&${responseFields}`
      : `${upload}/drive/v3/files?uploadType=resumable&${responseFields}`;

    // ONE session for the whole upload: a session only becomes a file once all
    // of its bytes are in, so a failed PUT leaves it open. A retry asks the
    // session where it stands (`querySession`) and sends only what it lacks —
    // or nothing, when it turns out complete; only a session Drive no longer
    // knows starts over. A 5xx is retried only before the PUT (on the init or
    // the status query): Drive may have kept a file whose PUT it answered with
    // one. A full account fails at once, as the storage-full error. Each wait
    // is reported, or the tray sits at 0 % for the whole of it.
    let sessionUri: string | null = null;
    let offset = 0;
    return await withDriveRetry(
      async () => {
        if (sessionUri) {
          const state = await querySession(sessionUri, blob.size);
          if (state.kind === 'complete') return state.result;
          if (state.kind === 'gone') sessionUri = null;
          else offset = state.offset;
        }
        if (!sessionUri) {
          sessionUri = await withToken((accessToken) =>
            openSession(uploadBase, existingFileId, accessToken, metadata)
          );
          offset = 0;
        }
        return await putFrom(sessionUri, blob, offset, uploadMimeType, onProgress);
      },
      {
        retryOn: (kind, error) =>
          kind === 'rate-limit' || (kind === 'transient' && phaseOf(error) !== 'put'),
        onWait: (delayMs, failure, attempt, attempts) =>
          onRetry?.({ attempt, attempts, delayMs, reason: retryReason(failure) })
      }
    );
  }
};
