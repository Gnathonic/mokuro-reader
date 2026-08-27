import type { UploadFileResult } from '$lib/util/sync/provider-interface';
import type { CloudProviderCore } from '../cloud-provider-core-types';
import { requireCredentialString } from '../cloud-provider-core-types';

export const googleDriveCore: CloudProviderCore = {
  async downloadFile({ fileId, credentials, onProgress }): Promise<ArrayBuffer> {
    const accessToken = requireCredentialString(
      credentials,
      'accessToken',
      'Google Drive access token'
    );

    const sizeResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!sizeResponse.ok) {
      throw new Error(`Failed to get file size: ${sizeResponse.statusText}`);
    }

    const sizeData = await sizeResponse.json();
    const totalSize = parseInt(sizeData.size, 10);

    const xhr = new XMLHttpRequest();
    xhr.open('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.responseType = 'arraybuffer';

    return await new Promise((resolve, reject) => {
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
          reject(new Error(`HTTP error ${xhr.status}: ${xhr.statusText}`));
        }
      };

      xhr.send();
    });
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
    const uploadBase = existingFileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=resumable&${responseFields}`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&${responseFields}`;

    const initResponse = await fetch(uploadBase, {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(metadata)
    });

    if (!initResponse.ok) {
      throw new Error(`Upload init failed: ${initResponse.status} ${initResponse.statusText}`);
    }

    const uploadUrl = initResponse.headers.get('Location');
    if (!uploadUrl) {
      throw new Error('No upload URL returned');
    }

    return await new Promise((resolve, reject) => {
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
            modifiedTime: typeof result.modifiedTime === 'string' ? result.modifiedTime : undefined,
            size: Number.isFinite(size) ? size : undefined
          });
        } else {
          reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
        }
      };

      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.ontimeout = () => reject(new Error('Upload timed out'));
      xhr.send(blob);
    });
  }
};
