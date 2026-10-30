import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../provider-interface';
import { fetchServerIdentity } from './identity';
import { ingestMarkerRead, resetCloudBunkoMarkersForTest } from '$lib/catalog/cloud-bunko-marker';

const { mockClient, mockCore, createClientMock } = vi.hoisted(() => {
  const mockClient = {
    getDirectoryContents: vi.fn(),
    exists: vi.fn(),
    createDirectory: vi.fn(),
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
    stat: vi.fn(),
    getQuota: vi.fn(),
    getHeaders: vi.fn(() => ({})),
    setHeaders: vi.fn()
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
  resetCloudBunkoMarkersForTest();
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
    // The endpoint answered in bunko's shape: bunko compiles the metadata files.
    expect(provider.getStatus().serverCompilesMetadata).toBe(true);
    // checkWritePermissions would have used PROPFIND - it must not run. (The
    // requests allowed are the token request and the OPTIONS asking whether
    // PUTs are staged and verified.)
    expect(
      fetchMock.mock.calls.every(
        (c) =>
          c[1]?.method === 'OPTIONS' ||
          (c[1]?.method === 'POST' && String(c[0]) === 'https://host/login/api/token')
      )
    ).toBe(true);
    // credentials persisted as plain strings (C6: format unchanged)
    expect(localStorage.getItem('webdav_server_url')).toBe('https://host');
    expect(localStorage.getItem('webdav_username')).toBe('alice');
    expect(localStorage.getItem('webdav_password')).toBe('pässwörd');
  });

  it('carries the identity endpoint’s metadata scope through to getStatus()', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({
      kind: 'authenticated' as const,
      username: 'alice',
      role: 'registered',
      permissions: {
        ...REGISTERED_PERMS,
        metadata: { scope: 'owned' as const, ownedSeries: ['One Piece'] }
      }
    });

    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });

    expect(provider.getStatus().metadataPermissions).toEqual({
      scope: 'owned',
      ownedSeries: ['One Piece']
    });
  });

  it('leaves getStatus().metadataPermissions undefined when the identity response omits it', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue(authenticatedIdentity());

    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });

    expect(provider.getStatus().metadataPermissions).toBeUndefined();
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
    // No identity endpoint (or an unreachable one): this client is the producer.
    expect(provider.getStatus().serverCompilesMetadata).toBe(false);
  });

  it('a server known to be bunko (verified PUTs recorded) stays a non-producer when identity fails', async () => {
    // The identity probe hit a flaky hop; this URL answered X-Mokuro-Put: verified before.
    localStorage.setItem('webdav_put_verified', 'https://host');
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });

    await provider.login({ serverUrl: 'https://host/', username: 'u', password: 'pw' });

    expect(provider.getStatus().serverCompilesMetadata).toBe(true);
  });

  it('the bunko record of ANOTHER server URL does not make this one a non-producer', async () => {
    localStorage.setItem('webdav_put_verified', 'https://bunko.example');
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });

    await provider.login({ serverUrl: 'https://host', username: 'u', password: 'pw' });

    expect(provider.getStatus().serverCompilesMetadata).toBe(false);
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
    // An anonymous answer still proves the endpoint spoke bunko's contract.
    expect(provider.getStatus().serverCompilesMetadata).toBe(true);
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

