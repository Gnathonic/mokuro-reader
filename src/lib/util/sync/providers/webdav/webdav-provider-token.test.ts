import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchServerIdentity } from './identity';
import { basicAuthHeader } from '$lib/util/base64';

/**
 * Bearer tokens on a mokuro-bunko WebDAV session: issued at connect, held in
 * localStorage beside the password, replaced silently (single-flight) when the
 * server refuses them, and the existing auth-failed flow only when the
 * password itself is refused.
 */

const { mockClient, clientHeaders, mockCore, createClientMock, snackbar } = vi.hoisted(() => {
  const clientHeaders = { current: {} as Record<string, string> };
  const mockClient = {
    getDirectoryContents: vi.fn(),
    exists: vi.fn(),
    createDirectory: vi.fn(),
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
    stat: vi.fn(),
    getQuota: vi.fn(),
    getHeaders: vi.fn(() => ({ ...clientHeaders.current })),
    setHeaders: vi.fn((h: Record<string, string>) => {
      clientHeaders.current = { ...h };
    })
  };
  const mockCore = { uploadFile: vi.fn(), downloadFile: vi.fn() };
  const createClientMock = vi.fn((_url: string, options: { headers?: Record<string, string> }) => {
    clientHeaders.current = { ...(options.headers ?? {}) };
    return mockClient;
  });
  const snackbar = vi.fn();
  return { mockClient, clientHeaders, mockCore, createClientMock, snackbar };
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
vi.mock('../../provider-manager', () => ({ providerManager: { updateStatus: vi.fn() } }));
vi.mock('../../cache-manager', () => ({ cacheManager: { registerCache: vi.fn() } }));
vi.mock('./webdav-cache', () => ({ webdavCache: {} }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: snackbar }));

import { WebDAVProvider } from './webdav-provider';
import { answerAuthRefresh } from '$lib/util/worker-auth-refresh';

const identityMock = vi.mocked(fetchServerIdentity);
const SERVER = 'https://host';
const ENDPOINT = 'https://host/login/api/token';
const DAY = 24 * 60 * 60 * 1000;

/** The token endpoint's next answers, in order (the last one repeats). */
let tokenAnswers: Array<() => Response>;
let issued = 0;
const fetchMock = vi.fn();

function issue(expiresInMs = 90 * DAY): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        token: `tok-${++issued}`,
        token_type: 'Bearer',
        kind: 'reader',
        expires_at: (Date.now() + expiresInMs) / 1000,
        user: { username: 'alice', role: 'registered' }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
}
const refuse = () =>
  new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 });
const limit = () => new Response(JSON.stringify({ error: 'Too many' }), { status: 429 });
const absent = () => new Response('Not Found', { status: 404 });

function tokenPosts() {
  return fetchMock.mock.calls.filter((c) => c[0] === ENDPOINT && c[1]?.method === 'POST');
}
function tokenDeletes() {
  return fetchMock.mock.calls.filter((c) => c[0] === ENDPOINT && c[1]?.method === 'DELETE');
}

function authenticated() {
  return {
    kind: 'authenticated' as const,
    username: 'alice',
    role: 'registered',
    permissions: { canWriteProgress: true, canAddFiles: true, canModifyDelete: false },
    endpoint: 'https://host/login/api/me'
  };
}

