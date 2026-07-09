import type { CloudProviderCore } from '../cloud-provider-core-types';
import { requireCredentialString } from '../cloud-provider-core-types';
import { ONEDRIVE_CONFIG } from '../../providers/onedrive/constants';
import { parseNextExpectedRange } from '../../providers/onedrive/upload-session';

const BASE = ONEDRIVE_CONFIG.GRAPH_BASE_URL;

function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

const MAX_CHUNK_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_MAX_DELAY_MS = 5000;
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_TIMEOUT_MS = 30 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers?.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.min(seconds * 1000, RETRY_MAX_DELAY_MS * 4) : undefined;
}

/**
 * Ask the upload session where to resume (Graph tracks received ranges
 * server-side). Returns null when the session can't say — caller retries
 * from its own counter.
 */
async function queryResumeOffset(uploadUrl: string): Promise<number | null> {
  try {
    const response = await fetch(uploadUrl, { signal: AbortSignal.timeout(SESSION_TIMEOUT_MS) });
    if (!response.ok) {
      await response.text().catch(() => '');
      return null;
    }
    const data = (await response.json()) as { nextExpectedRanges?: string[] };
    return data.nextExpectedRanges ? parseNextExpectedRange(data.nextExpectedRanges) : null;
  } catch {
    return null;
  }
}

/**
 * A dropped/timed-out response doesn't mean the write failed — Graph may have
 * already finalized the file server-side. Check by path+size before reporting
 * a hard failure, so a lost final ack doesn't surface as "upload failed" for
 * an upload that actually succeeded.
 */
async function findCompletedUpload(
  accessToken: string,
  targetPath: string,
  expectedSize: number
): Promise<string | null> {
  try {
    const response = await fetch(`${BASE}/me/drive/root:/${encodePath(targetPath)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const item = (await response.json()) as { id: string; size?: number };
    return item.size === expectedSize ? item.id : null;
  } catch {
    return null;
  }
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

    let uploadUrl: string | null = null;
    let sessionAttempt = 0;
    let sessionError = '';
    while (!uploadUrl) {
      sessionAttempt++;
      try {
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
            }),
            signal: AbortSignal.timeout(SESSION_TIMEOUT_MS)
          }
        );
        if (sessionResponse.ok) {
          ({ uploadUrl } = (await sessionResponse.json()) as { uploadUrl: string });
          break;
        }
        sessionError = `${sessionResponse.status} ${sessionResponse.statusText}`;
        if (!isRetryableStatus(sessionResponse.status)) {
          throw new Error(`Failed to create OneDrive upload session: ${sessionError}`);
        }
        if (sessionAttempt >= MAX_CHUNK_ATTEMPTS) {
          throw new Error(
            `Failed to create OneDrive upload session after ${MAX_CHUNK_ATTEMPTS} attempts: ${sessionError}`
          );
        }
        await sleep(
          retryAfterMs(sessionResponse) ??
            Math.min(RETRY_BASE_DELAY_MS * 2 ** (sessionAttempt - 1), RETRY_MAX_DELAY_MS)
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Failed to create')) throw error;
        sessionError = error instanceof Error ? error.message : 'network error';
        if (sessionAttempt >= MAX_CHUNK_ATTEMPTS) {
          throw new Error(
            `Failed to create OneDrive upload session after ${MAX_CHUNK_ATTEMPTS} attempts: ${sessionError}`
          );
        }
        await sleep(Math.min(RETRY_BASE_DELAY_MS * 2 ** (sessionAttempt - 1), RETRY_MAX_DELAY_MS));
      }
    }

    let lastItemId: string | null = null;
    let offset = 0;
    let attempt = 0;

    const retryOrThrow = async (reason: string, waitMs?: number): Promise<void> => {
      attempt++;
      if (attempt >= MAX_CHUNK_ATTEMPTS) {
        // The write may well have succeeded even though we never saw the ack
        // (dropped connection, client-side timeout). Confirm before failing.
        const completedId = await findCompletedUpload(accessToken, targetPath, blob.size);
        if (completedId) {
          lastItemId = completedId;
          offset = blob.size;
          return;
        }
        throw new Error(`OneDrive upload failed after ${MAX_CHUNK_ATTEMPTS} attempts: ${reason}`);
      }
      await sleep(waitMs ?? Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS));
      // Trust Graph's record of received bytes over our own counter.
      const resume = await queryResumeOffset(uploadUrl!);
      if (resume !== null) offset = resume;
    };

    while (offset < blob.size) {
      const end = Math.min(offset + ONEDRIVE_CONFIG.UPLOAD_CHUNK_SIZE - 1, blob.size - 1);

      let chunkResponse: Response;
      try {
        chunkResponse = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(end - offset + 1),
            'Content-Range': `bytes ${offset}-${end}/${blob.size}`
          },
          body: blob.slice(offset, end + 1),
          signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS)
        });
      } catch (error) {
        await retryOrThrow(error instanceof Error ? error.message : 'network error');
        continue;
      }

      if (chunkResponse.status === 200 || chunkResponse.status === 201) {
        // Final chunk returns the completed driveItem.
        const item = (await chunkResponse.json()) as { id: string };
        lastItemId = item.id;
        offset = end + 1;
        attempt = 0;
        onProgress?.(offset, blob.size);
        continue;
      }

      if (chunkResponse.status === 202) {
        // Intermediate chunk. Drain the body (avoids stream retention) and
        // use Graph's nextExpectedRanges as the authoritative next offset.
        const body = (await chunkResponse.json().catch(() => null)) as {
          nextExpectedRanges?: string[];
        } | null;
        const next = body?.nextExpectedRanges
          ? parseNextExpectedRange(body.nextExpectedRanges)
          : null;
        offset = next ?? end + 1;
        attempt = 0;
        onProgress?.(offset, blob.size);
        continue;
      }

      const waitMs = retryAfterMs(chunkResponse);
      await chunkResponse.text().catch(() => '');
      if (!isRetryableStatus(chunkResponse.status)) {
        // A definitive 4xx (other than 408/429) means Graph rejected the
        // request outright — no ambiguity to resolve, unlike a dropped
        // connection or exhausted retries against a transient status.
        throw new Error(
          `OneDrive upload chunk failed: ${chunkResponse.status} ${chunkResponse.statusText}`
        );
      }
      await retryOrThrow(`HTTP ${chunkResponse.status} ${chunkResponse.statusText}`, waitMs);
    }

    if (!lastItemId) {
      throw new Error('OneDrive upload session did not return a final driveItem');
    }
    return lastItemId;
  }
};
