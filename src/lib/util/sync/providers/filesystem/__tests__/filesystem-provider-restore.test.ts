import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Restore tests exercise the real constructor path (browser + supported API),
// unlike filesystem-provider.test.ts which pins browser:false to skip it.
vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('../feature-detect', () => ({
  isFilesystemProviderSupported: vi.fn(() => true)
}));

vi.mock('../handle-store', () => ({
  loadRootHandle: vi.fn(),
  saveRootHandle: vi.fn(),
  clearRootHandle: vi.fn(async () => {})
}));

vi.mock('../../../provider-detection', () => ({
  setActiveProviderKey: vi.fn(),
  clearActiveProviderKey: vi.fn()
}));

import { FilesystemProvider } from '../filesystem-provider';
import { loadRootHandle, clearRootHandle } from '../handle-store';
import type { SyncProvider } from '../../../provider-interface';
import {
  cloudBunkoStatus,
  refreshCloudBunkoMarker,
  resetCloudBunkoMarkersForTest
} from '$lib/catalog/cloud-bunko-marker';
import { servedMarker } from '$lib/catalog/__fixtures__/bunko-marker';
import { clearActiveProviderKey } from '../../../provider-detection';

describe('FilesystemProvider.restoreHandle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears a stored handle whose queryPermission throws (folder deleted/moved)', async () => {
    const brokenError = new Error('The object is in an invalid state');
    brokenError.name = 'InvalidStateError';
    const broken = {
      name: 'gone',
      queryPermission: vi.fn().mockRejectedValue(brokenError)
    };
    vi.mocked(loadRootHandle).mockResolvedValue(broken as unknown as FileSystemDirectoryHandle);

    const provider = new FilesystemProvider();
    await provider.whenReady();

    expect(clearRootHandle).toHaveBeenCalled();
    expect(clearActiveProviderKey).toHaveBeenCalled();
    expect(provider.getStatus().hasStoredCredentials).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
  });

  it('keeps config when the IndexedDB read itself fails (transient)', async () => {
    vi.mocked(loadRootHandle).mockRejectedValue(new Error('idb unavailable'));

    const provider = new FilesystemProvider();
    await provider.whenReady();

    expect(clearRootHandle).not.toHaveBeenCalled();
  });

  it('restores the handle when permission is still granted', async () => {
    const good = {
      name: 'manga',
      queryPermission: vi.fn().mockResolvedValue('granted')
    };
    vi.mocked(loadRootHandle).mockResolvedValue(good as unknown as FileSystemDirectoryHandle);

    const provider = new FilesystemProvider();
    await provider.whenReady();

    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.getStatus().statusMessage).toContain('manga');
  });

  it('leaves the reconnect state when permission is "prompt"', async () => {
    const prompt = {
      name: 'manga',
      queryPermission: vi.fn().mockResolvedValue('prompt')
    };
    vi.mocked(loadRootHandle).mockResolvedValue(prompt as unknown as FileSystemDirectoryHandle);

    const provider = new FilesystemProvider();
    await provider.whenReady();

    expect(provider.isAuthenticated()).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(true);
    expect(clearRootHandle).not.toHaveBeenCalled();
  });
});

/**
 * The Bunko marker read from a Local Folder belongs to THAT folder: picking
 * another folder, or signing out, forgets it (the poller reads it again from
 * scratch); picking the same folder again keeps it.
 */
describe('FilesystemProvider: the Bunko marker follows the folder', () => {
  /** A picked folder: `isSameEntry` compares the `id` both handles carry. */
  function folder(id: string, name = id) {
    const handle = {
      id,
      name,
      kind: 'directory',
      requestPermission: vi.fn(async () => 'granted'),
      queryPermission: vi.fn(async () => 'granted'),
      isSameEntry: vi.fn(async (other: { id?: string }) => other.id === id)
    };
    return handle as unknown as FileSystemDirectoryHandle;
  }

  async function connectedTo(handle: FileSystemDirectoryHandle) {
    vi.mocked(loadRootHandle).mockResolvedValue(handle);
    const provider = new FilesystemProvider();
    await provider.whenReady();
    expect(provider.isAuthenticated()).toBe(true);
    return provider;
  }

  async function recordFreshMarker() {
    const body = new Blob([JSON.stringify(servedMarker(Date.now()))]);
    const stub = {
      type: 'filesystem',
      readControlFile: vi.fn(async () => ({
        etag: 'm=1',
        nodes: [{ id: '.mokuro-bunko.json', etag: '1', blob: body }]
      }))
    } as unknown as SyncProvider;
    expect(await refreshCloudBunkoMarker(stub)).toBe(true);
    expect(cloudBunkoStatus('filesystem')?.fresh).toBe(true);
  }

  function pickNext(handle: FileSystemDirectoryHandle) {
    (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker =
      vi.fn(async () => handle);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetCloudBunkoMarkersForTest();
  });

  afterEach(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it('picking another folder forgets the old folder’s marker', async () => {
    const provider = await connectedTo(folder('a'));
    await recordFreshMarker();
    expect(provider.getStatus().serverCompilesMetadata).toBe(true);

    pickNext(folder('b'));
    await provider.login();

    expect(cloudBunkoStatus('filesystem')).toBeUndefined();
    expect(provider.getStatus().serverCompilesMetadata).toBe(false);
  });

  it('picking the same folder again keeps it', async () => {
    const provider = await connectedTo(folder('a'));
    await recordFreshMarker();

    pickNext(folder('a'));
    await provider.login();

    expect(cloudBunkoStatus('filesystem')?.fresh).toBe(true);
    expect(provider.getStatus().serverCompilesMetadata).toBe(true);
  });

  it('a stored folder waiting for a reconnect counts as the previous one', async () => {
    const stored = folder('a');
    (stored as unknown as { queryPermission: () => Promise<string> }).queryPermission = vi.fn(
      async () => 'prompt'
    );
    vi.mocked(loadRootHandle).mockResolvedValue(stored);
    const provider = new FilesystemProvider();
    await provider.whenReady();
    expect(provider.isAuthenticated()).toBe(false);
    await recordFreshMarker();

    pickNext(folder('b'));
    await provider.login();
    expect(cloudBunkoStatus('filesystem')).toBeUndefined();
  });

  it('signing out forgets the marker', async () => {
    const provider = await connectedTo(folder('a'));
    await recordFreshMarker();

    await provider.logout();

    expect(cloudBunkoStatus('filesystem')).toBeUndefined();
    expect(provider.getStatus().serverCompilesMetadata).toBe(false);
  });
});
