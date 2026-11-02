import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { googleDriveCore } from '../google-drive-core';
import { DriveHttpError } from '../drive-http';

const QUOTA_BODY = JSON.stringify({
  error: { errors: [{ domain: 'usageLimits', reason: 'storageQuotaExceeded' }], code: 403 }
});

interface XhrReply {
  status: number;
  statusText?: string;
  response?: unknown;
  headers?: Record<string, string>;
}

/** Answers each send() with the next queued reply. */
class FakeXhr {
  static replies: XhrReply[] = [];
  static sent = 0;
  status = 0;
  statusText = '';
  response: unknown = null;
  responseType = '';
  upload: { onprogress?: unknown } = {};
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  onprogress?: () => void;
  private headers: Record<string, string> = {};
  open() {}
  setRequestHeader() {}
  getResponseHeader(name: string) {
    return this.headers[name.toLowerCase()] ?? null;
  }
  get responseText() {
    if (this.responseType !== '' && this.responseType !== 'text') {
      throw new Error('InvalidStateError');
    }
    return typeof this.response === 'string' ? this.response : '';
  }
  send() {
    FakeXhr.sent++;
    const reply = FakeXhr.replies.shift()!;
    this.status = reply.status;
    this.statusText = reply.statusText ?? '';
    this.response = reply.response ?? null;
    this.headers = Object.fromEntries(
      Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    queueMicrotask(() => this.onload?.());
  }
}

const credentials = { accessToken: 'TOKEN', seriesFolderId: 'series-folder' };

function initOk(): Response {
  return new Response('', {
    status: 200,
    headers: { Location: 'https://upload.example/session' }
  });
}

describe('googleDriveCore', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.replies = [];
    FakeXhr.sent = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('uploadFile', () => {
    it('retries a 429 session init after its Retry-After', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response('{}', { status: 429, headers: { 'Retry-After': '0.001' } })
        )
        .mockResolvedValueOnce(initOk());
      FakeXhr.replies = [{ status: 200, response: JSON.stringify({ id: 'new-id', size: '1' }) }];

      const result = await googleDriveCore.uploadFile({
        seriesTitle: 'S',
        filename: 'v.cbz',
        blob: new Blob(['x']),
        credentials
      });

      expect(result.fileId).toBe('new-id');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('fails a full account at once, naming the reason in the message', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(QUOTA_BODY, { status: 403, statusText: 'Forbidden' })
      );

      const error = await googleDriveCore
        .uploadFile({ seriesTitle: 'S', filename: 'v.cbz', blob: new Blob(['x']), credentials })
        .catch((e) => e);

      expect(error).toBeInstanceOf(DriveHttpError);
      expect(error.kind).toBe('quota');
      // Only the message crosses the worker boundary.
      expect(error.message).toMatch(/\[storageQuotaExceeded\]/);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(FakeXhr.sent).toBe(0);
    });

    it('classifies a 429 on the data PUT but never retries it mid-stream', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(initOk());
      FakeXhr.replies = [
        {
          status: 429,
          statusText: 'Too Many Requests',
          response: '',
          headers: { 'Retry-After': '0.001' }
        }
      ];

      const error = await googleDriveCore
        .uploadFile({ seriesTitle: 'S', filename: 'v.cbz', blob: new Blob(['x']), credentials })
        .catch((e) => e);

      expect(error).toBeInstanceOf(DriveHttpError);
      expect(error.kind).toBe('rate-limit');
      expect(FakeXhr.sent).toBe(1);
    });
  });

  describe('downloadFile', () => {
    it('retries a rate-limited size lookup and a transient download', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }),
            {
              status: 403,
              headers: { 'Retry-After': '0.001' }
            }
          )
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ size: '4' }), { status: 200 }));
      const payload = new Uint8Array([1, 2, 3, 4]).buffer;
      FakeXhr.replies = [
        { status: 503, response: new ArrayBuffer(0), headers: { 'Retry-After': '0.001' } },
        { status: 200, response: payload }
      ];

      const data = await googleDriveCore.downloadFile({
        fileId: 'f1',
        credentials: { accessToken: 'TOKEN' },
        onProgress: () => {}
      });

      expect(data).toBe(payload);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(FakeXhr.sent).toBe(2);
    });

    it('reads the reason out of an arraybuffer error body', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ size: '4' }), { status: 200 })
      );
      FakeXhr.replies = [{ status: 403, response: new TextEncoder().encode(QUOTA_BODY).buffer }];

      const error = await googleDriveCore
        .downloadFile({ fileId: 'f1', credentials: { accessToken: 'TOKEN' }, onProgress: () => {} })
        .catch((e) => e);

      expect(error.kind).toBe('quota');
      expect(FakeXhr.sent).toBe(1);
    });
  });
});