describe('WebDAVProvider getStatus().accountScope', () => {
  it('is undefined before any connection', async () => {
    const provider = await freshProvider();
    expect(provider.getStatus().accountScope).toBeUndefined();
  });

  it('is `webdav:<serverUrl>|<username>` after login', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue(authenticatedIdentity());

    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });

    expect(provider.getStatus().accountScope).toBe('webdav:https://host/|alice');
  });

  it('omits the username segment for a password-only (no-username) session', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'anonymous' });

    await provider.login({ serverUrl: 'https://host' });

    expect(provider.getStatus().accountScope).toBe('webdav:https://host/');
  });

  it('strips embedded userinfo from a credentialed URL so no password reaches the persisted scope', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue(authenticatedIdentity());

    await provider.login({
      serverUrl: 'https://sneaky:hunter2@host/dav',
      username: 'alice',
      password: 'pw'
    });

    const scope = provider.getStatus().accountScope;
    expect(scope).not.toContain('hunter2');
    expect(scope).not.toContain('sneaky');
    expect(scope).toBe('webdav:https://host/dav|alice');
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

  it('a 403 on the series COLLECTION delete asks for per-file deletion, without demotion', async () => {
    // mokuro-bunko: an uploader may delete its own files, never a top-level folder.
    const provider = await loggedInProvider({ capabilities: REGISTERED_PERMS, hasPassword: true });
    mockClient.exists.mockResolvedValue(true);
    mockClient.deleteFile.mockRejectedValue(
      Object.assign(new Error('Invalid response: 403 Forbidden'), { status: 403 })
    );

    await expect(provider.deleteSeriesFolder('Series')).rejects.toMatchObject({
      code: 'FOLDER_DELETE_REFUSED'
    });
    expect(provider.isReadOnly).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
  });

  it('reports canAddFiles from identity, and absent for a generic server', async () => {
    const registered = await loggedInProvider({
      capabilities: REGISTERED_PERMS,
      hasPassword: true
    });
    expect(registered.getStatus().canAddFiles).toBe(false);
    expect(registered.isReadOnly).toBe(false); // progress still syncs
    const generic = await loggedInProvider({ capabilities: null, hasPassword: true });
    expect(generic.getStatus().canAddFiles).toBeUndefined();
  });

  it('a 403 on a rename MOVE says the account cannot rename, without demotion', async () => {
    const provider = await loggedInProvider({ capabilities: REGISTERED_PERMS, hasPassword: true });
    mockClient.exists.mockImplementation(async (path: string) => !path.includes('New'));
    mockClient.moveFile.mockRejectedValue(new Error('Invalid response: 403 Forbidden'));

    await expect(
      provider.renameFile(
        {
          provider: 'webdav',
          fileId: '/mokuro-reader/S/Old.cbz',
          path: 'S/Old.cbz',
          modifiedTime: '2026-01-01',
          size: 1
        },
        'S/New.cbz'
      )
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: "This account can't rename on this server"
    });
    expect(provider.isReadOnly).toBe(false);
  });

  it('errors thrown by the policy are ProviderError instances', async () => {
    const provider = await loggedInProvider({ capabilities: REGISTERED_PERMS, hasPassword: true });
    mockCore.uploadFile.mockRejectedValue(new Error('Request failed with status 401'));

    await expect(provider.uploadFile('Series/v1.cbz', new Blob(['x']))).rejects.toBeInstanceOf(
      ProviderError
    );
  });
});

