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
    // Step the clock until the retry has run (the digest resolves first, off the clock).
    for (let i = 0; i < 10 && uploadFileWithClient.mock.calls.length < 2; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
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
