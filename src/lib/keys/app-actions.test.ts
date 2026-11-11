import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const nav = vi.hoisted(() => ({
  toCatalog: vi.fn(),
  toReadingSpeed: vi.fn(),
  toProgressTracker: vi.fn(),
  toCloud: vi.fn()
}));
const sync = vi.hoisted(() => ({ syncProgress: vi.fn(async () => ({})) }));
const announce = vi.hoisted(() => vi.fn());
const snackbar = vi.hoisted(() => vi.fn());

vi.mock('$lib/util/hash-router', async () => {
  const { writable } = await import('svelte/store');
  return { nav, currentView: writable({ type: 'catalog' }) };
});
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: snackbar }));
vi.mock('./announce', () => ({ announce }));
vi.mock('$lib/util/sync/unified-provider-state', async () => {
  const { writable } = await import('svelte/store');
  return { unifiedProviderState: writable({ hasActiveProvider: false, isReadOnly: false }) };
});
vi.mock('$lib/util/sync/unified-cloud-manager', async () => {
  const { writable } = await import('svelte/store');
  return {
    unifiedCloudManager: { isSyncing: writable(false), syncProgress: sync.syncProgress }
  };
});

import { settingsOpen, uploadModalOpen } from '$lib/settings/settings-open';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { unifiedProviderState } from '$lib/util/sync/unified-provider-state';
import { KEY_ACTIONS } from './actions';
import { appKeyHandlers, canSyncProgress, manualSyncGate, syncProgressNow } from './app-actions';
import type { KeyHandler } from './dispatch';

const providerState = unifiedProviderState as unknown as ReturnType<
  typeof writable<{ hasActiveProvider: boolean; isReadOnly: boolean }>
>;
const isSyncing = unifiedCloudManager.isSyncing as unknown as ReturnType<typeof writable<boolean>>;
const press = (id: keyof typeof appKeyHandlers) =>
  (appKeyHandlers[id] as KeyHandler)({} as KeyboardEvent);

beforeEach(() => {
  vi.clearAllMocks();
  settingsOpen.set(false);
  uploadModalOpen.set(false);
  providerState.set({ hasActiveProvider: false, isReadOnly: false });
  isSyncing.set(false);
});

describe('the shared app handlers', () => {
  it('answers every app action but Back', () => {
    const app = KEY_ACTIONS.filter((a) => a.scope === 'app').map((a) => a.id as string);
    expect(Object.keys(appKeyHandlers).sort()).toEqual(
      app.filter((id) => id !== 'app.back').sort()
    );
  });

  it('Open settings sets the one settings-open flag', () => {
    press('app.settings');
    expect(get(settingsOpen)).toBe(true);
  });

  it('Open upload opens the NavBar dialog; the other four navigate', () => {
    press('app.open-upload');
    expect(get(uploadModalOpen)).toBe(true);
    press('app.open-catalog');
    press('app.open-reading-speed');
    press('app.open-progress-tracker');
    press('app.open-cloud');
    expect(nav.toCatalog).toHaveBeenCalledOnce();
    expect(nav.toReadingSpeed).toHaveBeenCalledOnce();
    expect(nav.toProgressTracker).toHaveBeenCalledOnce();
    expect(nav.toCloud).toHaveBeenCalledOnce();
  });

  it('none of them declines: a bound key never falls through to the browser', () => {
    providerState.set({ hasActiveProvider: true, isReadOnly: false });
    for (const id of Object.keys(appKeyHandlers) as (keyof typeof appKeyHandlers)[]) {
      expect(press(id), id).not.toBe(false);
    }
  });
});

describe('sync progress now', () => {
  it('shows the button with a writable provider only', () => {
    expect(canSyncProgress({ hasActiveProvider: true, isReadOnly: false })).toBe(true);
    expect(canSyncProgress({ hasActiveProvider: false, isReadOnly: false })).toBe(false);
    expect(canSyncProgress({ hasActiveProvider: true, isReadOnly: true })).toBe(false);
  });

  it('the gate is the button: no provider, read-only, mid-sync', () => {
    expect(manualSyncGate({ hasActiveProvider: true, isReadOnly: false }, false)).toEqual({
      run: true
    });
    for (const [state, syncing] of [
      [{ hasActiveProvider: false, isReadOnly: false }, false],
      [{ hasActiveProvider: true, isReadOnly: true }, false],
      [{ hasActiveProvider: true, isReadOnly: false }, true]
    ] as const) {
      const gate = manualSyncGate(state, syncing);
      expect(gate.run).toBe(false);
      if (!gate.run) expect(gate.reason.length).toBeGreaterThan(0);
    }
  });

  it('the key says why when it cannot sync, and syncs nothing', () => {
    press('app.sync');
    expect(sync.syncProgress).not.toHaveBeenCalled();
    expect(announce).toHaveBeenLastCalledWith('Connect cloud storage to sync progress', 'app-sync');

    providerState.set({ hasActiveProvider: true, isReadOnly: true });
    press('app.sync');
    expect(sync.syncProgress).not.toHaveBeenCalled();

    providerState.set({ hasActiveProvider: true, isReadOnly: false });
    isSyncing.set(true);
    press('app.sync');
    expect(sync.syncProgress).not.toHaveBeenCalled();
    expect(announce).toHaveBeenLastCalledWith('Already syncing', 'app-sync');
  });

  it('the key runs the NavBar sync and says so', async () => {
    providerState.set({ hasActiveProvider: true, isReadOnly: false });
    press('app.sync');
    expect(announce).toHaveBeenLastCalledWith('Syncing progress…', 'app-sync');
    await vi.waitFor(() => expect(sync.syncProgress).toHaveBeenCalledOnce());
  });

  it('a failed sync reports once and does not throw', async () => {
    sync.syncProgress.mockRejectedValueOnce(new Error('offline'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(syncProgressNow()).resolves.toBeUndefined();
    expect(snackbar).toHaveBeenCalledWith('Sync failed');
    error.mockRestore();
  });
});