function unauthorizedError() {
  return Object.assign(new Error('Invalid response: 401 Unauthorized'), { status: 401 });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  issued = 0;
  tokenAnswers = [issue()];
  clientHeaders.current = {};
  mockClient.getDirectoryContents.mockResolvedValue([]);
  mockClient.exists.mockResolvedValue(true);
  mockClient.createDirectory.mockResolvedValue(undefined);
  identityMock.mockResolvedValue(authenticated());
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === ENDPOINT && init?.method === 'POST') {
      const answer = tokenAnswers.length > 1 ? tokenAnswers.shift()! : tokenAnswers[0];
      return answer();
    }
    if (url === ENDPOINT && init?.method === 'DELETE') {
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    }
    return new Response('', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

async function connected(): Promise<WebDAVProvider> {
  const provider = new WebDAVProvider();
  await provider.whenReady();
  await provider.login({ serverUrl: SERVER, username: 'alice', password: 'pw' });
  return provider;
}

/** A provider restored at app start from what `connected()` stored. */
async function restored(): Promise<WebDAVProvider> {
  localStorage.setItem('active_cloud_provider', 'webdav');
  const provider = new WebDAVProvider();
  await provider.whenReady();
  return provider;
}

describe('token acquisition at connect', () => {
  it('trades the password for a reader token on a bunko server and switches to Bearer', async () => {
    const provider = await connected();

    expect(tokenPosts()).toHaveLength(1);
    const body = JSON.parse(tokenPosts()[0][1].body);
    expect(body).toMatchObject({ username: 'alice', password: 'pw', kind: 'reader' });
    expect(body.label).toMatch(/^mokuro-reader/);

    expect(localStorage.getItem('webdav_token')).toBe('tok-1');
    expect(localStorage.getItem('webdav_token_endpoint')).toBe(ENDPOINT);
    expect(localStorage.getItem('webdav_token_account')).toBe('https://host/|alice');
    expect(Number(localStorage.getItem('webdav_token_expires_at'))).toBeGreaterThan(Date.now());
    // The owner's choice: the password stays stored so a dead token is replaced silently.
    expect(localStorage.getItem('webdav_password')).toBe('pw');

    expect(provider.authorizationHeader()).toBe('Bearer tok-1');
    expect(clientHeaders.current.Authorization).toBe('Bearer tok-1');
    // The OPTIONS probe after the token went out under it.
    const options = fetchMock.mock.calls.find((c) => c[1]?.method === 'OPTIONS')!;
    expect(options[1].headers.Authorization).toBe('Bearer tok-1');
  });

  it('hands workers the token and NOT the password', async () => {
    const provider = await connected();
    const upload = await provider.getWorkerUploadCredentials();
    const download = await provider.getWorkerDownloadCredentials('/x');
    for (const creds of [upload, download]) {
      expect(creds.webdavToken).toBe('tok-1');
      expect(creds.webdavPassword).toBeUndefined();
      expect(creds.webdavUrl).toBe(SERVER);
    }
  });

  it('keeps Basic on a bunko without the endpoint, and does not ask again this session', async () => {
    tokenAnswers = [absent];
    const provider = await connected();
    expect(tokenPosts()).toHaveLength(1);
    expect(localStorage.getItem('webdav_token')).toBeNull();
    expect(provider.authorizationHeader()).toBe(basicAuthHeader('alice', 'pw'));
    expect(clientHeaders.current.Authorization).toBe(basicAuthHeader('alice', 'pw'));
    const creds = await provider.getWorkerUploadCredentials();
    expect(creds.webdavPassword).toBe('pw');
    expect(creds.webdavToken).toBeUndefined();
  });

  it('never asks a generic WebDAV server (identity unsupported) for a token', async () => {
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    const provider = await connected();
    expect(tokenPosts()).toHaveLength(0);
    expect(provider.authorizationHeader()).toBe(basicAuthHeader('alice', 'pw'));
  });

  it('a rate-limited or unreachable token request does not fail the connection', async () => {
    tokenAnswers = [limit];
    const provider = await connected();
    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.authorizationHeader()).toBe(basicAuthHeader('alice', 'pw'));
  });

  it('a restore reuses the held token: no password sent, no new token', async () => {
    await connected();
    fetchMock.mockClear();
    identityMock.mockClear();
    const provider = await restored();
    expect(provider.isAuthenticated()).toBe(true);
    expect(tokenPosts()).toHaveLength(0);
    // identity checked under the token
    expect(identityMock).toHaveBeenCalledWith(SERVER, 'alice', 'pw', undefined, 'tok-1');
    expect(createClientMock.mock.calls.at(-1)![1].headers?.Authorization).toBe('Bearer tok-1');
  });
});

describe('expiry-driven renewal at connect', () => {
  it('replaces a token with fewer than 7 days left and signs the old one out', async () => {
    tokenAnswers = [issue(3 * DAY), issue()];
    await connected();
    expect(localStorage.getItem('webdav_token')).toBe('tok-1');
    fetchMock.mockClear();

    const provider = await restored();
    expect(tokenPosts()).toHaveLength(1);
    expect(localStorage.getItem('webdav_token')).toBe('tok-2');
    expect(provider.authorizationHeader()).toBe('Bearer tok-2');
    expect(tokenDeletes()).toHaveLength(1);
    expect(tokenDeletes()[0][1].headers.Authorization).toBe('Bearer tok-1');
  });

  it('leaves a token with weeks left alone', async () => {
    tokenAnswers = [issue(30 * DAY)];
    await connected();
    fetchMock.mockClear();
    await restored();
    expect(tokenPosts()).toHaveLength(0);
  });

  it('a token the server refuses at restore is re-issued from the password, then identity again', async () => {
    tokenAnswers = [issue(), issue()];
    await connected();
    fetchMock.mockClear();
    identityMock.mockReset();
    identityMock
      .mockResolvedValueOnce({ kind: 'invalid-credentials' }) // tok-1 revoked server-side
      .mockResolvedValue(authenticated());
    const provider = await restored();
    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.getStatus().needsAttention).toBe(false);
    expect(tokenPosts()).toHaveLength(1);
    expect(identityMock.mock.calls.map((c) => c[4])).toEqual(['tok-1', 'tok-2']);
    expect(localStorage.getItem('webdav_password')).toBe('pw');
  });

  it('a refused re-issue at restore runs the auth-failed flow', async () => {
    tokenAnswers = [issue(), refuse];
    await connected();
    identityMock.mockReset();
    identityMock.mockResolvedValue({ kind: 'invalid-credentials' });
    const provider = await restored();
    expect(provider.isAuthenticated()).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(true);
    expect(localStorage.getItem('webdav_password')).toBeNull();
    expect(localStorage.getItem('webdav_token')).toBeNull();
    expect(localStorage.getItem('webdav_server_url')).toBe(SERVER); // form pre-fills
  });
});

