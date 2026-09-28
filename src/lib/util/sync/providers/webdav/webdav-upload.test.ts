import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebDAVClient } from 'webdav';
import { uploadFileWithClient } from './webdav-upload';

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
