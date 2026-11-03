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

import { escapeNameForDriveQuery, driveApiClient, isDriveAuthFailure } from './api-client';
import { tokenManager } from './token-manager';

describe('driveApiClient.folderHasChildren', () => {
  const list = vi.fn();
  afterEach(() => {
    list.mockReset();
    delete (globalThis as { gapi?: unknown }).gapi;
  });
  const gapiWith = (result: unknown) => {
    list.mockResolvedValue({ result });
    (globalThis as { gapi?: unknown }).gapi = { client: { drive: { files: { list } } } };
  };

  it('asks for ONE child, and never pages: a yes/no question, not a listing', async () => {
    gapiWith({ files: [{ id: 'child' }], nextPageToken: 'more' });

    await expect(driveApiClient.folderHasChildren('DUP')).resolves.toBe(true);

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ q: "'DUP' in parents and trashed=false", pageSize: 1 })
    );
  });

  it('is false for a folder the server lists empty', async () => {
    gapiWith({ files: [] });
    await expect(driveApiClient.folderHasChildren('DUP')).resolves.toBe(false);
  });
});

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
  /** The Authorization header of every send, in order. */
  static auth: string[] = [];
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
  private authorization = '';
  open() {}
  setRequestHeader(name: string, value: string) {
    if (name.toLowerCase() === 'authorization') this.authorization = value;
  }
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
    FakeXhr.auth.push(this.authorization);
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
    FakeXhr.auth = [];
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

    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.message).toMatch(/storage is full/);
    expect(list).toHaveBeenCalledTimes(1); // a full account is not retried
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('retries a 429 after its Retry-After and returns the listing', async () => {
    list
      .mockRejectedValueOnce({ status: 429, result: {}, headers: { 'retry-after': '0.001' } })
      .mockResolvedValueOnce({ result: { files: [{ id: 'f1', name: 'a', mimeType: 'x' }] } });

    await expect(driveApiClient.listFiles("name='x'")).resolves.toEqual([
      { id: 'f1', name: 'a', mimeType: 'x' }
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });

  it('a 429 on page N of a listing re-fetches page N only, not the pages before it', async () => {
    list
      .mockResolvedValueOnce({
        result: { files: [{ id: 'f1', name: 'a', mimeType: 'x' }], nextPageToken: 'p2' }
      })
      .mockRejectedValueOnce({ status: 429, result: {}, headers: { 'retry-after': '0.001' } })
      .mockResolvedValueOnce({ result: { files: [{ id: 'f2', name: 'b', mimeType: 'x' }] } });

    await expect(driveApiClient.listFiles("name='x'")).resolves.toEqual([
      { id: 'f1', name: 'a', mimeType: 'x' },
      { id: 'f2', name: 'b', mimeType: 'x' }
    ]);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls.map(([args]) => args.pageToken)).toEqual([undefined, 'p2', 'p2']);
  });

  it('retries a 403 userRateLimitExceeded instead of re-authenticating', async () => {
    list
      .mockRejectedValueOnce({
        status: 403,
        body: JSON.stringify(RATE_BODY),
        headers: { 'Retry-After': '0.001' }
      })
      .mockResolvedValueOnce({ result: { files: [] } });

    await expect(driveApiClient.listFiles("name='x'")).resolves.toEqual([]);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('a 403 quotaExceeded is an API usage quota: retried, never "storage full"', async () => {
    list
      .mockRejectedValueOnce({
        status: 403,
        result: { error: { errors: [{ domain: 'usageLimits', reason: 'quotaExceeded' }] } },
        headers: { 'Retry-After': '0.001' }
      })
      .mockResolvedValueOnce({ result: { files: [] } });

    await expect(driveApiClient.listFiles("name='x'")).resolves.toEqual([]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });

  it('keeps the auth path for a 403 a fresh token can fix', async () => {
    list.mockRejectedValue({
      status: 403,
      result: { error: { errors: [{ reason: 'forbidden' }] } }
    });

    await expect(driveApiClient.listFiles("name='x'")).rejects.toThrow(/Re-authentication/);
    expect(tokenManager.reAuthenticate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['insufficientFilePermissions', 'other'],
    ['numChildrenInNonRootLimitExceeded', 'limit']
  ])(
    'a 403 %s fails at once with its message, without a re-auth or a retry',
    async (reason, kind) => {
      list.mockRejectedValue({
        status: 403,
        result: { error: { errors: [{ domain: 'global', reason }], message: 'Nope' } }
      });

      const error = await driveApiClient.listFiles("name='x'").catch((e) => e);

      expect(error.kind).toBe(kind);
      expect(error.reason).toBe(reason);
      expect(error.message).toBe(`Nope: 403 [${reason}]`);
      expect(list).toHaveBeenCalledTimes(1);
      expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
      expect(tokenManager.clearToken).not.toHaveBeenCalled();
    }
  );

  it('a 403 sharingRateLimitExceeded (domain global) is a rate limit: retried', async () => {
    list
      .mockRejectedValueOnce({
        status: 403,
        result: { error: { errors: [{ domain: 'global', reason: 'sharingRateLimitExceeded' }] } },
        headers: { 'Retry-After': '0.001' }
      })
      .mockResolvedValueOnce({ result: { files: [] } });

    await expect(driveApiClient.listFiles("name='x'")).resolves.toEqual([]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
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
      .mockRejectedValueOnce({ status: 429, result: {}, headers: { 'retry-after': '0.001' } })
      .mockResolvedValueOnce({ result: { id: 'folder-1' } });

    await expect(driveApiClient.createFolder('mokuro-reader')).resolves.toBe('folder-1');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('an XHR upload answered 403 storageQuotaExceeded rejects as quota without re-auth', async () => {
    FakeXhr.replies = [{ status: 403, statusText: 'Forbidden', response: QUOTA_BODY }];

    const error = await driveApiClient
      .uploadFile(new Blob(['x']), { name: 'a.json', mimeType: 'application/json' })
      .catch((e) => e);

    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(FakeXhr.sent).toBe(1);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('an XHR upload answered 429 is retried', async () => {
    FakeXhr.replies = [
      { status: 429, response: null, headers: { 'Retry-After': '0.001' } },
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
        headers: { 'Retry-After': '0.001' }
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
  // popup under Google's sign-in), and the token held now is not the one
  // refused. A 401 created nothing, so the request is sent once more with the
  // token held now.
  it('a call answered 401 for a token a re-auth has since replaced is retried with the held one', async () => {
    list
      .mockImplementationOnce(async () => {
        tk.value = 'NEWER';
        throw { status: 401, result: {}, headers: {} };
      })
      .mockResolvedValueOnce({ result: { files: [{ id: 'f1', name: 'a', mimeType: 'x' }] } });

    await expect(driveApiClient.listFiles("name='x'")).resolves.toEqual([
      { id: 'f1', name: 'a', mimeType: 'x' }
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('a stale-token retry refused for the held token takes the auth path, once', async () => {
    list
      .mockImplementationOnce(async () => {
        tk.value = 'NEWER';
        throw { status: 401, result: {}, headers: {} };
      })
      .mockRejectedValueOnce({ status: 401, result: {}, headers: {} });

    await expect(driveApiClient.listFiles("name='x'")).rejects.toThrow(/Re-authentication/);
    expect(list).toHaveBeenCalledTimes(2);
    expect(tokenManager.reAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('a stale-token refusal is retried only once', async () => {
    let n = 0;
    list.mockImplementation(async () => {
      tk.value = `NEWER-${++n}`;
      throw { status: 401, result: {}, headers: {} };
    });

    await expect(driveApiClient.listFiles("name='x'")).rejects.toMatchObject({ status: 401 });
    expect(list).toHaveBeenCalledTimes(2);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('an XHR download answered 401 for a replaced token is retried with the held one', async () => {
    const payload = new Blob(['data']);
    FakeXhr.replies = [
      { status: 401, response: new Blob(['']), meanwhile: () => (tk.value = 'NEWER') },
      { status: 200, response: payload }
    ];

    await expect(driveApiClient.downloadFile('file-1')).resolves.toBe(payload);
    expect(FakeXhr.auth).toEqual(['Bearer TOKEN', 'Bearer NEWER']);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('an XHR upload answered 401 for a replaced token is retried with the held one', async () => {
    FakeXhr.replies = [
      { status: 401, response: null, meanwhile: () => (tk.value = 'NEWER') },
      { status: 200, response: { id: 'new-id' } }
    ];

    await expect(
      driveApiClient.uploadFile(new Blob(['x']), { name: 'a.json', mimeType: 'application/json' })
    ).resolves.toEqual({ id: 'new-id' });
    expect(FakeXhr.auth).toEqual(['Bearer TOKEN', 'Bearer NEWER']);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  // A re-auth can land while a request waits out a rate limit's backoff: the
  // next attempt must carry the token held THEN, or it is refused for the old one.
  it('an XHR upload retried after a re-auth sends the token held now', async () => {
    FakeXhr.replies = [
      { status: 429, headers: { 'Retry-After': '0' }, meanwhile: () => (tk.value = 'NEWER') },
      { status: 200, response: { id: 'new-id' } }
    ];

    await expect(
      driveApiClient.uploadFile(new Blob(['x']), { name: 'a.json', mimeType: 'application/json' })
    ).resolves.toEqual({ id: 'new-id' });
    expect(FakeXhr.auth).toEqual(['Bearer TOKEN', 'Bearer NEWER']);
  });

  it('an XHR download retried after a re-auth sends the token held now', async () => {
    const payload = new Blob(['data']);
    FakeXhr.replies = [
      {
        status: 503,
        response: new Blob(['']),
        headers: { 'Retry-After': '0' },
        meanwhile: () => (tk.value = 'NEWER')
      },
      { status: 200, response: payload }
    ];

    await expect(driveApiClient.downloadFile('file-1')).resolves.toBe(payload);
    expect(FakeXhr.auth).toEqual(['Bearer TOKEN', 'Bearer NEWER']);
  });
});

describe('driveApiClient change feed (changes.getStartPageToken / changes.list)', () => {
  const list = vi.fn();
  const getStartPageToken = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    list.mockReset();
    getStartPageToken.mockReset();
    vi.stubGlobal('gapi', { client: { drive: { changes: { list, getStartPageToken } } } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('getStartPageToken asks for the token field only', async () => {
    getStartPageToken.mockResolvedValue({ result: { startPageToken: '123' } });

    await expect(driveApiClient.getStartPageToken()).resolves.toBe('123');
    expect(getStartPageToken).toHaveBeenCalledWith({ fields: 'startPageToken' });
  });

  it('getStartPageToken retries a 429 like every other call', async () => {
    getStartPageToken
      .mockRejectedValueOnce({ status: 429, result: {}, headers: { 'retry-after': '0.001' } })
      .mockResolvedValueOnce({ result: { startPageToken: '124' } });

    await expect(driveApiClient.getStartPageToken()).resolves.toBe('124');
    expect(getStartPageToken).toHaveBeenCalledTimes(2);
  });

  it('listChanges pages to the end and returns the next position', async () => {
    list
      .mockResolvedValueOnce({ result: { changes: [{ fileId: 'a' }], nextPageToken: 'p2' } })
      .mockResolvedValueOnce({
        result: { changes: [{ fileId: 'b', removed: true }], newStartPageToken: 'next' }
      });

    await expect(driveApiClient.listChanges('start', 'changes(fileId,removed)')).resolves.toEqual({
      changes: [{ fileId: 'a' }, { fileId: 'b', removed: true }],
      newStartPageToken: 'next'
    });
    expect(list.mock.calls.map(([args]) => args.pageToken)).toEqual(['start', 'p2']);
    expect(list).toHaveBeenCalledWith({
      pageToken: 'start',
      pageSize: 1000,
      includeRemoved: true,
      fields: 'nextPageToken,newStartPageToken,changes(fileId,removed)'
    });
  });

  it('a 429 on page N re-asks page N only', async () => {
    list
      .mockResolvedValueOnce({ result: { changes: [{ fileId: 'a' }], nextPageToken: 'p2' } })
      .mockRejectedValueOnce({ status: 429, result: {}, headers: { 'retry-after': '0.001' } })
      .mockResolvedValueOnce({ result: { changes: [], newStartPageToken: 'next' } });

    const result = await driveApiClient.listChanges('start', 'changes(fileId)');

    expect(result?.changes).toEqual([{ fileId: 'a' }]);
    expect(list.mock.calls.map(([args]) => args.pageToken)).toEqual(['start', 'p2', 'p2']);
  });

  it('is null past maxPages: the log would cost more than a listing', async () => {
    list.mockResolvedValue({ result: { changes: [], nextPageToken: 'more' } });

    await expect(driveApiClient.listChanges('start', 'changes(fileId)', 2)).resolves.toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('a refused position fails typed, without a re-auth', async () => {
    list.mockRejectedValue({
      status: 400,
      result: { error: { errors: [{ reason: 'invalid' }], message: 'Invalid Value' } }
    });

    const error = await driveApiClient.listChanges('bogus', 'changes(fileId)').catch((e) => e);

    expect(error.status).toBe(400);
    expect(error.kind).toBe('other');
    // The POSITION was refused, not the feed: a listing takes a fresh one.
    expect(error.feedUnavailable).toBeUndefined();
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });

  it('an expired token goes down the auth path, and says so', async () => {
    list.mockRejectedValue({ status: 401, result: {} });

    const error = await driveApiClient.listChanges('start', 'changes(fileId)').catch((e) => e);

    expect(error.message).toMatch(/Re-authentication/);
    expect(isDriveAuthFailure(error)).toBe(true);
    expect(error.feedUnavailable).toBeUndefined();
    expect(tokenManager.reAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('a 401 on getStartPageToken is auth too', async () => {
    getStartPageToken.mockRejectedValue({ status: 401, result: {} });

    const error = await driveApiClient.getStartPageToken().catch((e) => e);

    expect(isDriveAuthFailure(error)).toBe(true);
    expect(tokenManager.reAuthenticate).toHaveBeenCalledTimes(1);
  });

  // A 403 the general classifier would send down the auth path (no reason,
  // `insufficientPermissions`): from the feed it means the token cannot read
  // the feed, not that it expired. A re-auth would mint the same token and
  // the next listing would ask again — a re-auth prompt on every listing.
  it.each([
    ['no reason', {}],
    ['insufficientPermissions', { error: { errors: [{ reason: 'insufficientPermissions' }] } }]
  ])('a 403 (%s) on the feed is "feed unavailable", never a re-auth', async (_label, result) => {
    list.mockRejectedValue({ status: 403, result });
    getStartPageToken.mockRejectedValue({ status: 403, result });

    for (const call of [
      () => driveApiClient.listChanges('start', 'changes(fileId)'),
      () => driveApiClient.getStartPageToken()
    ]) {
      const error = await call().catch((e) => e);
      expect(error.status).toBe(403);
      expect(error.feedUnavailable).toBe(true);
      expect(isDriveAuthFailure(error)).toBe(false);
    }
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  // A rate limit or an outage clears: it costs the call that met it a full
  // listing (the cache's fallback), never the feed for the rest of the
  // session — every later sync would walk the whole account.
  it.each([
    ['a 503', { status: 503, result: {} }],
    ['a 429', { status: 429, result: {} }],
    [
      'a 403 rateLimitExceeded',
      { status: 403, result: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } }
    ]
  ])(
    '%s that outlasts the retries is neither auth nor "feed unavailable"',
    async (_label, rejection) => {
      const answer = { ...rejection, headers: { 'retry-after': '0.001' } };
      list.mockRejectedValue(answer);
      getStartPageToken.mockRejectedValue(answer);

      for (const call of [
        () => driveApiClient.listChanges('start', 'changes(fileId)'),
        () => driveApiClient.getStartPageToken()
      ]) {
        const error = await call().catch((e) => e);
        expect(error.status).toBe(rejection.status);
        expect(error.feedUnavailable).toBeUndefined();
        expect(isDriveAuthFailure(error)).toBe(false);
      }
      expect(list.mock.calls.length).toBeGreaterThan(1); // retried first, like every call
      expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    }
  );

  // The stale-token rule holds for the feed as for every other call: a 401 for
  // a token a re-auth has since replaced is that token's, not the held one's.
  it('a feed read answered 401 for a replaced token is sent again with the held one', async () => {
    tk.value = 'TOKEN';
    getStartPageToken
      .mockImplementationOnce(async () => {
        tk.value = 'NEWER';
        throw { status: 401, result: {}, headers: {} };
      })
      .mockResolvedValueOnce({ result: { startPageToken: '125' } });
    list
      .mockImplementationOnce(async () => {
        tk.value = 'NEWEST';
        throw { status: 401, result: {}, headers: {} };
      })
      .mockResolvedValueOnce({ result: { changes: [], newStartPageToken: 'n' } });

    await expect(driveApiClient.getStartPageToken()).resolves.toBe('125');
    await expect(driveApiClient.listChanges('start', 'changes(fileId)')).resolves.toEqual({
      changes: [],
      newStartPageToken: 'n'
    });
    expect(getStartPageToken).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
    expect(tokenManager.clearToken).not.toHaveBeenCalled();
  });

  it('a named 403 refusal on the feed is "feed unavailable"', async () => {
    list.mockRejectedValue({
      status: 403,
      result: { error: { errors: [{ reason: 'insufficientFilePermissions' }] } }
    });

    const error = await driveApiClient.listChanges('start', 'changes(fileId)').catch((e) => e);

    expect(error.feedUnavailable).toBe(true);
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });

  it('a network failure is neither auth nor "feed unavailable"', async () => {
    getStartPageToken.mockRejectedValue(new Error('network error'));

    const error = await driveApiClient.getStartPageToken().catch((e) => e);

    expect(isDriveAuthFailure(error)).toBe(false);
    expect(error.feedUnavailable).toBeUndefined();
    expect(tokenManager.reAuthenticate).not.toHaveBeenCalled();
  });
});
