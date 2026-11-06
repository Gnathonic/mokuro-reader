/**
 * The token client comes from Google Identity Services, which is no longer a
 * `<script>` in app.html: `initTokenClient` joins (or starts) the on-demand
 * load of GIS before it asks GIS for a client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./google-scripts', () => ({ loadGisScript: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/user-gesture', () => ({ onNextUserGesture: vi.fn(() => () => {}) }));
vi.mock('../../provider-manager', () => ({ providerManager: { updateStatus: vi.fn() } }));

import { loadGisScript } from './google-scripts';
import { tokenManager } from './token-manager';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(loadGisScript).mockReset();
});

describe('tokenManager.initTokenClient', () => {
  it('loads GIS on demand, then builds the token client from it', async () => {
    const client = { requestAccessToken: vi.fn() };
    const initTokenClient = vi.fn(() => client);
    vi.mocked(loadGisScript).mockImplementation(async () => {
      vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient } } });
    });

    await tokenManager.initTokenClient();

    expect(loadGisScript).toHaveBeenCalledTimes(1);
    expect(initTokenClient).toHaveBeenCalledWith(
      expect.objectContaining({ callback: expect.any(Function) })
    );
  });

  it('does not load anything when GIS is already on the page', async () => {
    const initTokenClient = vi.fn(() => ({ requestAccessToken: vi.fn() }));
    vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient } } });

    await tokenManager.initTokenClient();

    expect(loadGisScript).not.toHaveBeenCalled();
    expect(initTokenClient).toHaveBeenCalled();
  });
});

describe('tokenManager.initTokenClient with the auth backend', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('GIS failing to load leaves no token client and does not throw (it is only the popup fallback)', async () => {
    vi.stubEnv('VITE_GDRIVE_AUTH_BACKEND', 'true');
    vi.resetModules();
    const { loadGisScript: load } = await import('./google-scripts');
    vi.mocked(load).mockRejectedValue(
      new Error('Failed to load https://accounts.google.com/gsi/client')
    );
    const { tokenManager: tm } = await import('./token-manager');

    await expect(tm.initTokenClient()).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
    // No client: the popup fallback is simply never offered.
    expect((tm as unknown as { hasTokenClient(): boolean }).hasTokenClient()).toBe(false);
  });

  it('implicit mode still fails: there GIS is the only way to a token', async () => {
    vi.resetModules();
    const { loadGisScript: load } = await import('./google-scripts');
    vi.mocked(load).mockRejectedValue(
      new Error('Failed to load https://accounts.google.com/gsi/client')
    );
    const { tokenManager: tm } = await import('./token-manager');

    await expect(tm.initTokenClient()).rejects.toThrow('Failed to load');
  });
});
