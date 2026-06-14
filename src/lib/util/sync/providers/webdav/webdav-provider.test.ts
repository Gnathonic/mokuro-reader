import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../provider-interface';
import { fetchServerIdentity } from './identity';

const { mockClient, mockCore, createClientMock } = vi.hoisted(() => {
  const mockClient = {
    getDirectoryContents: vi.fn(),
    exists: vi.fn(),
    createDirectory: vi.fn(),
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
    getQuota: vi.fn()
  };
  const mockCore = {
    uploadFile: vi.fn(),
    downloadFile: vi.fn()
  };
  const createClientMock = vi.fn(() => mockClient);
  return { mockClient, mockCore, createClientMock };
});

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('webdav', () => ({
  createClient: createClientMock,
  AuthType: { Auto: 'auto', Digest: 'digest', None: 'none', Password: 'password', Token: 'token' }
}));
vi.mock('./identity', async (importOriginal) => {
  const original = await importOriginal<typeof import('./identity')>();
  return { ...original, fetchServerIdentity: vi.fn() };
});
vi.mock('../../core/cloud-provider-core-registry', () => ({
  getCloudProviderCore: () => mockCore
}));
vi.mock('../../provider-manager', () => ({
  providerManager: { updateStatus: vi.fn() }
}));
vi.mock('../../cache-manager', () => ({
  cacheManager: { registerCache: vi.fn() }
}));
vi.mock('./webdav-cache', () => ({ webdavCache: {} }));

import { WebDAVProvider } from './webdav-provider';

const identityMock = vi.mocked(fetchServerIdentity);
const fetchMock = vi.fn();

const REGISTERED_PERMS = { canWriteProgress: true, canAddFiles: false, canModifyDelete: false };

function authenticatedIdentity() {
  return {
    kind: 'authenticated' as const,
    username: 'alice',
    role: 'registered',
    permissions: { ...REGISTERED_PERMS }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockClient.getDirectoryContents.mockResolvedValue([]);
  mockClient.exists.mockResolvedValue(true);
  mockClient.createDirectory.mockResolvedValue(undefined);
  // checkWritePermissions probes via global fetch; an always-404 stub makes the
  // legacy heuristics conclude "writable" (fail-open), which is today's behavior
  fetchMock.mockResolvedValue(new Response('', { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
});

async function freshProvider(): Promise<WebDAVProvider> {
  const provider = new WebDAVProvider();
  await provider.whenReady();
  return provider;
}

describe('WebDAVProvider login()', () => {
  it('uses server-reported permissions and skips heuristics when identity is authenticated', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue(authenticatedIdentity());

    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pässwörd' });

    // registered (canWriteProgress) => NOT read-only
    expect(provider.isReadOnly).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
    // checkWritePermissions would have used global fetch - it must not run
    expect(fetchMock).not.toHaveBeenCalled();
    // credentials persisted as plain strings (C6: format unchanged)
    expect(localStorage.getItem('webdav_server_url')).toBe('https://host');
    expect(localStorage.getItem('webdav_username')).toBe('alice');
    expect(localStorage.getItem('webdav_password')).toBe('pässwörd');
  });

  it('throws a typed auth error and does not persist credentials on invalid-credentials', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'invalid-credentials' });

    await expect(
      provider.login({ serverUrl: 'https://host', username: 'alice', password: 'wrong' })
    ).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'AUTH_FAILED',
      webdavErrorType: 'auth',
      isAuthError: true
    });

    expect(localStorage.getItem('webdav_password')).toBeNull();
    expect(localStorage.getItem('webdav_server_url')).toBeNull();
    expect(provider.isAuthenticated()).toBe(false);
  });

  it('throws a retryable auth error when rate-limited', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'rate-limited' });

    await expect(
      provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' })
    ).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      webdavErrorType: 'auth',
      isNetworkError: true
    });

    expect(localStorage.getItem('webdav_password')).toBeNull();
  });

  it('keeps the legacy heuristics path for unsupported (generic) servers', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });

    await provider.login({ serverUrl: 'https://host', username: 'u', password: 'pw' });

    // ensureMokuroFolder probed via client.exists
    expect(mockClient.exists).toHaveBeenCalledWith('/mokuro-reader');
    // checkWritePermissions heuristics ran (PROPFIND/OPTIONS via fetch)
    expect(fetchMock).toHaveBeenCalled();
    // fail-open heuristics => writable
    expect(provider.isReadOnly).toBe(false);
  });

  it('classifies a 401-bearing FOLDER_ERROR on the unsupported path as an auth-typed LOGIN_FAILED', async () => {
    // Anonymous-browse server: root PROPFIND succeeds, but the mokuro folder
    // probe rejects the credentials. Main classified this by message substring
    // (LOGIN_FAILED + webdavErrorType 'auth'); the AUTH_FAILED rethrow guard
    // must not bypass that classification (modal type + restore handling).
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    mockClient.exists.mockRejectedValue(new Error('Request failed with status 401 Unauthorized'));

    await expect(
      provider.login({ serverUrl: 'https://host', username: 'alice', password: 'bad' })
    ).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'LOGIN_FAILED',
      webdavErrorType: 'auth',
      isAuthError: true
    });
  });

  it('connects read-only without attention flag for anonymous mokuro-bunko sessions', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'anonymous' });

    await provider.login({ serverUrl: 'https://host' });

    expect(identityMock).toHaveBeenCalledWith('https://host', undefined, undefined);
    expect(provider.isReadOnly).toBe(true);
    expect(provider.getStatus().needsAttention).toBe(false);
    // no folder creation / write attempts for read-only anonymous sessions
    expect(mockClient.exists).not.toHaveBeenCalled();
    expect(mockClient.createDirectory).not.toHaveBeenCalled();
    // no permission heuristics either
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a username with no password instead of connecting anonymously', async () => {
    // The only anonymous login is a fully blank one. A username with no
    // password is an incomplete credential, not a browse-only session — it
    // must not silently degrade to anonymous read-only.
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'anonymous' });

    await expect(
      provider.login({ serverUrl: 'https://host', username: 'alice' })
    ).rejects.toMatchObject({ name: 'ProviderError', code: 'INVALID_CREDENTIALS' });

    expect(identityMock).not.toHaveBeenCalled();
    expect(provider.isAuthenticated()).toBe(false);
  });
});

