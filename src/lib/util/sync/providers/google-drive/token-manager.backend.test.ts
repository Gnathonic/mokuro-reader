/**
 * The token manager with the auth backend on (`VITE_GDRIVE_AUTH_BACKEND=true`):
 * silent renewal through `/api/gdrive/refresh`, single-flight, adopting another
 * tab's token, the clock retry, what reauth/transient/unavailable each do, the
 * sign-in hand-off at startup and sign-out. And with it off: the implicit flow
 * exactly as it was.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/user-gesture', () => ({ onNextUserGesture: vi.fn(() => () => {}) }));
vi.mock('../../provider-manager', () => ({ providerManager: { updateStatus: vi.fn() } }));
vi.mock('../../unified-cloud-manager', () => ({
  unifiedCloudManager: {
    fetchAllCloudVolumes: vi.fn(async () => {}),
    syncProgress: vi.fn(async () => ({ succeeded: 1 }))
  }
}));

import { checkProof, parseProof } from '$lib/server/gdrive-auth/pop';

const MIN = 60 * 1000;
const KEYS = {
  token: 'gdrive_token',
  expires: 'gdrive_token_expires',
  authed: 'gdrive_has_authenticated'
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const granted = (token: string) => json(200, { access_token: token, expires_in: 3599 });

/** A signed-in browser whose token has `msLeft` to live. */
function persist(token: string, msLeft: number) {
  localStorage.setItem(KEYS.token, token);
  localStorage.setItem(KEYS.expires, String(Date.now() + msLeft));
  localStorage.setItem(KEYS.authed, 'true');
}

/** A fresh manager (it is a module singleton), with its mocks. */
async function load() {
  vi.resetModules();
  const { tokenManager } = await import('./token-manager');
  const { showSnackbar } = await import('$lib/util/snackbar');
  const auth = await import('./auth-backend');
  const device = await import('./device-key');
  const { get } = await import('svelte/store');
  return {
    tm: tokenManager,
    snackbar: vi.mocked(showSnackbar),
    /** Sign-ins started: each leaves a pending flow for this tab, then navigates. */
    signInsStarted: () => (sessionStorage.getItem('gdrive_oauth_pending') ? 1 : 0),
    auth,
    device,
    held: () => get(tokenManager.token),
    attention: () => get(tokenManager.needsAttention)
  };
}

function calls(path: string) {
  return vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === path);
}
function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit).body));
}

let gapiSetToken: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('VITE_GDRIVE_AUTH_BACKEND', 'true');
  vi.stubGlobal('fetch', vi.fn());
  gapiSetToken = vi.fn();
  vi.stubGlobal('gapi', { client: { setToken: gapiSetToken } });
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase('mokuro-device-key');
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
});

