import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DriveHttpError,
  driveErrorReason,
  driveFailureOf,
  driveStorageFullError,
  isDriveRateLimit,
  isDriveStorageFull,
  withDriveRetry
} from './drive-retry';
import { MAX_RETRY_ATTEMPTS, RETRY_AFTER_MAX_MS } from '../../core/http-retry';
import { ProviderError } from '../../provider-interface';

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

  it('a 403 storageQuotaExceeded or quotaExceeded is a full drive', () => {
    expect(isDriveStorageFull({ status: 403, reason: 'storageQuotaExceeded' })).toBe(true);
    expect(isDriveStorageFull({ status: 403, reason: 'quotaExceeded' })).toBe(true);
    expect(isDriveStorageFull({ status: 403, reason: 'rateLimitExceeded' })).toBe(false);
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
      retryAfterMs: 2000
    });
    expect(driveFailureOf(gapiError(429, 'x', { 'Retry-After': '1' }))?.retryAfterMs).toBe(1000);
    expect(driveFailureOf(new DriveHttpError('m', 429, undefined, 300))).toEqual({
      status: 429,
      reason: undefined,
      retryAfterMs: 300
    });
    expect(driveFailureOf(new Error('network'))).toBeUndefined();
  });
});

describe('withDriveRetry', () => {
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
