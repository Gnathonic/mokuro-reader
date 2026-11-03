import { describe, expect, it, vi } from 'vitest';
import { fetchServerIdentity } from './identity';
import { describeContract, loadBunkoFixture } from '$lib/interop/contract';
import { bunkoLoginMe } from './__fixtures__/bunko-login-me';

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
      permissions: PERMS,
      endpoint: 'https://host/login/api/me'
    });
  });

  describe('permissions.metadata (per-series metadata edit scope)', () => {
    async function identityWith(permissions: Record<string, unknown>) {
      const { impl } = mockFetch({
        'https://host/login/api/me': jsonResponse(200, {
          authenticated: true,
          username: 'alice',
          role: 'registered',
          permissions
        })
      });
      return fetchServerIdentity('https://host', 'alice', 'pw', impl);
    }

    it('is absent from permissions when the server response omits it (older bunko)', async () => {
      const result = await identityWith({ ...PERMS });
      expect(result.kind).toBe('authenticated');
      expect(result.kind === 'authenticated' && result.permissions.metadata).toBeUndefined();
    });

    it('parses scope "all" with no ownedSeries', async () => {
      const result = await identityWith({ ...PERMS, metadata: { scope: 'all' } });
      expect(result.kind === 'authenticated' && result.permissions.metadata).toEqual({
        scope: 'all'
      });
    });

    it('parses scope "owned" with its ownedSeries list', async () => {
      const result = await identityWith({
        ...PERMS,
        metadata: { scope: 'owned', ownedSeries: ['One Piece', 'Berserk'] }
      });
      expect(result.kind === 'authenticated' && result.permissions.metadata).toEqual({
        scope: 'owned',
        ownedSeries: ['One Piece', 'Berserk']
      });
    });

    it('treats scope "owned" with a missing/non-array ownedSeries as an empty list, not a parse failure', async () => {
      const result = await identityWith({ ...PERMS, metadata: { scope: 'owned' } });
      expect(result.kind === 'authenticated' && result.permissions.metadata).toEqual({
        scope: 'owned',
        ownedSeries: []
      });
    });

    it('drops an unrecognizable scope value rather than passing it through', async () => {
      const result = await identityWith({ ...PERMS, metadata: { scope: 'bogus' } });
      expect(result.kind === 'authenticated' && result.permissions.metadata).toBeUndefined();
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
    // The origin-root endpoint answered: the token endpoint goes beside it.
    expect(result).toEqual({
      kind: 'authenticated',
      username: 'alice',
      role: 'registered',
      permissions: PERMS,
      endpoint: 'https://host/login/api/me'
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

  describe('server version (bunko reports it from 0.8.0)', () => {
    it('carries the reported version on an authenticated identity', async () => {
      const { impl } = mockFetch({
        'https://host/login/api/me': jsonResponse(200, {
          authenticated: true,
          username: 'alice',
          role: 'registered',
          permissions: PERMS,
          version: '0.8.0'
        })
      });
      const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
      expect(result).toMatchObject({ kind: 'authenticated', serverVersion: '0.8.0' });
    });

    it('carries it on an anonymous identity too', async () => {
      const { impl } = mockFetch({
        'https://host/login/api/me': jsonResponse(200, { authenticated: false, version: '0.8.1' })
      });
      expect(await fetchServerIdentity('https://host', undefined, undefined, impl)).toEqual({
        kind: 'anonymous',
        serverVersion: '0.8.1'
      });
    });

    it('leaves it absent when an older bunko does not report one', async () => {
      const { impl } = mockFetch({
        'https://host/login/api/me': jsonResponse(200, {
          authenticated: true,
          username: 'alice',
          role: 'registered',
          permissions: PERMS
        })
      });
      const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
      expect(result).not.toHaveProperty('serverVersion');
    });
  });
});

describe('per-user files (bunko keeps these per account)', () => {
  it('carries per_user_files on an authenticated identity', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, {
        authenticated: true,
        username: 'alice',
        role: 'registered',
        permissions: PERMS,
        per_user_files: ['volume-data.json', 'positions.json']
      })
    });
    const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
    expect(result).toMatchObject({
      kind: 'authenticated',
      perUserFiles: ['volume-data.json', 'positions.json']
    });
  });

  it('carries it on an anonymous identity too', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, {
        authenticated: false,
        per_user_files: ['positions.json']
      })
    });
    expect(await fetchServerIdentity('https://host', undefined, undefined, impl)).toEqual({
      kind: 'anonymous',
      perUserFiles: ['positions.json']
    });
  });

  it('anything but an array of strings leaves it absent', async () => {
    for (const bad of ['x', 42, [1, 'positions.json'], null]) {
      const { impl } = mockFetch({
        'https://host/login/api/me': jsonResponse(200, {
          authenticated: true,
          username: 'alice',
          role: 'registered',
          permissions: PERMS,
          per_user_files: bad
        })
      });
      const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
      expect(result).not.toHaveProperty('perUserFiles');
    }
  });
});

