/**
 * The interop rig's bootstrap: `globalThis.__mokuroInteropConfig` (set by
 * Playwright before any page script runs) is read once when the hooks module
 * initialises, and an injected Google token stands in for Google Identity
 * Services, as an injected OneDrive token already stands in for MSAL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));

/**
 * The sync a re-auth starts (`pendingPostReauthSync`). `rejects`: the API still
 * answers 401, so the listing hits `handleAuthError`, which re-auths again.
 */
const postReauth = vi.hoisted(() => ({ rounds: 0, synced: 0, rejects: true }));
vi.mock('./unified-cloud-manager', () => ({
  unifiedCloudManager: {
    fetchAllCloudVolumes: async () => {
      postReauth.rounds++;
      if (!postReauth.rejects) return;
      const { tokenManager } = await import('./providers/google-drive/token-manager');
      tokenManager.reAuthenticate();
      throw new Error('Authentication expired. Re-authentication in progress...');
    },
    syncProgress: async () => {
      postReauth.synced++;
      return { totalProviders: 1, succeeded: 1, failed: 0, results: [] };
    }
  }
}));

type Global = Record<string, unknown>;

async function freshHooks() {
  vi.resetModules();
  return import('./cloud-test-hooks');
}

afterEach(() => {
  postReauth.rounds = 0;
  postReauth.synced = 0;
  postReauth.rejects = true;
  delete (globalThis as Global).__mokuroInteropConfig;
  delete (globalThis as Global).gapi;
  delete (globalThis as Global).google;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('__mokuroInteropConfig', () => {
  it('sets the bases and tokens once, when the module initialises', async () => {
    (globalThis as Global).__mokuroInteropConfig = {
      v: 1,
      bases: { driveApi: 'http://localhost:9/g', graph: 'http://localhost:9/m' },
      tokens: { google: { access_token: 'g-token', expires_in: 3600 }, onedrive: 'o-token' }
    };
    const hooks = await freshHooks();
    expect(hooks.cloudBase('driveApi', 'https://www.googleapis.com')).toBe('http://localhost:9/g');
    expect(hooks.cloudBase('graph', 'https://graph.microsoft.com/v1.0')).toBe(
      'http://localhost:9/m'
    );
    expect(hooks.cloudBase('megaGateway', 'https://g.api.mega.co.nz/')).toBe(
      'https://g.api.mega.co.nz/'
    );
    expect(hooks.cloudTestToken('google')).toEqual({ access_token: 'g-token', expires_in: 3600 });
    expect(hooks.cloudTestToken('onedrive')).toBe('o-token');

    // Read once: a later change to the global is not picked up.
    (globalThis as Global).__mokuroInteropConfig = { v: 1, tokens: { onedrive: 'other' } };
    expect(hooks.cloudTestToken('onedrive')).toBe('o-token');
  });

  it('ignores a config of another version', async () => {
    (globalThis as Global).__mokuroInteropConfig = {
      v: 2,
      bases: { driveApi: 'http://localhost:9/g' },
      tokens: { onedrive: 'o-token' }
    };
    const hooks = await freshHooks();
    expect(hooks.cloudBase('driveApi', 'fallback')).toBe('fallback');
    expect(hooks.cloudTestToken('onedrive')).toBeNull();
  });

  it('installs the gapi REST shim on the Drive base when asked', async () => {
    (globalThis as Global).__mokuroInteropConfig = {
      v: 1,
      bases: { driveApi: 'http://localhost:9/g' },
      gapiShim: true
    };
    await freshHooks();
    await vi.waitFor(() => expect((globalThis as Global).gapi).toBeDefined());
    const gapi = (globalThis as any).gapi;
    expect(typeof gapi.load).toBe('function');
    expect(typeof gapi.client.drive.files.list).toBe('function');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"files":[]}', { status: 200 }));
    await gapi.client.drive.files.list({ q: 'trashed=false' });
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/^http:\/\/localhost:9\/g\/drive\/v3\/files/);
  });

  it('takes no config at all as no overrides', async () => {
    const hooks = await freshHooks();
    expect(hooks.cloudBase('driveApi', 'fallback')).toBe('fallback');
    expect(hooks.cloudTestToken('google')).toBeNull();
    expect((globalThis as Global).gapi).toBeUndefined();
  });
});