describe('WebDAVProvider renameFile idempotency & typed NOT_FOUND', () => {
  async function loggedInProvider(): Promise<WebDAVProvider> {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({
      kind: 'authenticated',
      username: 'alice',
      role: 'registered',
      permissions: { ...REGISTERED_PERMS }
    });
    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    return provider;
  }

  const sourceFile = {
    provider: 'webdav' as const,
    fileId: '/mokuro-reader/Old Series/Volume 1.cbz',
    path: 'Old Series/Volume 1.cbz',
    modifiedTime: 't',
    size: 100
  };
  const DEST = '/mokuro-reader/New Series/Volume 1.cbz';

  it('treats an occupied destination as OUR prior move only when the source is gone AND sizes match', async () => {
    const provider = await loggedInProvider();
    mockClient.exists.mockImplementation(
      async (path: string) => path !== sourceFile.fileId // dest + folders exist, source gone
    );
    mockClient.stat.mockResolvedValue({ size: 100 });

    const result = await provider.renameFile(sourceFile, 'New Series/Volume 1.cbz');

    expect(result.path).toBe('New Series/Volume 1.cbz');
    expect(mockClient.moveFile).not.toHaveBeenCalled();
    expect(mockClient.stat).toHaveBeenCalledWith(DEST);
    // The idempotent-retry branch is a second fabrication site: it must also
    // carry the ORIGINAL file's real modifiedTime, not the wall clock.
    expect(result.modifiedTime).toBe(sourceFile.modifiedTime);
  });

  it('throws TARGET_EXISTS when the source is gone but the occupant has a different size', async () => {
    // A different file at the destination (another volume's backup) must not
    // be silently adopted — the pre-PR loud conflict is the safe behavior.
    const provider = await loggedInProvider();
    mockClient.exists.mockImplementation(async (path: string) => path !== sourceFile.fileId);
    mockClient.stat.mockResolvedValue({ size: 999 });

    await expect(provider.renameFile(sourceFile, 'New Series/Volume 1.cbz')).rejects.toMatchObject({
      code: 'TARGET_EXISTS'
    });
  });

  it('throws TARGET_EXISTS on a genuine collision (source still present)', async () => {
    const provider = await loggedInProvider();
    mockClient.exists.mockResolvedValue(true); // source AND destination exist

    await expect(provider.renameFile(sourceFile, 'New Series/Volume 1.cbz')).rejects.toMatchObject({
      code: 'TARGET_EXISTS'
    });
    expect(mockClient.moveFile).not.toHaveBeenCalled();
  });

  it('maps a 404 from the MOVE to typed NOT_FOUND (source vanished)', async () => {
    const provider = await loggedInProvider();
    mockClient.exists.mockImplementation(
      async (path: string) => path.startsWith('/mokuro-reader') && !path.endsWith('.cbz')
    );
    mockClient.moveFile.mockRejectedValue(
      Object.assign(new Error('Request failed with status 404 Not Found'), { status: 404 })
    );

    await expect(provider.renameFile(sourceFile, 'New Series/Volume 1.cbz')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });
  });

  it('maps a 404 delete to typed NOT_FOUND so the shared layer can treat it as converged', async () => {
    const provider = await loggedInProvider();
    mockClient.deleteFile.mockRejectedValue(
      Object.assign(new Error('Request failed with status 404 Not Found'), { status: 404 })
    );

    await expect(provider.deleteFile(sourceFile)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(provider.isReadOnly).toBe(false); // 404 is not a permission signal
  });

  it('preserves the source file’s real modifiedTime through a normal rename (never fabricates from the client clock)', async () => {
    const provider = await loggedInProvider();
    mockClient.exists.mockResolvedValue(false); // no collision anywhere along the path
    mockClient.moveFile.mockResolvedValue(undefined);

    const result = await provider.renameFile(sourceFile, 'New Series/Volume 1.cbz');

    expect(mockClient.moveFile).toHaveBeenCalled();
    expect(result.path).toBe('New Series/Volume 1.cbz');
    // MUST equal the ORIGINAL exactly — not "close to now".
    expect(result.modifiedTime).toBe(sourceFile.modifiedTime);
    expect(result.modifiedTimeProvisional).toBeUndefined();
  });

  it('keeps modifiedTimeProvisional through a rename when the source was only ever a client-clock guess', async () => {
    const provider = await loggedInProvider();
    mockClient.exists.mockResolvedValue(false);
    mockClient.moveFile.mockResolvedValue(undefined);
    const provisionalSource = { ...sourceFile, modifiedTimeProvisional: true };

    const result = await provider.renameFile(provisionalSource, 'New Series/Volume 1.cbz');

    expect(result.modifiedTime).toBe(sourceFile.modifiedTime);
    expect(result.modifiedTimeProvisional).toBe(true);
  });
});

