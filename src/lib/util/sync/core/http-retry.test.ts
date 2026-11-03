import { describe, expect, it } from 'vitest';
import {
  RETRY_AFTER_MAX_MS,
  RETRY_BASE_DELAY_MS,
  RETRY_JITTER_MS,
  RETRY_MAX_DELAY_MS,
  backoffDelayMs,
  parseRetryAfterMs,
  retryAfterMs,
  retryDelayMs
} from './http-retry';

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('3')).toBe(3000);
    expect(parseRetryAfterMs(' 3 ')).toBe(3000);
    expect(parseRetryAfterMs('1.5')).toBe(1500);
  });

  it('reads an HTTP date as the time left until it', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(parseRetryAfterMs('Sat, 31 Oct 2026 12:00:07 GMT', now)).toBe(7000);
  });

  it('treats zero, or a date already past, as no advice, so the caller backs off', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(parseRetryAfterMs('0')).toBeUndefined();
    expect(parseRetryAfterMs(' 0 ')).toBeUndefined();
    expect(parseRetryAfterMs('Sat, 31 Oct 2026 11:59:00 GMT', now)).toBeUndefined();
    expect(parseRetryAfterMs('Sat, 31 Oct 2026 12:00:00 GMT', now)).toBeUndefined();
  });

  it('caps a long wait', () => {
    expect(parseRetryAfterMs('3600')).toBe(RETRY_AFTER_MAX_MS);
  });

  it('is undefined when absent or unreadable', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs('-5')).toBeUndefined();
  });

  it('reads it off a Response, and a stub without headers is no wait', () => {
    expect(retryAfterMs(new Response(null, { headers: { 'Retry-After': '2' } }))).toBe(2000);
    expect(retryAfterMs({} as Response)).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  it('doubles from the base and stops at the cap', () => {
    const noJitter = () => 0;
    expect(backoffDelayMs(1, noJitter)).toBe(RETRY_BASE_DELAY_MS);
    expect(backoffDelayMs(2, noJitter)).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(backoffDelayMs(3, noJitter)).toBe(RETRY_BASE_DELAY_MS * 4);
    expect(backoffDelayMs(20, noJitter)).toBe(RETRY_MAX_DELAY_MS);
  });

  it('adds jitter below RETRY_JITTER_MS', () => {
    expect(backoffDelayMs(1, () => 0.999)).toBe(RETRY_BASE_DELAY_MS + RETRY_JITTER_MS - 1);
  });

  it('a server Retry-After wins over backoff', () => {
    expect(retryDelayMs(4, 1000)).toBe(1000);
    const backoff = retryDelayMs(1);
    expect(backoff).toBeGreaterThanOrEqual(RETRY_BASE_DELAY_MS);
    expect(backoff).toBeLessThan(RETRY_BASE_DELAY_MS + RETRY_JITTER_MS);
  });

  it('a Retry-After of 0 is no advice: it backs off instead of retrying back to back', () => {
    expect(retryDelayMs(1, 0, () => 0)).toBe(RETRY_BASE_DELAY_MS);
    expect(retryDelayMs(2, 0, () => 0)).toBe(RETRY_BASE_DELAY_MS * 2);
  });
});
