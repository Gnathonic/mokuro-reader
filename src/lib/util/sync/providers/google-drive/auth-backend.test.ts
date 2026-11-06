/**
 * The client half of the Drive auth backend: what each server answer means,
 * the proof every refresh carries (checked here by the server's own verifier),
 * the sign-in URL, and the one-use hand-off from the callback page.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeUrl,
  backendAuthConfigured,
  backendAuthEnabled,
  callBackend,
  callWithProof,
  CALLBACK_KEY,
  hasPendingCallback,
  markBackendUnavailable,
  PENDING_KEY,
  pkceChallenge,
  resetAuthBackendForTest,
  safeReturnTo,
  startSignIn,
  takeCallback
} from './auth-backend';
import { ensureDeviceKey, forgetCachedDeviceKeyForTest } from './device-key';
import { checkProof, parseProof } from '$lib/server/gdrive-auth/pop';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
const html = (status: number) =>
  new Response('<!doctype html><title>x</title>', {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.stubEnv('VITE_GDRIVE_AUTH_BACKEND', 'true');
  sessionStorage.clear();
  localStorage.clear();
  resetAuthBackendForTest();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  forgetCachedDeviceKeyForTest();
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase('mokuro-device-key');
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
});

/** The JSON body of the n-th backend call. */
function sentBody(n = 0): Record<string, unknown> {
  const init = vi.mocked(fetch).mock.calls[n][1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe('the mode', () => {
  it('is on only with the build flag, and off for the tab once the backend is found missing', () => {
    vi.stubEnv('VITE_GDRIVE_AUTH_BACKEND', '');
    expect(backendAuthConfigured()).toBe(false);
    expect(backendAuthEnabled()).toBe(false);

    vi.stubEnv('VITE_GDRIVE_AUTH_BACKEND', 'true');
    expect(backendAuthEnabled()).toBe(true);
    markBackendUnavailable();
    expect(backendAuthConfigured()).toBe(true);
    expect(backendAuthEnabled()).toBe(false);
  });
});

describe('callBackend', () => {
  it('POSTs same-origin JSON with X-Requested-With, never cached', async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, { access_token: 'T', expires_in: 3599 }));
    await callBackend('refresh', { a: 1 });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/gdrive/refresh');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init.headers).get('x-requested-with')).toBe('XMLHttpRequest');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({ a: 1 });
  });

  it.each([
    [
      'a token',
      json(200, { access_token: 'T', expires_in: 3599 }),
      { kind: 'ok', accessToken: 'T', expiresIn: 3599 }
    ],
    [
      'logout done, revoked by the server',
      json(200, { ok: true, revoked: true, invalidated: true }),
      { kind: 'done', revoked: true, invalidated: true }
    ],
    [
      'logout done, nothing revoked, copies of a bound cookie now useless',
      json(200, { ok: true, revoked: false, invalidated: true }),
      { kind: 'done', revoked: false, invalidated: true }
    ],
    [
      'logout done, nothing revoked, a copy may still work',
      json(200, { ok: true, revoked: false, invalidated: false }),
      { kind: 'done', revoked: false, invalidated: false }
    ],
    // An older server that does not say: not proof of a revoke, nor of anything invalidated.
    [
      'logout done (no revoked or invalidated field)',
      json(200, { ok: true }),
      { kind: 'done', revoked: false, invalidated: false }
    ],
    ['reauth', json(401, { error: 'reauth' }), { kind: 'reauth' }],
    ['no_session', json(401, { error: 'no_session' }), { kind: 'reauth' }],
    [
      'pop_clock',
      json(401, { error: 'pop_clock', serverTime: 5 }),
      { kind: 'pop_clock', serverTime: 5 }
    ],
    ['transient', json(503, { error: 'transient' }), { kind: 'transient' }],
    ['server_config (cookies kept)', json(503, { error: 'server_config' }), { kind: 'transient' }],
    ['internal', json(500, { error: 'internal' }), { kind: 'transient' }],
    ['a WAF challenge page (non-JSON 403)', html(403), { kind: 'transient' }],
    ['a rate limit page (non-JSON 429)', html(429), { kind: 'transient' }],
    ['a 502 page', html(502), { kind: 'transient' }],
    ['404 (an old deployment)', html(404), { kind: 'unavailable' }],
    ['405', json(405, { error: 'method_not_allowed' }), { kind: 'unavailable' }],
    [
      '501 not_configured (a preview)',
      json(501, { error: 'not_configured' }),
      { kind: 'unavailable' }
    ],
    ['the app shell for an unknown path', html(200), { kind: 'unavailable' }],
    [
      'consent_incomplete',
      json(403, { error: 'consent_incomplete' }),
      { kind: 'refused', error: 'consent_incomplete' }
    ],
    ['forbidden', json(403, { error: 'forbidden' }), { kind: 'refused', error: 'forbidden' }]
  ])('maps %s', async (_label, response, outcome) => {
    vi.mocked(fetch).mockResolvedValue(response);
    expect(await callBackend('refresh', {})).toEqual(outcome);
  });

  it('a network failure is transient (offline: it never reached the backend), never thrown', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await callBackend('refresh', {})).toEqual({ kind: 'transient', offline: true });
  });

  it('our own timeout is a slow backend: transient, and it counts', async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    expect(await callBackend('refresh', {})).toEqual({ kind: 'transient' });
  });

  it('a browser that says it is offline: offline, even for a timeout', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    vi.mocked(fetch).mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    expect(await callBackend('refresh', {})).toEqual({ kind: 'transient', offline: true });
  });
});

