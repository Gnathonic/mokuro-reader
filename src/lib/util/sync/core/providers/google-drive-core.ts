import type { UploadFileResult } from '$lib/util/sync/provider-interface';
import type { CloudProviderCore } from '../cloud-provider-core-types';
import { requireCredentialString } from '../cloud-provider-core-types';
import { driveApiBase, driveUploadBase } from '../../providers/google-drive/constants';
import { CLOUD_TEST_HOOKS, credentialBase } from '../../cloud-test-hooks';
import {
  driveHttpErrorFromResponse,
  driveHttpErrorFromXhr,
  driveRefusal,
  withDriveRetry
} from './drive-http';

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

    // Each request retries rate limits (429, or a 403 naming one) and 5xx
    // on its own; a full account or a real auth failure is not retried.
    const sizeResponse = await withDriveRetry(async () => {
      const response = await fetch(`${api}/drive/v3/files/${fileId}?fields=size`, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
      if (!response.ok) {
        throw driveRefusal(await driveHttpErrorFromResponse(response, 'Failed to get file size'));
      }
      return response;
    });

    const sizeData = await sizeResponse.json();
    const totalSize = parseInt(sizeData.size, 10);

    // A GET is idempotent: a rejected attempt is simply asked again.
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

    // Each attempt is a fresh session (a session only becomes a file once its
    // PUT completes), so a rate limit on either step starts the upload over.
    // A 5xx is retried only before the PUT: Drive may have kept a file whose
    // PUT it answered with one. A full account fails at once, as the
    // storage-full error.
    let putSent = false;
    return await withDriveRetry(
      async () => {
        putSent = false;
        const initResponse = await fetch(uploadBase, {
          method: existingFileId ? 'PATCH' : 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(metadata)
        });
        if (!initResponse.ok) {
          throw driveRefusal(await driveHttpErrorFromResponse(initResponse, 'Upload init failed'));
        }

        const uploadUrl = initResponse.headers.get('Location');
        if (!uploadUrl) {
          throw new Error('No upload URL returned');
        }

        putSent = true;
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
              reject(driveRefusal(await driveHttpErrorFromXhr(xhr, 'Upload failed')));
            }
          };

          xhr.onerror = () => reject(new Error('Network error during upload'));
          xhr.ontimeout = () => reject(new Error('Upload timed out'));
          xhr.send(blob);
        });
      },
      { retryOn: (kind) => kind === 'rate-limit' || (kind === 'transient' && !putSent) }
    );
  }
};
