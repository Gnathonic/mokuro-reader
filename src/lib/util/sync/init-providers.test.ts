/**
 * Startup with Google Drive as the active provider: the session is restored
 * first (the auth backend's sign-in hand-off or silent renewal), then the
 * expiry the token manager reports decides between syncing and re-auth. The
 * popup re-auth runs only in the implicit flow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order = vi.hoisted(() => [] as string[]);
const boot = vi.hoisted(() => ({
  configured: 'google-drive' as string | null,
  callbackPending: false
}));

vi.mock('./provider-detection', () => ({ getConfiguredProviderType: () => boot.configured }));
vi.mock('$lib/util/sync/providers/google-drive/auth-backend', () => ({
  hasPendingCallback: () => boot.callbackPending
}));
vi.mock('./providers/google-drive/google-drive-provider', () => ({
  googleDriveProvider: { type: 'google-drive' }
}));
vi.mock('./provider-manager', () => ({
  providerManager: {
    registerProvider: vi.fn(),
    updateStatus: vi.fn(),
    initializeCurrentProvider: vi.fn(),
    getActiveProvider: vi.fn(() => ({ type: 'google-drive' }))
  }
}));
vi.mock('./unified-cloud-manager', () => ({
  unifiedCloudManager: {
    fetchAllCloudVolumes: vi.fn(async () => order.push('fetch')),
    syncProgress: vi.fn(async () => ({ succeeded: 1, failed: 0 }))
  }
}));
vi.mock('$lib/util/sync/providers/google-drive/api-client', () => ({
  driveApiClient: { initialize: vi.fn(async () => order.push('initialize')) }
}));
vi.mock('$lib/util/sync/providers/google-drive/token-manager', () => ({
  tokenManager: {
    restoreSession: vi.fn(async () => order.push('restoreSession')),
    getTimeUntilExpiry: vi.fn((): number | null => null),
    isBackendMode: vi.fn(() => false),
    reAuthenticate: vi.fn()
  }
}));
vi.mock('$lib/settings/misc', async () => {
  const { writable } = await import('svelte/store');
  return { miscSettings: writable({ gdriveAutoReAuth: true }) };
});
vi.mock('../snackbar', () => ({ showSnackbar: vi.fn() }));

import { initializeProviders } from './init-providers';
import { tokenManager } from '$lib/util/sync/providers/google-drive/token-manager';
import { unifiedCloudManager } from './unified-cloud-manager';

beforeEach(() => {
  order.length = 0;
  boot.configured = 'google-drive';
  boot.callbackPending = false;
  vi.mocked(tokenManager.reAuthenticate).mockClear();
  vi.mocked(unifiedCloudManager.fetchAllCloudVolumes).mockClear();
  vi.mocked(unifiedCloudManager.syncProgress).mockClear();
});

describe('initializeProviders, Google Drive', () => {
  it('restores the session before the API client waits on Google’s scripts', async () => {
    await initializeProviders();
    expect(order.slice(0, 2)).toEqual(['restoreSession', 'initialize']);
  });

  it('a token the backend renews on use (null): loads the listing and syncs', async () => {
    vi.mocked(tokenManager.getTimeUntilExpiry).mockReturnValue(null);
    vi.mocked(tokenManager.isBackendMode).mockReturnValue(true);
    await initializeProviders();
    expect(unifiedCloudManager.fetchAllCloudVolumes).toHaveBeenCalled();
    expect(unifiedCloudManager.syncProgress).toHaveBeenCalled();
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });

  it('implicit flow, token expired: the popup re-auth as before, and no sync', async () => {
    vi.mocked(tokenManager.getTimeUntilExpiry).mockReturnValue(-1000);
    vi.mocked(tokenManager.isBackendMode).mockReturnValue(false);
    await initializeProviders();
    expect(tokenManager.reAuthenticate).toHaveBeenCalledTimes(1);
    expect(unifiedCloudManager.fetchAllCloudVolumes).not.toHaveBeenCalled();
  });

  it('backend session gone: no popup, no redirect at startup — Reconnect waits for a click', async () => {
    vi.mocked(tokenManager.getTimeUntilExpiry).mockReturnValue(-1000);
    vi.mocked(tokenManager.isBackendMode).mockReturnValue(true);
    await initializeProviders();
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(unifiedCloudManager.fetchAllCloudVolumes).not.toHaveBeenCalled();
  });

  it('a failed restore never blocks startup', async () => {
    vi.mocked(tokenManager.restoreSession).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(tokenManager.getTimeUntilExpiry).mockReturnValue(null);
    await initializeProviders();
    expect(order).toContain('initialize');
  });

  it.each([
    ['no provider configured', null],
    ['another provider configured', 'mega']
  ])(
    'a sign-in answer waiting from Google (%s): Drive loads to take it',
    async (_label, configured) => {
      boot.configured = configured;
      boot.callbackPending = true;
      vi.mocked(tokenManager.getTimeUntilExpiry).mockReturnValue(null);
      await initializeProviders();
      expect(order.slice(0, 2)).toEqual(['restoreSession', 'initialize']);
    }
  );

  it('nothing configured and no answer waiting: Drive is not loaded at all', async () => {
    boot.configured = null;
    await initializeProviders();
    expect(order).toEqual([]);
  });
});
