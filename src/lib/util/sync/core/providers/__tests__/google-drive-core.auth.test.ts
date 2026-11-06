/**
 * A transfer whose access token Drive refuses (401) renews it ONCE through
 * `refreshAuth` and repeats the refused step with the new token: the size
 * probe, the media GET and the upload session init. That is how a worker's
 * download survives an hour-old token (the download queue does not retry a
 * failed job).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleDriveCore } from '../google-drive-core';
import { DriveHttpError } from '../drive-http';
import { TransientAuthRefreshError } from '$lib/util/worker-auth-refresh';

interface XhrReply {
  status: number;
  response?: unknown;
}

class FakeXhr {
  static replies: XhrReply[] = [];
  static authorizations: (string | null)[] = [];
  status = 0;
  statusText = '';
  response: unknown = null;
  responseType = '';
  upload: { onprogress?: unknown } = {};
  onload?: () => void;
  onerror?: () => void;
  onprogress?: () => void;
  private authorization: string | null = null;
  open() {}
  setRequestHeader(name: string, value: string) {
    if (name.toLowerCase() === 'authorization') this.authorization = value;
  }
  getResponseHeader() {
    return null;
  }
  get responseText() {
    return typeof this.response === 'string' ? this.response : '';
  }
  send() {
    FakeXhr.authorizations.push(this.authorization);
    const reply = FakeXhr.replies.shift()!;
    this.status = reply.status;
    this.response = reply.response ?? null;
    queueMicrotask(() => this.onload?.());
  }
}

const sizeOk = () => new Response(JSON.stringify({ size: '4' }), { status: 200 });
const unauthorized = () =>
  new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }), {
    status: 401
  });

function fetchAuthorizations(): (string | null)[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => new Headers((init as RequestInit)?.headers).get('authorization'));
}

describe('googleDriveCore token renewal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.replies = [];
    FakeXhr.authorizations = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  const download = (refreshAuth?: (stale: string) => Promise<Record<string, unknown> | null>) =>
    googleDriveCore.downloadFile({
      fileId: 'f',
      credentials: { accessToken: 'OLD' },
      onProgress: () => {},
      refreshAuth
    });

  it('a refused size probe renews the token once and goes again with the new one', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(sizeOk());
    FakeXhr.replies = [{ status: 200, response: new ArrayBuffer(4) }];
    const refreshAuth = vi.fn(async () => ({ accessToken: 'NEW' }));

    await expect(download(refreshAuth)).resolves.toBeInstanceOf(ArrayBuffer);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(refreshAuth).toHaveBeenCalledWith('Bearer OLD');
    expect(fetchAuthorizations()).toEqual(['Bearer OLD', 'Bearer NEW']);
    expect(FakeXhr.authorizations).toEqual(['Bearer NEW']);
  });

  it('a refused media GET renews too, and the GET goes again', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(sizeOk());
    FakeXhr.replies = [
      { status: 401, response: null },
      { status: 200, response: new ArrayBuffer(4) }
    ];
    const refreshAuth = vi.fn(async () => ({ accessToken: 'NEW' }));

    await expect(download(refreshAuth)).resolves.toBeInstanceOf(ArrayBuffer);
    expect(FakeXhr.authorizations).toEqual(['Bearer OLD', 'Bearer NEW']);
  });

  it('renews at most once per transfer: a second 401 stands', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(sizeOk());
    FakeXhr.replies = [{ status: 401, response: null }];
    const refreshAuth = vi.fn(async () => ({ accessToken: 'NEW' }));

    await expect(download(refreshAuth)).rejects.toMatchObject({ status: 401 });
    expect(refreshAuth).toHaveBeenCalledTimes(1);
  });

  it('without a refresher, or with none to give, the 401 stands as before', async () => {
    vi.mocked(fetch).mockResolvedValue(unauthorized());
    await expect(download()).rejects.toBeInstanceOf(DriveHttpError);
    await expect(download(async () => null)).rejects.toMatchObject({ status: 401 });
    await expect(download(async () => ({ accessToken: 'OLD' }))).rejects.toMatchObject({
      status: 401
    });
  });

  it('a transient renewal failure is what the transfer fails with, never the 401', async () => {
    vi.mocked(fetch).mockResolvedValue(unauthorized());
    await expect(
      download(async () => {
        throw new TransientAuthRefreshError('later');
      })
    ).rejects.toBeInstanceOf(TransientAuthRefreshError);
  });

  it('other refusals are not a reason to renew', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 404 }));
    const refreshAuth = vi.fn(async () => ({ accessToken: 'NEW' }));
    await expect(download(refreshAuth)).rejects.toMatchObject({ status: 404 });
    expect(refreshAuth).not.toHaveBeenCalled();
  });

  it('an upload whose session init is refused renews and opens the session with the new token', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(
        new Response('', { status: 200, headers: { Location: 'https://upload.example/s' } })
      );
    FakeXhr.replies = [{ status: 200, response: JSON.stringify({ id: 'new-id', size: '1' }) }];
    const refreshAuth = vi.fn(async () => ({ accessToken: 'NEW' }));

    const result = await googleDriveCore.uploadFile({
      seriesTitle: 'S',
      filename: 'v.cbz',
      blob: new Blob(['x']),
      credentials: { accessToken: 'OLD', seriesFolderId: 'folder' },
      refreshAuth
    });
    expect(result.fileId).toBe('new-id');
    expect(fetchAuthorizations()).toEqual(['Bearer OLD', 'Bearer NEW']);
    // The session URI is pre-authorized: the PUT carries no token.
    expect(FakeXhr.authorizations).toEqual([null]);
  });
});