describe('callWithProof', () => {
  it('without a device key sends no proof (an unbound session)', async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, { access_token: 'T', expires_in: 1 }));
    await callWithProof('refresh', {});
    expect(sentBody()).toEqual({});
  });

  it('with one, signs this origin, POST, the route and now: the server accepts it', async () => {
    await ensureDeviceKey();
    vi.mocked(fetch).mockResolvedValue(json(200, { access_token: 'T', expires_in: 1 }));
    const before = Date.now();
    await callWithProof('refresh', { extra: 1 });
    const body = sentBody();
    expect(body.extra).toBe(1);
    const proof = parseProof(body.pop)!;
    expect(proof.ts).toBeGreaterThanOrEqual(before);
    expect(checkProof(proof, location.origin, '/api/gdrive/refresh', Date.now()).ok).toBe(true);
    expect(checkProof(proof, location.origin, '/api/gdrive/session', Date.now()).ok).toBe(false);
  });

  it('pop_clock: adopts the server time, signs again ONCE, and remembers the offset', async () => {
    await ensureDeviceKey();
    const serverTime = Date.now() + 60 * 60 * 1000;
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'pop_clock', serverTime }))
      .mockResolvedValueOnce(json(200, { access_token: 'T', expires_in: 1 }));
    expect(await callWithProof('refresh', {})).toMatchObject({ kind: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const retried = parseProof(sentBody(1).pop)!;
    expect(Math.abs(retried.ts - serverTime)).toBeLessThan(5000);
    expect(checkProof(retried, location.origin, '/api/gdrive/refresh', serverTime).ok).toBe(true);
    expect(
      Math.abs(Number(localStorage.getItem('gdrive_pop_clock_offset')) - 3_600_000)
    ).toBeLessThan(5000);
  });

  it('a second pop_clock is transient (no loop)', async () => {
    await ensureDeviceKey();
    vi.mocked(fetch).mockResolvedValue(json(401, { error: 'pop_clock', serverTime: 1 }));
    expect(await callWithProof('refresh', {})).toEqual({ kind: 'transient' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('sign-in', () => {
  it('leaves for Google with PKCE S256, a random state, offline access and consent', async () => {
    history.replaceState(null, '', '/#/cloud');
    const navigate = vi.fn();
    await startSignIn(navigate);
    const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY)!);
    expect(pending.returnTo).toBe('#/cloud');
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.state).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const url = new URL(navigate.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = Object.fromEntries(url.searchParams);
    expect(p).toEqual({
      client_id: expect.any(String),
      redirect_uri: `${location.origin}/oauth/google-callback.html`,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive.file',
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: await pkceChallenge(pending.verifier),
      code_challenge_method: 'S256',
      state: pending.state
    });
    history.replaceState(null, '', '/');
  });

  it('creates the device key on the way (the only path that does)', async () => {
    const { loadDeviceKey } = await import('./device-key');
    expect(await loadDeviceKey()).toBeNull();
    await startSignIn(vi.fn());
    forgetCachedDeviceKeyForTest();
    expect(await loadDeviceKey()).not.toBeNull();
  });

  it('a fresh verifier and state every time', async () => {
    const navigate = vi.fn();
    await startSignIn(navigate);
    const first = sessionStorage.getItem(PENDING_KEY);
    await startSignIn(navigate);
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBe(first);
  });

  it('PKCE S256 matches RFC 7636’s worked example', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });

  it('only a hash route of the app is a place to come back to', () => {
    expect(safeReturnTo('#/series/abc-123')).toBe('#/series/abc-123');
    expect(safeReturnTo('#/reader/x?page=3')).toBe('#/reader/x?page=3');
    for (const bad of ['', '#', '#access_token=x', '//evil.example', '#/a b', '#/<x>', '#/"q"']) {
      expect(safeReturnTo(bad)).toBe('');
    }
  });

  it('authorizeUrl names the redirect from the origin it is given', () => {
    const url = new URL(
      authorizeUrl({ clientId: 'c', origin: 'https://reader.example', challenge: 'x', state: 's' })
    );
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://reader.example/oauth/google-callback.html'
    );
  });
});

