import { createClient } from 'webdav';
import {
  ensureFoldersExist,
  uploadFileWithClient
} from '$lib/util/sync/providers/webdav/webdav-upload';
import type { CloudProviderCore } from '../cloud-provider-core-types';
import { optionalCredentialString, requireCredentialString } from '../cloud-provider-core-types';

export const webdavCore: CloudProviderCore = {
  async downloadFile({ fileId, credentials, onProgress }): Promise<ArrayBuffer> {
    const url = requireCredentialString(credentials, 'webdavUrl', 'WebDAV URL');
    const username = optionalCredentialString(credentials, 'webdavUsername');
    const password = optionalCredentialString(credentials, 'webdavPassword');

    const encodedPath = fileId
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
    const fullUrl = `${baseUrl}${encodedPath}`;

    const headers: Record<string, string> = {};
    if (username || password) {
      headers.Authorization = 'Basic ' + btoa(`${username}:${password}`);
    }

    const MAX_ERROR_RETRIES = 5;
    const MAX_PARTIAL_RESUME_RETRIES = 8;
    const BASE_RETRY_DELAY_MS = 400;
    const MAX_RETRY_DELAY_MS = 5000;
    const PROGRESS_THROTTLE_MS = 67; // ~15 updates per second

    const chunks: Uint8Array[] = [];
    let receivedLength = 0;
    let expectedTotal = 0;
    let lastProgressUpdate = 0;
    let lastError: Error | null = null;
    let errorRetries = 0;
    let partialResumeRetries = 0;
    let lastRetryResetOffset = 0;

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;
    const isRetryableError = (error: unknown) => {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      return (
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('failed to fetch') ||
        message.includes('fetch')
      );
    };

    const parseContentRangeTotal = (value: string | null): number => {
      if (!value) return 0;
      const match = value.match(/\/(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    };

    const getRetryResetThreshold = (): number => {
      // Reset retry budgets after meaningful forward progress:
      // max(1MB, 5% of expected size when known)
      if (expectedTotal > 0) {
        return Math.max(1024 * 1024, Math.floor(expectedTotal * 0.05));
      }
      return 1024 * 1024;
    };

    // Best-effort size probe: helps detect truncation even when GET is chunked
    // without Content-Length. If HEAD fails/is unsupported, we'll continue without it.
    try {
      const headResponse = await fetch(fullUrl, { method: 'HEAD', headers });
      if (headResponse.ok) {
        const headSize = parseInt(headResponse.headers.get('Content-Length') || '0', 10);
        if (headSize > 0) {
          expectedTotal = headSize;
        }
      }
    } catch {
      // ignore
    }

    while (true) {
      const requestHeaders: Record<string, string> = { ...headers };
      if (receivedLength > 0) {
        requestHeaders.Range = `bytes=${receivedLength}-`;
      }

      try {
        const response = await fetch(fullUrl, { headers: requestHeaders });

        if (!response.ok) {
          // 416 can happen when range start == size (already complete)
          if (response.status === 416 && expectedTotal > 0 && receivedLength >= expectedTotal) {
            break;
          }

          const error = new Error(
            `WebDAV download failed: ${response.status} ${response.statusText}`
          );
          lastError = error;
          if (isRetryableStatus(response.status) && errorRetries < MAX_ERROR_RETRIES) {
            errorRetries += 1;
            const jitter = Math.floor(Math.random() * 150);
            const delay = Math.min(
              MAX_RETRY_DELAY_MS,
              BASE_RETRY_DELAY_MS * 2 ** (errorRetries - 1) + jitter
            );
            await sleep(delay);
            continue;
          }
          throw error;
        }

        // If server ignores Range on resumed attempts, restart from scratch.
        if (receivedLength > 0 && response.status === 200) {
          chunks.length = 0;
          receivedLength = 0;
        }

        const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
        const contentRangeTotal = parseContentRangeTotal(response.headers.get('Content-Range'));
        if (contentRangeTotal > 0) {
          expectedTotal = contentRangeTotal;
        } else if (contentLength > 0) {
          expectedTotal = receivedLength + contentLength;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('Response body is not readable');
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          chunks.push(value);
          receivedLength += value.length;

          // Connection is making forward progress; clear retry pressure periodically.
          if (receivedLength - lastRetryResetOffset >= getRetryResetThreshold()) {
            errorRetries = 0;
            partialResumeRetries = 0;
            lastRetryResetOffset = receivedLength;
          }

          const now = Date.now();
          if (now - lastProgressUpdate >= PROGRESS_THROTTLE_MS) {
            onProgress(receivedLength, expectedTotal || receivedLength);
            lastProgressUpdate = now;
          }
        }

        // If stream ended early, retry with Range from current offset.
        if (expectedTotal > 0 && receivedLength < expectedTotal) {
          if (partialResumeRetries >= MAX_PARTIAL_RESUME_RETRIES) {
            throw new Error('WebDAV download incomplete after partial-resume retries');
          }
          partialResumeRetries += 1;
          const jitter = Math.floor(Math.random() * 150);
          const delay = Math.min(
            MAX_RETRY_DELAY_MS,
            BASE_RETRY_DELAY_MS * 2 ** (partialResumeRetries - 1) + jitter
          );
          await sleep(delay);
          continue;
        }

        break;
      } catch (error) {
        const wrapped =
          error instanceof Error ? error : new Error('Unknown error during WebDAV download');
        lastError = wrapped;

        if (isRetryableError(wrapped) && errorRetries < MAX_ERROR_RETRIES) {
          errorRetries += 1;
          const jitter = Math.floor(Math.random() * 150);
          const delay = Math.min(
            MAX_RETRY_DELAY_MS,
            BASE_RETRY_DELAY_MS * 2 ** (errorRetries - 1) + jitter
          );
          await sleep(delay);
          continue;
        }

        throw wrapped;
      }
    }

    if (expectedTotal > 0 && receivedLength < expectedTotal) {
      throw lastError || new Error('WebDAV download incomplete after retries');
    }

    onProgress(receivedLength, expectedTotal || receivedLength);

    const blob = new Blob(chunks as BlobPart[]);
    const buffer = await blob.arrayBuffer();
    chunks.length = 0;
    return buffer;
  },

  async uploadFile({
    seriesTitle,
    filename,
    blob,
    credentials,
    onProgress
  }): Promise<string> {
    const serverUrl = requireCredentialString(credentials, 'webdavUrl', 'WebDAV URL');
    const username = optionalCredentialString(credentials, 'webdavUsername');
    const password = optionalCredentialString(credentials, 'webdavPassword');

    const clientOptions: { username?: string; password?: string } = {};
    if (username || password) {
      clientOptions.username = username;
      clientOptions.password = password;
    }
    const client = createClient(serverUrl, clientOptions);

    const folderPath = seriesTitle ? `mokuro-reader/${seriesTitle}` : 'mokuro-reader';
    await ensureFoldersExist(client, folderPath);

    const filePath = `/${folderPath}/${filename}`;

    // Delete-before-upload to avoid duplicate renames on servers that don't overwrite on PUT.
    try {
      const exists = await client.exists(filePath);
      if (exists) {
        await client.deleteFile(filePath);
      }
    } catch {
      // ignore existence/delete checks here; upload attempt will report fatal errors
    }

    return await uploadFileWithClient(client, filePath, blob, onProgress);
  }
};
