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
vi.mock('webdav', () => ({
  AuthType: { Password: 'password', None: 'none' },
  createClient: () => ({
    exists: vi.fn(async () => false),
    deleteFile: vi.fn(async () => {})
  })
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
