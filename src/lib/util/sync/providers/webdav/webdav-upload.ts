/**
 * Shared WebDAV upload utilities
 * Can be used by both the main thread provider and Web Workers
 */

import type { WebDAVClient } from 'webdav';
import type { ServerOcrQueued } from '$lib/util/sync/provider-interface';

/** What one PUT established. */
export interface WebdavPutResult {
  /** The path written (the old string-returning contract's value). */
  path: string;
  /**
   * The server queued this file for OCR (mokuro-bunko's `X-Mokuro-Manifest` /
   * `X-Mokuro-Recheck-After`); absent for any other server or file.
   */
  serverOcr?: ServerOcrQueued;
  /**
   * The server said `X-Mokuro-Put: verified`: it stages every PUT and moves it
   * into place only once verified, so a failed PUT never harms the live file.
   */
  putVerified?: true;
  /**
   * The server checked the body against our `Content-Digest` (the algorithm it
   * names, `sha-256`): the bytes it stored are the bytes we sent, end to end.
   */
  digestVerified?: string;
}

function base64OfBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * `Content-Digest` (RFC 9530) of an upload body: `sha-256=:<base64>:`. Lets a
 * server that verifies archives tell damage in transit (digest mismatch) from
 * damage already in our copy (digest matches, CRCs fail). Null where there is
 * no SubtleCrypto (an insecure origin): the upload then goes without one.
 */
export async function contentDigestOf(blob: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') return null;
  try {
    const hash = await subtle.digest('SHA-256', await blob.arrayBuffer());
    return `sha-256=:${base64OfBytes(new Uint8Array(hash))}:`;
  } catch (error) {
    console.warn('[WebDAV] Could not compute the upload digest; sending without one:', error);
    return null;
  }
}

/** Does this `X-Mokuro-Put` value promise staged, verified PUTs? */
export function isVerifiedPutHeader(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'verified';
}

/** A response header, or null — never throws (CORS-hidden headers read as null). */
type HeaderReader = (name: string) => string | null;

/**
 * A PUT that did not settle, with the server's verdict when it gave one
 * (mokuro-bunko answers `{ok: false, reason, detail, retry}`). The message
 * keeps the HTTP status in it: `classifyWriteError` reads it from there.
 */
export class WebdavUploadError extends Error {
  readonly status?: number;
  /** Server code (`truncated`, `archive-damaged`, `disk-full`, …) or ours (`network`, `timeout`, `size-mismatch`, `unverified`, `http-<status>`). */
  readonly reason: string;
  /** One human sentence: the server's, or ours. */
  readonly detail: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    info: { status?: number; reason: string; detail: string; retryable: boolean }
  ) {
    super(message);
    this.name = 'WebdavUploadError';
    this.status = info.status;
    this.reason = info.reason;
    this.detail = info.detail;
    this.retryable = info.retryable;
  }
}

/** A failed response: the server's JSON verdict when there is one, else the status decides. */
function failureFromResponse(status: number, statusText: string, body: string): WebdavUploadError {
  let verdict: { reason?: unknown; detail?: unknown; retry?: unknown } = {};
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === 'object') verdict = parsed as typeof verdict;
  } catch {
    // Not a verdict body: any other WebDAV server.
  }
  const reason = typeof verdict.reason === 'string' ? verdict.reason : `http-${status}`;
  const serverDetail =
    typeof verdict.detail === 'string' && verdict.detail.trim() ? verdict.detail.trim() : '';
  // The server's own word first; otherwise transient statuses only. 507 (disk
  // full) is a 5xx that retrying cannot fix. Damage in transit is always worth
  // another attempt: the body we hold is fine.
  const retryable =
    typeof verdict.retry === 'boolean'
      ? verdict.retry
      : reason === 'corrupted-in-transit' ||
        status === 408 ||
        status === 429 ||
        (status >= 500 && status !== 507);
  // A FINAL archive-damaged means the bytes arrived as sent (the digest matched,
  // or the same damage came back twice): it is this device's copy that is bad,
  // and only a fresh import can fix it.
  const detail =
    reason === 'archive-damaged' && !retryable
      ? `The copy of this volume on this device is damaged; re-import the volume, then upload it again.` +
        (serverDetail ? ` (Server: ${serverDetail})` : '')
      : serverDetail || `${status} ${statusText}`.trim();
  const suffix =
    typeof verdict.reason === 'string' ? ` (${reason}: ${serverDetail || detail})` : '';
  return new WebdavUploadError(`WebDAV upload failed: ${status} ${statusText}`.trim() + suffix, {
    status,
    reason,
    detail,
    retryable
  });
}

