import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uploadFileWithClient = vi.hoisted(() => vi.fn());
vi.mock('$lib/util/sync/providers/webdav/webdav-upload', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('$lib/util/sync/providers/webdav/webdav-upload')>();
  return { ...actual, ensureFoldersExist: vi.fn(async () => {}), uploadFileWithClient };
});
/** A webdav client whose headers are real state (createClient options, then setHeaders). */
const dav = vi.hoisted(() => {
  const state = { headers: {} as Record<string, string> };
  const client = {
    exists: vi.fn(async () => false),
    deleteFile: vi.fn(async () => {}),
    getHeaders: () => ({ ...state.headers }),
    setHeaders: vi.fn((h: Record<string, string>) => {
      state.headers = { ...h };
    })
  };
  return { state, client };
});
vi.mock('webdav', () => ({
  AuthType: { Password: 'password', None: 'none' },
  createClient: (_url: string, options: { headers?: Record<string, string> }) => {
    dav.state.headers = { ...(options.headers ?? {}) };
    return dav.client;
  }
}));

import { webdavCore } from '../webdav-core';
import { WebdavUploadError } from '$lib/util/sync/providers/webdav/webdav-upload';
import { TransientAuthRefreshError } from '$lib/util/worker-auth-refresh';
import { classifyWriteError } from '$lib/util/sync/providers/webdav/webdav-errors';

const TOKEN_CREDS = { webdavUrl: 'https://bunko.example', webdavToken: 'old' };

function unauthorized() {
  return new WebdavUploadError('WebDAV upload failed: 401 Unauthorized', {
    status: 401,
    reason: 'http-401',
    detail: '401 Unauthorized',
    retryable: false
  });
}