describe('WebDAVProvider staged, verified PUTs (X-Mokuro-Put)', () => {
  function optionsAnswer(put: string | null) {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'OPTIONS') {
        return new Response('', {
          status: 200,
          headers: {
            Allow: 'OPTIONS, GET, PUT, DELETE, MKCOL, PROPFIND',
            ...(put ? { 'X-Mokuro-Put': put } : {})
          }
        });
      }
      return new Response('', { status: 404 });
    });
  }

  it('records the header from the OPTIONS probe of a mokuro-bunko server', async () => {
    optionsAnswer('verified');
    const provider = await freshProvider();
    identityMock.mockResolvedValue(authenticatedIdentity());
    await provider.login({ serverUrl: 'https://host/', username: 'alice', password: 'pw' });
    expect(await provider.getWorkerUploadCredentials()).toMatchObject({
      webdavPutVerified: true
    });
  });

  it('records it from the permissions probe of a generic-path server too', async () => {
    optionsAnswer('verified');
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    await provider.login({ serverUrl: 'https://host', username: 'u', password: 'pw' });
    expect((await provider.getWorkerUploadCredentials()).webdavPutVerified).toBe(true);
  });

  it('is off for a server that does not send it', async () => {
    optionsAnswer(null);
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    await provider.login({ serverUrl: 'https://host', username: 'u', password: 'pw' });
    expect((await provider.getWorkerUploadCredentials()).webdavPutVerified).toBe(false);
  });

  it('records it from a PUT response, and forgets it for another server', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    await provider.login({ serverUrl: 'https://host', username: 'u', password: 'pw' });
    expect((await provider.getWorkerUploadCredentials()).webdavPutVerified).toBe(false);

    mockCore.uploadFile.mockResolvedValue({ fileId: '/x', serverPutVerified: true });
    await provider.uploadFile('Series/Vol 1.cbz', new Blob(['x']));
    expect((await provider.getWorkerUploadCredentials()).webdavPutVerified).toBe(true);

    await provider.login({ serverUrl: 'https://other', username: 'u', password: 'pw' });
    expect((await provider.getWorkerUploadCredentials()).webdavPutVerified).toBe(false);
  });

  it('notePutVerified records it for the connected server (worker-driven uploads)', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    await provider.login({ serverUrl: 'https://host', username: 'u', password: 'pw' });
    provider.notePutVerified();
    expect((await provider.getWorkerUploadCredentials()).webdavPutVerified).toBe(true);
  });
});

