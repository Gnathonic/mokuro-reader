import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The login's real path (browser + supported API), as filesystem-provider-restore.test.ts.
vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('../feature-detect', () => ({
  isFilesystemProviderSupported: vi.fn(() => true)
}));

vi.mock('../handle-store', () => ({
  loadRootHandle: vi.fn(async () => null),
  saveRootHandle: vi.fn(async () => {}),
  clearRootHandle: vi.fn(async () => {})
}));

vi.mock('../../../provider-detection', () => ({
  setActiveProviderKey: vi.fn(),
  clearActiveProviderKey: vi.fn()
}));

import { FilesystemProvider } from '../filesystem-provider';
import { saveRootHandle } from '../handle-store';
import { setFolderTestHandle } from '../../../cloud-test-hooks';

/** A folder the user (or the rig) gave read-write access to. */
function folder(name: string) {
  return {
    kind: 'directory' as const,
    name,
    requestPermission: vi.fn(async () => 'granted'),
    isSameEntry: vi.fn(async () => false)
  };
}

describe('FilesystemProvider.login with a folder handed by a test (the interop rig)', () => {
  const picker = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as Record<string, unknown>).showDirectoryPicker = picker;
  });

  afterEach(() => {
    setFolderTestHandle(null);
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
  });

  it('opens the handed folder and never shows the picker', async () => {
    const given = folder('Library');
    setFolderTestHandle(given as unknown as FileSystemDirectoryHandle);
    const provider = new FilesystemProvider();
    await provider.whenReady();
    await provider.login();
    expect(picker).not.toHaveBeenCalled();
    expect(given.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(saveRootHandle).toHaveBeenCalledWith(given);
    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.getStatus().statusMessage).toBe('Connected to folder "Library"');
  });

  it('without one, the picker chooses the folder', async () => {
    const picked = folder('Picked');
    picker.mockResolvedValueOnce(picked);
    const provider = new FilesystemProvider();
    await provider.whenReady();
    await provider.login();
    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(saveRootHandle).toHaveBeenCalledWith(picked);
  });

  it('a handed folder still needs its read-write grant', async () => {
    const given = folder('Library');
    given.requestPermission.mockResolvedValueOnce('denied');
    setFolderTestHandle(given as unknown as FileSystemDirectoryHandle);
    const provider = new FilesystemProvider();
    await provider.whenReady();
    await expect(provider.login()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(provider.isAuthenticated()).toBe(false);
  });
});