describe('takeCallback', () => {
  const pending = (overrides: Record<string, unknown> = {}) =>
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        state: 'S1',
        verifier: 'v'.repeat(43),
        returnTo: '',
        createdAt: Date.now(),
        ...overrides
      })
    );
  const answer = (value: Record<string, unknown>) =>
    sessionStorage.setItem(CALLBACK_KEY, JSON.stringify(value));

  it('nothing to take', () => {
    expect(takeCallback()).toEqual({ kind: 'none' });
  });

  it('a code for the flow this tab started, once', () => {
    pending();
    answer({ code: '4/c', state: 'S1', error: null });
    expect(takeCallback()).toEqual({ kind: 'code', code: '4/c', verifier: 'v'.repeat(43) });
    expect(sessionStorage.getItem(CALLBACK_KEY)).toBeNull();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(takeCallback()).toEqual({ kind: 'none' });
  });

  it('refuses a code with no pending flow (a crafted link)', () => {
    answer({ code: '4/c', state: 'S1' });
    expect(takeCallback()).toEqual({ kind: 'refused', reason: 'no_pending' });
  });

  it('refuses another state, and both entries are gone either way', () => {
    pending();
    answer({ code: '4/c', state: 'OTHER' });
    expect(takeCallback()).toEqual({ kind: 'refused', reason: 'state_mismatch' });
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('refuses a stale flow', () => {
    pending({ createdAt: Date.now() - 16 * 60 * 1000 });
    answer({ code: '4/c', state: 'S1' });
    expect(takeCallback()).toEqual({ kind: 'refused', reason: 'expired' });
  });

  it('reports Google’s error (the user cancelled)', () => {
    pending();
    answer({ code: null, state: 'S1', error: 'access_denied' });
    expect(takeCallback()).toEqual({ kind: 'denied', error: 'access_denied' });
  });

  it('refuses junk', () => {
    pending();
    sessionStorage.setItem(CALLBACK_KEY, '{nope');
    expect(takeCallback()).toEqual({ kind: 'refused', reason: 'malformed' });
  });
});

