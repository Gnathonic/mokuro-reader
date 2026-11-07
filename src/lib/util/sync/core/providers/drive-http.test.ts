import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  DriveHttpError,
  classifyDriveFailure,
  driveErrorDomain,
  driveErrorReason,
  driveFailureOf,
  driveHttpErrorFromResponse,
  driveRefusal,
  driveStorageFullError,
  isDriveRateLimit,
  isDriveStorageFull,
  withDriveRetry
} from './drive-http';
import {
  MAX_RETRY_ATTEMPTS,
  RETRY_AFTER_MAX_MS,
  RETRY_BASE_DELAY_MS,
  RETRY_JITTER_MS,
  parseRetryAfterMs
} from '../http-retry';
import { ProviderError } from '../../provider-interface';

const QUOTA_BODY = {
  error: {
    errors: [{ domain: 'usageLimits', reason: 'storageQuotaExceeded', message: 'quota' }],
    code: 403,
    message: "The user's Drive storage quota has been exceeded."
  }
};

describe('driveErrorReason', () => {
  it('reads error.errors[0].reason from a parsed body', () => {
    expect(driveErrorReason(QUOTA_BODY)).toBe('storageQuotaExceeded');
  });

  it('reads it from a JSON string body', () => {
    expect(driveErrorReason(JSON.stringify(QUOTA_BODY))).toBe('storageQuotaExceeded');
  });

  it('is undefined for garbage', () => {
    expect(driveErrorReason('<html>nope</html>')).toBeUndefined();
    expect(driveErrorReason(null)).toBeUndefined();
    expect(driveErrorReason({ error: { errors: [] } })).toBeUndefined();
    expect(driveErrorReason({ error: { errors: [{ reason: 7 }] } })).toBeUndefined();
  });

  it('reads the domain beside the reason', () => {
    expect(driveErrorDomain(QUOTA_BODY)).toBe('usageLimits');
    expect(driveErrorDomain(JSON.stringify(QUOTA_BODY))).toBe('usageLimits');
    expect(driveErrorDomain({ error: { errors: [{ reason: 'forbidden' }] } })).toBeUndefined();
    expect(driveErrorDomain('nope')).toBeUndefined();
  });
});

describe('classifyDriveFailure', () => {
  it.each([
    // Drive's ONE storage-full reason (handle-errors guide).
    [403, 'storageQuotaExceeded', 'quota'],
    // `quotaExceeded` is an API usage quota in Google's other APIs — it
    // resets, so it is waited out like any other rate limit, never "full".
    [403, 'quotaExceeded', 'rate-limit'],
    [429, undefined, 'rate-limit'],
    [429, 'rateLimitExceeded', 'rate-limit'],
    // A per-minute usage limit can carry the generic reason: every 429 waits.
    [429, 'quotaExceeded', 'rate-limit'],
    [429, 'storageQuotaExceeded', 'rate-limit'],
    [403, 'userRateLimitExceeded', 'rate-limit'],
    [403, 'rateLimitExceeded', 'rate-limit'],
    [403, 'dailyLimitExceeded', 'rate-limit'],
    // domain `global`, not `usageLimits` — classified by reason, never by domain.
    [403, 'sharingRateLimitExceeded', 'rate-limit'],
    // Limits neither waiting nor a re-auth can lift: fail with the message.
    [403, 'activeItemCreationLimitExceeded', 'limit'],
    [403, 'numChildrenInNonRootLimitExceeded', 'limit'],
    [403, 'myDriveHierarchyDepthLimitExceeded', 'limit'],
    [500, undefined, 'transient'],
    [502, undefined, 'transient'],
    [503, undefined, 'transient'],
    [504, undefined, 'transient'],
    [401, undefined, 'auth'],
    [401, 'authError', 'auth'],
    // Auth is an allow-list: a 403 re-authenticates only when its reason is
    // absent or one a fresh token can fix.
    [403, undefined, 'auth'],
    [403, 'authError', 'auth'],
    [403, 'insufficientPermissions', 'auth'],
    [403, 'forbidden', 'auth'],
    // Any other 403 reason is a refusal a re-auth cannot change.
    [403, 'insufficientFilePermissions', 'other'],
    [403, 'appNotAuthorizedToFile', 'other'],
    [403, 'domainPolicy', 'other'],
    [404, 'notFound', 'other'],
    [400, undefined, 'other']
  ] as const)('%i %s -> %s', (status, reason, kind) => {
    expect(classifyDriveFailure(status, reason)).toBe(kind);
  });
});

