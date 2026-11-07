import { describe, expect, it, vi } from 'vitest';
import {
  BODY_LIMIT_BYTES,
  COOKIE_MAX_AGE_S,
  clearSessionCookie,
  cookieName,
  methodNotAllowed,
  setSessionCookie,
  validateRequest
} from '../http';
import { authEvent, bodyOf } from './helpers';

async function rejection(options: Parameters<typeof authEvent>[0]) {
  const result = await validateRequest(authEvent(options));
  if (result.ok) throw new Error('expected a rejection');
  return {
    status: result.response.status,
    body: await bodyOf(result.response),
    cacheControl: result.response.headers.get('cache-control'),
    contentType: result.response.headers.get('content-type')
  };
}

describe('request validation (every route, before any crypto or Google call)', () => {
  it('accepts the client’s request', async () => {
    const result = await validateRequest(authEvent({ body: { pop: { ts: 1 } } }));
    expect(result).toEqual({ ok: true, body: { pop: { ts: 1 } } });
  });

  it('accepts no Sec-Fetch-Site at all (older browsers send none)', async () => {
    const result = await validateRequest(authEvent({ headers: { 'sec-fetch-site': null } }));
    expect(result.ok).toBe(true);
  });

  it('accepts application/json with a charset', async () => {
    const result = await validateRequest(
      authEvent({ headers: { 'content-type': 'application/json; charset=utf-8' } })
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a GET', { method: 'GET' }, 405, 'method_not_allowed'],
    [
      'a form post',
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      415,
      'unsupported_media_type'
    ],
    [
      'text/plain (a simple request)',
      { headers: { 'content-type': 'text/plain' } },
      415,
      'unsupported_media_type'
    ],
    ['no Content-Type', { headers: { 'content-type': null } }, 415, 'unsupported_media_type'],
    ['no Origin', { headers: { origin: null } }, 403, 'forbidden'],
    ['another Origin', { headers: { origin: 'https://evil.example' } }, 403, 'forbidden'],
    ['the same host over http', { headers: { origin: 'http://reader.example' } }, 403, 'forbidden'],
    ['Origin "null"', { headers: { origin: 'null' } }, 403, 'forbidden'],
    [
      'Sec-Fetch-Site cross-site',
      { headers: { 'sec-fetch-site': 'cross-site' } },
      403,
      'forbidden'
    ],
    [
      'Sec-Fetch-Site same-site (a sibling subdomain)',
      { headers: { 'sec-fetch-site': 'same-site' } },
      403,
      'forbidden'
    ],
    ['Sec-Fetch-Site none', { headers: { 'sec-fetch-site': 'none' } }, 403, 'forbidden'],
    ['no X-Requested-With', { headers: { 'x-requested-with': null } }, 403, 'forbidden'],
    [
      'a declared body over the cap',
      { rawBody: 'x', headers: { 'content-length': String(BODY_LIMIT_BYTES + 1) } },
      413,
      'payload_too_large'
    ],
    ['invalid JSON', { rawBody: '{nope' }, 400, 'bad_request'],
    ['a JSON array', { body: [1, 2] }, 400, 'bad_request'],
    ['a JSON string', { rawBody: '"hi"' }, 400, 'bad_request'],
    ['an empty body', { rawBody: '' }, 400, 'bad_request'],
    ['invalid UTF-8', { rawBody: new Uint8Array([0x7b, 0xff, 0x7d]) }, 400, 'bad_request']
  ] as const)('refuses %s', async (_label, options, status, error) => {
    const r = await rejection(options as Parameters<typeof authEvent>[0]);
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ error });
    expect(r.cacheControl).toBe('no-store');
    expect(r.contentType).toContain('application/json');
  });

  it('counts a chunked body while streaming: no Content-Length does not get past the cap', async () => {
    const chunk = new TextEncoder().encode(`{"pad":"${'x'.repeat(1000)}`);
    let sent = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++;
        if (sent > 100) controller.close();
        else controller.enqueue(chunk);
      },
      cancel
    });
    const r = await rejection({ rawBody: stream, headers: { 'content-length': null } });
    expect(r.status).toBe(413);
    // It stopped reading soon after the cap, not at the end of the stream.
    expect(sent).toBeLessThan(10);
    // Stopped, not cancelled: SvelteKit's Node stream destroys the socket on a
    // cancel, and the 413 would never reach the client.
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a body of exactly the cap is read', async () => {
    const pad = 'x'.repeat(BODY_LIMIT_BYTES - '{"p":""}'.length);
    const result = await validateRequest(authEvent({ rawBody: `{"p":"${pad}"}` }));
    expect(result.ok).toBe(true);
  });

  it('answers other methods with the same JSON, no-store shape', async () => {
    const response = methodNotAllowed();
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await bodyOf(response)).toEqual({ error: 'method_not_allowed' });
  });
});

describe('the session cookie', () => {
  it('is __Host- everywhere but plain http on loopback', () => {
    expect(cookieName(new URL('https://reader.example/'))).toBe('__Host-gdrive_rt');
    expect(cookieName(new URL('https://localhost/'))).toBe('__Host-gdrive_rt');
    expect(cookieName(new URL('http://localhost:5173/'))).toBe('gdrive_rt');
    expect(cookieName(new URL('http://127.0.0.1:4173/'))).toBe('gdrive_rt');
    expect(cookieName(new URL('http://[::1]:5173/'))).toBe('gdrive_rt');
    expect(cookieName(new URL('http://app.localhost/'))).toBe('gdrive_rt');
    // Plain http anywhere but loopback (another machine on the network): the
    // browser drops a __Host- cookie there, and that is the right outcome.
    expect(cookieName(new URL('http://reader.test:5173/'))).toBe('__Host-gdrive_rt');
  });

  it('is set HttpOnly, Secure, SameSite=Strict, Path=/ for 180 days, attributes spelled out', () => {
    const event = authEvent();
    setSessionCookie(event, 'v1.sealed');
    expect(event.jar.sets).toEqual([
      {
        name: '__Host-gdrive_rt',
        value: 'v1.sealed',
        options: {
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          maxAge: COOKIE_MAX_AGE_S
        }
      }
    ]);
    expect(COOKIE_MAX_AGE_S).toBe(180 * 24 * 60 * 60);
  });

  it('on loopback http it is not Secure (the browser would refuse it), still HttpOnly and Strict', () => {
    const event = authEvent({ origin: 'http://localhost:5173' });
    setSessionCookie(event, 'v1.sealed');
    expect(event.jar.sets[0]).toMatchObject({
      name: 'gdrive_rt',
      options: { secure: false, httpOnly: true, sameSite: 'strict', path: '/' }
    });
  });

  it('is cleared with the same attributes, or a __Host- cookie would survive', () => {
    const event = authEvent();
    clearSessionCookie(event);
    expect(event.jar.deletes).toEqual([
      {
        name: '__Host-gdrive_rt',
        options: { path: '/', httpOnly: true, secure: true, sameSite: 'strict' }
      }
    ]);
  });
});
