/**
 * The api-client's Drive transports — gapi `drive.files.*`, the XHR media
 * download and the multipart upload — retry Drive's rate limits (never taking
 * a 403 rate limit for an expired session), and turn a full drive into the
 * storage-full error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./token-manager', () => ({
  tokenManager: {
    isAuthenticated: vi.fn(() => true),
    reAuthenticate: vi.fn(),
    clearToken: vi.fn(),
    initTokenClient: vi.fn(async () => {}),
    token: { subscribe: (cb: (v: string) => void) => (cb('TOKEN'), () => {}) }
  }
}));
vi.mock('$lib/settings/misc', async () => {
  const { writable } = await import('svelte/store');
  return { miscSettings: writable({ gdriveAutoReAuth: true }) };
});
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

import { driveApiClient } from './api-client';
import { tokenManager } from './token-manager';
import { ProviderError } from '../../provider-interface';
import { MAX_RETRY_ATTEMPTS } from '../../core/http-retry';

/** A gapi rejection (`{ result: { error }, status, headers }`). */
function gapiError(status: number, reason: string, headers: Record<string, string> = {}) {
  const result = { error: { code: status, message: reason, errors: [{ reason }] } };
  return { result, body: JSON.stringify(result), status, statusText: '', headers };
}

function errorBody(reason: string): string {
  return JSON.stringify({ error: { code: 403, message: reason, errors: [{ reason }] } });
}

interface XhrAnswer {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}

let xhrAnswers: XhrAnswer[];
let xhrSent: number;

class FakeXhr {
  status = 0;
  statusText = '';
  responseType = '';
  response: unknown = null;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onprogress: ((e: ProgressEvent) => void) | null = null;
  private responseHeaders: Record<string, string> = {};

  open() {}
  setRequestHeader() {}
  getResponseHeader(name: string): string | null {
    const hit = Object.entries(this.responseHeaders).find(
      ([k]) => k.toLowerCase() === name.toLowerCase()
    );
    return hit ? hit[1] : null;
  }
  send() {
    xhrSent++;
    const answer = xhrAnswers.shift() ?? { status: 500 };
    queueMicrotask(() => {
      this.status = answer.status;
      this.statusText = answer.statusText ?? '';
      this.responseHeaders = answer.headers ?? {};
      const body = answer.body ?? '';
      if (this.responseType === 'blob') this.response = new Blob([body]);
      else if (this.responseType === 'json') this.response = body ? JSON.parse(body) : null;
      else this.response = body;
      this.onload?.();
    });
  }
}

