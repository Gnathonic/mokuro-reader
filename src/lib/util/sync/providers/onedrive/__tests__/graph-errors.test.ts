import { describe, it, expect } from 'vitest';
import {
  GRAPH_QUOTA_MESSAGE,
  GraphQuotaError,
  graphErrorCode,
  isGraphQuotaFailure,
  isGraphRetryableStatus
} from '../graph-errors';

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

  it('words a full drive so a worker-serialized message is still recognised', () => {
    expect(GRAPH_QUOTA_MESSAGE.test(new GraphQuotaError(507).message)).toBe(true);
    expect(GRAPH_QUOTA_MESSAGE.test(new GraphQuotaError(403, 'quotaLimitReached').message)).toBe(
      true
    );
  });
});
