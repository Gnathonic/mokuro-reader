/**
 * How the Drive transports (gapi `drive.files.*`, the XHR media download and
 * multipart upload, and the fetch/XHR core the unified-file-worker runs) treat
 * a refusal that is not about the request itself: rate limits are retried on
 * the shared policy (`core/http-retry.ts`), a full drive becomes the reader's
 * storage-full error. Worker-safe: no app imports beyond those two.
 */
import { ProviderError } from '../../provider-interface';
import { MAX_RETRY_ATTEMPTS, parseRetryAfterMs, retryDelayMs, sleep } from '../../core/http-retry';

/** Drive answers a rate limit as a 429, or as a 403 with one of these reasons. */
export const DRIVE_RATE_LIMIT_REASONS: readonly string[] = [
  'rateLimitExceeded',
  'userRateLimitExceeded'
];

/** 403 reasons Drive gives when the account's storage is full. */
export const DRIVE_STORAGE_FULL_REASONS: readonly string[] = [
  'storageQuotaExceeded',
  'quotaExceeded'
];

/** What a failed Drive request said: enough to choose retry, storage-full or neither. */
export interface DriveFailure {
  status?: number;
  /** `error.errors[0].reason` of Drive's error body. */
  reason?: string;
  /** The server's `Retry-After`, in ms. */
  retryAfterMs?: number;
}

/**
 * A Drive error response that did not succeed, from the fetch/XHR transports.
 * Carries the {@link DriveFailure} fields so {@link withDriveRetry} can read them.
 */
export class DriveHttpError extends Error implements DriveFailure {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reason?: string,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'DriveHttpError';
  }
}

/** The first `reason` in a Drive error body (object or JSON text). */
export function driveErrorReason(body: unknown): string | undefined {
  let value = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const errors = (value as { error?: { errors?: Array<{ reason?: unknown }> } } | null)?.error
    ?.errors;
  const reason = Array.isArray(errors) ? errors[0]?.reason : undefined;
  return typeof reason === 'string' ? reason : undefined;
}

export function isDriveRateLimit(failure: DriveFailure | undefined): boolean {
  if (!failure) return false;
  return (
    failure.status === 429 ||
    (failure.status === 403 &&
      failure.reason !== undefined &&
      DRIVE_RATE_LIMIT_REASONS.includes(failure.reason))
  );
}

export function isDriveStorageFull(failure: DriveFailure | undefined): boolean {
  return (
    failure?.status === 403 &&
    failure.reason !== undefined &&
    DRIVE_STORAGE_FULL_REASONS.includes(failure.reason)
  );
}

/** The storage-full error the UI shows as is (the same code MEGA uses). */
export function driveStorageFullError(): ProviderError {
  return new ProviderError(
    'Google Drive storage is full — free up space or upgrade your storage plan',
    'google-drive',
    'QUOTA_EXCEEDED'
  );
}

/** Whether an error is the storage-full error, so wrappers pass it through untouched. */
export function isQuotaExceededError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.code === 'QUOTA_EXCEEDED';
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
 * rejection (`{ status, result: { error }, headers }`).
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

/**
 * Run one Drive request, retrying it while Drive answers with a rate limit:
 * up to {@link MAX_RETRY_ATTEMPTS} tries, waiting the server's `Retry-After`
 * when given, else backoff with jitter. Any other failure, and the last rate
 * limit, is rethrown as it came.
 */
export async function withDriveRetry<T>(
  request: () => Promise<T>,
  failureOf: (error: unknown) => DriveFailure | undefined = driveFailureOf
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      const failure = failureOf(error);
      if (!isDriveRateLimit(failure) || attempt >= MAX_RETRY_ATTEMPTS) throw error;
      await sleep(retryDelayMs(attempt, failure?.retryAfterMs));
    }
  }
}