describe('getAccessToken', () => {
  it('hands back a token with time left, asking nobody', async () => {
    persist('LIVE', 30 * MIN);
    const { tm } = await load();
    expect(await tm.getAccessToken()).toBe('LIVE');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('renews one with under five minutes left, and stores it as the popup flow did', async () => {
    persist('OLD', 3 * MIN);
    const { tm, held } = await load();
    vi.mocked(fetch).mockResolvedValueOnce(granted('NEW'));
    expect(await tm.getAccessToken()).toBe('NEW');
    expect(calls('/api/gdrive/refresh')).toHaveLength(1);
    expect(held()).toBe('NEW');
    expect(localStorage.getItem(KEYS.token)).toBe('NEW');
    expect(Number(localStorage.getItem(KEYS.expires))).toBeGreaterThan(Date.now() + 50 * MIN);
    expect(gapiSetToken).toHaveBeenCalledWith({ access_token: 'NEW' });
  });

  it('asks for more when the caller needs it (a worker: 15 minutes)', async () => {
    persist('OLD', 10 * MIN);
    const { tm } = await load();
    vi.mocked(fetch).mockResolvedValueOnce(granted('NEW'));
    expect(await tm.getAccessToken()).toBe('OLD');
    expect(await tm.getAccessToken(15 * MIN)).toBe('NEW');
  });

  it('is single-flight: callers at once share one refresh', async () => {
    persist('OLD', -MIN);
    const { tm } = await load();
    let answer!: (r: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise((r) => (answer = r)));
    const all = Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()]);
    await new Promise((r) => setTimeout(r, 0));
    answer(granted('NEW'));
    expect(await all).toEqual(['NEW', 'NEW', 'NEW']);
    expect(calls('/api/gdrive/refresh')).toHaveLength(1);
  });

  it('adopts the token another tab just renewed, instead of renewing again', async () => {
    persist('OLD', 2 * MIN);
    const { tm, held } = await load();
    // The other tab wrote a fresh one into the shared localStorage.
    persist('FROM-OTHER-TAB', 55 * MIN);
    expect(await tm.getAccessToken()).toBe('FROM-OTHER-TAB');
    expect(fetch).not.toHaveBeenCalled();
    expect(held()).toBe('FROM-OTHER-TAB');
    expect(gapiSetToken).toHaveBeenCalledWith({ access_token: 'FROM-OTHER-TAB' });
  });

  it('sends a proof from the device key, and after pop_clock signs again with the server’s time', async () => {
    persist('OLD', -MIN);
    const { tm, device } = await load();
    await device.ensureDeviceKey();
    const serverTime = Date.now() + 30 * MIN;
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(401, { error: 'pop_clock', serverTime }))
      .mockResolvedValueOnce(granted('NEW'));
    expect(await tm.getAccessToken()).toBe('NEW');
    const [first, second] = calls('/api/gdrive/refresh');
    expect(parseProof(bodyOf(first).pop)).not.toBeNull();
    const retried = parseProof(bodyOf(second).pop)!;
    expect(checkProof(retried, location.origin, '/api/gdrive/refresh', serverTime).ok).toBe(true);
  });
});

