import { describe, it, expect, beforeEach, vi } from 'vitest';

// Keep the constructor cheap (no MSAL init) by reporting a non-browser env.
vi.mock('$app/environment', () => ({ browser: false }));

// The provider grabs a worker core at construction; a dummy is enough here.
vi.mock('../../../core/cloud-provider-core-registry', () => ({
  getCloudProviderCore: vi.fn(() => ({}))
}));

// Token manager: authenticated with a static token.
vi.mock('../token-manager', () => ({
  onedriveTokenManager: {
    initialize: vi.fn().mockResolvedValue(undefined),
    isAuthenticated: vi.fn().mockReturnValue(true),
    getAccessToken: vi.fn().mockResolvedValue('TOKEN')
  }
}));

// Graph client: every network call is a spy we drive per test.
vi.mock('../graph-client', () => ({
  getItemByPath: vi.fn(),
  listChildren: vi.fn(),
  createFolder: vi.fn(),
  deleteItem: vi.fn(),
  getDriveQuota: vi.fn(),
  patchItem: vi.fn()
}));

import { OneDriveProvider } from '../onedrive-provider';
import { getItemByPath, listChildren } from '../graph-client';

describe('OneDriveProvider.listCloudVolumes', () => {
  let provider: OneDriveProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OneDriveProvider();
  });

  it('returns empty when the root mokuro folder does not exist', async () => {
    vi.mocked(getItemByPath).mockResolvedValue(null);

    await expect(provider.listCloudVolumes()).resolves.toEqual([]);
    // Must not attempt to walk a folder it knows is absent.
    expect(vi.mocked(listChildren)).not.toHaveBeenCalled();
  });

  it('propagates a non-404 listing error instead of swallowing it', async () => {
    vi.mocked(getItemByPath).mockResolvedValue({ id: 'root', name: 'mokuro-reader' });
    vi.mocked(listChildren).mockRejectedValue(new Error('Graph 500 Internal Server Error: '));

    await expect(provider.listCloudVolumes()).rejects.toThrow(/500/);
  });

  it('does NOT swallow a 404 raised while listing a deep subfolder', async () => {
    vi.mocked(getItemByPath).mockResolvedValue({ id: 'root', name: 'mokuro-reader' });
    vi.mocked(listChildren)
      // Top-level mokuro folder lists one series subfolder...
      .mockResolvedValueOnce([{ id: 'series', name: 'Naruto', folder: {} }])
      // ...and listing that subfolder fails with a real 404.
      .mockRejectedValueOnce(new Error('Graph 404 Not Found: '));

    // A deep 404 means missing data, not "empty library" — it must surface,
    // not silently drop the affected volumes and return a partial set.
    await expect(provider.listCloudVolumes()).rejects.toThrow(/404/);
  });
});
