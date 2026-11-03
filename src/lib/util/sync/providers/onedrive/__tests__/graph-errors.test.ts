import { describe, it, expect } from 'vitest';
import {
  graphErrorCode,
  isGraphQuotaFailure,
  isGraphRetryableStatus,
  oneDriveStorageFullError
} from '../graph-errors';
import { ProviderError } from '../../../provider-interface';

describe('graph-errors', () => {
  it('reads error.code from parsed or text bodies, preferring a nested quota code', () => {
    expect(graphErrorCode({ error: { code: 'insufficientStorage' } })).toBe('insufficientStorage');
    expect(graphErrorCode('{"error":{"code":"itemNotFound"}}')).toBe('itemNotFound');
    expect(
      graphErrorCode({ error: { code: 'accessDenied', innerError: { code: 'quotaLimitReached' } } })
    ).toBe('quotaLimitReached');
    expect(graphErrorCode('not json')).toBeUndefined();
    expect(graphErrorCode(null)).toBeUndefined();
  });

  it('treats 507 or a quota code as a full drive', () => {
    expect(isGraphQuotaFailure(507)).toBe(true);
    expect(isGraphQuotaFailure(403, 'quotaLimitReached')).toBe(true);
    expect(isGraphQuotaFailure(403, 'accessDenied')).toBe(false);
    expect(isGraphQuotaFailure(503)).toBe(false);
  });

  it('retries 408, 429 and 5xx except 507', () => {
    expect([408, 429, 500, 503, 504].every(isGraphRetryableStatus)).toBe(true);
    expect(isGraphRetryableStatus(507)).toBe(false);
    expect(isGraphRetryableStatus(400)).toBe(false);
  });

  it('words a full drive for the user, so a worker-serialized message reads as is', () => {
    const error = oneDriveStorageFullError();
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.message).toMatch(/storage is full/);
  });
});