describe('WebDAVProvider session restore', () => {
  it('clears only the password and flags attention when stored credentials are rejected', async () => {
    localStorage.setItem('webdav_server_url', 'https://host');
    localStorage.setItem('webdav_username', 'alice');
    localStorage.setItem('webdav_password', 'stale');
    localStorage.setItem('active_cloud_provider', 'webdav');

    identityMock.mockResolvedValueOnce({ kind: 'invalid-credentials' }); // restore with creds

    const provider = await freshProvider();

    expect(localStorage.getItem('webdav_password')).toBeNull();
    expect(localStorage.getItem('webdav_server_url')).toBe('https://host');
    expect(localStorage.getItem('webdav_username')).toBe('alice');
    expect(localStorage.getItem('active_cloud_provider')).toBe('webdav');
    expect(provider.getStatus().needsAttention).toBe(true);
    // No silent anonymous fallback: the session is logged out, prompting a
    // re-login rather than quietly browsing read-only.
    expect(provider.isAuthenticated()).toBe(false);
    // only ONE identity check (the rejected one) — no anonymous reconnect
    expect(identityMock).toHaveBeenCalledTimes(1);
  });

  it('flags attention without reconnecting when restoring a username-without-password session', async () => {
    localStorage.setItem('webdav_server_url', 'https://host');
    localStorage.setItem('webdav_username', 'alice');
    localStorage.setItem('active_cloud_provider', 'webdav');

    const provider = await freshProvider();

    expect(provider.getStatus().needsAttention).toBe(true);
    // logged out, not anonymously browsing
    expect(provider.isAuthenticated()).toBe(false);
    // username preserved for login-form pre-fill
    expect(localStorage.getItem('webdav_username')).toBe('alice');
    // no connection attempt at all — nothing to silently fall back to
    expect(identityMock).not.toHaveBeenCalled();
  });

  it('keeps the stored password when restore hits a rate-limited (429) identity check (M-6)', async () => {
    // A hot server-side limiter (shared NAT being brute-forced, the user's own
    // other tab) must NOT be treated as credential rejection during startup
    // restore - the password is still valid and must survive for retry.
    localStorage.setItem('webdav_server_url', 'https://host');
    localStorage.setItem('webdav_username', 'alice');
    localStorage.setItem('webdav_password', 'pw');
    localStorage.setItem('active_cloud_provider', 'webdav');

    identityMock.mockResolvedValue({ kind: 'rate-limited' });

    const provider = await freshProvider();

    expect(localStorage.getItem('webdav_password')).toBe('pw');
    expect(localStorage.getItem('webdav_username')).toBe('alice');
    expect(localStorage.getItem('webdav_server_url')).toBe('https://host');
    expect(provider.getStatus().needsAttention).toBe(false);
  });

  it('keeps credentials on temporary (non-auth) restore failures', async () => {
    localStorage.setItem('webdav_server_url', 'https://host');
    localStorage.setItem('webdav_username', 'alice');
    localStorage.setItem('webdav_password', 'pw');
    localStorage.setItem('active_cloud_provider', 'webdav');

    mockClient.getDirectoryContents.mockRejectedValue(new Error('Failed to fetch'));

    const provider = await freshProvider();

    expect(localStorage.getItem('webdav_password')).toBe('pw');
    expect(localStorage.getItem('webdav_username')).toBe('alice');
    expect(provider.getStatus().needsAttention).toBe(false);
  });
});