describe('WebDAVProvider.readControlFile()', () => {
  const MARKER = '.mokuro-bunko.json';
  const URL_OF_MARKER = 'https://host/mokuro-reader/.mokuro-bunko.json';

  function freshMarkerBody() {
    return JSON.stringify({
      version: 1,
      kind: 'mokuro-bunko',
      instance_id: 'aaa',
      instance_name: 'nas',
      epoch: 1,
      claimed_at: '2026-10-12T09:00:00Z',
      heartbeat_at: new Date().toISOString(),
      ttl_s: 900,
      state: 'active',
      compiles: ['series.json', 'catalog.json'],
      ocr: true,
      queue: '.mokuro-queue.json'
    });
  }

  /** A plain (non-bunko) WebDAV: no identity endpoint, no PUT_VERIFIED. */
  async function plainConnected(): Promise<WebDAVProvider> {
    resetCloudBunkoMarkersForTest();
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' } as any);
    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    fetchMock.mockReset();
    return provider;
  }

  function lastGet() {
    const call = fetchMock.mock.calls.at(-1)!;
    return { url: String(call[0]), init: call[1] as RequestInit };
  }

  it('reads one node with a no-store GET carrying the account Authorization', async () => {
    const provider = await plainConnected();
    fetchMock.mockResolvedValueOnce(
      new Response(freshMarkerBody(), {
        status: 200,
        headers: { ETag: '"v1"', 'Last-Modified': 'Mon, 12 Oct 2026 09:00:00 GMT' }
      })
    );

    const result = (await provider.readControlFile(MARKER)) as any;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = lastGet();
    expect(url).toBe(URL_OF_MARKER);
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBeTruthy();
    expect(auth).toBe(provider.authorizationHeader());
    expect((init.headers as Record<string, string>)['If-None-Match']).toBeUndefined();
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: URL_OF_MARKER,
      etag: '"v1"',
      modified: '2026-10-12T09:00:00.000Z'
    });
    expect(JSON.parse(await result.nodes[0].blob.text()).instance_id).toBe('aaa');
  });

  it('sends If-None-Match with the server ETag and maps 304 to not-modified', async () => {
    const provider = await plainConnected();
    fetchMock.mockResolvedValueOnce(
      new Response(freshMarkerBody(), { status: 200, headers: { ETag: '"v1"' } })
    );
    const first = (await provider.readControlFile(MARKER)) as any;

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const second = await provider.readControlFile(MARKER, { ifNoneMatch: first.etag });

    expect(second).toBe('not-modified');
    expect((lastGet().init.headers as Record<string, string>)['If-None-Match']).toBe('"v1"');
  });

  it('does not send If-None-Match for an unknown set etag, and reads the new version', async () => {
    const provider = await plainConnected();
    fetchMock.mockResolvedValueOnce(
      new Response(freshMarkerBody(), { status: 200, headers: { ETag: '"v1"' } })
    );
    await provider.readControlFile(MARKER);

    fetchMock.mockResolvedValueOnce(
      new Response(freshMarkerBody(), { status: 200, headers: { ETag: '"v2"' } })
    );
    const next = (await provider.readControlFile(MARKER, { ifNoneMatch: 'something-else' })) as any;

    expect((lastGet().init.headers as Record<string, string>)['If-None-Match']).toBeUndefined();
    expect(next.nodes[0].etag).toBe('"v2"');
  });

  it('falls back to Last-Modified, then a body fingerprint, when there is no ETag', async () => {
    const provider = await plainConnected();
    fetchMock.mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: { 'Last-Modified': 'Mon, 12 Oct 2026 09:00:00 GMT' }
      })
    );
    const byDate = (await provider.readControlFile(MARKER)) as any;
    expect(byDate.nodes[0].etag).toBe('Mon, 12 Oct 2026 09:00:00 GMT');

    fetchMock.mockResolvedValueOnce(new Response('{"a":1}', { status: 200 }));
    const byBody = (await provider.readControlFile(MARKER)) as any;
    expect(byBody.nodes[0].etag).toMatch(/^len7-[0-9a-f]+$/);
    expect(byBody.nodes[0].modified).toBeUndefined();
  });

  it('returns null for 404', async () => {
    const provider = await plainConnected();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await provider.readControlFile(MARKER)).toBeNull();
  });

  it('throws an auth ProviderError for 401', async () => {
    const provider = await plainConnected();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    const err = await provider.readControlFile(MARKER).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.isAuthError).toBe(true);
  });

  it('throws an auth ProviderError when not connected', async () => {
    const provider = await freshProvider();
    await expect(provider.readControlFile(MARKER)).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
      isAuthError: true
    });
  });

  it('throws a network ProviderError when the request fails', async () => {
    const provider = await plainConnected();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(provider.readControlFile(MARKER)).rejects.toMatchObject({
      isAuthError: false,
      isNetworkError: true
    });
  });

  it('a fresh marker makes serverCompilesMetadata true on a plain WebDAV (false before)', async () => {
    const provider = await plainConnected();
    expect(provider.getStatus().serverCompilesMetadata).toBeFalsy();

    fetchMock.mockResolvedValueOnce(
      new Response(freshMarkerBody(), { status: 200, headers: { ETag: '"v1"' } })
    );
    await ingestMarkerRead('webdav', await provider.readControlFile(MARKER));

    const status = provider.getStatus();
    expect(status.serverCompilesMetadata).toBe(true);
    expect(status.cloudBunko?.fresh).toBe(true);
  });
});