describe('an injected Google token', () => {
  it('stands in for Google Identity Services: the token client hands it out', async () => {
    const hooks = await freshHooks();
    hooks.setCloudTestToken('google', { access_token: 'g-token', expires_in: 3600 });
    const setToken = vi.fn();
    (globalThis as Global).gapi = { client: { setToken } };
    const { tokenManager } = await import('./providers/google-drive/token-manager');

    // No `google` global: the real path would wait 10 s for GIS, then throw.
    const started = Date.now();
    await tokenManager.initTokenClient();
    expect(Date.now() - started).toBeLessThan(1000);

    tokenManager.requestNewToken(true);
    let token = '';
    tokenManager.token.subscribe((t) => (token = t))();
    // As GIS: the answer comes after the request returns, never inside it.
    expect(token).toBe('');
    await vi.waitFor(() => expect(setToken).toHaveBeenCalledWith({ access_token: 'g-token' }));
    tokenManager.token.subscribe((t) => (token = t))();
    expect(token).toBe('g-token');
    expect(tokenManager.isAuthenticated()).toBe(true);
    expect(tokenManager.getTimeUntilExpiry()).toBeGreaterThan(3500 * 1000);
  });

  /** Signed in with an injected token, as the rig's connectDrive does. */
  async function signedIn() {
    const hooks = await freshHooks();
    hooks.setCloudTestToken('google', { access_token: 'g-token', expires_in: 3600 });
    (globalThis as Global).gapi = { client: { setToken: vi.fn() } };
    const { tokenManager } = await import('./providers/google-drive/token-manager');
    await tokenManager.initTokenClient();
    tokenManager.requestNewToken(true);
    await vi.waitFor(() => expect(current(tokenManager.token)).toBe('g-token'));
    return { hooks, tokenManager };
  }

  function current(store: { subscribe: (cb: (v: any) => void) => () => void }) {
    let value: any;
    store.subscribe((v) => (value = v))();
    return value;
  }

  it('a token the API keeps rejecting ends at the banner, not in a re-auth loop', async () => {
    const { tokenManager } = await signedIn();
    // The first 401 (a revoked grant): re-auth, whose sync is refused again.
    tokenManager.reAuthenticate();
    await vi.waitFor(() => expect(current(tokenManager.needsAttention)).toBe(true));
    expect(postReauth.rounds).toBe(1);
    expect(current(tokenManager.token)).toBe('');

    // The grant stays gone: a later re-auth is refused, with no sync (its answer,
    // queued first, runs before this test's own next task).
    tokenManager.reAuthenticate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current(tokenManager.needsAttention)).toBe(true);
    expect(current(tokenManager.token)).toBe('');
    expect(postReauth.rounds).toBe(1);
  });

  it('a one-off 401 re-grants the token, again after each sync that worked', async () => {
    const { tokenManager } = await signedIn();
    postReauth.rejects = false;
    for (const round of [1, 2]) {
      tokenManager.reAuthenticate();
      await vi.waitFor(() => expect(postReauth.synced).toBe(round));
      expect(current(tokenManager.token)).toBe('g-token');
      expect(current(tokenManager.needsAttention)).toBe(false);
    }
  });

  it('a token the rig mints after a revocation signs in again', async () => {
    const { hooks, tokenManager } = await signedIn();
    tokenManager.reAuthenticate();
    await vi.waitFor(() => expect(current(tokenManager.needsAttention)).toBe(true));

    hooks.setCloudTestToken('google', { access_token: 'g-token-2', expires_in: 3600 });
    postReauth.rejects = false;
    tokenManager.requestNewToken(true);
    await vi.waitFor(() => expect(current(tokenManager.token)).toBe('g-token-2'));
    expect(current(tokenManager.needsAttention)).toBe(false);
  });

  it('never calls Google to revoke it on logout', async () => {
    const hooks = await freshHooks();
    hooks.setCloudTestToken('google', { access_token: 'g-token', expires_in: 3600 });
    (globalThis as Global).gapi = { client: { setToken: vi.fn() } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));
    const { tokenManager } = await import('./providers/google-drive/token-manager');
    await tokenManager.initTokenClient();
    tokenManager.requestNewToken(true);
    await vi.waitFor(() => expect(tokenManager.isAuthenticated()).toBe(true));
    await tokenManager.logout();
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining('googleapis.com')
    );
    expect(tokenManager.isAuthenticated()).toBe(false);
  });
});

describe('an injected OneDrive token', () => {
  it('stands in for MSAL: initialize needs no client id and loads no MSAL', async () => {
    const hooks = await freshHooks();
    hooks.setCloudTestToken('onedrive', 'o-token');
    const { onedriveTokenManager } = await import('./providers/onedrive/token-manager');
    await expect(onedriveTokenManager.initialize()).resolves.toBeUndefined();
    expect(onedriveTokenManager.isAuthenticated()).toBe(true);
    await expect(onedriveTokenManager.getAccessToken()).resolves.toBe('o-token');
  });
});
