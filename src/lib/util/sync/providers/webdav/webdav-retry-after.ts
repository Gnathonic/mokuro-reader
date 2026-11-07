/**
 * A 503 that names its wait (`Retry-After`) says "not now" about a request the
 * server did NOT apply: mokuro-bunko's lease fence while it confirms its claim
 * on the storage, a read of a file that changed behind its index, or any
 * WebDAV server shedding load. Every WebDAV request the reader sends honours
 * such a wait when it is short — at most `RETRY_AFTER_MAX_MS`, at most
 * `RETRY_AFTER_MAX_RETRIES` times per request. A 503 naming no wait, or a
 * longer one, keeps each path's own behaviour.
 *
 * Worker-safe: no `$app` imports.
 */

import type { WebDAVClient } from 'webdav';

/** A longer wait is a server down for a while: not worth holding a request open. */
export const RETRY_AFTER_MAX_MS = 30_000;
/** A floor for `0` or a date already past: never re-send at once to a server that just said no. */
export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_RETRIES = 2;

/**
 * The wait a response asks for, in ms: only a 503, only a readable
 * `Retry-After` (delay-seconds, or an HTTP-date — RFC 9110 allows both and
 * generic servers and proxies send dates), only up to `RETRY_AFTER_MAX_MS`.
 * Null otherwise. Deliberately not the Drive/OneDrive `parseRetryAfterMs`
 * (`core/http-retry.ts`): that one caps a long wait and always retries; here a
 * long wait means "don't".
 */
export function retryAfterDelayMs(
  status: number | undefined,
  value: string | null | undefined,
  now: number = Date.now()
): number | null {
  if (status !== 503 || typeof value !== 'string') return null;
  const text = value.trim();
  let ms: number;
  if (/^\d+$/.test(text)) {
    ms = Number(text) * 1000;
  } else if (/^[A-Za-z]{3,9},?\s/.test(text) && Number.isFinite(Date.parse(text))) {
    // An HTTP-date starts with its day name; `Date.parse` alone takes too much.
    ms = Date.parse(text) - now;
  } else {
    return null;
  }
  if (ms > RETRY_AFTER_MAX_MS) return null;
  return Math.max(RETRY_AFTER_MIN_MS, ms);
}

/** A response's header, or null — a CORS-hidden one reads as null. */
function headerOf(response: unknown, name: string): string | null {
  const headers = (response as { headers?: { get?: (n: string) => string | null } } | null)
    ?.headers;
  try {
    return typeof headers?.get === 'function' ? headers.get(name) : null;
  } catch {
    return null;
  }
}

/**
 * The wait a failed request asks for: a `webdav`-library error (it carries the
 * `Response`) or a `WebdavUploadError` (its `retryAfterMs`). Null otherwise.
 */
export function retryAfterOfError(error: unknown): number | null {
  const e = error as { status?: number; response?: unknown; retryAfterMs?: number } | null;
  if (!e || typeof e !== 'object') return null;
  if (typeof e.retryAfterMs === 'number') return e.retryAfterMs;
  return retryAfterDelayMs(e.status, headerOf(e.response, 'Retry-After'));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Sleep `ms`; an abort ends the wait at once with the signal's reason. */
export function waitForRetry(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Can this request body be sent a second time? Strings, buffers and Blobs are
 * read afresh by every send; a stream is consumed by the first and must never
 * be retried.
 */
export function isReplayableBody(body: unknown): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
  );
}

export interface RetryAfterOptions {
  signal?: AbortSignal | null;
  /** False for a request whose body cannot be sent twice: no 503 retry. */
  replayable?: boolean;
  /**
   * A 401: true when the caller replaced the credentials and the request
   * should go again (at most once per request). May throw.
   */
  onUnauthorized?: (error: unknown) => Promise<boolean>;
}

