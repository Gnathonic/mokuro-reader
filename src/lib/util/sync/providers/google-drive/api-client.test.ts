import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** The token the manager holds now (a re-auth replaces it). */
const tk = vi.hoisted(() => ({ value: 'TOKEN' }));
vi.mock('./token-manager', () => ({
  tokenManager: {
    isAuthenticated: vi.fn(() => true),
    reAuthenticate: vi.fn(),
    clearToken: vi.fn(),
    initTokenClient: vi.fn(async () => {}),
    token: { subscribe: (cb: (v: string) => void) => (cb(tk.value), () => {}) }
  }
}));
vi.mock('$lib/settings/misc', async () => {
  const { writable } = await import('svelte/store');
  return { miscSettings: writable({ gdriveAutoReAuth: true }) };
});
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

import { escapeNameForDriveQuery, driveApiClient } from './api-client';
import { tokenManager } from './token-manager';

describe('escapeNameForDriveQuery', () => {
  it('should return string unchanged when no special characters', () => {
    expect(escapeNameForDriveQuery('simple-name')).toBe('simple-name');
    expect(escapeNameForDriveQuery('My Volume 01')).toBe('My Volume 01');
    expect(escapeNameForDriveQuery('Manga_Title')).toBe('Manga_Title');
  });

  it('should escape single quotes', () => {
    expect(escapeNameForDriveQuery("It's a test")).toBe("It\\'s a test");
    expect(escapeNameForDriveQuery("Don't Stop")).toBe("Don\\'t Stop");
    expect(escapeNameForDriveQuery("'quoted'")).toBe("\\'quoted\\'");
  });

  it('should escape backslashes', () => {
    expect(escapeNameForDriveQuery('path\\to\\file')).toBe('path\\\\to\\\\file');
    expect(escapeNameForDriveQuery('test\\')).toBe('test\\\\');
    expect(escapeNameForDriveQuery('\\start')).toBe('\\\\start');
  });

  it('should escape both quotes and backslashes', () => {
    expect(escapeNameForDriveQuery("It\\'s escaped")).toBe("It\\\\\\'s escaped");
    expect(escapeNameForDriveQuery("path\\file's")).toBe("path\\\\file\\'s");
  });

  it('should handle multiple occurrences', () => {
    expect(escapeNameForDriveQuery("it's it's it's")).toBe("it\\'s it\\'s it\\'s");
    expect(escapeNameForDriveQuery('a\\b\\c\\d')).toBe('a\\\\b\\\\c\\\\d');
  });

  it('should handle empty string', () => {
    expect(escapeNameForDriveQuery('')).toBe('');
  });

  it('should handle Japanese characters with special chars', () => {
    expect(escapeNameForDriveQuery("お嬢様's日記")).toBe("お嬢様\\'s日記");
    expect(escapeNameForDriveQuery('日本\\語')).toBe('日本\\\\語');
  });

  it('should handle real-world folder names with apostrophes', () => {
    // This is the critical use case mentioned in CLAUDE.md
    expect(escapeNameForDriveQuery('Ascendance of a Bookworm')).toBe('Ascendance of a Bookworm');
    expect(escapeNameForDriveQuery("Mother's Rosario")).toBe("Mother\\'s Rosario");
    expect(escapeNameForDriveQuery("The King's Avatar")).toBe("The King\\'s Avatar");
  });
});

const QUOTA_BODY = {
  error: {
    errors: [{ domain: 'usageLimits', reason: 'storageQuotaExceeded' }],
    code: 403,
    message: "The user's Drive storage quota has been exceeded."
  }
};
const RATE_BODY = { error: { errors: [{ reason: 'userRateLimitExceeded' }], code: 403 } };

interface XhrReply {
  status: number;
  statusText?: string;
  response?: unknown;
  headers?: Record<string, string>;
  /** Runs between the send and the answer (a re-auth landing meanwhile). */
  meanwhile?: () => void;
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
    reply.meanwhile?.();
    queueMicrotask(() => this.onload?.());
  }
}

