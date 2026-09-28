import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebDAVClient } from 'webdav';
import {
  UPLOAD_RETRY_DELAYS_MS,
  WebdavUploadError,
  uploadFileWithClient,
  uploadWithRetry
} from './webdav-upload';

/** What the fake server answers each PUT with, in order. */
type Answer =
  | { status: number; statusText?: string; headers?: Record<string, string>; body?: string }
  | 'network-error'
  | 'timeout';

let answers: Answer[];
let sent: Array<{ url: string; headers: Record<string, string>; body: unknown }>;

class FakeXhr {
  status = 0;
  statusText = '';
  responseText = '';
  timeout = 0;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  private url = '';
  private requestHeaders: Record<string, string> = {};
  private responseHeaders: Record<string, string> = {};

  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.requestHeaders[key] = value;
  }
  getResponseHeader(name: string): string | null {
    const hit = Object.entries(this.responseHeaders).find(
      ([k]) => k.toLowerCase() === name.toLowerCase()
    );
    return hit ? hit[1] : null;
  }
  send(body: unknown) {
    sent.push({ url: this.url, headers: this.requestHeaders, body });
    const answer = answers.shift() ?? { status: 201 };
    queueMicrotask(() => {
      if (answer === 'network-error') return this.onerror?.();
      if (answer === 'timeout') return this.ontimeout?.();
      this.status = answer.status;
      this.statusText = answer.statusText ?? '';
      this.responseHeaders = answer.headers ?? {};
      this.responseText = answer.body ?? '';
      this.onload?.();
    });
  }
}

const client = {
  getFileUploadLink: (path: string) => `https://bunko.example/dav${encodeURI(path)}`,
  getHeaders: () => ({ Authorization: 'Basic abc' })
} as unknown as WebDAVClient;

beforeEach(() => {
  answers = [];
  sent = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a WebDAV PUT that the server queued for OCR (Addendum A)', () => {
  it('reports the manifest URL, resolved against the upload URL, and the recheck delay', async () => {
    answers = [
      {
        status: 201,
        headers: {
          'X-Mokuro-Manifest': '/catalog/api/manifest?series=S&volume=V',
          'X-Mokuro-Recheck-After': '95'
        }
      }
    ];
    const result = await uploadFileWithClient(client, '/mokuro-reader/S/V.cbz', new Blob(['x']));
    expect(result.path).toBe('/mokuro-reader/S/V.cbz');
    expect(result.serverOcr).toEqual({
      manifestUrl: 'https://bunko.example/catalog/api/manifest?series=S&volume=V',
      recheckAfter: 95
    });
  });

  it('reports no server OCR when the headers are absent (any other WebDAV server)', async () => {
    answers = [{ status: 204 }];
    const result = await uploadFileWithClient(client, '/mokuro-reader/S/V.cbz', new Blob(['x']));
    expect(result.serverOcr).toBeUndefined();
  });

  it('keeps the manifest with an unusable recheck delay (the recheck falls back)', async () => {
    answers = [
      { status: 201, headers: { 'X-Mokuro-Manifest': '/m', 'X-Mokuro-Recheck-After': 'soon' } }
    ];
    const result = await uploadFileWithClient(client, '/mokuro-reader/S/V.cbz', new Blob(['x']));
    expect(result.serverOcr).toEqual({
      manifestUrl: 'https://bunko.example/m',
      recheckAfter: null
    });
  });
});