/**
 * A 2xx is only a success when the server's verdict headers, WHEN PRESENT,
 * agree: `X-Mokuro-Upload` is `verified` (`stored` also does for a file that
 * is not an archive — the server does not zip-check those) and `X-Mokuro-Size`
 * equals the bytes sent. A server that sends neither keeps the plain 2xx rule.
 */
function verdictFailure(
  header: HeaderReader,
  path: string,
  sentBytes: number,
  status: number
): WebdavUploadError | null {
  const isArchive = /\.cbz$/i.test(path);
  const upload = header('X-Mokuro-Upload');
  if (upload !== null) {
    const verdict = upload.trim().toLowerCase();
    const ok = verdict === 'verified' || (!isArchive && verdict === 'stored');
    if (!ok) {
      return new WebdavUploadError(
        `WebDAV upload failed: ${status} but the server reported '${upload}', not verified`,
        {
          status,
          reason: 'unverified',
          detail: `The server did not verify the upload ('${upload}')`,
          retryable: true
        }
      );
    }
  }
  const size = header('X-Mokuro-Size');
  if (size !== null) {
    const stored = Number(size.trim());
    if (!Number.isFinite(stored) || stored !== sentBytes) {
      return new WebdavUploadError(
        `WebDAV upload failed: ${status} but the server stored ${size.trim()} of ${sentBytes} bytes`,
        {
          status,
          reason: 'size-mismatch',
          detail: `The server stored ${size.trim()} of ${sentBytes} bytes`,
          retryable: true
        }
      );
    }
  }
  return null;
}

/** Waits before the 2nd, 3rd and 4th attempt of an archive PUT. */
export const UPLOAD_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

export interface UploadRetryInfo {
  /** The attempt about to be made (2 = the first retry). */
  attempt: number;
  attempts: number;
  delayMs: number;
  /** Why the previous attempt failed (its `detail`). */
  reason: string;
}

/**
 * Run `attempt` until it settles, retrying only a `WebdavUploadError` that is
 * `retryable` (network, timeout, 5xx but 507, a server `retry: true`, a size
 * mismatch), with backoff. Anything else — a refusal the server means, or an
 * error nobody classified — rejects at once. The last error is the one thrown.
 */
export async function uploadWithRetry<T>(
  attempt: () => Promise<T>,
  options: {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: UploadRetryInfo) => void;
  } = {}
): Promise<T> {
  const delays = options.delaysMs ?? UPLOAD_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = delays.length + 1;
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof WebdavUploadError) || !error.retryable || i >= delays.length) {
        throw error;
      }
      const delayMs = delays[i];
      console.warn(
        `[WebDAV] Upload attempt ${i + 1}/${attempts} failed (${error.detail}); retrying in ${Math.round(delayMs / 1000)} s`
      );
      options.onRetry?.({ attempt: i + 2, attempts, delayMs, reason: error.detail });
      await sleep(delayMs);
    }
  }
}

/** The OCR queue headers of a PUT response, resolved against the upload URL. */
export function readServerOcrHeaders(
  header: HeaderReader,
  uploadUrl: string
): ServerOcrQueued | undefined {
  const manifest = header('X-Mokuro-Manifest');
  if (!manifest) return undefined;
  let manifestUrl: string;
  try {
    manifestUrl = new URL(manifest, uploadUrl).toString();
  } catch {
    return undefined;
  }
  const raw = header('X-Mokuro-Recheck-After');
  const seconds = raw !== null && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return { manifestUrl, recheckAfter: Number.isFinite(seconds) ? seconds : null };
}

/**
 * Upload a file to WebDAV using the webdav library client
 * Handles large files by streaming the Blob body (browser handles chunking)
 *
 * @param client WebDAV client instance
 * @param path Full path including filename (e.g., "/mokuro-reader/Series/Volume.cbz")
 * @param blob File data as Blob
 * @param onProgress Optional progress callback
 * @returns Promise resolving to the path written, plus what the server said about it
 */
