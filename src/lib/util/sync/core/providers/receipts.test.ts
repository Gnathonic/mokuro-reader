import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Upload receipts and the stat-informed download, at the provider CORES: what
 * each upload response hands back as `revision` (and on Drive where the file
 * lives), and WebDAV's download skipping its HEAD when the size is known.
 */

const davClient = vi.hoisted(() => ({
  exists: vi.fn(async () => true),
  createDirectory: vi.fn(async () => {}),
  deleteFile: vi.fn(async () => {}),
  getFileUploadLink: (path: string) => `https://dav.test${path}`,
  getHeaders: () => ({ Authorization: 'Basic abc' }),
  setHeaders: vi.fn()
}));
vi.mock('webdav', () => ({
  createClient: () => davClient,
  AuthType: { Auto: 'auto', Digest: 'digest', None: 'none', Password: 'password', Token: 'token' }
}));

import { googleDriveCore } from './google-drive-core';
import { onedriveCore, oneDriveRevision } from './onedrive-core';
import { webdavCore } from './webdav-core';

/** A fake XHR: each `send` answers with the next queued response. */
type XhrAnswer = { status: number; body?: string; headers?: Record<string, string> };
let xhrAnswers: XhrAnswer[] = [];
let xhrOpened: Array<{ method: string; url: string }> = [];

class FakeXhr {
  status = 0;
  statusText = '';
  responseText = '';
  response: unknown = null;
  responseType = '';
  timeout = 0;
  upload = { onprogress: null as unknown };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onprogress: unknown = null;
  onabort: unknown = null;
  private headers: Record<string, string> = {};
  open(method: string, url: string) {
    xhrOpened.push({ method, url });
  }
  setRequestHeader() {}
  getResponseHeader(name: string): string | null {
    const hit = Object.entries(this.headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
    return hit ? hit[1] : null;
  }
  send() {
    const answer = xhrAnswers.shift() ?? { status: 200 };
    queueMicrotask(() => {
      this.status = answer.status;
      this.responseText = answer.body ?? '';
      this.headers = answer.headers ?? {};
      this.onload?.();
    });
  }
}

const fetchMock = vi.fn();

beforeEach(() => {
  xhrAnswers = [];
  xhrOpened = [];
  fetchMock.mockReset();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Google Drive upload receipt', () => {
  it('asks the final response for version, name and parents, and returns them', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { Location: 'https://upload.test/session' } })
    );
    xhrAnswers = [
      {
        status: 200,
        body: JSON.stringify({
          id: 'file-1',
          name: 'volume-data.json',
          size: '3',
          modifiedTime: '2026-11-02T10:00:00.000Z',
          version: '42',
          parents: ['reader-root']
        })
      }
    ];
    const result = await googleDriveCore.uploadFile({
      seriesTitle: '',
      filename: 'volume-data.json',
      blob: new Blob(['abc']),
      credentials: { accessToken: 't', seriesFolderId: 'reader-root' }
    });

    const initUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(initUrl.searchParams.get('fields')!.split(',')).toEqual(
      expect.arrayContaining(['id', 'name', 'size', 'modifiedTime', 'version', 'parents'])
    );
    expect(result).toEqual({
      fileId: 'file-1',
      modifiedTime: '2026-11-02T10:00:00.000Z',
      size: 3,
      revision: '42',
      parentId: 'reader-root',
      name: 'volume-data.json'
    });
  });
});

describe('OneDrive upload receipt', () => {
  it('is the final driveItem cTag (content only), else its eTag', async () => {
    expect(oneDriveRevision({ cTag: 'c1', eTag: 'e1' })).toBe('c1');
    expect(oneDriveRevision({ eTag: 'e1' })).toBe('e1');
    expect(oneDriveRevision({})).toBeUndefined();

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ uploadUrl: 'https://upload.test/s' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'item-1',
            size: 3,
            lastModifiedDateTime: '2026-11-02T10:00:00Z',
            eTag: '"{E},2"',
            cTag: '"c:{E},2"'
          }),
          { status: 201 }
        )
      );
    const result = await onedriveCore.uploadFile({
      seriesTitle: '',
      filename: 'volume-data.json',
      blob: new Blob(['abc']),
      credentials: { accessToken: 't' }
    });
    expect(result).toEqual({
      fileId: 'item-1',
      modifiedTime: '2026-11-02T10:00:00Z',
      size: 3,
      revision: '"c:{E},2"'
    });
  });
});

describe('WebDAV core', () => {
  it("returns the PUT's ETag as the receipt's revision", async () => {
    xhrAnswers = [{ status: 201, headers: { ETag: '"1730541600.5-2"' } }];
    const result = await webdavCore.uploadFile({
      seriesTitle: '',
      filename: 'positions.json',
      blob: new Blob(['{}']),
      credentials: { webdavUrl: 'https://dav.test' }
    });
    expect(result).toEqual({ fileId: '/mokuro-reader/positions.json', revision: '1730541600.5-2' });
  });

  it('skips its HEAD when the caller already knows the size', async () => {
    fetchMock.mockImplementation(
      async () => new Response('{}', { status: 200, headers: { 'Content-Length': '2' } })
    );
    const read = (expectedSize?: number) =>
      webdavCore.downloadFile({
        fileId: '/mokuro-reader/volume-data.json',
        credentials: { webdavUrl: 'https://dav.test' },
        onProgress: () => {},
        ...(expectedSize ? { expectedSize } : {})
      });
    const methods = () =>
      fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET');

    expect(new TextDecoder().decode(await read(2))).toBe('{}');
    expect(methods()).toEqual(['GET']);

    fetchMock.mockClear();
    await read();
    expect(methods()).toEqual(['HEAD', 'GET']);
  });
});
