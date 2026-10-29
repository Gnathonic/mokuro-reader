/**
 * Google Drive HTTP failure handling shared by the main thread (api-client,
 * provider) and the download/upload workers (google-drive-core) — so no
 * svelte imports here.
 *
 * Drive answers a full account, a rate limit and a revoked token all with
 * 403; only the body's `error.errors[0].reason` tells them apart. Sending a
 * quota or rate-limit 403 down the auth path cleared the token (or started a
 * re-auth) for a perfectly valid session.
 */

export type DriveFailureKind = 'quota' | 'rate-limit' | 'transient' | 'auth' | 'other';

export const DRIVE_RETRY_ATTEMPTS = 4;
export const DRIVE_RETRY_AFTER_CAP_MS = 60_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_JITTER = 0.2;

const QUOTA_REASONS = new Set(['storageQuotaExceeded', 'quotaExceeded']);
const RATE_LIMIT_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded']);
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

/** `error.errors[0].reason` of a Drive error body, parsed or as JSON text. */
export function driveErrorReason(body: unknown): string | undefined {
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  const reason = (parsed as { error?: { errors?: Array<{ reason?: unknown }> } } | null)?.error
    ?.errors?.[0]?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

export function classifyDriveFailure(status: number, reason?: string): DriveFailureKind {
  if (reason && QUOTA_REASONS.has(reason)) return 'quota';
  if (status === 429 || (status === 403 && reason && RATE_LIMIT_REASONS.has(reason))) {
    return 'rate-limit';
  }
  if (TRANSIENT_STATUSES.has(status)) return 'transient';
  // Any other 403 keeps the old auth handling.
  if (status === 401 || status === 403) return 'auth';
  return 'other';
}

/** Retry-After (delta-seconds or HTTP-date) in ms, capped at 60 s. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now()
): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  return Math.min(Math.max(0, ms), DRIVE_RETRY_AFTER_CAP_MS);
}

export class DriveHttpError extends Error {
  readonly kind: DriveFailureKind;
  readonly retryAfterMs?: number;

  constructor(
    public readonly status: number,
    public readonly reason?: string,
    options: { context?: string; statusText?: string; retryAfterMs?: number } = {}
  ) {
    // The bracketed reason survives a worker's message-only serialization,
    // so the main thread can still tell a full account apart.
    super(
      `${options.context ?? 'Google Drive request failed'}: ${status}` +
        (options.statusText ? ` ${options.statusText}` : '') +
        (reason ? ` [${reason}]` : '')
    );
    this.name = 'DriveHttpError';
    this.kind = classifyDriveFailure(status, reason);
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** A non-ok fetch Response as a DriveHttpError (drains the body). */
export async function driveHttpErrorFromResponse(
  response: Response,
  context: string
): Promise<DriveHttpError> {
  const text = await response.text().catch(() => '');
  return new DriveHttpError(response.status, driveErrorReason(text), {
    context,
    statusText: response.statusText,
    retryAfterMs: parseRetryAfter(response.headers?.get('Retry-After'))
  });
}

/** An XHR error body of any responseType, as something driveErrorReason reads. */
export async function readXhrErrorBody(response: unknown): Promise<unknown> {
  if (typeof Blob !== 'undefined' && response instanceof Blob) {
    return response.text().catch(() => undefined);
  }
  // Tag check, not instanceof: a buffer from another realm still decodes.
  if (Object.prototype.toString.call(response) === '[object ArrayBuffer]') {
    try {
      return new TextDecoder().decode(response as ArrayBuffer);
    } catch {
      return undefined;
    }
  }
  return response;
}

/** A finished non-2xx XHR as a DriveHttpError. */
export async function driveHttpErrorFromXhr(
  xhr: XMLHttpRequest,
  context: string
): Promise<DriveHttpError> {
  // responseText throws for 'json'/'blob'/'arraybuffer' response types.
  const body =
    xhr.responseType === '' || xhr.responseType === 'text'
      ? xhr.responseText
      : await readXhrErrorBody(xhr.response);
  return new DriveHttpError(xhr.status, driveErrorReason(body), {
    context,
    statusText: xhr.statusText,
    retryAfterMs: parseRetryAfter(xhr.getResponseHeader('Retry-After'))
  });
}

/** True for a full Drive account — by kind, or by the reason a message names. */
export function isDriveQuotaError(error: unknown): boolean {
  if (error instanceof DriveHttpError) return error.kind === 'quota';
  if ((error as { kind?: unknown } | null)?.kind === 'quota') return true;
  const message = error instanceof Error ? error.message : '';
  return /\[(storageQuotaExceeded|quotaExceeded)\]/.test(message);
}

export interface DriveRetryOptions {
  attempts?: number;
  /** Which failures are worth another attempt; default rate limits and 5xx. */
  retryOn?: (kind: DriveFailureKind) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onWait?: (ms: number, error: DriveHttpError) => void;
}

const defaultRetryOn = (kind: DriveFailureKind) => kind === 'rate-limit' || kind === 'transient';
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying a rate-limited or transient Drive failure after the
 * server's Retry-After, else 1 s / 2 s / 4 s (±20 %). Only DriveHttpErrors
 * are retried; anything else (quota, auth, network) propagates at once.
 */
export async function withDriveRetry<T>(
  fn: () => Promise<T>,
  options: DriveRetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? DRIVE_RETRY_ATTEMPTS;
  const retryOn = options.retryOn ?? defaultRetryOn;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof DriveHttpError) || !retryOn(error.kind) || attempt >= attempts) {
        throw error;
      }
      const backoff =
        BACKOFF_BASE_MS * 2 ** (attempt - 1) * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random());
      const wait = error.retryAfterMs ?? Math.round(backoff);
      options.onWait?.(wait, error);
      await sleep(wait);
    }
  }
}
