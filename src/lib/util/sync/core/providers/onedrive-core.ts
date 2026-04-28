import type { CloudProviderCore } from '../cloud-provider-core-types';
import { requireCredentialString } from '../cloud-provider-core-types';
import { ONEDRIVE_CONFIG } from '../../providers/onedrive/constants';
import { createChunkRanges } from '../../providers/onedrive/upload-session';

const BASE = ONEDRIVE_CONFIG.GRAPH_BASE_URL;

function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

export const onedriveCore: CloudProviderCore = {
  async downloadFile({ fileId, credentials, onProgress }): Promise<ArrayBuffer> {
    const accessToken = requireCredentialString(
      credentials,
      'accessToken',
      'OneDrive access token'
    );

    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${BASE}/me/drive/items/${encodeURIComponent(fileId)}/content`);
      xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      xhr.responseType = 'arraybuffer';
      xhr.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
      xhr.onerror = () => reject(new Error('Network error during OneDrive download'));
      xhr.ontimeout = () => reject(new Error('OneDrive download timed out'));
      xhr.onabort = () => reject(new Error('OneDrive download aborted'));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response as ArrayBuffer);
        } else {
          reject(new Error(`OneDrive download HTTP ${xhr.status}: ${xhr.statusText}`));
        }
      };
      xhr.send();
    });
  },

  async uploadFile({ seriesTitle, filename, blob, credentials, onProgress }): Promise<string> {
    const accessToken = requireCredentialString(
      credentials,
      'accessToken',
      'OneDrive access token'
    );

    // The worker calls in with the bare series title (e.g. "Cowboy Bebop").
    // Anchor the upload under our app's mokuro-reader folder, matching the
    // layout used by Drive and WebDAV. The provider's main-thread uploadFile
    // ensures the parent folder exists ahead of time via prepareUploadTarget;
    // worker uploads ride on that same precondition.
    const folderPath = seriesTitle
      ? `${ONEDRIVE_CONFIG.MOKURO_FOLDER}/${seriesTitle}`
      : ONEDRIVE_CONFIG.MOKURO_FOLDER;
    const targetPath = `${folderPath}/${filename}`;

    const sessionResponse = await fetch(
      `${BASE}/me/drive/root:/${encodePath(targetPath)}:/createUploadSession`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          item: { '@microsoft.graph.conflictBehavior': 'replace' }
        })
      }
    );
    if (!sessionResponse.ok) {
      throw new Error(
        `Failed to create OneDrive upload session: ${sessionResponse.status} ${sessionResponse.statusText}`
      );
    }
    const { uploadUrl } = (await sessionResponse.json()) as { uploadUrl: string };

    let lastItemId: string | null = null;
    for (const range of createChunkRanges(blob.size, ONEDRIVE_CONFIG.UPLOAD_CHUNK_SIZE)) {
      const chunk = blob.slice(range.start, range.end + 1);
      const chunkResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${range.total}`
        },
        body: chunk
      });
      if (!chunkResponse.ok) {
        throw new Error(
          `OneDrive upload chunk failed: ${chunkResponse.status} ${chunkResponse.statusText}`
        );
      }
      onProgress?.(range.end + 1, range.total);

      // Final chunk returns the completed driveItem (201 Created or 200 OK).
      // Non-final chunks return 202 Accepted with nextExpectedRanges.
      if (chunkResponse.status === 201 || chunkResponse.status === 200) {
        const item = (await chunkResponse.json()) as { id: string };
        lastItemId = item.id;
      }
    }

    if (!lastItemId) {
      throw new Error('OneDrive upload session did not return a final driveItem');
    }
    return lastItemId;
  }
};