describe('a 401 under the token: re-issue once, retry once', () => {
  it('re-issues silently and retries the refused client request', async () => {
    tokenAnswers = [issue(), issue()];
    const provider = await connected();
    mockClient.exists.mockClear();
    mockClient.exists.mockRejectedValueOnce(unauthorizedError()).mockResolvedValue(true);

    await expect(provider.listCloudVolumes()).resolves.toEqual([]);

    expect(tokenPosts()).toHaveLength(2); // connect + one re-issue
    expect(mockClient.exists).toHaveBeenCalledTimes(2);
    expect(clientHeaders.current.Authorization).toBe('Bearer tok-2');
    expect(localStorage.getItem('webdav_token')).toBe('tok-2');
    expect(provider.getStatus().needsAttention).toBe(false);
  });

  it('concurrent refusals share ONE re-issue', async () => {
    tokenAnswers = [issue(), issue()];
    const provider = await connected();
    const results = await Promise.all([
      provider.reissueAfterUnauthorized('Bearer tok-1'),
      provider.reissueAfterUnauthorized('Bearer tok-1'),
      provider.refreshedWorkerCredentials('Bearer tok-1')
    ]);
    expect(results[0]).toBe(true);
    expect(results[1]).toBe(true);
    expect(results[2]).toMatchObject({ webdavToken: 'tok-2' });
    expect(tokenPosts()).toHaveLength(2);
    // A straggler that still carried tok-1 is told to retry, without another POST.
    expect(await provider.reissueAfterUnauthorized('Bearer tok-1')).toBe(true);
    expect(tokenPosts()).toHaveLength(2);
  });

  it('a refused re-issue runs the existing auth-failed flow and the request fails', async () => {
    tokenAnswers = [issue(), refuse];
    const provider = await connected();
    mockClient.deleteFile.mockRejectedValue(unauthorizedError());

    await expect(
      provider.deleteFile({
        provider: 'webdav',
        fileId: '/mokuro-reader/S/V.cbz',
        path: 'S/V.cbz',
        modifiedTime: '',
        size: 1
      })
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });

    expect(tokenPosts()).toHaveLength(2);
    expect(mockClient.deleteFile).toHaveBeenCalledTimes(1); // no retry without a token
    expect(provider.getStatus().needsAttention).toBe(true);
    expect(localStorage.getItem('webdav_password')).toBeNull();
    expect(localStorage.getItem('webdav_token')).toBeNull();
    expect(localStorage.getItem('webdav_username')).toBe('alice');
  });

  it('a rate-limited re-issue surfaces a notice and does not loop', async () => {
    tokenAnswers = [issue(), limit];
    const provider = await connected();
    expect(await provider.reissueAfterUnauthorized('Bearer tok-1')).toBe(false);
    expect(await provider.reissueAfterUnauthorized('Bearer tok-1')).toBe(false);
    expect(tokenPosts()).toHaveLength(2); // the second is held back by the cooldown
    await vi.waitFor(() => expect(snackbar).toHaveBeenCalledTimes(1));
    expect(provider.getStatus().needsAttention).toBe(false);
    expect(localStorage.getItem('webdav_password')).toBe('pw');
  });

  it('a server that stopped issuing tokens falls back to Basic and retries', async () => {
    tokenAnswers = [issue(), absent];
    const provider = await connected();
    expect(await provider.reissueAfterUnauthorized('Bearer tok-1')).toBe(true);
    expect(provider.authorizationHeader()).toBe(basicAuthHeader('alice', 'pw'));
    expect(clientHeaders.current.Authorization).toBe(basicAuthHeader('alice', 'pw'));
    // later stragglers retry under Basic without asking the server again
    expect(await provider.reissueAfterUnauthorized('Bearer tok-1')).toBe(true);
    expect(tokenPosts()).toHaveLength(2);
  });

  it('never re-issues for a refused Basic header', async () => {
    tokenAnswers = [absent];
    const provider = await connected();
    expect(await provider.reissueAfterUnauthorized(basicAuthHeader('alice', 'pw'))).toBe(false);
    expect(tokenPosts()).toHaveLength(1);
  });

  it('main-thread uploads and downloads hand the core the shared refresher', async () => {
    tokenAnswers = [issue(), issue()];
    const provider = await connected();
    mockCore.downloadFile.mockImplementation(async ({ credentials, refreshAuth }) => {
      expect(credentials.webdavToken).toBe('tok-1');
      const fresh = await refreshAuth('Bearer tok-1');
      expect(fresh.webdavToken).toBe('tok-2');
      return new ArrayBuffer(1);
    });
    await provider.downloadFile({
      provider: 'webdav',
      fileId: '/mokuro-reader/S/V.cbz',
      path: 'S/V.cbz',
      modifiedTime: '',
      size: 1
    });
    expect(tokenPosts()).toHaveLength(2);
  });
});

