import { describe, it, expect, beforeEach, vi } from 'vitest';

// Lifecycle tests need the real constructor path (MSAL init + status),
// unlike onedrive-provider.test.ts which pins browser:false to skip it.
vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('../../../core/cloud-provider-core-registry', () => ({
  getCloudProviderCore: vi.fn(() => ({}))
}));

const h = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    initialize: vi.fn(async () => {}),
    logout: vi.fn(async () => {
      order.push('tokenManager.logout');
    }),
    clearActiveProviderKey: vi.fn(() => {
      order.push('clearActiveProviderKey');
    }),
    setActiveProviderKey: vi.fn()
  };
});

vi.mock('../token-manager', () => ({
  onedriveTokenManager: {
    initialize: h.initialize,
    logout: h.logout,
    isAuthenticated: vi.fn().mockReturnValue(false),
    hasStoredCredentials: vi.fn().mockReturnValue(false),
    getActiveAccountName: vi.fn().mockReturnValue(null),
    getActiveAccountId: vi.fn().mockReturnValue(null),
    getAccessToken: vi.fn(async () => 'TOKEN'),
    markNeedsAttention: vi.fn(),
    needsAttention: {
      subscribe: (fn: (v: boolean) => void) => {
        fn(false);
        return () => {};
      }
    }
  }
}));

vi.mock('../../../provider-detection', () => ({
  setActiveProviderKey: h.setActiveProviderKey,
  clearActiveProviderKey: h.clearActiveProviderKey
}));

vi.mock('../graph-client', () => ({
  getItemByPath: vi.fn(),
  listChildren: vi.fn(),
  createFolder: vi.fn(),
  deleteItem: vi.fn(),
  getDriveQuota: vi.fn(),
  patchItem: vi.fn()
}));

import { OneDriveProvider } from '../onedrive-provider';
import { onedriveTokenManager } from '../token-manager';
import { getItemByPath } from '../graph-client';

describe('OneDriveProvider lifecycle', () => {
  beforeEach(() => {
    h.order.length = 0;
    vi.clearAllMocks();
  });

  describe('logout', () => {
    it('clears the active provider key before the token-manager redirect', async () => {
      const provider = new OneDriveProvider();
      await provider.whenReady();

      await provider.logout();

      expect(h.order).toEqual(['clearActiveProviderKey', 'tokenManager.logout']);
    });
  });

  describe('login', () => {
    it('forgets the folder ids an upload remembered: the account may be another one', async () => {
      vi.mocked(onedriveTokenManager.isAuthenticated).mockReturnValue(true);
      vi.mocked(getItemByPath).mockResolvedValue({
        id: 'root-a',
        name: 'mokuro-reader',
        folder: {}
      });
      const provider = new OneDriveProvider();
      await provider.whenReady();

      await provider.login();
      // A second login (another account) asks for the mokuro folder again
      // instead of trusting the first account's id.
      vi.mocked(getItemByPath).mockResolvedValue({
        id: 'root-b',
        name: 'mokuro-reader',
        folder: {}
      });
      await provider.login();

      expect(vi.mocked(getItemByPath)).toHaveBeenCalledTimes(2);
      expect((provider as unknown as { folderIds: Map<string, string> }).folderIds.get('')).toBe(
        'root-b'
      );
      vi.mocked(onedriveTokenManager.isAuthenticated).mockReturnValue(false);
    });
  });

  describe('getStatus().accountScope', () => {
    it('is undefined when there is no active account id', async () => {
      const provider = new OneDriveProvider();
      await provider.whenReady();

      expect(provider.getStatus().accountScope).toBeUndefined();
    });

    it('is `onedrive:<homeAccountId>` once MSAL reports an active account', async () => {
      vi.mocked(onedriveTokenManager.isAuthenticated).mockReturnValue(true);
      vi.mocked(onedriveTokenManager.getActiveAccountId).mockReturnValue('AAID.TID');

      const provider = new OneDriveProvider();
      await provider.whenReady();

      expect(provider.getStatus().accountScope).toBe('onedrive:AAID.TID');
    });
  });

  describe('getStatus after failed MSAL init', () => {
    it('reports an initialization failure instead of "Not configured"', async () => {
      h.initialize.mockRejectedValueOnce(new Error('VITE_ONEDRIVE_CLIENT_ID is not set'));

      const provider = new OneDriveProvider();
      await provider.whenReady();

      const status = provider.getStatus();
      expect(status.statusMessage).toMatch(/initialization failed/i);
      expect(status.isAuthenticated).toBe(false);
    });
  });
});
