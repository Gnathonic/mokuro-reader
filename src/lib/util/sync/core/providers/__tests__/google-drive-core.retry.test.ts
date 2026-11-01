/**
 * googleDriveCore (the Drive transport the unified-file-worker runs): Drive's
 * rate limits are retried on the shared policy, a full drive is the reader's
 * storage-full error at once, and any other refusal fails as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleDriveCore } from '../google-drive-core';
import { ProviderError } from '$lib/util/sync/provider-interface';
import { MAX_RETRY_ATTEMPTS } from '../../http-retry';

/** What the fake XHR answers each request with, in order. */
interface XhrAnswer {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}

let xhrAnswers: XhrAnswer[];
let xhrSent: Array<{ method: string; url: string }>;

class FakeXhr {
  status = 0;
  statusText = '';
  responseText = '';
  responseType = '';
  response: unknown = null;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onprogress: ((e: ProgressEvent) => void) | null = null;
  private method = '';
  private url = '';
  private responseHeaders: Record<string, string> = {};

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  getResponseHeader(name: string): string | null {
    const hit = Object.entries(this.responseHeaders).find(
      ([k]) => k.toLowerCase() === name.toLowerCase()
    );
    return hit ? hit[1] : null;
  }
  send() {
    xhrSent.push({ method: this.method, url: this.url });
    const answer = xhrAnswers.shift() ?? { status: 500 };
    queueMicrotask(() => {
      this.status = answer.status;
      this.statusText = answer.statusText ?? '';
      this.responseHeaders = answer.headers ?? {};
      const body = answer.body ?? '';
      this.responseText = body;
      this.response =
        this.responseType === 'arraybuffer' ? new TextEncoder().encode(body).buffer : body;
      this.onload?.();
    });
  }
}

function driveError(status: number, reason: string, headers: Record<string, string> = {}) {
  return new Response(
    JSON.stringify({ error: { code: status, message: reason, errors: [{ reason }] } }),
    { status, headers }
  );
}

function errorBody(reason: string): string {
  return JSON.stringify({ error: { errors: [{ reason }] } });
}

function initOk(): Response {
  return new Response(null, { status: 200, headers: { Location: 'https://upload.example/s1' } });
}

const UPLOAD_ARGS = {
  seriesTitle: 'S',
  filename: 'v.cbz',
  blob: new Blob(['abc']),
  credentials: { accessToken: 'TOKEN', seriesFolderId: 'folder-1' }
};

const DOWNLOAD_ARGS = {
  fileId: 'file-1',
  credentials: { accessToken: 'TOKEN' },
  onProgress: () => {}
};

beforeEach(() => {
  xhrAnswers = [];
  xhrSent = [];
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('googleDriveCore.uploadFile', () => {
  it('retries a 429 on the session init after its Retry-After', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(driveError(429, 'rateLimitExceeded', { 'Retry-After': '2' }))
      .mockResolvedValueOnce(initOk());
    xhrAnswers = [{ status: 200, body: JSON.stringify({ id: 'new-id', size: '3' }) }];

    const done = googleDriveCore.uploadFile(UPLOAD_ARGS);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toMatchObject({ fileId: 'new-id', size: 3 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a 403 userRateLimitExceeded on the media PUT starts over with a fresh session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(initOk()).mockResolvedValueOnce(initOk());
    xhrAnswers = [
      { status: 403, body: errorBody('userRateLimitExceeded') },
      { status: 200, body: JSON.stringify({ id: 'new-id' }) }
    ];

    const done = googleDriveCore.uploadFile(UPLOAD_ARGS);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toMatchObject({ fileId: 'new-id' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(xhrSent.map((r) => r.method)).toEqual(['PUT', 'PUT']);
  });

  it('a 403 storageQuotaExceeded on the init fails at once with QUOTA_EXCEEDED', async () => {
    vi.mocked(fetch).mockResolvedValue(driveError(403, 'storageQuotaExceeded'));
    const err = await googleDriveCore.uploadFile(UPLOAD_ARGS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('QUOTA_EXCEEDED');
    expect((err as ProviderError).message).toMatch(/storage is full/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a 403 quotaExceeded on the media PUT is the same storage-full error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(initOk());
    xhrAnswers = [{ status: 403, body: errorBody('quotaExceeded') }];
    const err = await googleDriveCore.uploadFile(UPLOAD_ARGS).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('QUOTA_EXCEEDED');
    expect(xhrSent).toHaveLength(1);
  });

  it('a 403 insufficientPermissions is not retried', async () => {
    vi.mocked(fetch).mockResolvedValue(driveError(403, 'insufficientPermissions'));
    await expect(googleDriveCore.uploadFile(UPLOAD_ARGS)).rejects.toThrow(
      /Upload init failed: 403/
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after MAX_RETRY_ATTEMPTS rate limits with the usual error', async () => {
    vi.mocked(fetch).mockImplementation(async () => driveError(429, 'rateLimitExceeded'));
    const settled = googleDriveCore.uploadFile(UPLOAD_ARGS).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await settled;
    expect((err as Error).message).toMatch(/Upload init failed: 429/);
    expect(err).not.toBeInstanceOf(ProviderError);
    expect(fetch).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
  });
});

describe('googleDriveCore.downloadFile', () => {
  it('retries a rate-limited size lookup and media GET, each on its own', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(driveError(403, 'rateLimitExceeded', { 'Retry-After': '1' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ size: '5' }), { status: 200 }));
    xhrAnswers = [
      { status: 429, headers: { 'Retry-After': '1' }, body: errorBody('rateLimitExceeded') },
      { status: 200, body: 'hello' }
    ];

    const done = googleDriveCore.downloadFile(DOWNLOAD_ARGS);
    await vi.runAllTimersAsync();
    const data = await done;
    expect(new TextDecoder().decode(data)).toBe('hello');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(xhrSent).toHaveLength(2);
  });

  it('a 404 media GET fails at once, as before', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ size: '5' }), { status: 200 })
    );
    xhrAnswers = [{ status: 404, statusText: 'Not Found', body: errorBody('notFound') }];
    await expect(googleDriveCore.downloadFile(DOWNLOAD_ARGS)).rejects.toThrow(
      'HTTP error 404: Not Found'
    );
    expect(xhrSent).toHaveLength(1);
  });
});
