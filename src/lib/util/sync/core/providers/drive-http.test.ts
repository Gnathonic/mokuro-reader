import { describe, it, expect, vi } from 'vitest';
import {
  DriveHttpError,
  classifyDriveFailure,
  driveErrorReason,
  driveHttpErrorFromResponse,
  isDriveQuotaError,
  parseRetryAfter,
  withDriveRetry
} from './drive-http';

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
});

describe('classifyDriveFailure', () => {
  it.each([
    [403, 'storageQuotaExceeded', 'quota'],
    [403, 'quotaExceeded', 'quota'],
    [429, undefined, 'rate-limit'],
    [429, 'rateLimitExceeded', 'rate-limit'],
    [403, 'userRateLimitExceeded', 'rate-limit'],
    [403, 'rateLimitExceeded', 'rate-limit'],
    [500, undefined, 'transient'],
    [502, undefined, 'transient'],
    [503, undefined, 'transient'],
    [504, undefined, 'transient'],
    [401, undefined, 'auth'],
    [403, undefined, 'auth'],
    [403, 'insufficientFilePermissions', 'auth'],
    [404, 'notFound', 'other'],
    [400, undefined, 'other']
  ] as const)('%i %s -> %s', (status, reason, kind) => {
    expect(classifyDriveFailure(status, reason)).toBe(kind);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(parseRetryAfter('Thu, 29 Oct 2026 12:00:10 GMT', now)).toBe(10_000);
    // A date already past means "now", not a negative wait.
    expect(parseRetryAfter('Thu, 29 Oct 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('caps at 60 s', () => {
    expect(parseRetryAfter('3600')).toBe(60_000);
  });

  it('is undefined when absent or unreadable', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
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
    // A worker hands back only the message: the bracketed reason lets the
    // main thread reclassify it.
    expect(error.message).toMatch(/^Upload init failed: 403 \[storageQuotaExceeded\]$/);
    expect(isDriveQuotaError(new Error(error.message))).toBe(true);
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

describe('isDriveQuotaError', () => {
  it('recognises the kind, or the bracketed reason in a bare message', () => {
    expect(isDriveQuotaError(new DriveHttpError(403, 'quotaExceeded'))).toBe(true);
    expect(isDriveQuotaError(new Error('Upload failed: 403 [quotaExceeded]'))).toBe(true);
    expect(isDriveQuotaError(new DriveHttpError(403, 'userRateLimitExceeded'))).toBe(false);
    expect(isDriveQuotaError(new Error('storage quota'))).toBe(false);
    expect(isDriveQuotaError('nope')).toBe(false);
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

  it('backs off 1 s, 2 s, 4 s (±20 %) without a Retry-After, and gives up after 4 attempts', async () => {
    const { waits, sleep } = noSleep();
    const fn = vi.fn(async () => {
      throw new DriveHttpError(403, 'userRateLimitExceeded');
    });
    await expect(withDriveRetry(fn, { sleep, random: () => 0.5 })).rejects.toMatchObject({
      kind: 'rate-limit'
    });
    expect(fn).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([1000, 2000, 4000]);

    const jittered = noSleep();
    await withDriveRetry(fn, { sleep: jittered.sleep, random: () => 0 }).catch(() => {});
    expect(jittered.waits).toEqual([800, 1600, 3200]);
  });

  it('retries a transient 503', async () => {
    const { sleep } = noSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new DriveHttpError(503))
      .mockResolvedValueOnce('ok');
    await expect(withDriveRetry(fn, { sleep })).resolves.toBe('ok');
  });

  it.each([
    ['quota', new DriveHttpError(403, 'storageQuotaExceeded')],
    ['auth', new DriveHttpError(401)],
    ['other 403', new DriveHttpError(403)],
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
});
