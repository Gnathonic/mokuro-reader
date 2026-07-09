import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

// Capture-order log shared between the msal mock and assertions.
const calls: string[] = [];

class FakeBrowserAuthError extends Error {
  constructor(public errorCode: string) {
    super(errorCode);
  }
}
class FakeInteractionRequiredAuthError extends Error {}

const fakeAccount = { name: 'Test User', username: 'test@example.com' };

const fakeInstance = {
  initialize: vi.fn(async () => {}),
  handleRedirectPromise: vi.fn(async () => null),
  getAllAccounts: vi.fn(() => [fakeAccount]),
  setActiveAccount: vi.fn(),
  loginRedirect: vi.fn(async () => {
    calls.push('loginRedirect');
  }),
  acquireTokenRedirect: vi.fn(async () => {
    calls.push('acquireTokenRedirect');
  }),
  acquireTokenSilent: vi.fn(async () => ({ accessToken: 'tok' })),
  logoutRedirect: vi.fn(async () => {
    calls.push(`logoutRedirect(hasAuth=${localStorage.getItem('onedrive_has_authenticated')})`);
  })
};

vi.mock('@azure/msal-browser', () => ({
  PublicClientApplication: vi.fn(() => fakeInstance),
  BrowserAuthError: FakeBrowserAuthError,
  InteractionRequiredAuthError: FakeInteractionRequiredAuthError
}));

async function freshManager() {
  vi.resetModules();
  vi.stubEnv('VITE_ONEDRIVE_CLIENT_ID', 'test-client-id');
  const { onedriveTokenManager } = await import('../token-manager');
  return onedriveTokenManager;
}

describe('OneDriveTokenManager', () => {
  beforeEach(() => {
    calls.length = 0;
    localStorage.clear();
    vi.clearAllMocks();
    fakeInstance.getAllAccounts.mockReturnValue([fakeAccount]);
  });

  it('logout clears local state BEFORE the logoutRedirect navigation', async () => {
    localStorage.setItem('onedrive_has_authenticated', 'true');
    localStorage.setItem('onedrive_login_pending', 'true');
    const mgr = await freshManager();
    await mgr.initialize();

    await mgr.logout();

    // The redirect call must observe already-cleared storage.
    expect(calls).toContain('logoutRedirect(hasAuth=null)');
    expect(localStorage.getItem('onedrive_login_pending')).toBeNull();
  });

  it('login surfaces a friendly error when an interaction is already in progress', async () => {
    fakeInstance.loginRedirect.mockRejectedValueOnce(
      new FakeBrowserAuthError('interaction_in_progress')
    );
    const mgr = await freshManager();
    await expect(mgr.login()).rejects.toThrow(/already in progress/i);
  });

  it('reauthenticate surfaces a friendly error when an interaction is already in progress', async () => {
    fakeInstance.acquireTokenRedirect.mockRejectedValueOnce(
      new FakeBrowserAuthError('interaction_in_progress')
    );
    const mgr = await freshManager();
    await mgr.initialize();
    await expect(mgr.reauthenticate()).rejects.toThrow(/already in progress/i);
  });

  it('markNeedsAttention flips the needsAttention store', async () => {
    const mgr = await freshManager();
    let value = false;
    mgr.markNeedsAttention();
    mgr.needsAttention.subscribe((v) => (value = v))();
    expect(value).toBe(true);
  });

  it('no longer exposes the dead hasPendingRedirect helper', async () => {
    const mgr = await freshManager();
    expect((mgr as unknown as Record<string, unknown>).hasPendingRedirect).toBeUndefined();
  });
});
