import { describe, it, expect, vi } from 'vitest';
import {
  DriveHttpError,
  classifyDriveFailure,
  driveErrorDomain,
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

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter('0.5')).toBe(500);
  });

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(parseRetryAfter('Thu, 29 Oct 2026 12:00:10 GMT', now)).toBe(10_000);
  });

  it('treats a zero or past value as absent, so the backoff applies instead of a 0 ms wait', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(parseRetryAfter('0')).toBeUndefined();
    expect(parseRetryAfter('Thu, 29 Oct 2026 11:00:00 GMT', now)).toBeUndefined();
    expect(parseRetryAfter('Thu, 29 Oct 2026 12:00:00 GMT', now)).toBeUndefined();
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

describe('isDriveQuotaError', () => {
  it('recognises the kind, or the bracketed reason in a bare message', () => {
    expect(isDriveQuotaError(new DriveHttpError(403, 'storageQuotaExceeded'))).toBe(true);
    expect(isDriveQuotaError(new Error('Upload failed: 403 [storageQuotaExceeded]'))).toBe(true);
    expect(isDriveQuotaError({ kind: 'quota' })).toBe(true);
    expect(isDriveQuotaError(new DriveHttpError(429, 'storageQuotaExceeded'))).toBe(false);
    expect(
      isDriveQuotaError(new Error('Upload failed: 429 Too Many Requests [storageQuotaExceeded]'))
    ).toBe(false);
    // An API usage quota is not a full account.
    expect(isDriveQuotaError(new DriveHttpError(403, 'quotaExceeded'))).toBe(false);
    expect(isDriveQuotaError(new Error('Upload failed: 403 [quotaExceeded]'))).toBe(false);
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

  it('falls back to the backoff when Retry-After was 0, instead of retrying back to back', async () => {
    const { waits, sleep } = noSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new DriveHttpError(429, undefined, { retryAfterMs: 0 }))
      .mockResolvedValueOnce('ok');
    await expect(withDriveRetry(fn, { sleep, random: () => 0.5 })).resolves.toBe('ok');
    expect(waits).toEqual([1000]);
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
      [5000, expect.objectContaining({ status: 429 }), 2, 4],
      [2000, expect.objectContaining({ status: 503 }), 3, 4]
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
});
