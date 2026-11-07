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
let xhrSent: Array<{
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}>;

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
  private requestHeaders: Record<string, string> = {};

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }
  getResponseHeader(name: string): string | null {
    const hit = Object.entries(this.responseHeaders).find(
      ([k]) => k.toLowerCase() === name.toLowerCase()
    );
    return hit ? hit[1] : null;
  }
  send(body?: unknown) {
    xhrSent.push({ method: this.method, url: this.url, headers: this.requestHeaders, body });
    const answer = xhrAnswers.shift() ?? { status: 500 };
    queueMicrotask(() => {
      // The whole body goes out before the answer, as an upload's progress says.
      if (body instanceof Blob) {
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: body.size,
          total: body.size
        } as ProgressEvent);
      }
      this.status = answer.status;
      this.statusText = answer.statusText ?? '';
      this.responseHeaders = answer.headers ?? {};
      const text = answer.body ?? '';
      this.responseText = text;
      this.response =
        this.responseType === 'arraybuffer' ? new TextEncoder().encode(text).buffer : text;
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

const SESSION = 'https://upload.example/s1';

function initOk(location = SESSION): Response {
  return new Response(null, { status: 200, headers: { Location: location } });
}

/** A session's 308 answer to a status query: Drive holds bytes 0..accepted-1. */
function resumeAt(accepted: number, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 308,
    headers: accepted > 0 ? { ...headers, Range: `bytes=0-${accepted - 1}` } : headers
  });
}

type FetchCall = [string, RequestInit | undefined];

function fetchCalls(): FetchCall[] {
  return vi.mocked(fetch).mock.calls.map(([url, init]) => [String(url), init]);
}

/** The session inits (POST/PATCH to the resumable upload URL). */
function initCalls(): FetchCall[] {
  return fetchCalls().filter(([url]) => url.includes('uploadType=resumable'));
}

