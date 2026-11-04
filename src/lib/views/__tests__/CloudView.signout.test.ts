/**
 * Google Drive's two sign-outs on the cloud screen. "Log out" signs out THIS
 * device only (no revoke: other devices and a mokuro-bunko server may share
 * the Google grant). "Sign out everywhere…" opens a confirmation, and only its
 * confirm button asks for `{ everywhere: true }`.
 *
 * The screen is rendered with its services stubbed: the provider manager is
 * a store saying Drive is connected, and everything the connected column
 * would fetch answers empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({
  logout: vi.fn(async (_options?: { everywhere?: boolean }) => {}),
  showSnackbar: vi.fn()
}));

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));
vi.mock('$lib/util', () => ({
  promptConfirmation: vi.fn(),
  showSnackbar: mocks.showSnackbar,
  showWebDAVError: vi.fn()
}));
vi.mock('$lib/util/sync', async () => {
  const { writable } = await import('svelte/store');
  return {
    providerManager: {
      // Set per test (`connectedTo`).
      status: writable({ currentProviderType: null, providers: {} }),
      logout: mocks.logout,
      getActiveProvider: () => ({ getStorageQuota: async () => null }),
      getProviderInstance: () => undefined,
      getOrLoadProvider: vi.fn(),
      setCurrentProvider: vi.fn(),
      updateStatus: vi.fn()
    }
  };
});
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    fetchAllCloudVolumes: vi.fn(async () => {}),
    syncProgress: vi.fn(async () => ({ succeeded: 0 })),
    getCloudVolume: vi.fn()
  }
}));
vi.mock('$lib/util/sync/cache-manager', async () => {
  const { writable } = await import('svelte/store');
  return { cacheManager: { isFetchingState: writable(false) } };
});
vi.mock('$lib/catalog', async () => {
  const { writable } = await import('svelte/store');
  return { catalog: writable([]) };
});
vi.mock('$lib/catalog/volume-state', () => ({ isVolumeInstalled: () => true }));
vi.mock('$lib/util/backup-queue', () => ({
  backupQueue: { queueSeriesVolumesForBackup: vi.fn() }
}));
vi.mock('$lib/util/download-queue', () => ({ queueVolumesFromCloudFiles: vi.fn() }));
vi.mock('$lib/metadata/series-file-sync', () => ({ reconcileMissingMetadataFiles: vi.fn() }));
vi.mock('$lib/util/sync/providers/filesystem/feature-detect', () => ({
  isFilesystemProviderSupported: () => false
}));
vi.mock('$lib/util/sync/providers/google-drive/auth-backend', () => ({
  backendAuthEnabled: () => true
}));
vi.mock('$lib/components/Devices/DevicesSettings.svelte', () => ({ default: () => {} }));

import CloudView from '../CloudView.svelte';
import { providerManager } from '$lib/util/sync';
import type { Writable } from 'svelte/store';

const connected = {
  isAuthenticated: true,
  hasStoredCredentials: true,
  needsAttention: false,
  statusMessage: 'Connected',
  isReadOnly: false
};
function connectedTo(type: string) {
  (providerManager.status as unknown as Writable<unknown>).set({
    currentProviderType: type,
    providers: { [type]: connected }
  });
}

beforeEach(() => {
  connectedTo('google-drive');
  mocks.logout.mockClear();
  mocks.showSnackbar.mockClear();
  // The view clears the service worker's download cache on mount.
  vi.stubGlobal('caches', { keys: async () => [], delete: async () => true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const everywhereButton = () => screen.getByRole('button', { name: 'Sign out everywhere…' });
const modalConfirm = () => screen.queryByRole('button', { name: 'Sign out everywhere' });

describe('Google Drive sign-out on the cloud screen', () => {
  it('"Log out" signs out this device only, and says so', async () => {
    render(CloudView);
    await fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
    expect(mocks.logout.mock.calls[0][0]?.everywhere).not.toBe(true);
    expect(mocks.showSnackbar).toHaveBeenCalledWith('Logged out of Google Drive on this device');
  });

  it('"Sign out everywhere…" asks first; Cancel signs nothing out', async () => {
    render(CloudView);
    expect(modalConfirm()).toBeNull();
    await fireEvent.click(everywhereButton());
    await waitFor(() => expect(modalConfirm()).not.toBeNull());
    expect(screen.getByText(/on every device and browser where you use it/)).toBeTruthy();
    expect(screen.getByText(/any mokuro-bunko server signed in to the same Google/)).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(modalConfirm()).toBeNull());
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.showSnackbar).not.toHaveBeenCalled();
  });

  it('confirming signs out everywhere, and says so', async () => {
    render(CloudView);
    await fireEvent.click(everywhereButton());
    await waitFor(() => expect(modalConfirm()).not.toBeNull());
    await fireEvent.click(modalConfirm()!);
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledWith({ everywhere: true }));
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.showSnackbar).toHaveBeenCalledWith('Signed out of Google Drive everywhere');
  });

  it('the action buttons sit above the dialog’s stacking context (night mode)', async () => {
    render(CloudView);
    await fireEvent.click(everywhereButton());
    await waitFor(() => expect(modalConfirm()).not.toBeNull());
    const container = modalConfirm()!.parentElement!;
    expect(container.className).toContain('relative');
    expect(container.className).toContain('z-10');
  });

  it('is Drive’s alone: another provider’s Log out is unchanged and offers no "everywhere"', async () => {
    connectedTo('mega');
    render(CloudView);
    expect(screen.queryByRole('button', { name: 'Sign out everywhere…' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
    expect(mocks.logout.mock.calls[0][0]).toBeUndefined();
    expect(mocks.showSnackbar).toHaveBeenCalledWith('Logged out of MEGA');
  });
});
