/**
 * The Drive API client with the auth backend on: a token about to expire is
 * renewed before a request goes out, and a 401 renews the token once and sends
 * the call again — no popup, no cleared token. When nothing can renew it the
 * call fails as an auth failure and the manager's Reconnect state stands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tk = vi.hoisted(() => ({ value: 'OLD' }));
vi.mock('./token-manager', () => ({
  tokenManager: {
    isAuthenticated: vi.fn(() => true),
    reAuthenticate: vi.fn(),
    clearToken: vi.fn(),
    initTokenClient: vi.fn(async () => {}),
    getAccessToken: vi.fn(async () => tk.value),
    renewRejectedToken: vi.fn(),
    token: { subscribe: (cb: (v: string) => void) => (cb(tk.value), () => {}) }
  }
}));
vi.mock('./auth-backend', () => ({ backendAuthEnabled: () => true }));
vi.mock('$lib/settings/misc', async () => {
  const { writable } = await import('svelte/store');
  return { miscSettings: writable({ gdriveAutoReAuth: true }) };
});
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

import { driveApiClient, isDriveAuthFailure } from './api-client';
import { tokenManager } from './token-manager';

const unauthorized = () => ({
  status: 401,
  result: {
    error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] }
  },
  headers: {}
});

const sentAuthorizations: (string | null)[] = [];
let xhrAnswers: { status: number; body?: string }[] = [];

class FakeXhr {
  status = 0;
  statusText = '';
  responseType = '';
  response: unknown = null;
  upload = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onprogress: (() => void) | null = null;
  private authorization: string | null = null;
  open() {}
  setRequestHeader(name: string, value: string) {
    if (name === 'Authorization') this.authorization = value;
  }
  getResponseHeader() {
    return null;
  }
  send() {
    sentAuthorizations.push(this.authorization);
    const answer = xhrAnswers.shift() ?? { status: 500 };
    queueMicrotask(() => {
      this.status = answer.status;
      this.response = this.responseType === 'blob' ? new Blob([answer.body ?? '']) : answer.body;
      this.onload?.();
    });
  }
}

const list = vi.fn();

beforeEach(() => {
  tk.value = 'OLD';
  list.mockReset();
  sentAuthorizations.length = 0;
  xhrAnswers = [];
  vi.mocked(tokenManager.reAuthenticate).mockClear();
  vi.mocked(tokenManager.clearToken).mockClear();
  vi.mocked(tokenManager.getAccessToken).mockClear();
  vi.mocked(tokenManager.renewRejectedToken).mockReset();
  vi.stubGlobal('gapi', { client: { drive: { files: { list } } } });
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

describe('a request in backend mode', () => {
  it('first makes sure the token has time left', async () => {
    list.mockResolvedValue({ result: { files: [] } });
    await driveApiClient.listFiles("name='x'");
    expect(tokenManager.getAccessToken).toHaveBeenCalled();
    expect(vi.mocked(tokenManager.getAccessToken).mock.invocationCallOrder[0]).toBeLessThan(
      list.mock.invocationCallOrder[0]
    );
  });

  it('a 401 renews the token once and sends the call again', async () => {
    list.mockRejectedValueOnce(unauthorized()).mockResolvedValueOnce({
      result: { files: [{ id: 'a', name: 'a', mimeType: 'x' }] }
    });
    vi.mocked(tokenManager.renewRejectedToken).mockImplementation(async () => {
      tk.value = 'NEW';
      return { kind: 'renewed', token: 'NEW' };
    });

    const listed = await driveApiClient.listFiles("name='a'");
    expect(listed.map((f) => f.id)).toEqual(['a']);
    expect(tokenManager.renewRejectedToken).toHaveBeenCalledTimes(1);
    expect(tokenManager.renewRejectedToken).toHaveBeenCalledWith('OLD');
    expect(list).toHaveBeenCalledTimes(2);
    // Never the popup path, never a cleared token.
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('when nothing can renew it, an auth failure — and still no popup, nothing cleared', async () => {
    list.mockRejectedValue(unauthorized());
    vi.mocked(tokenManager.renewRejectedToken).mockResolvedValue({ kind: 'failed' });
    const error = await driveApiClient.listFiles("name='a'").catch((e) => e);
    expect(isDriveAuthFailure(error)).toBe(true);
    expect(String(error.message)).toMatch(/Reconnect/);
    expect(list).toHaveBeenCalledTimes(1);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('a backend that is down says so (transient), and the call fails without a retry loop', async () => {
    list.mockRejectedValue(unauthorized());
    vi.mocked(tokenManager.renewRejectedToken).mockResolvedValue({ kind: 'transient' });
    const error = await driveApiClient.listFiles("name='a'").catch((e) => e);
    expect(String(error.message)).toMatch(/temporarily unavailable/);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('renews at most once per call: a renewed token refused again fails', async () => {
    list.mockRejectedValue(unauthorized());
    vi.mocked(tokenManager.renewRejectedToken)
      .mockImplementationOnce(async () => {
        tk.value = 'NEW';
        return { kind: 'renewed', token: 'NEW' };
      })
      .mockResolvedValue({ kind: 'failed' });
    const error = await driveApiClient.listFiles("name='a'").catch((e) => e);
    expect(isDriveAuthFailure(error)).toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('a media download refused with 401 goes again with the renewed token', async () => {
    xhrAnswers = [
      { status: 401, body: '{}' },
      { status: 200, body: 'bytes' }
    ];
    vi.mocked(tokenManager.renewRejectedToken).mockImplementation(async () => {
      tk.value = 'NEW';
      return { kind: 'renewed', token: 'NEW' };
    });
    const blob = await driveApiClient.downloadFile('file-id');
    expect(await blob.text()).toBe('bytes');
    expect(sentAuthorizations).toEqual(['Bearer OLD', 'Bearer NEW']);
  });
});