/**
 * Run a request that throws on failure (`webdav` client calls, XHR uploads),
 * re-running it after a short server-named 503 wait, at most
 * `RETRY_AFTER_MAX_RETRIES` times, and after one 401 re-issue — in either
 * order. An abort during the wait throws the 503 it was waiting out: that is
 * the server's answer (login's timeout must not read as "unreachable").
 * Re-running a MOVE or COPY is safe here: a 503 means the server did not apply
 * it, and a server that did anyway fails the second one (source gone, or
 * `overwrite: false` against the copy) — never a double move or copy.
 */
export async function withRetryAfter<T>(
  run: () => Promise<T>,
  options: RetryAfterOptions = {}
): Promise<T> {
  let retries = 0;
  let reissued = false;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      if (status === 401 && options.onUnauthorized && !reissued) {
        reissued = true;
        if (await options.onUnauthorized(error)) continue;
        throw error;
      }
      const wait = options.replayable === false ? null : retryAfterOfError(error);
      if (wait === null || retries >= RETRY_AFTER_MAX_RETRIES) throw error;
      retries += 1;
      try {
        await waitForRetry(wait, options.signal);
      } catch {
        throw error;
      }
    }
  }
}

/**
 * `fetch` that sends a request again after a short server-named 503 wait (at
 * most `RETRY_AFTER_MAX_RETRIES` times) and, given `onUnauthorized`, once with
 * the headers it returns after a 401. The last response is returned as is —
 * also when an abort ends a wait. A body that cannot be re-read (a stream) is
 * sent once.
 */
export async function fetchWithRetryAfter(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  onUnauthorized?: (sent: Record<string, string>) => Promise<Record<string, string> | null>
): Promise<Response> {
  const replayable = isReplayableBody(init.body);
  let headers = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
  let retries = 0;
  let reissued = false;
  for (;;) {
    const response = await fetchImpl(url, { ...init, headers });
    if (response.status === 401 && onUnauthorized && !reissued) {
      reissued = true;
      const fresh = await onUnauthorized(headers);
      if (!fresh) return response;
      headers = fresh;
      continue;
    }
    const wait = retryAfterDelayMs(response.status, headerOf(response, 'Retry-After'));
    if (wait === null || !replayable || retries >= RETRY_AFTER_MAX_RETRIES) return response;
    retries += 1;
    try {
      await waitForRetry(wait, init.signal);
    } catch {
      return response;
    }
    void response.body?.cancel().catch(() => {});
  }
}

/** `webdav` client methods that send a request. */
export const WEBDAV_CLIENT_REQUEST_METHODS = new Set([
  'copyFile',
  'createDirectory',
  'customRequest',
  'deleteFile',
  'exists',
  'getDAVCompliance',
  'getDirectoryContents',
  'getFileContents',
  'getQuota',
  'moveFile',
  'putFileContents',
  'stat'
]);

/** The `signal` among a client call's arguments (its options object), if any. */
function signalOf(args: unknown[]): AbortSignal | null {
  for (const arg of args) {
    const signal = (arg as { signal?: unknown } | null)?.signal;
    if (signal && typeof (signal as AbortSignal).addEventListener === 'function') {
      return signal as AbortSignal;
    }
  }
  return null;
}

/**
 * Wrap a `webdav` client so every request method honours a short 503 wait
 * (`withRetryAfter`). `onUnauthorized` gets the Authorization the refused
 * attempt sent. A `putFileContents` 503 is retried only with a body that can
 * be read again.
 */
export function wrapWebdavClient(
  raw: WebDAVClient,
  onUnauthorized?: (sentAuthorization: string | undefined) => Promise<boolean>
): WebDAVClient {
  return new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || !WEBDAV_CLIENT_REQUEST_METHODS.has(prop)) return value;
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        let sent: string | undefined;
        const once = () => {
          sent = onUnauthorized ? target.getHeaders().Authorization : undefined;
          return value.apply(target, args);
        };
        return withRetryAfter(once, {
          signal: signalOf(args),
          replayable: prop !== 'putFileContents' || isReplayableBody(args[1]),
          onUnauthorized: onUnauthorized ? () => onUnauthorized(sent) : undefined
        });
      };
    }
  });
}