describe('driveApiClient failure classification', () => {
  const list = vi.fn();
  const create = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    list.mockReset();
    create.mockReset();
    vi.stubGlobal('gapi', { client: { drive: { files: { list, create } } } });
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.replies = [];
    FakeXhr.sent = 0;
    tk.value = 'TOKEN';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a 403 storageQuotaExceeded never re-authenticates or clears the token', async () => {
    list.mockRejectedValue({ status: 403, result: QUOTA_BODY, headers: {} });

    const error = await driveApiClient.listFiles("name='x'").catch((e) => e);

    expect(error.kind).toBe('quota');
    expect(error.message).toMatch(/storageQuotaExceeded/);
    expect(list).toHaveBeenCalledTimes(1); // a full account is not retried
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('retries a 429 after its Retry-After and returns the listing', async () => {
    list
      .mockRejectedValueOnce({ status: 429, result: {}, headers: { 'retry-after': '0' } })
      .mockResolvedValueOnce({ result: { files: [{ id: 'f1', name: 'a', mimeType: 'x' }] } });

    await expect(driveApiClient.listFiles("name='x'")).resolves.toEqual([
      { id: 'f1', name: 'a', mimeType: 'x' }
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });

  it('retries a 403 userRateLimitExceeded instead of re-authenticating', async () => {
    list
      .mockRejectedValueOnce({
        status: 403,
        body: JSON.stringify(RATE_BODY),
        headers: { 'Retry-After': '0' }
      })
      .mockResolvedValueOnce({ result: { files: [] } });

    await expect(driveApiClient.listFiles("name='x'")).resolves.toEqual([]);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('keeps the auth path for any other 403', async () => {
    list.mockRejectedValue({
      status: 403,
      result: { error: { errors: [{ reason: 'forbidden' }] } }
    });

    await expect(driveApiClient.listFiles("name='x'")).rejects.toThrow(/Re-authentication/);
    expect(tokenManager.reAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('a folder create answered 503 is not retried: Drive may have made the folder', async () => {
    create.mockRejectedValue({ status: 503, result: {}, headers: {} });

    await expect(driveApiClient.createFolder('mokuro-reader')).rejects.toMatchObject({
      kind: 'transient'
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a folder create answered 429 is retried', async () => {
    create
      .mockRejectedValueOnce({ status: 429, result: {}, headers: { 'retry-after': '0' } })
      .mockResolvedValueOnce({ result: { id: 'folder-1' } });

    await expect(driveApiClient.createFolder('mokuro-reader')).resolves.toBe('folder-1');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('an XHR upload answered 403 storageQuotaExceeded rejects as quota without re-auth', async () => {
    FakeXhr.replies = [{ status: 403, statusText: 'Forbidden', response: QUOTA_BODY }];

    const error = await driveApiClient
      .uploadFile(new Blob(['x']), { name: 'a.json', mimeType: 'application/json' })
      .catch((e) => e);

    expect(error.kind).toBe('quota');
    expect(FakeXhr.sent).toBe(1);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('an XHR upload answered 429 is retried', async () => {
    FakeXhr.replies = [
      { status: 429, response: null, headers: { 'Retry-After': '0' } },
      { status: 200, response: { id: 'new-id' } }
    ];

    await expect(
      driveApiClient.uploadFile(new Blob(['x']), { name: 'a.json', mimeType: 'application/json' })
    ).resolves.toEqual({ id: 'new-id' });
    expect(FakeXhr.sent).toBe(2);
  });

  it('an XHR download answered 403 rateLimitExceeded is retried, not re-authenticated', async () => {
    const payload = new Blob(['data']);
    FakeXhr.replies = [
      {
        status: 403,
        response: new Blob([
          JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } })
        ]),
        headers: { 'Retry-After': '0' }
      },
      { status: 200, response: payload }
    ];

    await expect(driveApiClient.downloadFile('file-1')).resolves.toBe(payload);
    expect(FakeXhr.sent).toBe(2);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });

  it('an XHR download answered with a plain 401 still goes down the auth path', async () => {
    FakeXhr.replies = [{ status: 401, response: new Blob(['']) }];

    await expect(driveApiClient.downloadFile('file-1')).rejects.toThrow(/Re-authentication/);
    expect(tokenManager.reAuthenticate).toHaveBeenCalledTimes(1);
  });

  // Requests sent with one token can come back 401 after a re-auth already
  // replaced it: asking again would be a second sign-in for nothing (a second
  // popup under Google's sign-in), and the token held now is not the one refused.
  it('a call answered 401 for a token a re-auth has since replaced asks for no re-auth', async () => {
    list.mockImplementation(async () => {
      tk.value = 'NEWER';
      throw { status: 401, result: {}, headers: {} };
    });

    const error = await driveApiClient.listFiles("name='x'").catch((e) => e);

    expect(error.status).toBe(401);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('an XHR download answered 401 for a replaced token asks for no re-auth', async () => {
    FakeXhr.replies = [
      { status: 401, response: new Blob(['']), meanwhile: () => (tk.value = 'NEWER') }
    ];

    await expect(driveApiClient.downloadFile('file-1')).rejects.toMatchObject({ status: 401 });
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('an XHR upload answered 401 for a replaced token asks for no re-auth', async () => {
    FakeXhr.replies = [{ status: 401, response: null, meanwhile: () => (tk.value = 'NEWER') }];

    await expect(
      driveApiClient.uploadFile(new Blob(['x']), { name: 'a.json', mimeType: 'application/json' })
    ).rejects.toMatchObject({ status: 401 });
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });
});