describe('takeCallback: the callback URL an old service worker cached', () => {
  // A worker from before this build caches every same-origin 200 GET by its
  // full URL, until the user accepts the update banner: the redirect back
  // from Google, code and state included, lands in Cache Storage.
  const at = (path: string) => new URL(path, location.origin).href;
  const callbackUrl = at('/oauth/google-callback.html?code=4%2Fx&state=S1');

  function fakeCaches(entries: Record<string, string[]>) {
    const stores = new Map(
      Object.entries(entries).map(([name, urls]) => [name, new Set(urls)] as const)
    );
    const api = {
      keys: vi.fn(async () => [...stores.keys()]),
      open: vi.fn(async (name: string) => {
        const store = stores.get(name)!;
        return {
          keys: async () => [...store].map((url) => new Request(url)),
          delete: async (request: Request) => store.delete(request.url)
        };
      })
    };
    vi.stubGlobal('caches', api);
    return { api, urls: (name: string) => [...stores.get(name)!] };
  }

  const handBack = (value: Record<string, unknown>) => {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ state: 'S1', verifier: 'v'.repeat(43), returnTo: '', createdAt: Date.now() })
    );
    sessionStorage.setItem(CALLBACK_KEY, JSON.stringify(value));
  };

  it('a code handed back: the cached callback entries go, everything else stays', async () => {
    const { urls } = fakeCaches({
      'v-old': [callbackUrl, at('/'), at('/oauth/other.html')],
      'v-older': [at('/oauth/google-callback.html?code=4%2Fy&state=S0'), at('/app.js')]
    });
    handBack({ code: '4/x', state: 'S1', error: null });

    // Handed back at once: the purge never holds up the sign-in.
    expect(takeCallback()).toEqual({ kind: 'code', code: '4/x', verifier: 'v'.repeat(43) });
    await vi.waitFor(() => {
      expect(urls('v-old')).toEqual([at('/')]);
      expect(urls('v-older')).toEqual([at('/app.js')]);
    });
  });

  it('a cancelled sign-in is purged too (its URL carries the state)', async () => {
    const { urls } = fakeCaches({ v: [at('/oauth/google-callback.html?error=x&state=S1')] });
    handBack({ code: null, state: 'S1', error: 'access_denied' });
    expect(takeCallback()).toEqual({ kind: 'denied', error: 'access_denied' });
    await vi.waitFor(() => expect(urls('v')).toEqual([]));
  });

  it('no answer to take: Cache Storage is not even opened', () => {
    const { api } = fakeCaches({ v: [callbackUrl] });
    expect(takeCallback()).toEqual({ kind: 'none' });
    expect(api.keys).not.toHaveBeenCalled();
  });

  // An unhandled rejection from the purge would fail this run (vitest reports it).
  it('Cache Storage missing or failing: the code is still handed back, nothing thrown', async () => {
    const keys = vi.fn(async () => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.stubGlobal('caches', { keys });
    handBack({ code: '4/x', state: 'S1', error: null });
    expect(takeCallback()).toMatchObject({ kind: 'code' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(keys).toHaveBeenCalled();

    vi.stubGlobal('caches', undefined);
    handBack({ code: '4/x', state: 'S1', error: null });
    expect(takeCallback()).toMatchObject({ kind: 'code' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('hasPendingCallback', () => {
  it('only when the callback page left an answer, and only in backend mode', () => {
    expect(hasPendingCallback()).toBe(false);
    // A started sign-in alone (abandoned on Google's page) is not one.
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state: 's' }));
    expect(hasPendingCallback()).toBe(false);
    sessionStorage.setItem(CALLBACK_KEY, JSON.stringify({ code: 'c', state: 's' }));
    expect(hasPendingCallback()).toBe(true);
    markBackendUnavailable();
    expect(hasPendingCallback()).toBe(false);
  });
});
