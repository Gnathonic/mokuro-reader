/**
 * The token client comes from Google Identity Services, which is no longer a
 * `<script>` in app.html: `initTokenClient` joins (or starts) the on-demand
 * load before it asks GIS for a client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./google-scripts', () => ({ loadGoogleScripts: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/user-gesture', () => ({ onNextUserGesture: vi.fn(() => () => {}) }));
vi.mock('../../provider-manager', () => ({ providerManager: { updateStatus: vi.fn() } }));

import { loadGoogleScripts } from './google-scripts';
import { tokenManager } from './token-manager';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(loadGoogleScripts).mockReset();
});

describe('tokenManager.initTokenClient', () => {
  it('loads GIS on demand, then builds the token client from it', async () => {
    const client = { requestAccessToken: vi.fn() };
    const initTokenClient = vi.fn(() => client);
    vi.mocked(loadGoogleScripts).mockImplementation(async () => {
      vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient } } });
    });

    await tokenManager.initTokenClient();

    expect(loadGoogleScripts).toHaveBeenCalledTimes(1);
    expect(initTokenClient).toHaveBeenCalledWith(
      expect.objectContaining({ callback: expect.any(Function) })
    );
  });

  it('does not load anything when GIS is already on the page', async () => {
    const initTokenClient = vi.fn(() => ({ requestAccessToken: vi.fn() }));
    vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient } } });

    await tokenManager.initTokenClient();

    expect(loadGoogleScripts).not.toHaveBeenCalled();
    expect(initTokenClient).toHaveBeenCalled();
  });
});