describe('WebDAVProvider Allow verdict on a known mokuro-bunko', () => {
  // bunko <= 0.7 answers a collection OPTIONS with no PUT or MKCOL in Allow;
  // its permissions are decided per request, so Allow must not demote it.
  const BUNKO_COLLECTION_ALLOW =
    'OPTIONS, HEAD, GET, PROPFIND, DELETE, COPY, MOVE, PROPPATCH, LOCK, UNLOCK';

  function optionsAnswer(allow: string, put: string | null) {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'OPTIONS') {
        return new Response('', {
          status: 200,
          headers: { Allow: allow, ...(put ? { 'X-Mokuro-Put': put } : {}) }
        });
      }
      return new Response('', { status: 404 });
    });
  }

  it('an OPTIONS answering X-Mokuro-Put: verified skips the Allow verdict', async () => {
    optionsAnswer(BUNKO_COLLECTION_ALLOW, 'verified');
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });

    await provider.login({ serverUrl: 'https://host', username: 'u', password: 'pw' });

    expect(provider.isReadOnly).toBe(false);
    expect(provider.getStatus().serverCompilesMetadata).toBe(true);
  });

  it('a recorded PUT_VERIFIED skips the PROPFIND and OPTIONS probes entirely', async () => {
    localStorage.setItem('webdav_put_verified', 'https://host');
    optionsAnswer(BUNKO_COLLECTION_ALLOW, null);
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });

    await provider.login({ serverUrl: 'https://host', username: 'u', password: 'pw' });

    const methods = fetchMock.mock.calls.map((c) => c[1]?.method);
    expect(methods).not.toContain('PROPFIND');
    expect(methods).not.toContain('OPTIONS');
    expect(provider.isReadOnly).toBe(false);
    expect(provider.getStatus().serverCompilesMetadata).toBe(true);
  });

  it('a generic server whose Allow lacks PUT is still read-only', async () => {
    optionsAnswer(BUNKO_COLLECTION_ALLOW, null);
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });

    await provider.login({ serverUrl: 'https://host', username: 'u', password: 'pw' });

    expect(provider.isReadOnly).toBe(true);
    expect(provider.getStatus().serverCompilesMetadata).toBe(false);
  });
});

describe('WebDAVProvider listing of reading history', () => {
  it('lists history/<device>/ files by relative path and ignores look-alikes elsewhere', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    await provider.login({ serverUrl: 'https://host' });
    const lastmod = 'Mon, 05 Oct 2026 00:00:00 GMT';
    mockClient.getDirectoryContents.mockResolvedValue([
      {
        type: 'file',
        filename: '/mokuro-reader/history/dev-a/2026-10.events',
        basename: '2026-10.events',
        lastmod,
        size: 10
      },
      {
        type: 'file',
        filename: '/mokuro-reader/Series/device.json',
        basename: 'device.json',
        lastmod,
        size: 5
      },
      {
        type: 'file',
        filename: '/mokuro-reader/Series/2026-10.events',
        basename: '2026-10.events',
        lastmod,
        size: 5
      }
    ]);

    const files = await provider.listCloudVolumes();

    expect(files.map((f) => f.path)).toEqual(['history/dev-a/2026-10.events']);
  });
});

describe('WebDAVProvider getStatus().historySync (per-user reading history)', () => {
  const PER_USER = ['volume-data.json', 'profiles.json', 'goals.json', 'history/'];

  it.each([
    ['0.7.1', PER_USER, false],
    ['0.7.3', PER_USER, false],
    ['0.8.0', PER_USER, true],
    ['0.8.0-beta.1', PER_USER, true],
    ['0.8.0', ['volume-data.json', 'profiles.json', 'goals.json'], false],
    ['0.8.0', undefined, false],
    [undefined, PER_USER, false],
    [undefined, undefined, false]
  ])(
    'bunko reporting version %s, per_user_files %j -> %s',
    async (version, perUserFiles, expected) => {
      const provider = await freshProvider();
      identityMock.mockResolvedValue({
        ...authenticatedIdentity(),
        ...(version ? { serverVersion: version } : {}),
        ...(perUserFiles ? { perUserFiles } : {})
      });
      await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
      expect(provider.getStatus().historySync).toBe(expected);
    }
  );

  it('anonymous bunko follows its reported version and per-user files too', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({
      kind: 'anonymous',
      serverVersion: '0.8.0',
      perUserFiles: PER_USER
    });
    await provider.login({ serverUrl: 'https://host' });
    expect(provider.getStatus().historySync).toBe(true);
  });

  it('anonymous bunko 0.7.1 does not', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({
      kind: 'anonymous',
      serverVersion: '0.7.1',
      perUserFiles: PER_USER
    });
    await provider.login({ serverUrl: 'https://host' });
    expect(provider.getStatus().historySync).toBe(false);
  });

  it('a plain WebDAV server is not restricted (history files are just files there)', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    await provider.login({ serverUrl: 'https://host' });
    expect(provider.getStatus().historySync).toBeUndefined();
  });
});