describe('WebDAVProvider write-failure policy', () => {
  async function loggedInProvider(opts: {
    capabilities?: typeof REGISTERED_PERMS | null;
    hasPassword: boolean;
  }): Promise<WebDAVProvider> {
    const provider = await freshProvider();
    if (opts.capabilities) {
      identityMock.mockResolvedValue({
        kind: 'authenticated',
        username: 'alice',
        role: 'registered',
        permissions: { ...opts.capabilities }
      });
    } else {
      identityMock.mockResolvedValue({ kind: 'unsupported' });
    }
    // A credential-less session is a fully blank (anonymous) login — username
    // is only sent alongside a password now.
    await provider.login({
      serverUrl: 'https://host',
      username: opts.hasPassword ? 'alice' : undefined,
      password: opts.hasPassword ? 'pw' : undefined
    });
    return provider;
  }

  it('does NOT demote to read-only on 403 when the server reports canWriteProgress', async () => {
    const provider = await loggedInProvider({ capabilities: REGISTERED_PERMS, hasPassword: true });
    mockCore.uploadFile.mockRejectedValue(new Error('Request failed with status 403 Forbidden'));

    await expect(provider.uploadFile('Series/v1.cbz', new Blob(['x']))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      webdavErrorType: 'permission'
    });

    expect(provider.isReadOnly).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
  });

  it('demotes to read-only on 403 when capabilities are unknown (generic server)', async () => {
    const provider = await loggedInProvider({ capabilities: null, hasPassword: true });
    mockCore.uploadFile.mockRejectedValue(new Error('Request failed with status 403 Forbidden'));

    await expect(provider.uploadFile('Series/v1.cbz', new Blob(['x']))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    });

    expect(provider.isReadOnly).toBe(true);
  });

  it('treats 401 as auth failure (not read-only) when the session has a password', async () => {
    const provider = await loggedInProvider({ capabilities: REGISTERED_PERMS, hasPassword: true });
    expect(localStorage.getItem('webdav_password')).toBe('pw');
    mockCore.uploadFile.mockRejectedValue(new Error('Request failed with status 401'));

    await expect(provider.uploadFile('Series/v1.cbz', new Blob(['x']))).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      webdavErrorType: 'auth',
      isAuthError: true
    });

    expect(provider.isReadOnly).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(true);
    // password cleared, URL + username kept
    expect(localStorage.getItem('webdav_password')).toBeNull();
    expect(localStorage.getItem('webdav_server_url')).toBe('https://host');
    expect(localStorage.getItem('webdav_username')).toBe('alice');
  });

  it('falls back to read-only demotion on 401 for credential-less sessions', async () => {
    const provider = await loggedInProvider({ capabilities: null, hasPassword: false });
    mockCore.uploadFile.mockRejectedValue(new Error('Request failed with status 401'));

    await expect(provider.uploadFile('Series/v1.cbz', new Blob(['x']))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      webdavErrorType: 'permission'
    });

    expect(provider.isReadOnly).toBe(true);
    expect(provider.getStatus().needsAttention).toBe(false);
  });

  it('still treats 405 as a read-only server', async () => {
    const provider = await loggedInProvider({ capabilities: null, hasPassword: true });
    mockCore.uploadFile.mockRejectedValue(new Error('405 Method Not Allowed'));

    await expect(provider.uploadFile('Series/v1.cbz', new Blob(['x']))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED'
    });

    expect(provider.isReadOnly).toBe(true);
    expect(provider.getStatus().needsAttention).toBe(false);
    expect(localStorage.getItem('webdav_password')).toBe('pw');
  });

  it('routes deleteFile 401 failures through the auth policy', async () => {
    const provider = await loggedInProvider({ capabilities: REGISTERED_PERMS, hasPassword: true });
    mockClient.deleteFile.mockRejectedValue(new Error('Request failed with status 401'));

    await expect(
      provider.deleteFile({
        provider: 'webdav',
        fileId: '/mokuro-reader/Series/v1.cbz',
        path: 'Series/v1.cbz',
        modifiedTime: '2026-01-01',
        size: 1
      })
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', webdavErrorType: 'auth' });

    expect(provider.getStatus().needsAttention).toBe(true);
  });

  it('errors thrown by the policy are ProviderError instances', async () => {
    const provider = await loggedInProvider({ capabilities: REGISTERED_PERMS, hasPassword: true });
    mockCore.uploadFile.mockRejectedValue(new Error('Request failed with status 401'));

    await expect(provider.uploadFile('Series/v1.cbz', new Blob(['x']))).rejects.toBeInstanceOf(
      ProviderError
    );
  });
});
