import { describe, expect, it, vi } from 'vitest';
import { fetchServerIdentity } from './identity';

type MockResponse = { status: number; body: string; contentType?: string };

function jsonResponse(status: number, body: unknown): MockResponse {
  return { status, body: JSON.stringify(body), contentType: 'application/json' };
}

function htmlResponse(status: number, body = '<html>nope</html>'): MockResponse {
  return { status, body, contentType: 'text/html' };
}

/**
 * Build a fetch mock that replies per-URL. Unlisted URLs get a 404.
 * Records the URLs and request init for each call.
 */
function mockFetch(routes: Record<string, MockResponse | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url] ?? htmlResponse(404, 'not found');
    if (route instanceof Error) throw route;
    return new Response(route.body, {
      status: route.status,
      headers: { 'Content-Type': route.contentType ?? 'application/json' }
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const PERMS = { canWriteProgress: true, canAddFiles: false, canModifyDelete: false };

describe('fetchServerIdentity', () => {
  it('returns authenticated with permissions on a 200 authenticated:true', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, {
        authenticated: true,
        username: 'alice',
        role: 'registered',
        created_at: '2026-01-01',
        permissions: PERMS
      })
    });

    const result = await fetchServerIdentity('https://host', 'alice', 'pässwörd', impl);
    expect(result).toEqual({
      kind: 'authenticated',
      username: 'alice',
      role: 'registered',
      permissions: PERMS
    });
  });

  it('treats a recognizable 401 as terminal invalid-credentials without trying candidate B', async () => {
    const { impl, calls } = mockFetch({
      'https://host/mokuro-reader/login/api/me': jsonResponse(401, {
        authenticated: false,
        error: 'Invalid credentials'
      }),
      'https://host/login/api/me': jsonResponse(200, {
        authenticated: true,
        username: 'x',
        role: 'registered',
        permissions: PERMS
      })
    });

    const result = await fetchServerIdentity('https://host/mokuro-reader', 'alice', 'wrong', impl);
    expect(result).toEqual({ kind: 'invalid-credentials' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://host/mokuro-reader/login/api/me');
  });

  it('returns invalid-credentials for 200 authenticated:false when creds were sent', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, { authenticated: false, role: 'anonymous' })
    });

    const result = await fetchServerIdentity('https://host', 'alice', 'wrong', impl);
    expect(result).toEqual({ kind: 'invalid-credentials' });
  });

  it('returns anonymous for 200 authenticated:false when no creds were sent', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, { authenticated: false, role: 'anonymous' })
    });

    const result = await fetchServerIdentity('https://host', undefined, undefined, impl);
    expect(result).toEqual({ kind: 'anonymous' });
  });

  it('H1: returns unsupported for a 200 old-shape body without an authenticated boolean', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, {
        username: 'a',
        role: 'registered',
        created_at: '2026-01-01'
      })
    });

    const result = await fetchServerIdentity('https://host', 'a', 'pw', impl);
    expect(result).toEqual({ kind: 'unsupported' });
  });

  it('H2: a 401 with an unrecognizable body advances to the next candidate, then unsupported', async () => {
    const { impl, calls } = mockFetch({
      'https://host/sub/login/api/me': htmlResponse(404),
      'https://host/login/api/me': htmlResponse(401, '<html>401 Authorization Required</html>')
    });

    const result = await fetchServerIdentity('https://host/sub', 'a', 'pw', impl);
    expect(result).toEqual({ kind: 'unsupported' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://host/sub/login/api/me',
      'https://host/login/api/me'
    ]);
  });

  it('H3: derives subpath candidate first, then origin root, for slashless base URLs', async () => {
    const { impl, calls } = mockFetch({
      'https://host/mokuro-reader/login/api/me': htmlResponse(404),
      'https://host/login/api/me': jsonResponse(200, {
        authenticated: true,
        username: 'a',
        role: 'admin',
        permissions: { canWriteProgress: true, canAddFiles: true, canModifyDelete: true }
      })
    });

    const result = await fetchServerIdentity('https://host/mokuro-reader', 'a', 'pw', impl);
    expect(result.kind).toBe('authenticated');
    expect(calls.map((c) => c.url)).toEqual([
      'https://host/mokuro-reader/login/api/me',
      'https://host/login/api/me'
    ]);
  });

  it('uses a single candidate when the base URL is the origin root', async () => {
    const { impl, calls } = mockFetch({
      'https://host/login/api/me': htmlResponse(404)
    });

    const result = await fetchServerIdentity('https://host', 'a', 'pw', impl);
    expect(result).toEqual({ kind: 'unsupported' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://host/login/api/me');
  });

  it('returns rate-limited for a recognizable 429', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(429, {
        authenticated: false,
        error: 'Too many failed attempts. Retry in 60s'
      })
    });

    const result = await fetchServerIdentity('https://host', 'a', 'pw', impl);
    expect(result).toEqual({ kind: 'rate-limited' });
  });

  it('treats an unrecognizable 429 as unsupported', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': htmlResponse(429, '<html>slow down</html>')
    });

    const result = await fetchServerIdentity('https://host', 'a', 'pw', impl);
    expect(result).toEqual({ kind: 'unsupported' });
  });

  it('returns unsupported when all candidates fail with network errors', async () => {
    const { impl } = mockFetch({
      'https://host/sub/login/api/me': new Error('Failed to fetch'),
      'https://host/login/api/me': new Error('Failed to fetch')
    });

    const result = await fetchServerIdentity('https://host/sub', 'a', 'pw', impl);
    expect(result).toEqual({ kind: 'unsupported' });
  });

  it('returns unsupported for a non-JSON 200 once all candidates are exhausted', async () => {
    const { impl, calls } = mockFetch({
      'https://host/sub/login/api/me': htmlResponse(200, '<html>welcome</html>'),
      'https://host/login/api/me': htmlResponse(200, '<html>welcome</html>')
    });

    const result = await fetchServerIdentity('https://host/sub', 'a', 'pw', impl);
    expect(result).toEqual({ kind: 'unsupported' });
    // a non-JSON 200 is not recognizably ours - BOTH candidates must be probed
    expect(calls.map((c) => c.url)).toEqual([
      'https://host/sub/login/api/me',
      'https://host/login/api/me'
    ]);
  });

  it('advances past a non-JSON 200 (SPA fallback / proxy) to a working origin-root endpoint', async () => {
    const { impl, calls } = mockFetch({
      'https://host/sub/login/api/me': htmlResponse(200, '<!doctype html><html>app shell</html>'),
      'https://host/login/api/me': jsonResponse(200, {
        authenticated: true,
        username: 'alice',
        role: 'registered',
        permissions: PERMS
      })
    });

    const result = await fetchServerIdentity('https://host/sub', 'alice', 'pw', impl);
    expect(result).toEqual({
      kind: 'authenticated',
      username: 'alice',
      role: 'registered',
      permissions: PERMS
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://host/sub/login/api/me',
      'https://host/login/api/me'
    ]);
  });

  it('returns unsupported for a 500', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(500, { error: 'boom' })
    });

    const result = await fetchServerIdentity('https://host', 'a', 'pw', impl);
    expect(result).toEqual({ kind: 'unsupported' });
  });

  it('sends the UTF-8-safe Authorization header when a password is given', async () => {
    const { impl, calls } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, {
        authenticated: true,
        username: 'user',
        role: 'registered',
        permissions: PERMS
      })
    });

    await fetchServerIdentity('https://host', 'user', 'päss', impl);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Basic dXNlcjpww6Rzcw==');
  });

  it('sends no Authorization header when password is empty, even with a username', async () => {
    const { impl, calls } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, { authenticated: false, role: 'anonymous' })
    });

    const result = await fetchServerIdentity('https://host', 'user', '', impl);
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers).not.toHaveProperty('Authorization');
    // No creds were sent, so authenticated:false means anonymous (not invalid creds)
    expect(result).toEqual({ kind: 'anonymous' });
  });
});