describe('the upload verdict (Addendum B)', () => {
  const blob = new Blob(['12345']); // 5 bytes
  const put = (path = '/mokuro-reader/S/V.cbz') => uploadFileWithClient(client, path, blob);

  it('settles on a 2xx that says verified with the size that was sent', async () => {
    answers = [{ status: 201, headers: { 'X-Mokuro-Upload': 'verified', 'X-Mokuro-Size': '5' } }];
    await expect(put()).resolves.toMatchObject({ path: '/mokuro-reader/S/V.cbz' });
  });

  it('keeps the plain 2xx rule for a server that sends neither header', async () => {
    answers = [{ status: 204 }];
    await expect(put()).resolves.toMatchObject({ path: '/mokuro-reader/S/V.cbz' });
  });

  it('refuses an archive the server stored but did not verify (retryable)', async () => {
    answers = [{ status: 201, headers: { 'X-Mokuro-Upload': 'stored', 'X-Mokuro-Size': '5' } }];
    const error = await put().catch((e) => e);
    expect(error).toBeInstanceOf(WebdavUploadError);
    expect(error.retryable).toBe(true);
    expect(error.reason).toBe('unverified');
  });

  it('accepts "stored" for a file that is not an archive', async () => {
    answers = [{ status: 201, headers: { 'X-Mokuro-Upload': 'stored', 'X-Mokuro-Size': '5' } }];
    await expect(put('/mokuro-reader/S/V.mokuro')).resolves.toMatchObject({
      path: '/mokuro-reader/S/V.mokuro'
    });
  });

  it('refuses a 2xx whose stored size differs from what was sent (retryable)', async () => {
    answers = [{ status: 201, headers: { 'X-Mokuro-Upload': 'verified', 'X-Mokuro-Size': '4' } }];
    const error = await put().catch((e) => e);
    expect(error).toBeInstanceOf(WebdavUploadError);
    expect(error.reason).toBe('size-mismatch');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('4');
  });

  it('reads the server verdict body of a failure: reason, detail, retry', async () => {
    answers = [
      {
        status: 422,
        statusText: 'Unprocessable Entity',
        body: JSON.stringify({
          ok: false,
          reason: 'archive-damaged',
          detail: 'Member 003.jpg failed its CRC check',
          retry: false
        })
      }
    ];
    const error = await put().catch((e) => e);
    expect(error).toMatchObject({
      status: 422,
      reason: 'archive-damaged',
      detail: 'Member 003.jpg failed its CRC check',
      retryable: false
    });
    expect(error.message).toContain('422');
    expect(error.message).toContain('Member 003.jpg failed its CRC check');
  });

  it('retries a truncated body the server flags as retryable', async () => {
    answers = [
      {
        status: 422,
        body: JSON.stringify({ ok: false, reason: 'truncated', detail: 'short', retry: true })
      }
    ];
    expect((await put().catch((e) => e)).retryable).toBe(true);
  });

  for (const [status, retryable] of [
    [500, true],
    [502, true],
    [503, true],
    [507, false],
    [401, false],
    [403, false],
    [404, false],
    [429, true]
  ] as const) {
    it(`classifies a bare ${status} as ${retryable ? '' : 'not '}retryable`, async () => {
      answers = [{ status }];
      const error = await put().catch((e) => e);
      expect(error).toBeInstanceOf(WebdavUploadError);
      expect(error.retryable).toBe(retryable);
      // The status stays in the message: the provider's write-error classifier reads it.
      expect(error.message).toContain(String(status));
    });
  }

  it('classifies network errors and timeouts as retryable', async () => {
    answers = ['network-error'];
    expect((await put().catch((e) => e)).retryable).toBe(true);
    answers = ['timeout'];
    expect((await put().catch((e) => e)).retryable).toBe(true);
  });
});

describe('uploadWithRetry', () => {
  const noSleep = vi.fn(async (_ms: number) => {});

  beforeEach(() => noSleep.mockClear());

  it('waits 5 s, 30 s, 2 min between attempts, then gives up with the last error', async () => {
    const attempt = vi.fn(async () => {
      throw new WebdavUploadError('WebDAV upload failed: 503', {
        status: 503,
        reason: 'server-error',
        detail: 'busy',
        retryable: true
      });
    });
    const onRetry = vi.fn();
    const error = await uploadWithRetry(attempt, { sleep: noSleep, onRetry }).catch((e) => e);
    expect(UPLOAD_RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000]);
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([5_000, 30_000, 120_000]);
    expect(onRetry.mock.calls.map((c) => c[0])).toEqual([
      { attempt: 2, attempts: 4, delayMs: 5_000, reason: 'busy' },
      { attempt: 3, attempts: 4, delayMs: 30_000, reason: 'busy' },
      { attempt: 4, attempts: 4, delayMs: 120_000, reason: 'busy' }
    ]);
    expect(error.detail).toBe('busy');
  });

  it('stops at once on an error that is not retryable', async () => {
    const attempt = vi.fn(async () => {
      throw new WebdavUploadError('WebDAV upload failed: 507', {
        status: 507,
        reason: 'disk-full',
        detail: 'No space left on the server',
        retryable: false
      });
    });
    await expect(uploadWithRetry(attempt, { sleep: noSleep })).rejects.toThrow('507');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it('never retries an error it cannot classify', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('something else');
    });
    await expect(uploadWithRetry(attempt, { sleep: noSleep })).rejects.toThrow('something else');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('returns the first success', async () => {
    let n = 0;
    const attempt = vi.fn(async () => {
      if (n++ === 0) {
        throw new WebdavUploadError('WebDAV upload failed: network', {
          reason: 'network',
          detail: 'Network error during WebDAV upload',
          retryable: true
        });
      }
      return 'ok';
    });
    await expect(uploadWithRetry(attempt, { sleep: noSleep })).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