const files = {
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn()
};

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of Object.values(files)) fn.mockReset();
  vi.mocked(tokenManager.reAuthenticate).mockClear();
  vi.mocked(tokenManager.clearToken).mockClear();
  xhrAnswers = [];
  xhrSent = 0;
  vi.stubGlobal('gapi', { client: { drive: { files } } });
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('gapi drive.files calls', () => {
  it('retry a 403 rateLimitExceeded after Retry-After, without re-auth', async () => {
    files.list
      .mockRejectedValueOnce(gapiError(403, 'rateLimitExceeded', { 'retry-after': '1' }))
      .mockResolvedValueOnce({ result: { files: [{ id: 'f1', name: 'a', mimeType: 'x' }] } });

    const done = driveApiClient.listFiles("name='a'");
    await vi.advanceTimersByTimeAsync(999);
    expect(files.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual([{ id: 'f1', name: 'a', mimeType: 'x' }]);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('retry one page of a paged listing, not the whole walk', async () => {
    files.list
      .mockResolvedValueOnce({ result: { files: [{ id: 'p1' }], nextPageToken: 't2' } })
      .mockRejectedValueOnce(gapiError(429, 'rateLimitExceeded'))
      .mockResolvedValueOnce({ result: { files: [{ id: 'p2' }] } });

    const done = driveApiClient.listFiles('q');
    await vi.runAllTimersAsync();
    expect((await done).map((f) => f.id)).toEqual(['p1', 'p2']);
    expect(files.list).toHaveBeenCalledTimes(3);
    expect(files.list.mock.calls[2][0]).toMatchObject({ pageToken: 't2' });
  });

  it('a 403 insufficientPermissions is not retried and takes the auth path as before', async () => {
    files.get.mockRejectedValue(gapiError(403, 'insufficientPermissions'));
    await expect(driveApiClient.getFileMetadata('f1', 'size')).rejects.toMatchObject({
      status: 403
    });
    expect(files.get).toHaveBeenCalledTimes(1);
    expect(tokenManager.reAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('after MAX_RETRY_ATTEMPTS rate limits, fails with the status and no re-auth', async () => {
    files.delete.mockRejectedValue(gapiError(403, 'userRateLimitExceeded'));
    const settled = driveApiClient.deleteFile('f1').catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await settled) as { name: string; status: number; reason: string };
    expect(err).toMatchObject({
      name: 'DriveApiError',
      status: 403,
      reason: 'userRateLimitExceeded'
    });
    expect(files.delete).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });

  it('a 403 storageQuotaExceeded is the storage-full error', async () => {
    files.create.mockRejectedValue(gapiError(403, 'storageQuotaExceeded'));
    const err = await driveApiClient.createFolder('S').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('QUOTA_EXCEEDED');
    expect(files.create).toHaveBeenCalledTimes(1);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });

  // gapi rejects with no `.message`: the error's text names the status and
  // reason, as the transport errors do, without changing the classification.
  it('a gapi failure message names its status and [reason]', async () => {
    files.get.mockRejectedValue(gapiError(404, 'notFound'));
    const err = (await driveApiClient.getFileMetadata('f1', 'size').catch((e: unknown) => e)) as {
      message: string;
      status: number;
      reason: string;
      kind: string;
    };
    expect(err.message).toBe('notFound: 404 [notFound]');
    expect(err).toMatchObject({ status: 404, reason: 'notFound', kind: 'other' });
  });

  it('a gapi failure without an error message still names its status', async () => {
    files.get.mockRejectedValue({ status: 500, result: {}, headers: {} });
    const settled = driveApiClient.getFileMetadata('f1', 'size').catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await settled) as { message: string; kind: string };
    expect(err.message).toBe('Drive API error: 500');
    expect(err.kind).toBe('transient');
  });
});

describe('XHR media download', () => {
  it('retries a 429 after Retry-After', async () => {
    xhrAnswers = [
      { status: 429, headers: { 'Retry-After': '2' }, body: errorBody('rateLimitExceeded') },
      { status: 200, body: 'bytes' }
    ];
    const done = driveApiClient.downloadFile('f1');
    await vi.advanceTimersByTimeAsync(1999);
    expect(xhrSent).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await done).text()).toBe('bytes');
    expect(xhrSent).toBe(2);
  });

  it('a 403 rateLimitExceeded is retried, never re-auth', async () => {
    xhrAnswers = [
      { status: 403, body: errorBody('rateLimitExceeded') },
      { status: 200, body: 'bytes' }
    ];
    const done = driveApiClient.downloadFile('f1');
    await vi.runAllTimersAsync();
    expect(await (await done).text()).toBe('bytes');
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });

  it('a 403 insufficientPermissions takes the auth path, once', async () => {
    xhrAnswers = [{ status: 403, body: errorBody('insufficientPermissions') }];
    await expect(driveApiClient.downloadFile('f1')).rejects.toMatchObject({ status: 403 });
    expect(xhrSent).toBe(1);
    expect(tokenManager.reAuthenticate).toHaveBeenCalledTimes(1);
  });
});

describe('XHR multipart upload', () => {
  it('retries a 403 userRateLimitExceeded and lands', async () => {
    xhrAnswers = [
      { status: 403, body: errorBody('userRateLimitExceeded') },
      { status: 200, body: JSON.stringify({ id: 'new-id' }) }
    ];
    const done = driveApiClient.uploadFile(new Blob(['{}']), {
      name: 'p.json',
      mimeType: 'application/json'
    });
    await vi.runAllTimersAsync();
    await expect(done).resolves.toEqual({ id: 'new-id' });
    expect(xhrSent).toBe(2);
  });

  it('a 403 storageQuotaExceeded is the storage-full error, not retried', async () => {
    xhrAnswers = [{ status: 403, body: errorBody('storageQuotaExceeded') }];
    const err = await driveApiClient
      .uploadFile(new Blob(['{}']), { name: 'p.json', mimeType: 'application/json' })
      .catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('QUOTA_EXCEEDED');
    expect(xhrSent).toBe(1);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });
});
