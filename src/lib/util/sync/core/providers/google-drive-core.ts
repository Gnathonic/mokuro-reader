import type { UploadFileResult } from '$lib/util/sync/provider-interface';
import type { CloudProviderCore } from '../cloud-provider-core-types';
import { requireCredentialString } from '../cloud-provider-core-types';
import { driveApiBase, driveUploadBase } from '../../providers/google-drive/constants';
import { CLOUD_TEST_HOOKS, credentialBase } from '../../cloud-test-hooks';
import { parseRetryAfterMs } from '../http-retry';
import {
  DriveHttpError,
  driveErrorReason,
  driveStorageFullError,
  isDriveStorageFull,
  withDriveRetry
} from '../../providers/google-drive/drive-retry';

/**
 * A fetch that fails on a non-2xx with a {@link DriveHttpError} (status,
 * reason, Retry-After) — or the storage-full error when that is what Drive said.
 */
async function driveFetch(url: string, init: RequestInit, failure: string): Promise<Response> {
  const response = await fetch(url, init);
  if (response.ok) return response;
  const reason = driveErrorReason(await response.text().catch(() => ''));
  if (isDriveStorageFull({ status: response.status, reason })) throw driveStorageFullError();
  throw new DriveHttpError(
    `${failure}: ${response.status} ${response.statusText}`,
    response.status,
    reason,
    parseRetryAfterMs(response.headers?.get?.('Retry-After'))
  );
}

/** The failure of a finished XHR that did not succeed (see {@link driveFetch}). */
function xhrFailure(xhr: XMLHttpRequest, message: string, bodyText: string): Error {
  const reason = driveErrorReason(bodyText);
  if (isDriveStorageFull({ status: xhr.status, reason })) return driveStorageFullError();
  return new DriveHttpError(
    message,
    xhr.status,
    reason,
    parseRetryAfterMs(xhr.getResponseHeader('Retry-After'))
  );
}

/** The text of an `arraybuffer` XHR's (error) body. */
function arrayBufferText(body: unknown): string {
  if (!(body instanceof ArrayBuffer)) return '';
  try {
    return new TextDecoder().decode(body);
  } catch {
    return '';
  }
}

export const googleDriveCore: CloudProviderCore = {
  async downloadFile({ fileId, credentials, onProgress }): Promise<ArrayBuffer> {
    const accessToken = requireCredentialString(
      credentials,
      'accessToken',
      'Google Drive access token'
    );
    // A worker's bases come in its credentials (see cloudTestCredentials).
    const api = CLOUD_TEST_HOOKS
      ? credentialBase(credentials, 'driveApi', driveApiBase())
      : driveApiBase();

    // Each request retries Drive's rate limits on its own (`withDriveRetry`).
    const sizeResponse = await withDriveRetry(() =>
      driveFetch(
        `${api}/drive/v3/files/${fileId}?fields=size`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        'Failed to get file size'
      )
    );

    const sizeData = await sizeResponse.json();
    const totalSize = parseInt(sizeData.size, 10);

    return await withDriveRetry(
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

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(xhr.response as ArrayBuffer);
            } else {
              reject(
                xhrFailure(
                  xhr,
                  `HTTP error ${xhr.status}: ${xhr.statusText}`,
                  arrayBufferText(xhr.response)
                )
              );
            }
          };

          xhr.send();
        })
    );
  },

  async uploadFile({
    filename,
    blob,
    credentials,
    mimeType,
    existingFileId,
    onProgress
  }): Promise<UploadFileResult> {
    const accessToken = requireCredentialString(
      credentials,
      'accessToken',
      'Google Drive access token'
    );
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
    // returns: the server's own `modifiedTime` (and authoritative `size`) come
    // back with the last PUT for free — no follow-up metadata request needed.
    const responseFields = 'fields=id,modifiedTime,size';
    const upload = CLOUD_TEST_HOOKS
      ? credentialBase(credentials, 'driveUpload', driveUploadBase())
      : driveUploadBase();
    const uploadBase = existingFileId
      ? `${upload}/drive/v3/files/${existingFileId}?uploadType=resumable&${responseFields}`
      : `${upload}/drive/v3/files?uploadType=resumable&${responseFields}`;

    // A rate limit on either step starts the upload over with a fresh session
    // (a session only becomes a file once its PUT completes), on the shared
    // retry policy. A full drive fails at once with the storage-full error.
    return await withDriveRetry(async () => {
      const initResponse = await driveFetch(
        uploadBase,
        {
          method: existingFileId ? 'PATCH' : 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(metadata)
        },
        'Upload init failed'
      );

      const uploadUrl = initResponse.headers.get('Location');
      if (!uploadUrl) {
        throw new Error('No upload URL returned');
      }

      return await new Promise<UploadFileResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', uploadMimeType);

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && onProgress) {
            onProgress(event.loaded, event.total);
          }
        };

        xhr.onload = async () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            const result = JSON.parse(xhr.responseText);
            // Drive serializes `size` as a string in the file resource.
            const size = Number(result.size);
            resolve({
              fileId: result.id,
              modifiedTime:
                typeof result.modifiedTime === 'string' ? result.modifiedTime : undefined,
              size: Number.isFinite(size) ? size : undefined
            });
          } else {
            reject(
              xhrFailure(xhr, `Upload failed: ${xhr.status} ${xhr.statusText}`, xhr.responseText)
            );
          }
        };

        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));
        xhr.send(blob);
      });
    });
  }
};