export async function uploadFileWithClient(
  client: WebDAVClient,
  path: string,
  blob: Blob,
  onProgress?: (loaded: number, total: number) => void,
  options: {
    /** `Content-Digest` of `blob` (`contentDigestOf`), computed once per upload. */
    contentDigest?: string;
  } = {}
): Promise<WebdavPutResult> {
  const uploadUrl = client.getFileUploadLink(path);
  const clientHeaders = client.getHeaders();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);

    // Apply client headers (includes Authorization)
    // Note: getHeaders() returns a plain object, not a native Headers instance
    for (const [key, value] of Object.entries(clientHeaders)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (options.contentDigest) xhr.setRequestHeader('Content-Digest', options.contentDigest);

    // Long timeout for large files (30 minutes)
    xhr.timeout = 30 * 60 * 1000;

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(event.loaded, event.total);
        }
      };
    }

    xhr.onload = () => {
      const header: HeaderReader = (name) => {
        try {
          return xhr.getResponseHeader(name);
        } catch {
          return null;
        }
      };
      if (xhr.status >= 200 && xhr.status < 300) {
        const refused = verdictFailure(header, path, blob.size, xhr.status);
        if (refused) {
          reject(refused);
          return;
        }
        const serverOcr = readServerOcrHeaders(header, uploadUrl);
        const digestVerified = header('X-Mokuro-Digest-Verified')?.trim().toLowerCase();
        resolve({
          path,
          ...(digestVerified ? { digestVerified } : {}),
          ...(serverOcr ? { serverOcr } : {}),
          ...(isVerifiedPutHeader(header('X-Mokuro-Put')) ? { putVerified: true as const } : {})
        });
      } else {
        let body = '';
        try {
          body = typeof xhr.responseText === 'string' ? xhr.responseText : '';
        } catch {
          body = '';
        }
        reject(failureFromResponse(xhr.status, xhr.statusText, body));
      }
    };

    xhr.onerror = () => {
      reject(
        new WebdavUploadError('Network error during WebDAV upload', {
          reason: 'network',
          detail: 'Network error during the upload',
          retryable: true
        })
      );
    };

    xhr.ontimeout = () => {
      reject(
        new WebdavUploadError('WebDAV upload timed out', {
          reason: 'timeout',
          detail: 'The upload timed out',
          retryable: true
        })
      );
    };

    // Send Blob directly - browser streams without loading into memory
    xhr.send(blob);
  });
}

/**
 * Create WebDAV folders recursively
 *
 * @param client WebDAV client instance
 * @param path Folder path to create (e.g., "mokuro-reader/Series")
 */
export async function ensureFoldersExist(client: WebDAVClient, path: string): Promise<void> {
  const parts = path.split('/').filter((p) => p);

  let currentPath = '';
  for (const part of parts) {
    currentPath += `/${part}`;
    try {
      const exists = await client.exists(currentPath);
      if (!exists) {
        await client.createDirectory(currentPath);
      }
    } catch {
      // Ignore errors - folder may already exist or be created by another request
    }
  }
}

/**
 * Upload a file to WebDAV with credentials (for use in workers)
 * Creates the webdav client internally
 *
 * @param serverUrl WebDAV server URL
 * @param username Optional username
 * @param password Optional password
 * @param seriesTitle Series folder name
 * @param filename File name (e.g., "Volume 1.cbz")
 * @param blob File data
 * @param onProgress Optional progress callback
 * @returns Promise resolving to the file path
 */
export async function uploadToWebDAV(
  serverUrl: string,
  username: string,
  password: string,
  seriesTitle: string,
  filename: string,
  blob: Blob,
  onProgress?: (loaded: number, total: number) => void
): Promise<string> {
  // Dynamically import webdav to support usage in workers
  const { createClient } = await import('webdav');
  const { webdavAuthOptions } = await import('$lib/util/sync/core/providers/webdav-auth');

  // Create client with credentials (UTF-8-safe Authorization header)
  const client = createClient(serverUrl, webdavAuthOptions(username, password));

  // Ensure folder structure exists
  const folderPath = `mokuro-reader/${seriesTitle}`;
  await ensureFoldersExist(client, folderPath);

  // Upload file
  const filePath = `/${folderPath}/${filename}`;
  return (await uploadFileWithClient(client, filePath, blob, onProgress)).path;
}
