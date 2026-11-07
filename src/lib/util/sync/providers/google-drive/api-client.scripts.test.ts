/**
 * `driveApiClient.initialize()` no longer waits for a `<script>` in app.html:
 * it joins (or starts) the on-demand load of gapi — gapi's alone, so a GIS
 * failure never fails the Drive client — then runs gapi's loader as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./google-scripts', () => ({ loadGapiScript: vi.fn() }));
vi.mock('./token-manager', () => ({
  tokenManager: {
    isAuthenticated: vi.fn(() => true),
    reAuthenticate: vi.fn(),
    clearToken: vi.fn(),
    initTokenClient: vi.fn(async () => {}),
    token: { subscribe: (cb: (v: string) => void) => (cb('TOKEN'), () => {}) }
  }
}));
vi.mock('$lib/settings/misc', async () => {
  const { writable } = await import('svelte/store');
  return { miscSettings: writable({ gdriveAutoReAuth: true }) };
});
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

import { driveApiClient } from './api-client';
import { loadGapiScript } from './google-scripts';
import { tokenManager } from './token-manager';

/** What api.js puts on the page: `gapi.load` and, once loaded, `gapi.client`. */
function fakeGapi() {
  const init = vi.fn(async () => {});
  const load = vi.fn((_modules: string, done: () => void) => done());
  return { gapi: { load, client: { init } }, load, init };
}

afterEach(() => {
  delete (globalThis as { gapi?: unknown }).gapi;
  vi.mocked(loadGapiScript).mockReset();
});

describe('driveApiClient.initialize', () => {
  it('loads the Google scripts on demand when gapi is not on the page yet', async () => {
    const { gapi, load, init } = fakeGapi();
    // The injected script runs: gapi appears.
    vi.mocked(loadGapiScript).mockImplementation(async () => {
      (globalThis as { gapi?: unknown }).gapi = gapi;
    });

    await driveApiClient.initialize();

    expect(loadGapiScript).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('client:picker', expect.any(Function));
    expect(init).toHaveBeenCalled();
    expect(tokenManager.initTokenClient).toHaveBeenCalled();
  });

  it('reports a script that failed to load instead of waiting out a timeout', async () => {
    // A fresh client: the one above is initialized.
    vi.resetModules();
    const { driveApiClient: fresh } = await import('./api-client');
    const { loadGapiScript: load } = await import('./google-scripts');
    vi.mocked(load).mockRejectedValue(
      new Error('Failed to load https://apis.google.com/js/api.js')
    );

    await expect(fresh.initialize()).rejects.toThrow('Failed to load');
  });
});
