/**
 * The contract helper's own rules: a Bunko checkout named by `BUNKO_REPO` must be
 * there, records are only ever written into one named that way, and Bunko's time
 * sentinels rebase in the format they were written in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractDir, rebase, recordRequest } from './contract';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the contract helper', () => {
  it('a BUNKO_REPO without interop/contract is an error, not a quiet skip', () => {
    vi.stubEnv('BUNKO_REPO', '/nonexistent/bunko-checkout');
    expect(() => contractDir()).toThrow(/BUNKO_REPO=\/nonexistent\/bunko-checkout/);
  });

  it('READER_BLESS=1 writes only into a checkout named by BUNKO_REPO', () => {
    vi.stubEnv('BUNKO_REPO', undefined);
    vi.stubEnv('READER_BLESS', '1');
    expect(() =>
      recordRequest('anything', {
        request: { method: 'GET', url: 'https://bunko.example/' },
        expect: { status: [200] }
      })
    ).toThrow(/needs BUNKO_REPO/);
  });

  it('rebases each sentinel time in its own format', () => {
    const now = Date.parse('2026-10-28T12:34:56.789Z');
    expect(
      rebase(
        {
          z: '2000-01-01T00:00:00Z',
          ms: '2000-01-01T00:00:00.000Z',
          offset: '2000-01-01T00:00:00+00:00',
          sqlite: '2000-01-01 00:00:00',
          http: 'Sat, 01 Jan 2000 00:00:00 GMT',
          s: 946684800,
          millis: 946684800000
        },
        now
      )
    ).toEqual({
      z: '2026-10-28T12:34:56Z',
      ms: '2026-10-28T12:34:56.789Z',
      offset: '2026-10-28T12:34:56+00:00',
      sqlite: '2026-10-28 12:34:56',
      http: 'Wed, 28 Oct 2026 12:34:56 GMT',
      s: Math.floor(now / 1000),
      millis: now
    });
  });
});