describe('per-account layers and the curated scope (bunko 0.8)', () => {
  /** The signed-in `/login/api/me` body bunko 0.8 serves, in bunko's key order. */
  const signedIn = (
    extra: Record<string, unknown> = {},
    curated: unknown = { scope: 'owned' }
  ) => ({
    authenticated: true,
    username: 'alice',
    role: 'uploader',
    created_at: '2026-10-01T00:00:00Z',
    permissions: { ...PERMS, canAddFiles: true, curated },
    per_user_files: ['volume-data.json', 'positions.json', 'history/'],
    per_user_layers: ['edit'],
    version: '0.0.0',
    ...extra
  });

  it('carries per_user_layers and permissions.curated on an authenticated identity', async () => {
    const { impl } = mockFetch({ 'https://host/login/api/me': jsonResponse(200, signedIn()) });
    const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
    expect(result).toMatchObject({
      kind: 'authenticated',
      perUserLayers: ['edit'],
      permissions: { canAddFiles: true, curated: { scope: 'owned' } }
    });
  });

  it.each(['all', 'owned', 'none'])('parses curated scope %s', async (scope) => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, signedIn({}, { scope }))
    });
    const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
    expect(result).toMatchObject({ permissions: { curated: { scope } } });
  });

  it('carries curated.volumes (the uploads this account controls in shared folders)', async () => {
    const volumes = [
      { series: 'Shared Series', volume: 'VOL 2' },
      { series: 'Other', volume: 'Tome 1' }
    ];
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, signedIn({}, { scope: 'owned', volumes }))
    });
    const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
    expect(result).toMatchObject({ permissions: { curated: { scope: 'owned', volumes } } });
  });

  it('an empty curated.volumes stays an empty list', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, signedIn({}, { scope: 'owned', volumes: [] }))
    });
    const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
    expect((result as { permissions: object }).permissions).toHaveProperty('curated', {
      scope: 'owned',
      volumes: []
    });
  });

  it('curated.volumes: absent or garbage is not reported, malformed entries are dropped', async () => {
    const parsed = async (curated: unknown) => {
      const { impl } = mockFetch({
        'https://host/login/api/me': jsonResponse(200, signedIn({}, curated))
      });
      const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
      return (result as { permissions: { curated?: unknown } }).permissions.curated;
    };
    // An older bunko: the scope alone, exactly as before.
    expect(await parsed({ scope: 'owned' })).toEqual({ scope: 'owned' });
    for (const bad of ['Vol 1', 42, null, { series: 'S', volume: 'V' }]) {
      expect(await parsed({ scope: 'owned', volumes: bad })).toEqual({ scope: 'owned' });
    }
    expect(
      await parsed({
        scope: 'owned',
        volumes: [
          { series: 'S', volume: 'V' },
          { series: 'S' },
          { series: 1, volume: 'V' },
          'S/V',
          null,
          { series: 'T', volume: 'W', extra: true }
        ]
      })
    ).toEqual({
      scope: 'owned',
      volumes: [
        { series: 'S', volume: 'V' },
        { series: 'T', volume: 'W' }
      ]
    });
    // Present only under scope owned: anything else ignores it.
    for (const scope of ['all', 'none']) {
      expect(await parsed({ scope, volumes: [{ series: 'S', volume: 'V' }] })).toEqual({ scope });
    }
  });

  it('carries per_user_layers on an anonymous identity too', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, {
        authenticated: false,
        role: 'anonymous',
        permissions: { ...PERMS, canWriteProgress: false, curated: { scope: 'none' } },
        per_user_files: ['positions.json'],
        per_user_layers: ['edit'],
        version: '0.0.0'
      })
    });
    expect(await fetchServerIdentity('https://host', undefined, undefined, impl)).toEqual({
      kind: 'anonymous',
      serverVersion: '0.0.0',
      perUserFiles: ['positions.json'],
      perUserLayers: ['edit']
    });
  });

  it('a 0.7.x body (neither key) leaves both absent', async () => {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, {
        authenticated: true,
        username: 'alice',
        role: 'registered',
        permissions: PERMS
      })
    });
    const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
    expect(result).not.toHaveProperty('perUserLayers');
    expect(result).toMatchObject({ kind: 'authenticated' });
    expect((result as { permissions: object }).permissions).not.toHaveProperty('curated');
  });

  it('garbage leaves each absent, without failing the identity', async () => {
    for (const bad of ['edit', 42, [1, 'edit'], null, {}]) {
      const { impl } = mockFetch({
        'https://host/login/api/me': jsonResponse(200, signedIn({ per_user_layers: bad }))
      });
      const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
      expect(result).toMatchObject({ kind: 'authenticated' });
      expect(result).not.toHaveProperty('perUserLayers');
    }
    for (const bad of ['all', { scope: 'everything' }, { scope: 1 }, null, []]) {
      const { impl } = mockFetch({
        'https://host/login/api/me': jsonResponse(200, signedIn({}, bad))
      });
      const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
      expect(result).toMatchObject({ kind: 'authenticated' });
      expect((result as { permissions: object }).permissions).not.toHaveProperty('curated');
    }
  });
});

