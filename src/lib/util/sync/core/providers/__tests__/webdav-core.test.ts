import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uploadFileWithClient = vi.hoisted(() => vi.fn());
vi.mock('$lib/util/sync/providers/webdav/webdav-upload', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('$lib/util/sync/providers/webdav/webdav-upload')>();
  return {
    ...actual,
    ensureFoldersExist: vi.fn(async () => {}),
    uploadFileWithClient
  };
});
const davClient = vi.hoisted(() => ({
  exists: vi.fn(async () => false),
  deleteFile: vi.fn(async () => {})
}));
vi.mock('webdav', () => ({
  AuthType: { Password: 'password', None: 'none' },
  createClient: () => davClient
}));

import { webdavCore } from '../webdav-core';
import { WebdavUploadError } from '$lib/util/sync/providers/webdav/webdav-upload';

const credentials = { webdavUrl: 'https://bunko.example/dav', webdavPassword: 'pw' };

function transient() {
  return new WebdavUploadError('WebDAV upload failed: 503', {
    status: 503,
    reason: 'server-error',
    detail: 'busy',
    retryable: true
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  uploadFileWithClient.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('webdavCore.uploadFile', () => {
  it('retries a transient archive failure with backoff, reporting each retry', async () => {
    uploadFileWithClient
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce({ path: '/mokuro-reader/S/V.cbz' });
    const onRetry = vi.fn();
    const done = webdavCore.uploadFile({
      seriesTitle: 'S',
      filename: 'V.cbz',
      blob: new Blob(['x']),
      credentials,
      onRetry
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(done).resolves.toEqual({ fileId: '/mokuro-reader/S/V.cbz' });
    expect(uploadFileWithClient).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls.map((c) => c[0].attempt)).toEqual([2, 3]);
  });

  it('does not retry a sidecar or progress file (a single attempt, verdict still applied)', async () => {
    uploadFileWithClient.mockRejectedValueOnce(transient());
    await expect(
      webdavCore.uploadFile({
        seriesTitle: 'S',
        filename: 'V.mokuro',
        blob: new Blob(['x']),
        credentials
      })
    ).rejects.toThrow('503');
    expect(uploadFileWithClient).toHaveBeenCalledTimes(1);
  });

  it('surfaces a refusal at once', async () => {
    uploadFileWithClient.mockRejectedValueOnce(
      new WebdavUploadError('WebDAV upload failed: 422 (archive-damaged: bad CRC)', {
        status: 422,
        reason: 'archive-damaged',
        detail: 'bad CRC',
        retryable: false
      })
    );
    await expect(
      webdavCore.uploadFile({
        seriesTitle: 'S',
        filename: 'V.cbz',
        blob: new Blob(['x']),
        credentials
      })
    ).rejects.toThrow('bad CRC');
    expect(uploadFileWithClient).toHaveBeenCalledTimes(1);
  });
});

describe('webdavCore.uploadFile delete-before-PUT', () => {
  beforeEach(() => {
    davClient.exists.mockReset().mockResolvedValue(true);
    davClient.deleteFile.mockReset().mockResolvedValue(undefined);
    uploadFileWithClient.mockResolvedValue({ path: '/mokuro-reader/S/V.cbz' });
  });

  it('issues no exists-check or DELETE for a server whose PUTs are staged and verified', async () => {
    await webdavCore.uploadFile({
      seriesTitle: 'S',
      filename: 'V.cbz',
      blob: new Blob(['x']),
      credentials: { ...credentials, webdavPutVerified: true }
    });
    expect(davClient.exists).not.toHaveBeenCalled();
    expect(davClient.deleteFile).not.toHaveBeenCalled();
    expect(uploadFileWithClient).toHaveBeenCalledTimes(1);
  });

  it('still deletes an existing file first on any other server', async () => {
    await webdavCore.uploadFile({
      seriesTitle: 'S',
      filename: 'V.cbz',
      blob: new Blob(['x']),
      credentials
    });
    expect(davClient.deleteFile).toHaveBeenCalledWith('/mokuro-reader/S/V.cbz');
    const deleteOrder = davClient.deleteFile.mock.invocationCallOrder[0];
    const putOrder = uploadFileWithClient.mock.invocationCallOrder.at(-1)!;
    expect(deleteOrder).toBeLessThan(putOrder);
  });

  it('reports a PUT response that says the server stages and verifies', async () => {
    uploadFileWithClient.mockResolvedValue({ path: '/mokuro-reader/S/V.cbz', putVerified: true });
    await expect(
      webdavCore.uploadFile({
        seriesTitle: 'S',
        filename: 'V.cbz',
        blob: new Blob(['x']),
        credentials
      })
    ).resolves.toEqual({ fileId: '/mokuro-reader/S/V.cbz', serverPutVerified: true });
  });
});

describe('webdavCore.uploadFile Content-Digest', () => {
  beforeEach(() => {
    uploadFileWithClient.mockReset();
  });

  it('computes the digest once and sends the same one on every attempt', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    uploadFileWithClient
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce({ path: '/mokuro-reader/S/V.cbz' });
    const done = webdavCore.uploadFile({
      seriesTitle: 'S',
      filename: 'V.cbz',
      blob: new Blob(['hello']),
      credentials: { ...credentials, webdavPutVerified: true }
    });
    // The digest resolves off the fake clock (real SubtleCrypto, slow under a
    // loaded run): wait in REAL time for the first attempt, then step the
    // fake clock past the retry delay. A fixed number of clock steps raced it.
    await vi.waitFor(() => expect(uploadFileWithClient).toHaveBeenCalledTimes(1), {
      timeout: 4_000
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(digest).toHaveBeenCalledTimes(1);
    const options = uploadFileWithClient.mock.calls.map((c) => c[4]);
    expect(options).toEqual([
      { contentDigest: 'sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:' },
      { contentDigest: 'sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:' }
    ]);
  });

  it('digests small non-archive bodies too', async () => {
    uploadFileWithClient.mockResolvedValueOnce({ path: '/mokuro-reader/S/V.mokuro' });
    await webdavCore.uploadFile({
      seriesTitle: 'S',
      filename: 'V.mokuro',
      blob: new Blob(['hello']),
      credentials: { ...credentials, webdavPutVerified: true }
    });
    expect(uploadFileWithClient.mock.calls[0][4]).toEqual({
      contentDigest: 'sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:'
    });
  });

  it('sends no digest to a server that has not advertised verified PUTs', async () => {
    // A cross-origin PUT's preflight must allow every request header: a plain
    // WebDAV server with a fixed Access-Control-Allow-Headers list would refuse it.
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    uploadFileWithClient.mockResolvedValueOnce({ path: '/mokuro-reader/S/V.cbz' });
    await webdavCore.uploadFile({
      seriesTitle: 'S',
      filename: 'V.cbz',
      blob: new Blob(['hello']),
      credentials
    });
    expect(digest).not.toHaveBeenCalled();
    expect(uploadFileWithClient.mock.calls[0][4]).toBeUndefined();
  });

  it('reports a digest the server verified end to end', async () => {
    uploadFileWithClient.mockResolvedValueOnce({
      path: '/mokuro-reader/S/V.cbz',
      digestVerified: 'sha-256'
    });
    await expect(
      webdavCore.uploadFile({
        seriesTitle: 'S',
        filename: 'V.cbz',
        blob: new Blob(['hello']),
        credentials: { ...credentials, webdavPutVerified: true }
      })
    ).resolves.toEqual({ fileId: '/mokuro-reader/S/V.cbz', serverDigestVerified: 'sha-256' });
  });
});

/** A `webdav`-library failure: the status, and the Response it came from. */
function davError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`Invalid response: ${status}`), {
    status,
    response: new Response(null, { status, headers })
  });
}

/** A 503 PUT failure that named its wait (`retryAfterMs`, read off the response). */
function busyFor(ms: number | undefined) {
  return new WebdavUploadError('WebDAV upload failed: 503', {
    status: 503,
    reason: 'http-503',
    detail: '503 Service Unavailable',
    retryable: true,
    retryAfterMs: ms
  });
}

describe('webdavCore.downloadFile and a 503 that names its wait (Retry-After)', () => {
  /** HEAD answers 200 (3 bytes); each GET takes the next answer, the last one repeating. */
  function stubServer(gets: Array<() => Response>) {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'Content-Length': '3' } });
      }
      const next = gets.length > 1 ? gets.shift()! : gets[0];
      return next();
    });
    vi.stubGlobal('fetch', fetchMock);
    return {
      gets: () => fetchMock.mock.calls.filter((c) => c[1]?.method !== 'HEAD').length
    };
  }
  const ok = () =>
    new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Length': '3' } });
  const busy = (retryAfter?: string) => () =>
    new Response('', {
      status: 503,
      headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter }
    });
  const download = () =>
    webdavCore.downloadFile({
      fileId: '/mokuro-reader/S/V.mokuro',
      credentials,
      onProgress: () => {}
    });

  afterEach(() => vi.unstubAllGlobals());

  it('waits the seconds the server asked, not the backoff', async () => {
    const server = stubServer([busy('3'), ok]);
    const done = download();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(server.gets()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toHaveProperty('byteLength', 3);
    expect(server.gets()).toBe(2);
  });

  it('takes the HTTP-date form too', async () => {
    const server = stubServer([busy(new Date(Date.now() + 4_000).toUTCString()), ok]);
    const done = download();
    await vi.advanceTimersByTimeAsync(2_900);
    expect(server.gets()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(done).resolves.toHaveProperty('byteLength', 3);
    expect(server.gets()).toBe(2);
  });

  it('waits at least a second for a Retry-After of 0', async () => {
    const server = stubServer([busy('0'), ok]);
    const done = download();
    await vi.advanceTimersByTimeAsync(999);
    expect(server.gets()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toHaveProperty('byteLength', 3);
  });

  it('waits a named time at most twice, then falls back to the backoff', async () => {
    const server = stubServer([busy('30')]);
    const done = download().catch((e: unknown) => e);
    // 30 s + 30 s named, then the backoff's own steps (1.6 s, 3.2 s, 5 s) and
    // its 5-retry budget: about 70 s in all, never 5 x 30 s.
    await vi.advanceTimersByTimeAsync(75_000);
    expect(server.gets()).toBe(6);
    expect(String(await done)).toContain('503');
  });

  it('keeps the backoff for a wait over 30 s, or one it cannot read', async () => {
    for (const header of ['120', 'soon', undefined]) {
      const server = stubServer([busy(header), ok]);
      const done = download();
      await vi.advanceTimersByTimeAsync(600); // the first backoff step: 400 ms + jitter
      await expect(done).resolves.toHaveProperty('byteLength', 3);
      expect(server.gets()).toBe(2);
    }
  });
});

describe('webdavCore.uploadFile and a 503 that names its wait (Retry-After)', () => {
  it('an archive PUT waits the server-named time instead of its step delay', async () => {
    uploadFileWithClient
      .mockRejectedValueOnce(busyFor(2_000))
      .mockResolvedValueOnce({ path: '/mokuro-reader/S/V.cbz' });
    const done = webdavCore.uploadFile({
      seriesTitle: 'S',
      filename: 'V.cbz',
      blob: new Blob(['x']),
      credentials
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(uploadFileWithClient).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual({ fileId: '/mokuro-reader/S/V.cbz' });
    expect(uploadFileWithClient).toHaveBeenCalledTimes(2);
  });

  it('a sidecar PUT is re-sent after the wait (the same Blob), at most twice', async () => {
    const blob = new Blob(['x']);
    uploadFileWithClient.mockRejectedValue(busyFor(1_000));
    const done = webdavCore
      .uploadFile({ seriesTitle: 'S', filename: 'V.mokuro', blob, credentials })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await done).toBeInstanceOf(WebdavUploadError);
    expect(uploadFileWithClient).toHaveBeenCalledTimes(3);
    for (const call of uploadFileWithClient.mock.calls) expect(call[2]).toBe(blob);
  });

  it('a sidecar PUT recovers from one 503 + Retry-After', async () => {
    uploadFileWithClient
      .mockRejectedValueOnce(busyFor(1_000))
      .mockResolvedValueOnce({ path: '/mokuro-reader/S/V.mokuro' });
    const done = webdavCore.uploadFile({
      seriesTitle: 'S',
      filename: 'V.mokuro',
      blob: new Blob(['x']),
      credentials
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toEqual({ fileId: '/mokuro-reader/S/V.mokuro' });
  });

  it('the DELETE before a PUT is retried too, before the PUT goes', async () => {
    davClient.exists.mockReset().mockResolvedValue(true);
    davClient.deleteFile
      .mockReset()
      .mockRejectedValueOnce(davError(503, { 'Retry-After': '1' }))
      .mockResolvedValue(undefined);
    uploadFileWithClient.mockResolvedValue({ path: '/mokuro-reader/S/V.cbz' });
    const done = webdavCore.uploadFile({
      seriesTitle: 'S',
      filename: 'V.cbz',
      blob: new Blob(['x']),
      credentials
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(davClient.deleteFile).toHaveBeenCalledTimes(2);
    const lastDelete = davClient.deleteFile.mock.invocationCallOrder.at(-1)!;
    expect(lastDelete).toBeLessThan(uploadFileWithClient.mock.invocationCallOrder[0]);
  });
});