beforeEach(() => {
  uploadFileWithClient.mockReset();
  dav.client.setHeaders.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('webdavCore.uploadFile under a bearer token', () => {
  it('sends the token, not a password', async () => {
    uploadFileWithClient.mockImplementationOnce(async (client) => {
      expect(client.getHeaders().Authorization).toBe('Bearer old');
      return { path: '/mokuro-reader/S/V.mokuro' };
    });
    await webdavCore.uploadFile({
      seriesTitle: 'S',
      filename: 'V.mokuro',
      blob: new Blob(['x']),
      credentials: TOKEN_CREDS
    });
  });

  it('a 401 asks for fresh credentials once and retries the whole upload with them', async () => {
    const seen: string[] = [];
    uploadFileWithClient.mockImplementation(async (client) => {
      seen.push(client.getHeaders().Authorization);
      if (seen.length === 1) throw unauthorized();
      return { path: '/mokuro-reader/S/V.cbz' };
    });
    const refreshAuth = vi.fn(async () => ({ ...TOKEN_CREDS, webdavToken: 'new' }));
    await expect(
      webdavCore.uploadFile({
        seriesTitle: 'S',
        filename: 'V.cbz',
        blob: new Blob(['x']),
        credentials: TOKEN_CREDS,
        refreshAuth
      })
    ).resolves.toEqual({ fileId: '/mokuro-reader/S/V.cbz' });
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(refreshAuth).toHaveBeenCalledWith('Bearer old');
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
  });

  it('a refused refresh (null) leaves the 401 standing, no second attempt', async () => {
    uploadFileWithClient.mockRejectedValue(unauthorized());
    const refreshAuth = vi.fn(async () => null);
    await expect(
      webdavCore.uploadFile({
        seriesTitle: 'S',
        filename: 'V.cbz',
        blob: new Blob(['x']),
        credentials: TOKEN_CREDS,
        refreshAuth
      })
    ).rejects.toThrow('401');
    expect(uploadFileWithClient).toHaveBeenCalledTimes(1);
  });

  it('retries at most once even if the fresh token is refused too', async () => {
    uploadFileWithClient.mockRejectedValue(unauthorized());
    const refreshAuth = vi.fn(async () => ({ ...TOKEN_CREDS, webdavToken: 'new' }));
    await expect(
      webdavCore.uploadFile({
        seriesTitle: 'S',
        filename: 'V.cbz',
        blob: new Blob(['x']),
        credentials: TOKEN_CREDS,
        refreshAuth
      })
    ).rejects.toThrow('401');
    expect(uploadFileWithClient).toHaveBeenCalledTimes(2);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
  });

  it('a TRANSIENT refresh failure fails the upload with that error, never the 401', async () => {
    uploadFileWithClient.mockRejectedValue(unauthorized());
    const refreshAuth = vi.fn(async () => {
      throw new TransientAuthRefreshError();
    });
    const error = await webdavCore
      .uploadFile({
        seriesTitle: 'S',
        filename: 'V.cbz',
        blob: new Blob(['x']),
        credentials: TOKEN_CREDS,
        refreshAuth
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientAuthRefreshError);
    expect(classifyWriteError((error as Error).message)).toBe('other');
    expect((error as { status?: number }).status).toBeUndefined();
    expect(uploadFileWithClient).toHaveBeenCalledTimes(1);
  });

  it('a 401 under Basic is final, exactly as before (no refresh)', async () => {
    uploadFileWithClient.mockRejectedValue(unauthorized());
    const refreshAuth = vi.fn();
    await expect(
      webdavCore.uploadFile({
        seriesTitle: 'S',
        filename: 'V.cbz',
        blob: new Blob(['x']),
        credentials: { webdavUrl: 'https://dav.example', webdavPassword: 'pw' },
        refreshAuth
      })
    ).rejects.toThrow('401');
    expect(refreshAuth).not.toHaveBeenCalled();
  });
});

describe('webdavCore.downloadFile under a bearer token', () => {
  it('a 401 is retried once with the fresh token', async () => {
    const auths: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (init?.method === 'HEAD') return new Response(null, { status: 401 });
      auths.push(auth);
      return auth === 'Bearer new'
        ? new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'Content-Length': '3' }
          })
        : new Response('', { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const refreshAuth = vi.fn(async () => ({ ...TOKEN_CREDS, webdavToken: 'new' }));
    const buffer = await webdavCore.downloadFile({
      fileId: '/mokuro-reader/S/V.cbz',
      credentials: TOKEN_CREDS,
      onProgress: () => {},
      refreshAuth
    });
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(auths).toEqual(['Bearer old', 'Bearer new']);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
  });

  it('without fresh credentials the 401 fails the download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401, statusText: 'Unauthorized' }))
    );
    await expect(
      webdavCore.downloadFile({
        fileId: '/mokuro-reader/S/V.cbz',
        credentials: TOKEN_CREDS,
        onProgress: () => {},
        refreshAuth: async () => null
      })
    ).rejects.toThrow('401');
  });

  it('a TRANSIENT refresh failure fails the download at once with that error, never the 401', async () => {
    const fetchMock = vi.fn(
      async () => new Response('', { status: 401, statusText: 'Unauthorized' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const error = await webdavCore
      .downloadFile({
        fileId: '/mokuro-reader/S/V.cbz',
        credentials: TOKEN_CREDS,
        onProgress: () => {},
        refreshAuth: async () => {
          throw new TransientAuthRefreshError();
        }
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientAuthRefreshError);
    expect(classifyWriteError((error as Error).message)).toBe('other');
    expect(fetchMock).toHaveBeenCalledTimes(2); // HEAD + one GET: no backoff loop
  });

  it('revalidates every HEAD and GET (cache: no-cache): a stale cached sidecar is never served', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Length': '3' }
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    await webdavCore.downloadFile({
      fileId: '/mokuro-reader/S/V.mokuro',
      credentials: TOKEN_CREDS,
      onProgress: () => {}
    });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of calls) expect(init.cache).toBe('no-cache');
  });
});