/** What Bunko answers (its contract fixtures), served at `https://host/login/api/me`. */
function bunko(name: string): MockResponse {
  const f = loadBunkoFixture(name);
  return {
    status: f.status!,
    body: JSON.stringify(f.body),
    contentType: f.headers!['content-type']
  };
}

/**
 * What a 0.8 Bunko's `/login/api/me` carries beside the account; the version
 * is the fixtures' sentinel (`bunko-contract.test.ts`).
 */
const BUNKO_08 = {
  serverVersion: '0.0.0',
  perUserFiles: ['volume-data.json', 'profiles.json', 'goals.json', 'positions.json', 'history/'],
  perUserLayers: ['edit']
};

describeContract('fetchServerIdentity on Bunko’s own answers', () => {
  it('returns authenticated with permissions on a 200 authenticated:true', async () => {
    const { impl } = mockFetch({ 'https://host/login/api/me': bunko('login-me-basic') });

    const result = await fetchServerIdentity('https://host', 'reader', 'pässwörd', impl);
    expect(result).toEqual({
      kind: 'authenticated',
      username: 'reader',
      role: 'uploader',
      permissions: {
        canWriteProgress: true,
        canAddFiles: true,
        canModifyDelete: false,
        metadata: { scope: 'owned', ownedSeries: ['Contract Series'] },
        curated: { scope: 'owned', volumes: [] },
        addFiles: { scope: 'open', closedSeries: [] }
      },
      endpoint: 'https://host/login/api/me',
      ...BUNKO_08
    });
  });

  it('returns anonymous for 200 authenticated:false when no creds were sent', async () => {
    const { impl } = mockFetch({ 'https://host/login/api/me': bunko('login-me-anonymous') });

    const result = await fetchServerIdentity('https://host', undefined, undefined, impl);
    expect(result).toEqual({ kind: 'anonymous', ...BUNKO_08 });
  });

  it('returns invalid-credentials for Bunko’s 401 to a wrong password', async () => {
    const { impl } = mockFetch({ 'https://host/login/api/me': bunko('login-me-bad-password') });

    const result = await fetchServerIdentity('https://host', 'reader', 'wrong', impl);
    expect(result).toEqual({ kind: 'invalid-credentials' });
  });
});

