/**
 * How far a sign-out reaches through the provider manager. A provider switch
 * signs the previous provider out on THIS device only — it must never ask
 * Google Drive to revoke the grant that other devices and a mokuro-bunko
 * server may share. An explicit `everywhere` from the cloud page passes
 * straight through to the provider.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import type {
  LogoutOptions,
  ProviderStatus,
  ProviderType,
  SyncProvider
} from './provider-interface';
import { providerManager } from './provider-manager';

function fakeProvider(type: ProviderType) {
  const logout = vi.fn(async (_options?: LogoutOptions) => {});
  const provider = {
    type,
    name: `Fake ${type}`,
    supportsWorkerDownload: true,
    supportsWorkerUpload: true,
    uploadConcurrencyLimit: 1,
    downloadConcurrencyLimit: 1,
    isAuthenticated: () => true,
    getStatus: (): ProviderStatus => ({
      isAuthenticated: true,
      hasStoredCredentials: true,
      needsAttention: false,
      statusMessage: 'Connected',
      isReadOnly: false
    }),
    logout
  } as unknown as SyncProvider;
  return { provider, logout };
}

beforeEach(async () => {
  localStorage.clear();
  // Start each test with no current provider.
  await providerManager.logout();
});

describe('providerManager and the sign-out scope', () => {
  it('switching providers signs Drive out without `everywhere`', async () => {
    const drive = fakeProvider('google-drive');
    const mega = fakeProvider('mega');
    providerManager.registerProvider(drive.provider);
    providerManager.registerProvider(mega.provider);
    await providerManager.setCurrentProvider(drive.provider);
    drive.logout.mockClear();

    await providerManager.setCurrentProvider(mega.provider);

    expect(drive.logout).toHaveBeenCalledTimes(1);
    const [options] = drive.logout.mock.calls[0];
    expect(options?.everywhere).not.toBe(true);
    expect(mega.logout).not.toHaveBeenCalled();
  });

  it('logout() with no options is a device sign-out', async () => {
    const drive = fakeProvider('google-drive');
    providerManager.registerProvider(drive.provider);
    await providerManager.setCurrentProvider(drive.provider);

    await providerManager.logout();

    expect(drive.logout).toHaveBeenCalledTimes(1);
    expect(drive.logout.mock.calls[0][0]?.everywhere).not.toBe(true);
  });

  it('logout({ everywhere: true }) reaches the provider as asked', async () => {
    const drive = fakeProvider('google-drive');
    providerManager.registerProvider(drive.provider);
    await providerManager.setCurrentProvider(drive.provider);

    await providerManager.logout({ everywhere: true });

    expect(drive.logout).toHaveBeenCalledWith({ everywhere: true });
  });

  it('with no current provider, still answers the shown provider’s sign-out (Drive: revoked)', async () => {
    // Drive is the configured provider (the cloud page shows its panel) but
    // was never made current: its token was cleared, auth history kept.
    localStorage.setItem('active_cloud_provider', 'google-drive');
    const drive = fakeProvider('google-drive');
    drive.logout.mockResolvedValue({ revoked: true } as never);
    const mega = fakeProvider('mega');
    providerManager.registerProvider(drive.provider);
    providerManager.registerProvider(mega.provider);

    const result = await providerManager.logout({ everywhere: true });

    expect(drive.logout).toHaveBeenCalledWith({ everywhere: true });
    expect(result).toEqual({ revoked: true });
  });

  it('with no current provider, another provider’s answer is not passed off as the shown one’s', async () => {
    localStorage.setItem('active_cloud_provider', 'mega');
    const drive = fakeProvider('google-drive');
    drive.logout.mockResolvedValue({ revoked: true } as never);
    const mega = fakeProvider('mega');
    providerManager.registerProvider(drive.provider);
    providerManager.registerProvider(mega.provider);

    expect(await providerManager.logout({ everywhere: true })).toEqual({});
  });
});
