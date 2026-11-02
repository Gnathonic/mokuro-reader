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

/**
 * - `quota`: the account is full (`storageQuotaExceeded`, Drive's ONE such
 *   reason). Never retried, surfaced as "storage is full".
 * - `rate-limit`: waits it out. Every 429, and the 403 usage limits —
 *   including `quotaExceeded`, which in Google's APIs is an API usage quota
 *   that resets, not storage, and `sharingRateLimitExceeded`, whose domain is
 *   `global` (reasons are matched by name; the domain never decides).
 * - `limit`: a Drive limit neither waiting nor a re-auth lifts (an item
 *   count, a folder depth). Fails at once with its message.
 * - `auth`: a fresh token may help. An allow-list — a 403 whose reason is
 *   absent, `authError`, `insufficientPermissions` or `forbidden` — so a
 *   refusal Drive meant (`insufficientFilePermissions`, `domainPolicy`, …)
 *   no longer starts a re-auth or clears a valid token.
 */
export type DriveFailureKind = 'quota' | 'rate-limit' | 'transient' | 'auth' | 'limit' | 'other';

export const DRIVE_RETRY_ATTEMPTS = 4;
export const DRIVE_RETRY_AFTER_CAP_MS = 60_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_JITTER = 0.2;

const QUOTA_REASONS = new Set(['storageQuotaExceeded']);
const RATE_LIMIT_REASONS = new Set([
  'userRateLimitExceeded',
  'rateLimitExceeded',
  'dailyLimitExceeded',
  'sharingRateLimitExceeded',
  'quotaExceeded'
]);
const LIMIT_REASONS = new Set([
  'activeItemCreationLimitExceeded',
  'numChildrenInNonRootLimitExceeded',
  'myDriveHierarchyDepthLimitExceeded'
]);
const AUTH_REASONS = new Set(['authError', 'insufficientPermissions', 'forbidden']);
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

/** `error.errors[0]` of a Drive error body, parsed or as JSON text. */
function driveErrorEntry(body: unknown): Record<string, unknown> | undefined {
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  const entry = (parsed as { error?: { errors?: unknown[] } } | null)?.error?.errors?.[0];
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
}

/** `error.errors[0].reason` of a Drive error body, parsed or as JSON text. */
export function driveErrorReason(body: unknown): string | undefined {
  const reason = driveErrorEntry(body)?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** `error.errors[0].domain` of a Drive error body (`usageLimits`, `global`, …). */
export function driveErrorDomain(body: unknown): string | undefined {
  const domain = driveErrorEntry(body)?.domain;
  return typeof domain === 'string' ? domain : undefined;
}

export function classifyDriveFailure(status: number, reason?: string): DriveFailureKind {
  // Every 429 is a rate limit, even one naming the generic `quotaExceeded`
  // (per-minute usage limits do): it clears in seconds, a full account never.
  if (status === 429) return 'rate-limit';
  if (reason && QUOTA_REASONS.has(reason)) return 'quota';
  if (status === 403) {
    if (reason && RATE_LIMIT_REASONS.has(reason)) return 'rate-limit';
    if (reason && LIMIT_REASONS.has(reason)) return 'limit';
    // Re-auth only for what a fresh token can fix; every other named reason
    // is a refusal, failed with its message.
    return !reason || AUTH_REASONS.has(reason) ? 'auth' : 'other';
  }
  if (TRANSIENT_STATUSES.has(status)) return 'transient';
  if (status === 401) return 'auth';
  return 'other';
}

/**
 * Retry-After (delta-seconds or HTTP-date) in ms, capped at 60 s. Zero or a
 * date already past is "no advice" — undefined, so the caller backs off
 * instead of retrying back to back.
 */
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
  if (!(ms > 0)) return undefined;
  return Math.min(ms, DRIVE_RETRY_AFTER_CAP_MS);
}

export class DriveHttpError extends Error {
  readonly kind: DriveFailureKind;
  readonly retryAfterMs?: number;
  /** The body's `error.errors[0].domain`, for logs; classification is by reason. */
  readonly domain?: string;

  constructor(
    public readonly status: number,
    public readonly reason?: string,
    options: { context?: string; statusText?: string; retryAfterMs?: number; domain?: string } = {}
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
    this.domain = options.domain;
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
    retryAfterMs: parseRetryAfter(response.headers?.get('Retry-After')),
    domain: driveErrorDomain(text)
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
    retryAfterMs: parseRetryAfter(xhr.getResponseHeader('Retry-After')),
    domain: driveErrorDomain(body)
  });
}

/** True for a full Drive account — by kind, or by the reason a message names. */
export function isDriveQuotaError(error: unknown): boolean {
  if (error instanceof DriveHttpError) return error.kind === 'quota';
  if ((error as { kind?: unknown } | null)?.kind === 'quota') return true;
  const message = error instanceof Error ? error.message : '';
  // DriveHttpError's message is `context: status statusText [reason]`.
  const match = /(?::\s*(\d{3})\b[^[]*)?\[storageQuotaExceeded\]/.exec(message);
  return !!match && match[1] !== '429';
}

export interface DriveRetryOptions {
  attempts?: number;
  /** Which failures are worth another attempt; default rate limits and 5xx. */
  retryOn?: (kind: DriveFailureKind) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** About to wait `ms` before `attempt` (2 = the first retry) of `attempts`. */
  onWait?: (ms: number, error: DriveHttpError, attempt: number, attempts: number) => void;
}

const defaultRetryOn = (kind: DriveFailureKind) => kind === 'rate-limit' || kind === 'transient';
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying a rate-limited or transient Drive failure after the
 * server's Retry-After, else 1 s / 2 s / 4 s (±20 %). Only DriveHttpErrors
 * are retried; anything else (quota, limit, auth, network) propagates at once.
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
      // A Retry-After of 0 is no advice: back off rather than hammer.
      const wait =
        error.retryAfterMs !== undefined && error.retryAfterMs > 0
          ? error.retryAfterMs
          : Math.round(backoff);
      options.onWait?.(wait, error, attempt + 1, attempts);
      await sleep(wait);
    }
  }
}