describe('WebDAVProvider getStatus().positionsSync (per-user positions.json)', () => {
  it('bunko listing positions.json in per_user_files -> true', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({
      ...authenticatedIdentity(),
      perUserFiles: ['volume-data.json', 'positions.json']
    });
    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    expect(provider.getStatus().positionsSync).toBe(true);
  });

  it('bunko not listing it, or listing nothing -> false', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ ...authenticatedIdentity(), perUserFiles: ['goals.json'] });
    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    expect(provider.getStatus().positionsSync).toBe(false);

    const old = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'anonymous' });
    await old.login({ serverUrl: 'https://host' });
    expect(old.getStatus().positionsSync).toBe(false);
  });

  // Unlike historySync, no version floor: the per-user mapping alone decides.
  it.each([['0.7.3'], ['0.8.0'], [undefined]])(
    'bunko reporting version %s and listing it -> true, whatever historySync says',
    async (version) => {
      const provider = await freshProvider();
      identityMock.mockResolvedValue({
        ...authenticatedIdentity(),
        ...(version ? { serverVersion: version } : {}),
        perUserFiles: ['volume-data.json', 'positions.json']
      });
      await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
      expect(provider.getStatus().positionsSync).toBe(true);
      expect(provider.getStatus().historySync).toBe(false);
    }
  );

  it('anonymous bunko listing it -> true', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'anonymous', perUserFiles: ['positions.json'] });
    await provider.login({ serverUrl: 'https://host' });
    expect(provider.getStatus().positionsSync).toBe(true);
  });

  it('a plain WebDAV server -> undefined', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    await provider.login({ serverUrl: 'https://host' });
    expect(provider.getStatus().positionsSync).toBeUndefined();
  });
});

// bunko can be upgraded or rolled back while a tab stays open; the gates must
// follow what the server keeps per user NOW, or a rolled-back 0.7.x would take
// history, positions and edit layers into its SHARED library.
describe('WebDAVProvider refreshIdentity() (the server changed under an open session)', () => {
  const V08 = {
    ...authenticatedIdentity(),
    serverVersion: '0.8.0',
    perUserFiles: ['volume-data.json', 'positions.json', 'history/'],
    perUserLayers: ['edit']
  };
  const V073 = { ...authenticatedIdentity(), serverVersion: '0.7.3' };
  const gates = (provider: WebDAVProvider) => {
    const { historySync, positionsSync, editLayerSync } = provider.getStatus();
    return { historySync, positionsSync, editLayerSync };
  };

  it('a rollback to 0.7.3 turns history, positions and edit-layer sync off', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue(V08);
    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    expect(gates(provider)).toEqual({
      historySync: true,
      positionsSync: true,
      editLayerSync: 'push'
    });

    identityMock.mockResolvedValue(V073);
    await provider.refreshIdentity();
    expect(gates(provider)).toEqual({
      historySync: false,
      positionsSync: false,
      editLayerSync: 'local'
    });
  });

  it('an upgrade to 0.8 turns them on without a reload', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue(V073);
    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    identityMock.mockResolvedValue(V08);
    await provider.refreshIdentity();
    expect(gates(provider)).toEqual({
      historySync: true,
      positionsSync: true,
      editLayerSync: 'push'
    });
  });

  it('an anonymous session follows the server too', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'anonymous', perUserLayers: ['edit'] });
    await provider.login({ serverUrl: 'https://host' });
    expect(provider.getStatus().editLayerSync).toBe('push');
    identityMock.mockResolvedValue({ kind: 'anonymous', serverVersion: '0.7.3' });
    await provider.refreshIdentity();
    expect(provider.getStatus().editLayerSync).toBe('local');
    expect(provider.isReadOnly).toBe(true);
  });

  it('maxAgeMs skips an identity fresher than that, and asks once it is older', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const provider = await freshProvider();
      identityMock.mockResolvedValue(V08);
      await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
      identityMock.mockClear();
      identityMock.mockResolvedValue(V073);

      now.mockReturnValue(1_000_000 + 60_000);
      await provider.refreshIdentity({ maxAgeMs: 5 * 60_000 });
      expect(identityMock).not.toHaveBeenCalled();

      now.mockReturnValue(1_000_000 + 6 * 60_000);
      await provider.refreshIdentity({ maxAgeMs: 5 * 60_000 });
      expect(identityMock).toHaveBeenCalledTimes(1);
      expect(provider.getStatus().editLayerSync).toBe('local');
    } finally {
      now.mockRestore();
    }
  });

  it('a failed refresh keeps what the server said last', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue(V08);
    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    await provider.refreshIdentity();
    expect(gates(provider)).toEqual({
      historySync: true,
      positionsSync: true,
      editLayerSync: 'push'
    });
  });
});