describe('workers', () => {
  it("a worker's refresh request is answered by the provider's single-flight re-issue", async () => {
    tokenAnswers = [issue(), issue()];
    // The module-level provider registers itself as the 'webdav' refresher.
    const { webdavProvider } = await import('./webdav-provider');
    await webdavProvider.login({ serverUrl: SERVER, username: 'alice', password: 'pw' });
    const before = tokenPosts().length;
    const stale = `Bearer ${localStorage.getItem('webdav_token')}`;
    const answers = await Promise.all(
      [1, 2, 3].map((requestId) =>
        answerAuthRefresh({
          type: 'auth-refresh',
          requestId,
          provider: 'webdav',
          staleAuthorization: stale
        })
      )
    );
    expect(tokenPosts().length - before).toBe(1);
    const fresh = localStorage.getItem('webdav_token');
    for (const answer of answers) {
      expect(answer.credentials).toMatchObject({ webdavToken: fresh });
      expect(answer.credentials).not.toHaveProperty('webdavPassword');
    }
  });
});

describe('sign-out and account changes', () => {
  it('logout revokes the token on its server, then forgets it', async () => {
    const provider = await connected();
    await provider.logout();
    expect(tokenDeletes()).toHaveLength(1);
    expect(tokenDeletes()[0][1].headers.Authorization).toBe('Bearer tok-1');
    for (const key of [
      'webdav_token',
      'webdav_token_expires_at',
      'webdav_token_endpoint',
      'webdav_token_account'
    ]) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  it('connecting as another user drops (and revokes) the old token', async () => {
    tokenAnswers = [issue(), issue()];
    const provider = await connected();
    await provider.login({ serverUrl: SERVER, username: 'bob', password: 'pw2' });
    expect(tokenDeletes()).toHaveLength(1);
    expect(tokenDeletes()[0][1].headers.Authorization).toBe('Bearer tok-1');
    expect(localStorage.getItem('webdav_token')).toBe('tok-2');
    expect(localStorage.getItem('webdav_token_account')).toBe('https://host/|bob');
  });

  it('connecting to another server never sends it the old token', async () => {
    tokenAnswers = [issue()];
    const provider = await connected();
    identityMock.mockResolvedValue({ kind: 'unsupported' });
    fetchMock.mockClear();
    await provider.login({ serverUrl: 'https://other.example', username: 'alice', password: 'pw' });
    expect(localStorage.getItem('webdav_token')).toBeNull();
    expect(provider.authorizationHeader()).toBe(basicAuthHeader('alice', 'pw'));
    const toOther = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('https://other'));
    for (const call of toOther) {
      expect(call[1]?.headers?.Authorization ?? '').not.toMatch(/^Bearer/);
    }
    // the revoke went to the server that issued it
    expect(tokenDeletes()).toHaveLength(1);
  });

  it('a different password typed for the same account is verified, not vouched for by the token', async () => {
    const provider = await connected();
    identityMock.mockClear();
    await provider
      .login({ serverUrl: SERVER, username: 'alice', password: 'typo' })
      .catch(() => {});
    expect(identityMock.mock.calls[0][4]).toBeUndefined(); // checked with Basic, not the token
  });
});