describe('when the backend cannot renew', () => {
  it.each(['reauth', 'no_session'])(
    '%s: the Reconnect state, and no more attempts until a sign-in',
    async (error) => {
      persist('OLD', -MIN);
      const { tm, attention } = await load();
      vi.mocked(fetch).mockImplementation(async () => json(401, { error }));
      expect(await tm.getAccessToken()).toBe('OLD');
      expect(attention()).toBe(true);
      // The real (expired) time is back, so the navbar shows Reconnect.
      expect(tm.getTimeUntilExpiry()!).toBeLessThanOrEqual(0);
      await tm.getAccessToken();
      await tm.renewRejectedToken('OLD');
      expect(calls('/api/gdrive/refresh')).toHaveLength(1);
      // Still signed in as far as the app goes: the button, not a logout.
      expect(tm.isAuthenticated()).toBe(true);
    }
  );

  it('transient: a token still valid is kept and used; nothing is flagged; backs off', async () => {
    persist('STILL-OK', 3 * MIN);
    const { tm, attention } = await load();
    vi.mocked(fetch).mockImplementation(async () => json(503, { error: 'transient' }));
    expect(await tm.getAccessToken()).toBe('STILL-OK');
    expect(attention()).toBe(false);
    expect(tm.getTimeUntilExpiry()).toBeNull();
    // Inside the backoff: no request.
    await tm.getAccessToken();
    expect(calls('/api/gdrive/refresh')).toHaveLength(1);
  });

  it.each([
    ['server_config', json(503, { error: 'server_config' })],
    [
      'a WAF challenge page',
      new Response('<html>', { status: 403, headers: { 'content-type': 'text/html' } })
    ],
    [
      'a rate limit page',
      new Response('slow down', { status: 429, headers: { 'content-type': 'text/plain' } })
    ],
    ['the network', 'network' as const]
  ])('%s counts as transient, never as a lost session', async (_label, answer) => {
    persist('OLD', -MIN);
    const { tm, attention } = await load();
    if (answer === 'network') vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    else vi.mocked(fetch).mockImplementation(async () => answer.clone());
    await tm.getAccessToken();
    expect(attention()).toBe(false);
    expect(tm.isAuthenticated()).toBe(true);
  });

  it('three transient failures with an expired token offer the popup sign-in instead', async () => {
    persist('OLD', -MIN);
    const { tm, attention, snackbar } = await load();
    const requestAccessToken = vi.fn();
    vi.stubGlobal('google', {
      accounts: { oauth2: { initTokenClient: vi.fn(() => ({ requestAccessToken })) } }
    });
    await tm.initTokenClient();
    vi.mocked(fetch).mockImplementation(async () => json(503, { error: 'transient' }));
    for (let i = 0; i < 3; i++) await tm.refreshFromBackend(true);
    expect(attention()).toBe(true);
    expect(snackbar).toHaveBeenCalledWith(expect.stringContaining('Reconnect'));
    expect(tm.getTimeUntilExpiry()!).toBeLessThanOrEqual(0);

    // Reconnect now opens Google's popup, synchronously inside the click.
    tm.reconnect();
    expect(requestAccessToken).toHaveBeenCalledTimes(1);
  });

  it('offline failures back off but never offer the popup (it could not open offline either)', async () => {
    persist('OLD', -MIN);
    const { tm, attention, snackbar } = await load();
    vi.stubGlobal('google', {
      accounts: { oauth2: { initTokenClient: vi.fn(() => ({ requestAccessToken: vi.fn() })) } }
    });
    await tm.initTokenClient();
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    for (let i = 0; i < 5; i++) await tm.refreshFromBackend(true);
    expect(attention()).toBe(false);
    expect(snackbar).not.toHaveBeenCalled();
    expect(tm.getTimeUntilExpiry()).toBeNull();
    // Still backing off between unforced attempts.
    vi.mocked(fetch).mockClear();
    await tm.getAccessToken();
    expect(fetch).not.toHaveBeenCalled();
    // Connect offline says try again, not "use the popup".
    await expect(tm.connectViaBackend(true)).rejects.toThrow(/unavailable/);
  });

  it('404/405/501/HTML: the popup flow for the rest of this tab', async () => {
    persist('OLD', -MIN);
    const { tm, auth } = await load();
    vi.mocked(fetch).mockResolvedValueOnce(json(501, { error: 'not_configured' }));
    await tm.getAccessToken();
    expect(auth.backendAuthEnabled()).toBe(false);
    expect(tm.isBackendMode()).toBe(false);
    // Back to the implicit flow's expiry, countdown and all.
    expect(tm.getTimeUntilExpiry()!).toBeLessThanOrEqual(0);
    vi.mocked(fetch).mockClear();
    await tm.getAccessToken();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('across tabs', () => {
  it('a sign-in in another tab brings this tab’s dead session back', async () => {
    persist('OLD', -MIN);
    const { tm, attention } = await load();
    vi.mocked(fetch).mockImplementation(async () => json(401, { error: 'reauth' }));
    await tm.getAccessToken();
    expect(attention()).toBe(true);
    expect(tm.getTimeUntilExpiry()).not.toBeNull();

    // The other tab signed in again: a new cookie (shared) and a new token.
    persist('FROM-OTHER-TAB', 3 * MIN);
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockResolvedValueOnce(granted('RENEWED-HERE'));
    // Under five minutes left: adopted, and renewed through the session again.
    expect(await tm.getAccessToken()).toBe('RENEWED-HERE');
    expect(attention()).toBe(false);
    expect(tm.getTimeUntilExpiry()).toBeNull();
  });
});

describe('a burst of refusals while the backend is down', () => {
  it('asks the backend once, then waits out the backoff', async () => {
    persist('OLD', 30 * MIN);
    const { tm } = await load();
    vi.mocked(fetch).mockImplementation(async () => json(503, { error: 'transient' }));
    expect(await tm.renewRejectedToken('OLD')).toEqual({ kind: 'transient' });
    expect(await tm.renewRejectedToken('OLD')).toEqual({ kind: 'transient' });
    expect(await tm.renewRejectedToken('OLD')).toEqual({ kind: 'transient' });
    expect(calls('/api/gdrive/refresh')).toHaveLength(1);
    // A click to reconnect is not held back by it.
    await tm.refreshFromBackend(true);
    expect(calls('/api/gdrive/refresh')).toHaveLength(2);
  });
});

describe('the hourly countdown is gone', () => {
  it('getTimeUntilExpiry is null while the session can renew, even past expiry', async () => {
    persist('OLD', -5 * MIN);
    const { tm, attention } = await load();
    expect(tm.getTimeUntilExpiry()).toBeNull();
    expect(tm.getExpiryMinutes()).toBeNull();
    // An expired token at startup is not a reason for attention here.
    expect(attention()).toBe(false);
  });
});

describe('renewRejectedToken (a 401 from Drive)', () => {
  it('renews the rejected token through the backend', async () => {
    persist('OLD', 30 * MIN);
    const { tm } = await load();
    vi.mocked(fetch).mockResolvedValueOnce(granted('NEW'));
    expect(await tm.renewRejectedToken('OLD')).toEqual({ kind: 'renewed', token: 'NEW' });
  });

  it('a token someone already replaced comes back as it is, with no request', async () => {
    persist('NEWER', 30 * MIN);
    const { tm } = await load();
    expect(await tm.renewRejectedToken('OLD')).toEqual({ kind: 'renewed', token: 'NEWER' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('transient when the backend is down', async () => {
    persist('OLD', 30 * MIN);
    const { tm } = await load();
    vi.mocked(fetch).mockResolvedValueOnce(json(503, { error: 'transient' }));
    expect(await tm.renewRejectedToken('OLD')).toEqual({ kind: 'transient' });
  });
});

describe('startup (restoreSession)', () => {
  function signInPending(state = 'S1') {
    sessionStorage.setItem(
      'gdrive_oauth_pending',
      JSON.stringify({
        state,
        verifier: 'v'.repeat(43),
        returnTo: '#/cloud',
        createdAt: Date.now()
      })
    );
  }
  function callbackArrived(state = 'S1') {
    sessionStorage.setItem(
      'gdrive_oauth_callback',
      JSON.stringify({ code: '4/code', state, error: null })
    );
  }

  it('redeems the code the callback brought back, with a proof, and is signed in', async () => {
    const { tm, held, device } = await load();
    await device.ensureDeviceKey();
    signInPending();
    callbackArrived();
    vi.mocked(fetch).mockResolvedValueOnce(granted('FIRST'));
    await tm.restoreSession();

    const [call] = calls('/api/gdrive/session');
    const body = bodyOf(call);
    expect(body).toMatchObject({ code: '4/code', code_verifier: 'v'.repeat(43) });
    expect(
      checkProof(parseProof(body.pop)!, location.origin, '/api/gdrive/session', Date.now()).ok
    ).toBe(true);
    expect(held()).toBe('FIRST');
    expect(localStorage.getItem(KEYS.token)).toBe('FIRST');
    expect(localStorage.getItem(KEYS.authed)).toBe('true');
    expect(localStorage.getItem('active_cloud_provider')).toBe('google-drive');
    expect(tm.isAuthenticated()).toBe(true);

    // One use: the next start finds nothing to redeem.
    vi.mocked(fetch).mockClear();
    await tm.restoreSession();
    expect(calls('/api/gdrive/session')).toHaveLength(0);
  });

  it('refuses a code no flow of this tab asked for, quietly (nothing of ours to retry)', async () => {
    const { tm, snackbar } = await load();
    callbackArrived();
    await tm.restoreSession();
    expect(fetch).not.toHaveBeenCalled();
    expect(tm.isAuthenticated()).toBe(false);
    expect(snackbar).not.toHaveBeenCalled();
  });

  it('refuses a code whose state is not the pending flow’s, and says the sign-in did not finish', async () => {
    const { tm, snackbar } = await load();
    signInPending('S1');
    callbackArrived('S2');
    await tm.restoreSession();
    expect(fetch).not.toHaveBeenCalled();
    expect(snackbar).toHaveBeenCalledWith(
      'Google Drive sign-in did not finish. Click Connect to try again.'
    );
  });

  it('a sign-in that took too long on Google’s screens says so too', async () => {
    const { tm, snackbar } = await load();
    sessionStorage.setItem(
      'gdrive_oauth_pending',
      JSON.stringify({ state: 'S1', verifier: 'v'.repeat(43), createdAt: Date.now() - 16 * MIN })
    );
    callbackArrived('S1');
    await tm.restoreSession();
    expect(fetch).not.toHaveBeenCalled();
    expect(snackbar).toHaveBeenCalledWith(expect.stringContaining('did not finish'));
  });

  it('a cancelled sign-in says so and redeems nothing', async () => {
    const { tm, snackbar } = await load();
    signInPending();
    sessionStorage.setItem(
      'gdrive_oauth_callback',
      JSON.stringify({ code: null, state: 'S1', error: 'access_denied' })
    );
    await tm.restoreSession();
    expect(fetch).not.toHaveBeenCalled();
    expect(snackbar).toHaveBeenCalledWith('Google Drive sign-in was cancelled.');
  });

  it('renews an expired token silently, and leaves a live one alone', async () => {
    persist('OLD', -MIN);
    const first = await load();
    vi.mocked(fetch).mockResolvedValueOnce(granted('NEW'));
    await first.tm.restoreSession();
    expect(first.held()).toBe('NEW');

    vi.mocked(fetch).mockClear();
    persist('LIVE', 40 * MIN);
    const second = await load();
    await second.tm.restoreSession();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('re-auth and reconnect', () => {
  it('reAuthenticate (automatic callers) renews silently: no popup, no redirect', async () => {
    persist('OLD', -MIN);
    const { tm, held, signInsStarted } = await load();
    const requestAccessToken = vi.fn();
    vi.stubGlobal('google', {
      accounts: { oauth2: { initTokenClient: vi.fn(() => ({ requestAccessToken })) } }
    });
    await tm.initTokenClient();
    vi.mocked(fetch).mockResolvedValueOnce(granted('NEW'));
    tm.reAuthenticate();
    await vi.waitFor(() => expect(held()).toBe('NEW'));
    expect(requestAccessToken).not.toHaveBeenCalled();
    expect(signInsStarted()).toBe(0);
  });

  it('reAuthenticate never signs in, even with the session gone', async () => {
    persist('OLD', -MIN);
    const { tm, signInsStarted, attention } = await load();
    vi.mocked(fetch).mockImplementation(async () => json(401, { error: 'reauth' }));
    tm.reAuthenticate();
    await vi.waitFor(() => expect(attention()).toBe(true));
    expect(signInsStarted()).toBe(0);
  });

  it('reconnect (a click) starts the full-page sign-in once the session is gone', async () => {
    persist('OLD', -MIN);
    const { tm, signInsStarted } = await load();
    vi.mocked(fetch).mockImplementation(async () => json(401, { error: 'reauth' }));
    await tm.getAccessToken();
    tm.reconnect();
    await vi.waitFor(() => expect(signInsStarted()).toBe(1));
    // The provider is not switched before leaving: a sign-in abandoned on
    // Google's page leaves the app as it was. The callback's answer is what
    // brings the next boot back to Drive (`hasPendingCallback`).
    expect(localStorage.getItem('active_cloud_provider')).toBeNull();
  });

  it('reconnect on a session this tab found dead tries it once more before any sign-in', async () => {
    persist('OLD', -MIN);
    const { tm, held, signInsStarted, attention } = await load();
    // A bound cookie whose proof failed once (an IndexedDB hiccup): the
    // server kept the cookie, and the next proof works.
    vi.mocked(fetch).mockResolvedValueOnce(json(401, { error: 'reauth' }));
    await tm.getAccessToken();
    expect(attention()).toBe(true);

    vi.mocked(fetch).mockResolvedValueOnce(granted('NEW'));
    tm.reconnect();
    await vi.waitFor(() => expect(held()).toBe('NEW'));
    expect(signInsStarted()).toBe(0);
    expect(attention()).toBe(false);
  });

  it('reconnect tries the session first, and a live one needs no sign-in', async () => {
    persist('OLD', -MIN);
    const { tm, held, signInsStarted } = await load();
    vi.mocked(fetch).mockResolvedValueOnce(granted('NEW'));
    tm.reconnect();
    await vi.waitFor(() => expect(held()).toBe('NEW'));
    expect(signInsStarted()).toBe(0);
  });

  it('connectViaBackend: a live cookie connects without consent; none needs a click', async () => {
    const { tm, signInsStarted } = await load();
    vi.mocked(fetch).mockResolvedValueOnce(granted('NEW'));
    expect(await tm.connectViaBackend(true)).toBe('connected');

    vi.mocked(fetch).mockImplementation(async () => json(401, { error: 'no_session' }));
    await expect(tm.connectViaBackend(false)).rejects.toThrow(/cloud page/);
    expect(signInsStarted()).toBe(0);
    expect(await tm.connectViaBackend(true)).toBe('redirecting');
    expect(signInsStarted()).toBe(1);
  });
});

describe('logout', () => {
  it('asks the server to revoke and clear the cookie, then clears this device', async () => {
    persist('LIVE', 30 * MIN);
    const { tm, held } = await load();
    vi.mocked(fetch).mockResolvedValueOnce(json(200, { ok: true, revoked: true }));
    await tm.logout();
    expect(calls('/api/gdrive/logout')).toHaveLength(1);
    expect(held()).toBe('');
    expect(localStorage.getItem(KEYS.token)).toBeNull();
    expect(localStorage.getItem(KEYS.expires)).toBeNull();
    expect(localStorage.getItem(KEYS.authed)).toBeNull();
    expect(gapiSetToken).toHaveBeenLastCalledWith(null);
    // Revoked server-side: no second revoke from here.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a failed request still signs this device out, and revokes the grant from here', async () => {
    persist('LIVE', 30 * MIN);
    const { tm, held } = await load();
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    await tm.logout();
    expect(held()).toBe('');
    expect(localStorage.getItem(KEYS.token)).toBeNull();
    expect(gapiSetToken).toHaveBeenLastCalledWith(null);
    const revoke = vi.mocked(fetch).mock.calls[1];
    expect(String(revoke[0])).toBe('https://oauth2.googleapis.com/revoke');
    // The token in the body, not the URL.
    expect(String((revoke[1] as RequestInit).body)).toBe('token=LIVE');
  });

  it('the server cleared the cookie but revoked nothing: the grant is revoked from here', async () => {
    // Google's revoke timed out server-side, or the cookie was sealed under a
    // retired key, or there was none (a popup-fallback token).
    persist('LIVE', 30 * MIN);
    const { tm } = await load();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(200, { ok: true, revoked: false }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    await tm.logout();
    const revoke = vi.mocked(fetch).mock.calls[1];
    expect(String(revoke[0])).toBe('https://oauth2.googleapis.com/revoke');
    expect((revoke[1] as RequestInit).method).toBe('POST');
    expect(String((revoke[1] as RequestInit).body)).toBe('token=LIVE');
    // The cookie is gone: nothing left to finish.
    expect(localStorage.getItem('gdrive_logout_pending')).toBeNull();
  });

  it('offline: neither got through, so no silent refresh may use the cookie until a sign-out does', async () => {
    persist('LIVE', 30 * MIN);
    const { tm, signInsStarted } = await load();
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    await tm.logout();
    expect(tm.isAuthenticated()).toBe(false);
    expect(localStorage.getItem('gdrive_logout_pending')).toBe('1');

    // Still offline at the next Connect: no refresh goes out.
    vi.mocked(fetch).mockClear();
    await expect(tm.connectViaBackend(true)).rejects.toThrow(/unavailable/);
    expect(calls('/api/gdrive/refresh')).toHaveLength(0);
    expect(calls('/api/gdrive/logout')).toHaveLength(1);

    // Back online (someone else at the machine clicks Connect): the sign-out
    // finishes FIRST, so the old account's cookie cannot sign anyone in.
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url) === '/api/gdrive/logout'
        ? json(200, { ok: true, revoked: true })
        : json(401, { error: 'no_session' })
    );
    expect(await tm.connectViaBackend(true)).toBe('redirecting');
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      '/api/gdrive/logout',
      '/api/gdrive/refresh'
    ]);
    expect(localStorage.getItem('gdrive_logout_pending')).toBeNull();
    expect(signInsStarted()).toBe(1);
  });

  it('a pending sign-out is finished before a returning sign-in sets its cookie, never after', async () => {
    localStorage.setItem('gdrive_logout_pending', '1');
    const { tm, held } = await load();
    sessionStorage.setItem(
      'gdrive_oauth_pending',
      JSON.stringify({ state: 'S1', verifier: 'v'.repeat(43), createdAt: Date.now() })
    );
    sessionStorage.setItem(
      'gdrive_oauth_callback',
      JSON.stringify({ code: '4/code', state: 'S1', error: null })
    );
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url) === '/api/gdrive/logout'
        ? json(200, { ok: true, revoked: false })
        : granted('FIRST')
    );
    await tm.restoreSession();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      '/api/gdrive/logout',
      '/api/gdrive/session'
    ]);
    expect(held()).toBe('FIRST');
    expect(localStorage.getItem('gdrive_logout_pending')).toBeNull();
  });

  it('even a throwing fetch cannot keep the token on this device', async () => {
    persist('LIVE', 30 * MIN);
    const { tm, held } = await load();
    vi.mocked(fetch).mockImplementation(() => {
      throw new Error('boom');
    });
    await tm.logout();
    expect(held()).toBe('');
    expect(localStorage.getItem(KEYS.token)).toBeNull();
  });
});

describe('with the flag unset: the implicit flow, exactly as before', () => {
  beforeEach(() => vi.stubEnv('VITE_GDRIVE_AUTH_BACKEND', ''));

  it('never talks to the backend, and keeps the hourly expiry', async () => {
    persist('OLD', -MIN);
    const { tm, attention } = await load();
    expect(await tm.getAccessToken()).toBe('OLD');
    expect(await tm.renewRejectedToken('OLD')).toEqual({ kind: 'failed' });
    await tm.restoreSession();
    expect(fetch).not.toHaveBeenCalled();
    expect(tm.getTimeUntilExpiry()!).toBeLessThanOrEqual(0);
    expect(attention()).toBe(true);
  });

  it('reconnect is the popup re-auth it always was', async () => {
    persist('OLD', -MIN);
    const { tm } = await load();
    const requestAccessToken = vi.fn();
    vi.stubGlobal('google', {
      accounts: { oauth2: { initTokenClient: vi.fn(() => ({ requestAccessToken })) } }
    });
    await tm.initTokenClient();
    tm.reconnect();
    expect(requestAccessToken).toHaveBeenCalledWith({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('logout revokes as before (no backend call)', async () => {
    persist('LIVE', 30 * MIN);
    const { tm } = await load();
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 200 }));
    await tm.logout();
    expect(calls('/api/gdrive/logout')).toHaveLength(0);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
      'https://oauth2.googleapis.com/revoke?token=LIVE'
    );
  });
});
