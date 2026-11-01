/**
 * Google Drive HTTP failure handling shared by the main thread (api-client,
 * provider) and the unified-file-worker (google-drive-core) — so no svelte
 * imports here.
 *
 * Drive answers a full account, a rate limit and a revoked token all with
 * 403; only the body's `error.errors[0].reason` tells them apart. Sending a
 * quota or rate-limit 403 down the auth path cleared the token (or started a
 * re-auth) for a perfectly valid session. Retries wait on the policy every
 * cloud core shares (`core/http-retry.ts`).
 */
import { ProviderError } from '../../provider-interface';
import { MAX_RETRY_ATTEMPTS, backoffDelayMs, parseRetryAfterMs, sleep } from '../http-retry';

export type DriveFailureKind = 'quota' | 'rate-limit' | 'transient' | 'auth' | 'other';

/** Reasons Drive gives when the account's storage is full. */
export const DRIVE_STORAGE_FULL_REASONS: readonly string[] = [
  'storageQuotaExceeded',
  'quotaExceeded'
];
/** Drive answers a rate limit as a 429, or as a 403 with one of these reasons. */
export const DRIVE_RATE_LIMIT_REASONS: readonly string[] = [
  'userRateLimitExceeded',
  'rateLimitExceeded'
];
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
  // Every 429 is a rate limit, even one naming the generic `quotaExceeded`
  // (per-minute usage limits do): it clears in seconds, a full account never.
  if (status === 429) return 'rate-limit';
  if (reason && DRIVE_STORAGE_FULL_REASONS.includes(reason)) return 'quota';
  if (status === 403 && reason && DRIVE_RATE_LIMIT_REASONS.includes(reason)) return 'rate-limit';
  if (TRANSIENT_STATUSES.has(status)) return 'transient';
  // Any other 403 keeps the old auth handling.
  if (status === 401 || status === 403) return 'auth';
  return 'other';
}

/** What a failed Drive request said: enough to choose retry, storage-full or neither. */
export interface DriveFailure {
  status?: number;
  /** `error.errors[0].reason` of Drive's error body. */
  reason?: string;
  /** The server's `Retry-After`, in ms. */
  retryAfterMs?: number;
}

export function isDriveRateLimit(failure: DriveFailure | undefined): boolean {
  return (
    typeof failure?.status === 'number' &&
    classifyDriveFailure(failure.status, failure.reason) === 'rate-limit'
  );
}

export function isDriveStorageFull(failure: DriveFailure | undefined): boolean {
  return (
    typeof failure?.status === 'number' &&
    classifyDriveFailure(failure.status, failure.reason) === 'quota'
  );
}

export class DriveHttpError extends Error implements DriveFailure {
  readonly kind: DriveFailureKind;
  readonly retryAfterMs?: number;

  constructor(
    public readonly status: number,
    public readonly reason?: string,
    options: { context?: string; statusText?: string; message?: string; retryAfterMs?: number } = {}
  ) {
    // `message` keeps a transport's own wording; the bracketed reason rides
    // along either way, so a worker's message-only error still names it.
    super(
      (options.message ??
        `${options.context ?? 'Google Drive request failed'}: ${status}` +
          (options.statusText ? ` ${options.statusText}` : '')) + (reason ? ` [${reason}]` : '')
    );
    this.name = 'DriveHttpError';
    this.kind = classifyDriveFailure(status, reason);
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** The storage-full error the UI shows as is (the code and wording MEGA uses). */
export function driveStorageFullError(): ProviderError {
  return new ProviderError(
    'Google Drive storage is full — free up space or upgrade your plan',
    'google-drive',
    'QUOTA_EXCEEDED'
  );
}

/** Whether an error is the storage-full error, so wrappers pass it through untouched. */
export function isQuotaExceededError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.code === 'QUOTA_EXCEEDED';
}

/**
 * What a transport throws for a refusal: the storage-full error for a full
 * account — thrown where the answer is read, so a worker's message-only error
 * says so too — else the DriveHttpError itself.
 */
export function driveRefusal(error: DriveHttpError): Error {
  return error.kind === 'quota' ? driveStorageFullError() : error;
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
    retryAfterMs: parseRetryAfterMs(response.headers?.get?.('Retry-After'))
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

/** A finished non-2xx XHR as a DriveHttpError (`message`: see DriveHttpError). */
export async function driveHttpErrorFromXhr(
  xhr: XMLHttpRequest,
  context: string,
  message?: string
): Promise<DriveHttpError> {
  // responseText throws for 'json'/'blob'/'arraybuffer' response types.
  const body =
    xhr.responseType === '' || xhr.responseType === 'text'
      ? xhr.responseText
      : await readXhrErrorBody(xhr.response);
  return new DriveHttpError(xhr.status, driveErrorReason(body), {
    context,
    message,
    statusText: xhr.statusText,
    retryAfterMs: parseRetryAfterMs(xhr.getResponseHeader('Retry-After'))
  });
}

/** Read a header from a plain `{ name: value }` map, ignoring case (gapi lowercases them). */
function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Read a failure off whatever a Drive call rejected with: a {@link DriveHttpError}
 * (or anything carrying `status` / `reason` / `retryAfterMs`), or a gapi
 * rejection (`{ status, result: { error }, headers }`). Undefined without a
 * status: a network failure, a parse error, the storage-full error.
 */
export function driveFailureOf(error: unknown): DriveFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as {
    status?: unknown;
    reason?: unknown;
    retryAfterMs?: unknown;
    result?: unknown;
    body?: unknown;
    headers?: unknown;
  };
  if (typeof e.status !== 'number') return undefined;
  const reason =
    typeof e.reason === 'string'
      ? e.reason
      : (driveErrorReason(e.result) ?? driveErrorReason(e.body));
  const retryAfterMs =
    typeof e.retryAfterMs === 'number'
      ? e.retryAfterMs
      : parseRetryAfterMs(headerValue(e.headers, 'Retry-After'));
  return { status: e.status, reason, retryAfterMs };
}

export interface DriveRetryOptions {
  attempts?: number;
  /** Which failures are worth another attempt; default rate limits and 5xx. */
  retryOn?: (kind: DriveFailureKind) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultRetryOn = (kind: DriveFailureKind) => kind === 'rate-limit' || kind === 'transient';

/**
 * Run ONE Drive request, retrying a rate-limited or transient failure on the
 * shared policy: up to {@link MAX_RETRY_ATTEMPTS} tries, the server's
 * Retry-After when it gave one, else backoff with jitter. Only failures that
 * carry an HTTP status are retried (see {@link driveFailureOf}); anything
 * else — a full account, an auth failure, the last retryable failure —
 * propagates as it came.
 */
export async function withDriveRetry<T>(
  fn: () => Promise<T>,
  options: DriveRetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? MAX_RETRY_ATTEMPTS;
  const retryOn = options.retryOn ?? defaultRetryOn;
  const wait = options.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const failure = driveFailureOf(error);
      if (
        failure?.status === undefined ||
        !retryOn(classifyDriveFailure(failure.status, failure.reason)) ||
        attempt >= attempts
      ) {
        throw error;
      }
      await wait(failure.retryAfterMs ?? backoffDelayMs(attempt, options.random));
    }
  }
}
