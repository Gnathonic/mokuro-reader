import { ProviderError, type UploadFileResult } from '$lib/util/sync/provider-interface';
import type { CloudProviderCore } from '../cloud-provider-core-types';
import { requireCredentialString } from '../cloud-provider-core-types';
import { ONEDRIVE_CONFIG, graphBase } from '../../providers/onedrive/constants';
import { parseNextExpectedRange } from '../../providers/onedrive/upload-session';
import { CLOUD_TEST_HOOKS, credentialBase } from '../../cloud-test-hooks';
import {
  MAX_RETRY_ATTEMPTS,
  backoffDelayMs,
  retryAfterMs,
  retryDelayMs,
  sleep
} from '../http-retry';
import {
  graphErrorCode,
  isGraphQuotaFailure,
  isGraphRetryableStatus,
  oneDriveStorageFullError
} from '../../providers/onedrive/graph-errors';

function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

const MAX_CHUNK_ATTEMPTS = MAX_RETRY_ATTEMPTS;

/** A refusal's body as text ('' when unreadable), which also drains it. */
async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_TIMEOUT_MS = 30 * 1000;

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
  graph: string,
  accessToken: string,
  targetPath: string,
  expectedSize: number
): Promise<CompletedDriveItem | null> {
  try {
    const response = await fetch(`${graph}/me/drive/root:/${encodePath(targetPath)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const item = (await response.json()) as CompletedDriveItem;
    return item.size === expectedSize ? item : null;
  } catch {
    return null;
  }
}

/** The slice of a Graph driveItem the upload paths read. */
interface CompletedDriveItem {
  id: string;
  /** The server's own modification timestamp — what listings later report. */
  lastModifiedDateTime?: string;
  size?: number;
  /** Content change token — the receipt's revision when present. */
  cTag?: string;
  eTag?: string;
}

/** A driveItem's revision token: `cTag` (moves with the content only), else `eTag`. */
export function oneDriveRevision(item: { cTag?: string; eTag?: string }): string | undefined {
  if (typeof item.cTag === 'string' && item.cTag) return item.cTag;
  if (typeof item.eTag === 'string' && item.eTag) return item.eTag;
  return undefined;
}

export const onedriveCore: CloudProviderCore = {
  async downloadFile({ fileId, credentials, onProgress }): Promise<ArrayBuffer> {
    const accessToken = requireCredentialString(
      credentials,
      'accessToken',
      'OneDrive access token'
    );
    // A worker's bases come in its credentials (see cloudTestCredentials).
    const graph = CLOUD_TEST_HOOKS
      ? credentialBase(credentials, 'graph', graphBase())
      : graphBase();

    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `${graph}/me/drive/items/${encodeURIComponent(fileId)}/content`);
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

  async uploadFile({
    seriesTitle,
    filename,
    blob,
    credentials,
    onProgress
  }): Promise<UploadFileResult> {
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
    const graph = CLOUD_TEST_HOOKS
      ? credentialBase(credentials, 'graph', graphBase())
      : graphBase();

    let uploadUrl: string | null = null;
    let sessionAttempt = 0;
    let sessionError = '';
    while (!uploadUrl) {
      sessionAttempt++;
      try {
        const sessionResponse = await fetch(
          `${graph}/me/drive/root:/${encodePath(targetPath)}:/createUploadSession`,
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
        // Every refusal's body is read (and so drained): a full drive (507, or
        // ANY status naming a quota code — a 429/503 can too) stays full, so it
        // fails now with the storage-full error, before the retryable check.
        const code = graphErrorCode(await readBody(sessionResponse));
        if (isGraphQuotaFailure(sessionResponse.status, code)) throw oneDriveStorageFullError();
        if (!isGraphRetryableStatus(sessionResponse.status)) {
          throw new Error(`Failed to create OneDrive upload session: ${sessionError}`);
        }
        if (sessionAttempt >= MAX_CHUNK_ATTEMPTS) {
          throw new Error(
            `Failed to create OneDrive upload session after ${MAX_CHUNK_ATTEMPTS} attempts: ${sessionError}`
          );
        }
        await sleep(retryDelayMs(sessionAttempt, retryAfterMs(sessionResponse)));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof Error && error.message.startsWith('Failed to create')) throw error;
        sessionError = error instanceof Error ? error.message : 'network error';
        if (sessionAttempt >= MAX_CHUNK_ATTEMPTS) {
          throw new Error(
            `Failed to create OneDrive upload session after ${MAX_CHUNK_ATTEMPTS} attempts: ${sessionError}`
          );
        }
        await sleep(backoffDelayMs(sessionAttempt));
      }
    }

    let lastItem: CompletedDriveItem | null = null;
    /**
     * `lastItem` came from the lost-ack probe, not from the upload session's
     * own answer. A same-size file at the path is all it proves: that may be
     * this write, the file it was replacing (a `positions.json` whose page
     * moved but not its length), or another device's same-size write. Its
     * change token and mtime then vouch for bytes that may not be ours.
     */
    let recovered = false;
    let offset = 0;
    let attempt = 0;

    const retryOrThrow = async (reason: string, waitMs?: number): Promise<void> => {
      attempt++;
      if (attempt >= MAX_CHUNK_ATTEMPTS) {
        // The write may well have succeeded even though we never saw the ack
        // (dropped connection, client-side timeout). Confirm before failing.
        const completed = await findCompletedUpload(graph, accessToken, targetPath, blob.size);
        if (completed) {
          lastItem = completed;
          recovered = true;
          offset = blob.size;
          return;
        }
        throw new Error(`OneDrive upload failed after ${MAX_CHUNK_ATTEMPTS} attempts: ${reason}`);
      }
      await sleep(retryDelayMs(attempt, waitMs));
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
        // Final chunk returns the completed driveItem — including the
        // server's `lastModifiedDateTime`, the same field listings report.
        const item = (await chunkResponse.json()) as CompletedDriveItem;
        lastItem = item;
        recovered = false;
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
      // A quota code fails at once whatever status carries it (see above).
      if (
        isGraphQuotaFailure(chunkResponse.status, graphErrorCode(await readBody(chunkResponse)))
      ) {
        throw oneDriveStorageFullError();
      }
      if (!isGraphRetryableStatus(chunkResponse.status)) {
        // A definitive 4xx (other than 408/429) means Graph rejected the
        // request outright — no ambiguity to resolve, unlike a dropped
        // connection or exhausted retries against a transient status.
        throw new Error(
          `OneDrive upload chunk failed: ${chunkResponse.status} ${chunkResponse.statusText}`
        );
      }
      await retryOrThrow(`HTTP ${chunkResponse.status} ${chunkResponse.statusText}`, waitMs);
    }

    if (!lastItem) {
      throw new Error('OneDrive upload session did not return a final driveItem');
    }
    const finalItem: CompletedDriveItem = lastItem;
    if (recovered) {
      // An unverified receipt: no revision, so the root-file memo drops its
      // copy and the next read downloads the real file
      // (`noteRootFileUpload`); no server mtime, so the cache entry stays
      // provisional (`uploadCacheEntry`). The id and size are the path's.
      return {
        fileId: finalItem.id,
        size: typeof finalItem.size === 'number' ? finalItem.size : undefined
      };
    }
    return {
      fileId: finalItem.id,
      modifiedTime:
        typeof finalItem.lastModifiedDateTime === 'string'
          ? finalItem.lastModifiedDateTime
          : undefined,
      size: typeof finalItem.size === 'number' ? finalItem.size : undefined,
      // The same token `statFile` compares: cTag (content only), else eTag.
      ...(oneDriveRevision(finalItem) ? { revision: oneDriveRevision(finalItem) } : {})
    };
  }
};