// Drive reads Retry-After with the shared parser (core/http-retry.ts).
describe('Retry-After as Drive sends it', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('7')).toBe(7000);
    expect(parseRetryAfterMs('0.5')).toBe(500);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(parseRetryAfterMs('Thu, 29 Oct 2026 12:00:10 GMT', now)).toBe(10_000);
  });

  it('treats a zero or past value as absent, so the backoff applies instead of a 0 ms wait', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(parseRetryAfterMs('0')).toBeUndefined();
    expect(parseRetryAfterMs('Thu, 29 Oct 2026 11:00:00 GMT', now)).toBeUndefined();
    expect(parseRetryAfterMs('Thu, 29 Oct 2026 12:00:00 GMT', now)).toBeUndefined();
  });

  it('caps a long wait at the shared policy’s cap', () => {
    expect(parseRetryAfterMs('3600')).toBe(RETRY_AFTER_MAX_MS);
  });

  it('is undefined when absent or unreadable', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});

describe('DriveHttpError', () => {
  it('carries status, reason and kind, and names the reason in its message', () => {
    const error = new DriveHttpError(403, 'storageQuotaExceeded', {
      context: 'Upload init failed'
    });
    expect(error.status).toBe(403);
    expect(error.reason).toBe('storageQuotaExceeded');
    expect(error.kind).toBe('quota');
    // A worker hands back only the message: it still names the reason.
    expect(error.message).toMatch(/^Upload init failed: 403 \[storageQuotaExceeded\]$/);
  });

  it('keeps a transport’s own wording when given one', () => {
    const error = new DriveHttpError(404, 'notFound', { message: 'HTTP error 404: Not Found' });
    expect(error.message).toBe('HTTP error 404: Not Found [notFound]');
    expect(error.kind).toBe('other');
  });

  it('carries the error domain when the body named one', async () => {
    const response = new Response(JSON.stringify(QUOTA_BODY), { status: 403 });
    const error = await driveHttpErrorFromResponse(response, 'Upload init failed');
    expect(error.domain).toBe('usageLimits');
    expect(new DriveHttpError(403, 'forbidden').domain).toBeUndefined();
    expect(new DriveHttpError(403, 'forbidden', { domain: 'global' }).domain).toBe('global');
  });

  it('is built from a fetch Response, reading the body reason and Retry-After', async () => {
    const response = new Response(
      JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }),
      {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '3' }
      }
    );
    const error = await driveHttpErrorFromResponse(response, 'Failed to get file size');
    expect(error.kind).toBe('rate-limit');
    expect(error.retryAfterMs).toBe(3000);
    expect(error.message).toBe(
      'Failed to get file size: 429 Too Many Requests [rateLimitExceeded]'
    );
  });
});

describe('driveRefusal', () => {
  it('a full account is the storage-full error; anything else stays as it is', () => {
    const full = driveRefusal(new DriveHttpError(403, 'storageQuotaExceeded'));
    expect(full).toBeInstanceOf(ProviderError);
    expect((full as ProviderError).code).toBe('QUOTA_EXCEEDED');
    // A 429 naming `storageQuotaExceeded` is a rate limit, not a full account.
    const rate = new DriveHttpError(429, 'storageQuotaExceeded');
    expect(driveRefusal(rate)).toBe(rate);
    // An API usage quota is not a full account.
    const usage = new DriveHttpError(403, 'quotaExceeded');
    expect(driveRefusal(usage)).toBe(usage);
    const limited = new DriveHttpError(403, 'userRateLimitExceeded');
    expect(driveRefusal(limited)).toBe(limited);
  });
});

