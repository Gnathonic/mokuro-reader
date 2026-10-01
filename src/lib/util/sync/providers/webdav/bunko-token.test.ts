import { describe, expect, it, vi } from 'vitest';
import {
  TOKEN_RENEW_BEFORE_MS,
  requestBunkoToken,
  revokeBunkoToken,
  tokenEndpointFor,
  tokenLabel,
  tokenNeedsRenewal
} from './bunko-token';

const ENDPOINT = 'https://host/login/api/token';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('requestBunkoToken', () => {
  it('posts a reader token request as JSON and returns the token on 200', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        token: 'tok-1',
        token_type: 'Bearer',
        kind: 'reader',
        expires_at: 1_800_000_000.5,
        user: { username: 'alice', role: 'registered' }
      })
    );
    const result = await requestBunkoToken(ENDPOINT, 'alice', 'pässwörd', 'label', fetchImpl);
    expect(result).toEqual({ kind: 'issued', token: 'tok-1', expiresAt: 1_800_000_000_500 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      username: 'alice',
      password: 'pässwörd',
      kind: 'reader',
      label: 'label'
    });
  });

  it('accepts a 200 without an expiry (no proactive renewal then)', async () => {
    const result = await requestBunkoToken(ENDPOINT, 'a', 'p', 'l', async () =>
      json(200, { token: 't', token_type: 'bearer' })
    );
    expect(result).toEqual({ kind: 'issued', token: 't', expiresAt: null });
  });

  it('a JSON 401 from the endpoint is a refused password', async () => {
    const result = await requestBunkoToken(ENDPOINT, 'a', 'wrong', 'l', async () =>
      json(401, { error: 'Invalid credentials' })
    );
    expect(result).toEqual({ kind: 'invalid-credentials' });
  });

  it("an older bunko's text/plain 401 (auth layer, no endpoint) is NOT a refused password", async () => {
    const result = await requestBunkoToken(
      ENDPOINT,
      'a',
      'p',
      'l',
      async () =>
        new Response('Authentication required', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="x"' }
        })
    );
    expect(result).toEqual({ kind: 'unsupported' });
  });

  it('404 / 405 / a non-token 200 mean no endpoint here', async () => {
    for (const response of [
      new Response('nope', { status: 404 }),
      new Response('', { status: 405 }),
      json(200, { hello: 'world' }),
      new Response('<html></html>', { status: 200 })
    ]) {
      expect(await requestBunkoToken(ENDPOINT, 'a', 'p', 'l', async () => response)).toEqual({
        kind: 'unsupported'
      });
    }
  });

  it('a JSON 429 is the login rate limiter', async () => {
    const result = await requestBunkoToken(ENDPOINT, 'a', 'p', 'l', async () =>
      json(429, { error: 'Too many failed attempts. Retry in 60s' })
    );
    expect(result).toEqual({ kind: 'rate-limited' });
  });

  it('a network error or a 5xx learns nothing: unreachable', async () => {
    expect(
      await requestBunkoToken(ENDPOINT, 'a', 'p', 'l', async () => {
        throw new TypeError('Failed to fetch');
      })
    ).toEqual({ kind: 'unreachable' });
    expect(
      await requestBunkoToken(
        ENDPOINT,
        'a',
        'p',
        'l',
        async () => new Response('', { status: 502 })
      )
    ).toEqual({ kind: 'unreachable' });
  });
});

describe('revokeBunkoToken', () => {
  it('DELETEs with the token as Bearer and never throws', async () => {
    const fetchImpl = vi.fn(async () => json(200, { revoked: true }));
    expect(await revokeBunkoToken(ENDPOINT, 'tok', fetchImpl)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');

    expect(
      await revokeBunkoToken(ENDPOINT, 'tok', async () => {
        throw new TypeError('offline');
      })
    ).toBe(false);
  });
});

describe('tokenEndpointFor', () => {
  it('sits beside the identity endpoint that answered (subpath or origin root)', () => {
    expect(tokenEndpointFor('https://host/sub/login/api/me', 'https://host/sub')).toBe(
      'https://host/sub/login/api/token'
    );
    expect(tokenEndpointFor('https://host/login/api/me', 'https://host/sub')).toBe(
      'https://host/login/api/token'
    );
  });

  it("without one, takes the server URL's subpath candidate", () => {
    expect(tokenEndpointFor(undefined, 'https://host/sub')).toBe(
      'https://host/sub/login/api/token'
    );
    expect(tokenEndpointFor(undefined, 'https://host')).toBe('https://host/login/api/token');
  });
});

describe('tokenNeedsRenewal / tokenLabel', () => {
  it('renews with fewer than 7 days left, never on an unknown expiry', () => {
    const now = 1_000_000_000_000;
    expect(tokenNeedsRenewal(now + TOKEN_RENEW_BEFORE_MS + 1, now)).toBe(false);
    expect(tokenNeedsRenewal(now + TOKEN_RENEW_BEFORE_MS - 1, now)).toBe(true);
    expect(tokenNeedsRenewal(now - 1, now)).toBe(true);
    expect(tokenNeedsRenewal(null, now)).toBe(false);
  });

  it('names the browser', () => {
    expect(
      tokenLabel('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')
    ).toBe('mokuro-reader (Firefox)');
    expect(
      tokenLabel(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
      )
    ).toBe('mokuro-reader (Chrome)');
    expect(tokenLabel('')).toBe('mokuro-reader');
  });
});
