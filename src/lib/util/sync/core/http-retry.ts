/**
 * The retry policy the cloud cores share for transient HTTP answers (rate
 * limits, a busy server): a small attempt cap, a server's `Retry-After` when
 * it gives one, else exponential backoff with jitter, and a cap on any single
 * wait. Free of app imports, so it runs inside the unified-file-worker too.
 */

/** Tries per request, the first one included. */
export const MAX_RETRY_ATTEMPTS = 5;
/**
 * First backoff wait; doubles per attempt. 1 s is where Google's Drive guidance
 * starts its exponential backoff ("Resolve errors": 1 s, 2 s, 4 s, …).
 */
export const RETRY_BASE_DELAY_MS = 1000;
/** The longest backoff wait (before jitter): every try's doubling runs uncut (1, 2, 4, 8 s). */
export const RETRY_MAX_DELAY_MS = 8000;
/** The longest wait a server's `Retry-After` can ask for (32 s, Google's suggested ceiling). */
export const RETRY_AFTER_MAX_MS = RETRY_MAX_DELAY_MS * 4;
/** Up to this much is added to a backoff wait, so parallel clients spread out. */
export const RETRY_JITTER_MS = 250;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `Retry-After` value (delta-seconds or an HTTP date) in ms, capped at
 * {@link RETRY_AFTER_MAX_MS}. Undefined when absent or unreadable — and for
 * zero or a date already past, which are "no advice": the caller backs off
 * instead of re-sending at once to a server that just said no.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now()
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    // An HTTP date names its day and month; without letters, `Date.parse`
    // would take "-5" for a year.
    if (!/[a-z]/i.test(trimmed)) return undefined;
    const at = Date.parse(trimmed);
    if (!Number.isFinite(at)) return undefined;
    ms = at - now;
  }
  if (!(ms > 0)) return undefined;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

/** The `Retry-After` of a fetch Response, in ms (see {@link parseRetryAfterMs}). */
export function retryAfterMs(response: Pick<Response, 'headers'>): number | undefined {
  return parseRetryAfterMs(response.headers?.get?.('Retry-After'));
}

/**
 * The wait before try `attempt + 1`, after `attempt` failed tries:
 * exponential from {@link RETRY_BASE_DELAY_MS}, capped at
 * {@link RETRY_MAX_DELAY_MS}, plus up to {@link RETRY_JITTER_MS} of jitter.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    RETRY_MAX_DELAY_MS
  );
  return exponential + Math.floor(random() * RETRY_JITTER_MS);
}

/**
 * The server's `Retry-After` when it gave a positive one, else backoff. A
 * wait of 0 is no advice (see {@link parseRetryAfterMs}), whoever measured it.
 */
export function retryDelayMs(
  attempt: number,
  retryAfter?: number,
  random: () => number = Math.random
): number {
  return retryAfter !== undefined && retryAfter > 0 ? retryAfter : backoffDelayMs(attempt, random);
}
