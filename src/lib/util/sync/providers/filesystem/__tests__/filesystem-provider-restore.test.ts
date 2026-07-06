import { describe, it, expect, beforeEach, vi } from 'vitest';

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