describe('WebDAVProvider getStatus().editLayerSync / curatedPublish (bunko 0.8 layers)', () => {
  it('a bunko listing `edit` in per_user_layers keeps edit layers per account -> push', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({
      ...authenticatedIdentity(),
      serverVersion: '0.8.0',
      perUserLayers: ['edit']
    });
    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    expect(provider.getStatus().editLayerSync).toBe('push');
  });

  it('a 0.7.3 bunko (no per_user_layers) would share them with every account -> local', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ ...authenticatedIdentity(), serverVersion: '0.7.3' });
    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    expect(provider.getStatus().editLayerSync).toBe('local');

    const other = await freshProvider();
    identityMock.mockResolvedValue({ ...authenticatedIdentity(), perUserLayers: ['notes'] });
    await other.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    expect(other.getStatus().editLayerSync).toBe('local');
  });

  it('anonymous bunko follows its per_user_layers too', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'anonymous', perUserLayers: ['edit'] });
    await provider.login({ serverUrl: 'https://host' });
    expect(provider.getStatus().editLayerSync).toBe('push');

    const old = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'anonymous' });
    await old.login({ serverUrl: 'https://host' });
    expect(old.getStatus().editLayerSync).toBe('local');
  });

  it('a bunko known only by its verified PUTs (identity failed) -> local', async () => {
    localStorage.setItem('webdav_put_verified', 'https://host');
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    await provider.login({ serverUrl: 'https://host/', username: 'u', password: 'pw' });
    expect(provider.getStatus().editLayerSync).toBe('local');
  });

  it('a plain WebDAV server -> undefined (its edit layer is the user’s own file)', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    await provider.login({ serverUrl: 'https://host' });
    expect(provider.getStatus().editLayerSync).toBeUndefined();
    expect(provider.getStatus().curatedPublish).toBeUndefined();
  });

  it.each(['all', 'owned', 'none'] as const)(
    'curatedPublish is the identity’s curated scope (%s)',
    async (scope) => {
      const provider = await freshProvider();
      identityMock.mockResolvedValue({
        ...authenticatedIdentity(),
        permissions: { ...REGISTERED_PERMS, curated: { scope } }
      });
      await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
      expect(provider.getStatus().curatedPublish).toBe(scope);
    }
  );

  it('a bunko that reports no curated scope -> undefined', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue(authenticatedIdentity());
    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    expect(provider.getStatus().curatedPublish).toBeUndefined();
  });

  it('logout forgets both', async () => {
    const provider = await freshProvider();
    identityMock.mockResolvedValue({
      ...authenticatedIdentity(),
      permissions: { ...REGISTERED_PERMS, curated: { scope: 'all' as const } },
      perUserLayers: ['edit']
    });
    await provider.login({ serverUrl: 'https://host', username: 'alice', password: 'pw' });
    await provider.logout();
    expect(provider.getStatus().editLayerSync).toBeUndefined();
    expect(provider.getStatus().curatedPublish).toBeUndefined();
  });
});