/** The status queries (a PUT to a session URI). */
function statusQueries(): FetchCall[] {
  return fetchCalls().filter(([, init]) => init?.method === 'PUT');
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

  it('a 403 userRateLimitExceeded on the media PUT resumes the same session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(initOk()).mockResolvedValueOnce(resumeAt(0));
    xhrAnswers = [
      { status: 403, body: errorBody('userRateLimitExceeded') },
      { status: 200, body: JSON.stringify({ id: 'new-id' }) }
    ];

    const done = googleDriveCore.uploadFile(UPLOAD_ARGS);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toMatchObject({ fileId: 'new-id' });
    // One session, asked where it stands; no second init.
    expect(initCalls()).toHaveLength(1);
    expect(statusQueries()).toHaveLength(1);
    expect(xhrSent.map((r) => [r.method, r.url])).toEqual([
      ['PUT', SESSION],
      ['PUT', SESSION]
    ]);
  });

  it('a 429 on the media PUT resumes from the offset Drive accepted, never re-sending it', async () => {
    const bytes = new Uint8Array(10).map((_, i) => i + 1);
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk())
      .mockResolvedValueOnce(resumeAt(6, { 'Retry-After': '1' }));
    xhrAnswers = [
      { status: 429, headers: { 'Retry-After': '1' }, body: errorBody('rateLimitExceeded') },
      { status: 200, body: JSON.stringify({ id: 'new-id', size: '10' }) }
    ];
    const progress: Array<[number, number]> = [];

    const done = googleDriveCore.uploadFile({
      ...UPLOAD_ARGS,
      blob: new Blob([bytes]),
      onProgress: (loaded: number, total: number) => progress.push([loaded, total])
    });
    await vi.runAllTimersAsync();
    await expect(done).resolves.toMatchObject({ fileId: 'new-id', size: 10 });

    // The status query: an empty PUT to the session naming only the total.
    const [query] = statusQueries();
    expect(query[0]).toBe(SESSION);
    expect(query[1]?.method).toBe('PUT');
    expect(query[1]?.body ?? null).toBeNull();
    expect(new Headers(query[1]?.headers).get('Content-Range')).toBe('bytes */10');
    expect(initCalls()).toHaveLength(1);

    // The resumed PUT carries bytes 6..9 only.
    expect(xhrSent).toHaveLength(2);
    const resumed = xhrSent[1];
    expect(resumed.url).toBe(SESSION);
    expect(resumed.headers['Content-Range']).toBe('bytes 6-9/10');
    expect(resumed.body).toBeInstanceOf(Blob);
    const sent = new Uint8Array(await (resumed.body as Blob).arrayBuffer());
    expect(Array.from(sent)).toEqual([7, 8, 9, 10]);
    // Progress counts the accepted bytes, not the slice alone.
    expect(progress.at(-1)).toEqual([10, 10]);
  });

  it('a session the status query finds complete is the result, with no second PUT', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'done-id', modifiedTime: '2026-11-02T00:00:00Z', size: '3' }),
          { status: 200 }
        )
      );
    xhrAnswers = [{ status: 429, body: errorBody('rateLimitExceeded') }];

    const done = googleDriveCore.uploadFile(UPLOAD_ARGS);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toEqual({
      fileId: 'done-id',
      modifiedTime: '2026-11-02T00:00:00Z',
      size: 3
    });
    expect(xhrSent).toHaveLength(1);
    expect(initCalls()).toHaveLength(1);
  });

  it.each([404, 410])(
    'a session the status query answers %i for starts a fresh one',
    async (status) => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(initOk())
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(initOk('https://upload.example/s2'));
      xhrAnswers = [
        { status: 429, body: errorBody('rateLimitExceeded') },
        { status: 200, body: JSON.stringify({ id: 'new-id' }) }
      ];

      const done = googleDriveCore.uploadFile(UPLOAD_ARGS);
      await vi.runAllTimersAsync();
      await expect(done).resolves.toMatchObject({ fileId: 'new-id' });
      expect(initCalls()).toHaveLength(2);
      expect(xhrSent.map((r) => r.url)).toEqual([SESSION, 'https://upload.example/s2']);
      // A fresh session takes the whole file, as the first PUT did.
      expect(xhrSent[1].headers['Content-Range']).toBeUndefined();
    }
  );

  it('a 5xx on the media PUT is not retried', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(initOk());
    xhrAnswers = [
      { status: 503, statusText: 'Service Unavailable', body: errorBody('backendError') }
    ];
    const settled = googleDriveCore.uploadFile(UPLOAD_ARGS).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await settled;
    expect((err as Error).message).toMatch(/Upload failed: 503/);
    expect((err as { phase?: string }).phase).toBe('put');
    expect(xhrSent).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a 5xx on the session init is retried', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(driveError(503, 'backendError'))
      .mockResolvedValueOnce(initOk());
    xhrAnswers = [{ status: 200, body: JSON.stringify({ id: 'new-id' }) }];
    const done = googleDriveCore.uploadFile(UPLOAD_ARGS);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toMatchObject({ fileId: 'new-id' });
    expect(initCalls()).toHaveLength(2);
  });

  it('a 403 storageQuotaExceeded on the init fails at once with QUOTA_EXCEEDED', async () => {
    vi.mocked(fetch).mockResolvedValue(driveError(403, 'storageQuotaExceeded'));
    const err = await googleDriveCore.uploadFile(UPLOAD_ARGS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('QUOTA_EXCEEDED');
    expect((err as ProviderError).message).toMatch(/storage is full/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a 403 storageQuotaExceeded on the media PUT is the same storage-full error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(initOk());
    xhrAnswers = [{ status: 403, body: errorBody('storageQuotaExceeded') }];
    const err = await googleDriveCore.uploadFile(UPLOAD_ARGS).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('QUOTA_EXCEEDED');
    expect(xhrSent).toHaveLength(1);
  });

  it('a 403 quotaExceeded on the media PUT is an API usage quota: the session resumes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(initOk()).mockResolvedValueOnce(resumeAt(0));
    xhrAnswers = [
      { status: 403, body: errorBody('quotaExceeded') },
      { status: 200, body: JSON.stringify({ id: 'new-id' }) }
    ];

    const done = googleDriveCore.uploadFile(UPLOAD_ARGS);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toMatchObject({ fileId: 'new-id' });
    expect(initCalls()).toHaveLength(1);
    expect(xhrSent).toHaveLength(2);
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