describe('withDriveRetry', () => {
  const noSleep = () => {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
  };

  it('retries a 429 after its Retry-After and then succeeds', async () => {
    const { waits, sleep } = noSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new DriveHttpError(429, undefined, { retryAfterMs: 5000 }))
      .mockResolvedValueOnce('ok');
    await expect(withDriveRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([5000]);
  });

  it('backs off on the shared policy without a Retry-After, and gives up after MAX_RETRY_ATTEMPTS', async () => {
    const { waits, sleep } = noSleep();
    const fn = vi.fn(async () => {
      throw new DriveHttpError(403, 'userRateLimitExceeded');
    });
    await expect(withDriveRetry(fn, { sleep, random: () => 0 })).rejects.toMatchObject({
      kind: 'rate-limit'
    });
    expect(fn).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
    const base = Array.from(
      { length: MAX_RETRY_ATTEMPTS - 1 },
      (_, i) => RETRY_BASE_DELAY_MS * 2 ** i
    );
    expect(waits).toEqual(base);

    const jittered = noSleep();
    await withDriveRetry(fn, { sleep: jittered.sleep, random: () => 0.5 }).catch(() => {});
    expect(jittered.waits).toEqual(base.map((ms) => ms + Math.floor(0.5 * RETRY_JITTER_MS)));
  });

  it('retries a transient 503', async () => {
    const { sleep } = noSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new DriveHttpError(503))
      .mockResolvedValueOnce('ok');
    await expect(withDriveRetry(fn, { sleep })).resolves.toBe('ok');
  });

  it('falls back to the backoff when Retry-After was 0, instead of retrying back to back', async () => {
    const { waits, sleep } = noSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new DriveHttpError(429, undefined, { retryAfterMs: 0 }))
      .mockResolvedValueOnce('ok');
    await expect(withDriveRetry(fn, { sleep, random: () => 0.5 })).resolves.toBe('ok');
    expect(waits).toEqual([RETRY_BASE_DELAY_MS + Math.floor(0.5 * RETRY_JITTER_MS)]);
  });

  it('reports each wait with the attempt about to be made', async () => {
    const { sleep } = noSleep();
    const onWait = vi.fn();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new DriveHttpError(429, undefined, { retryAfterMs: 5000 }))
      .mockRejectedValueOnce(new DriveHttpError(503))
      .mockResolvedValueOnce('ok');
    await expect(withDriveRetry(fn, { sleep, random: () => 0.5, onWait })).resolves.toBe('ok');
    expect(onWait.mock.calls).toEqual([
      [5000, expect.objectContaining({ status: 429, kind: 'rate-limit' }), 2, MAX_RETRY_ATTEMPTS],
      [
        RETRY_BASE_DELAY_MS * 2 + Math.floor(0.5 * RETRY_JITTER_MS),
        expect.objectContaining({ status: 503, kind: 'transient' }),
        3,
        MAX_RETRY_ATTEMPTS
      ]
    ]);
  });

  it.each([
    ['quota', new DriveHttpError(403, 'storageQuotaExceeded')],
    ['a Drive limit', new DriveHttpError(403, 'numChildrenInNonRootLimitExceeded')],
    ['auth', new DriveHttpError(401)],
    ['a bare 403', new DriveHttpError(403)],
    ['a refused 403', new DriveHttpError(403, 'insufficientFilePermissions')],
    ['a non-HTTP error', new TypeError('Failed to fetch')]
  ])('does not retry %s', async (_label, error) => {
    const { sleep } = noSleep();
    const fn = vi.fn(async () => {
      throw error;
    });
    await expect(withDriveRetry(fn, { sleep })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honours a narrower retryOn (a non-idempotent create retries rate limits only)', async () => {
    const { sleep } = noSleep();
    const fn = vi.fn(async () => {
      throw new DriveHttpError(503);
    });
    await expect(
      withDriveRetry(fn, { sleep, retryOn: (kind) => kind === 'rate-limit' })
    ).rejects.toMatchObject({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('hands retryOn the thrown error, so a step tagged on it can decide', async () => {
    const { sleep } = noSleep();
    const tagged = (phase: string) => Object.assign(new DriveHttpError(503), { phase });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(tagged('init'))
      .mockRejectedValueOnce(tagged('put'));
    const retryOn = vi.fn(
      (kind: string, error: unknown) =>
        kind === 'transient' && (error as DriveHttpError).phase !== 'put'
    );
    await expect(withDriveRetry(fn, { sleep, retryOn })).rejects.toMatchObject({
      status: 503,
      phase: 'put'
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(retryOn.mock.calls.map(([, e]) => (e as DriveHttpError).phase)).toEqual(['init', 'put']);
  });
});

/** A gapi rejection, the shape `gapi.client.drive.*` (and the REST shim) reject with. */
function gapiError(status: number, reason: string, headers: Record<string, string> = {}) {
  const result = {
    error: { code: status, message: reason, errors: [{ domain: 'usageLimits', reason }] }
  };
  return { result, body: JSON.stringify(result), status, statusText: '', headers };
}

describe('Drive failure classification', () => {
  it('reads the reason from an error body, object or text', () => {
    const body = { error: { errors: [{ reason: 'userRateLimitExceeded' }] } };
    expect(driveErrorReason(body)).toBe('userRateLimitExceeded');
    expect(driveErrorReason(JSON.stringify(body))).toBe('userRateLimitExceeded');
    expect(driveErrorReason('not json')).toBeUndefined();
    expect(driveErrorReason(null)).toBeUndefined();
  });

  it('a 429, and a 403 with either rate-limit reason, is a rate limit', () => {
    expect(isDriveRateLimit({ status: 429 })).toBe(true);
    expect(isDriveRateLimit({ status: 403, reason: 'rateLimitExceeded' })).toBe(true);
    expect(isDriveRateLimit({ status: 403, reason: 'userRateLimitExceeded' })).toBe(true);
  });

  it('other 403s are not: permissions, auth, a full drive', () => {
    expect(isDriveRateLimit({ status: 403, reason: 'insufficientPermissions' })).toBe(false);
    expect(isDriveRateLimit({ status: 403, reason: 'storageQuotaExceeded' })).toBe(false);
    expect(isDriveRateLimit({ status: 403 })).toBe(false);
    expect(isDriveRateLimit({ status: 500 })).toBe(false);
  });

  it('only a 403 storageQuotaExceeded is a full drive', () => {
    expect(isDriveStorageFull({ status: 403, reason: 'storageQuotaExceeded' })).toBe(true);
    // An API usage quota resets: a rate limit, never "full".
    expect(isDriveStorageFull({ status: 403, reason: 'quotaExceeded' })).toBe(false);
    expect(isDriveRateLimit({ status: 403, reason: 'quotaExceeded' })).toBe(true);
    expect(isDriveStorageFull({ status: 403, reason: 'rateLimitExceeded' })).toBe(false);
    expect(isDriveStorageFull({ status: 429, reason: 'storageQuotaExceeded' })).toBe(false);
    expect(isDriveStorageFull({ status: 429 })).toBe(false);
  });

  it('the storage-full error carries the code MEGA uses', () => {
    const error = driveStorageFullError();
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.providerType).toBe('google-drive');
    expect(error.message).toMatch(/storage is full/i);
  });

  it('reads a gapi rejection, its headers in any case', () => {
    expect(driveFailureOf(gapiError(403, 'rateLimitExceeded', { 'retry-after': '2' }))).toEqual({
      status: 403,
      reason: 'rateLimitExceeded',
      retryAfterMs: 2000,
      domain: 'usageLimits'
    });
    expect(driveFailureOf(gapiError(429, 'x', { 'Retry-After': '1' }))?.retryAfterMs).toBe(1000);
    expect(driveFailureOf(new DriveHttpError(429, undefined, { retryAfterMs: 300 }))).toEqual({
      status: 429,
      reason: undefined,
      retryAfterMs: 300
    });
    expect(driveFailureOf(new Error('network'))).toBeUndefined();
  });
});

describe('withDriveRetry on gapi rejections and real timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits out Retry-After on a 429, then succeeds', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(gapiError(429, 'rateLimitExceeded', { 'retry-after': '3' }))
      .mockResolvedValueOnce('ok');
    const done = withDriveRetry(request);
    await vi.advanceTimersByTimeAsync(2999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe('ok');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])(
    'retries a 403 %s with backoff when there is no Retry-After',
    async (reason) => {
      const request = vi
        .fn()
        .mockRejectedValueOnce(gapiError(403, reason))
        .mockRejectedValueOnce(gapiError(403, reason))
        .mockResolvedValueOnce('ok');
      const done = withDriveRetry(request);
      await vi.runAllTimersAsync();
      await expect(done).resolves.toBe('ok');
      expect(request).toHaveBeenCalledTimes(3);
    }
  );

  it('does not retry a 403 insufficientPermissions, nor a full drive', async () => {
    for (const reason of ['insufficientPermissions', 'storageQuotaExceeded']) {
      const refusal = gapiError(403, reason);
      const request = vi.fn().mockRejectedValue(refusal);
      await expect(withDriveRetry(request)).rejects.toBe(refusal);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it('does not retry an error without a status (network, parse)', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Network error'));
    await expect(withDriveRetry(request)).rejects.toThrow('Network error');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('gives up after MAX_RETRY_ATTEMPTS tries with the last error', async () => {
    const last = gapiError(429, 'rateLimitExceeded');
    const request = vi.fn().mockRejectedValue(last);
    const done = withDriveRetry(request);
    const settled = done.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await settled).toBe(last);
    expect(request).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
  });

  it('never waits longer than the cap, whatever Retry-After asks', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(gapiError(429, 'rateLimitExceeded', { 'retry-after': '86400' }))
      .mockResolvedValueOnce('ok');
    const done = withDriveRetry(request);
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MAX_MS - 1);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe('ok');
  });
});