// bunko 0.8 records who owns a series folder: an uploader may add files only
// to series nobody else owns. `permissions.addFiles` reports it, and its
// presence is what says the server enforces series owners at all.
describe('permissions.addFiles (series owners, bunko 0.8)', () => {
  async function identityWith(extra: Record<string, unknown>) {
    const { impl } = mockFetch({
      'https://host/login/api/me': jsonResponse(200, {
        authenticated: true,
        username: 'alice',
        role: 'uploader',
        permissions: { ...PERMS, canAddFiles: true, ...extra }
      })
    });
    const result = await fetchServerIdentity('https://host', 'alice', 'pw', impl);
    if (result.kind !== 'authenticated') throw new Error(`expected authenticated: ${result.kind}`);
    return result.permissions as unknown as Record<string, unknown>;
  }

  it('parses scope all and none', async () => {
    expect((await identityWith({ addFiles: { scope: 'all' } })).addFiles).toEqual({
      scope: 'all'
    });
    expect((await identityWith({ addFiles: { scope: 'none' } })).addFiles).toEqual({
      scope: 'none'
    });
  });

  it('parses scope open with its closedSeries, dropping non-strings', async () => {
    const permissions = await identityWith({
      addFiles: { scope: 'open', closedSeries: ['Admin Series', 7, null, 'Berserk'] }
    });
    expect(permissions.addFiles).toEqual({
      scope: 'open',
      closedSeries: ['Admin Series', 'Berserk']
    });
  });

  it('reads a non-array closedSeries as no closed series', async () => {
    for (const bad of [undefined, 'Admin Series', { a: 1 }, null]) {
      const permissions = await identityWith({ addFiles: { scope: 'open', closedSeries: bad } });
      expect(permissions.addFiles).toEqual({ scope: 'open', closedSeries: [] });
    }
  });

  it('an unknown scope, or no object, reads as not reported', async () => {
    for (const bad of [{ scope: 'owned' }, { scope: 1 }, 'all', null, []]) {
      expect(await identityWith({ addFiles: bad })).not.toHaveProperty('addFiles');
    }
  });

  it('an older bunko (no addFiles) reports none', async () => {
    expect(await identityWith({})).not.toHaveProperty('addFiles');
  });

  it.each(['login-me-basic', 'login-me-closed-series'] as const)(
    "bunko's %s contract body parses",
    async (name) => {
      const body = bunkoLoginMe(name);
      const { impl } = mockFetch({ 'https://host/login/api/me': jsonResponse(200, body) });
      const result = await fetchServerIdentity('https://host', 'reader', 'pw', impl);
      const served = (body.permissions as { addFiles: { closedSeries: string[] } }).addFiles;
      expect(result).toMatchObject({
        kind: 'authenticated',
        permissions: {
          canAddFiles: true,
          addFiles: { scope: 'open', closedSeries: served.closedSeries },
          metadata: { scope: 'owned', ownedSeries: ['Contract Series'] }
        }
      });
      if (name === 'login-me-closed-series') expect(served.closedSeries).toEqual(['Admin Series']);
      // The curated scope reads back as served, and so does each per-volume
      // entry's folder + archive stem. Keys an entry gains later are dropped
      // on purpose, so the entries are compared on those two fields only.
      const curated = (body.permissions as { curated: { scope: string; volumes?: unknown } })
        .curated;
      const parsed = (result as { permissions: { curated?: { scope: string; volumes?: unknown } } })
        .permissions.curated;
      expect(parsed?.scope).toBe(curated.scope);
      if (curated.volumes === undefined) {
        expect(parsed).not.toHaveProperty('volumes');
      } else {
        const entries = curated.volumes as { series: unknown; volume: unknown }[];
        for (const { series, volume } of entries) {
          expect(typeof series).toBe('string');
          expect(typeof volume).toBe('string');
          // The archive STEM: the .cbz name without .cbz.
          expect(volume as string).not.toMatch(/\.cbz$/i);
        }
        expect(parsed?.volumes).toEqual(entries.map(({ series, volume }) => ({ series, volume })));
      }
    }
  );
});
