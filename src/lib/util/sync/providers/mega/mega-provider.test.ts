import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('./mega-cache', () => ({ megaCache: { fetch: vi.fn() } }));
vi.mock('../../cache-manager', () => ({
  cacheManager: { clearAll: vi.fn(), registerCache: vi.fn() }
}));

// Controllable megajs Storage mock.
const storageState = vi.hoisted(() => ({
  // What the next `new Storage(opts, cb)` should do.
  loginError: null as Error | null,
  lastOptions: null as any,
  toJSON: () => ({
    key: 'MASTERKEY',
    sid: 'SID123',
    name: 'n',
    user: 'u',
    options: { email: 'a@b.c', password: 'secret', secondFactorCode: '123456', autoload: true }
  }),
  files: { f1: { name: 'mokuro-reader', directory: true } } as Record<string, any>,
  reloadError: null as Error | null
}));

vi.mock('megajs', () => {
  class MockStorage {
    files: Record<string, any>;
    sid = 'SID123';
    reload = vi.fn(async () => {});
    on = vi.fn();
    constructor(options: any, cb?: (e: Error | null) => void) {
      storageState.lastOptions = options;
      this.files = storageState.files;
      // Defer cb so the caller's `const s = new Storage(...)` is assigned first.
      if (cb) queueMicrotask(() => cb(storageState.loginError));
    }
    toJSON() {
      return storageState.toJSON();
    }
    getAccountInfo() {
      return Promise.resolve({ spaceUsed: 0, spaceTotal: 100 });
    }
    static fromJSON = vi.fn((json: any) => {
      const s = new MockStorage({ autologin: false, autoload: false } as any);
      s.sid = json.sid;
      (s as any).reload = vi.fn(async () => {
        if (storageState.reloadError) throw storageState.reloadError;
      });
      return s;
    });
  }
  return { Storage: MockStorage, File: vi.fn() };
});

import { MegaProvider } from './mega-provider';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  storageState.loginError = null;
  storageState.reloadError = null;
  storageState.files = { f1: { name: 'mokuro-reader', directory: true } };
});

describe('MegaProvider.login()', () => {
  it('persists a sanitized session blob and removes legacy password on success', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();

    localStorage.setItem('mega_email', 'a@b.c');
    localStorage.setItem('mega_password', 'secret');

    await provider.login({ email: 'a@b.c', password: 'secret' });

    expect(provider.isAuthenticated()).toBe(true);
    const raw = localStorage.getItem('mega_session');
    expect(raw).toBeTruthy();
    const blob = JSON.parse(raw!);
    expect(blob.sid).toBe('SID123');
    expect(blob.key).toBe('MASTERKEY');
    expect(blob.options).not.toHaveProperty('password');
    expect(blob.options).not.toHaveProperty('secondFactorCode');
    expect(localStorage.getItem('mega_email')).toBeNull();
    expect(localStorage.getItem('mega_password')).toBeNull();
    expect(localStorage.getItem('active_cloud_provider')).toBe('mega');
  });

  it('forwards secondFactorCode to the Storage constructor', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();

    await provider.login({ email: 'a@b.c', password: 'secret', secondFactorCode: '654321' });

    expect(storageState.lastOptions.secondFactorCode).toBe('654321');
  });

  it('logs in with keepalive enabled and listens to storage change events', async () => {
    // The sc long-poll keeps the local tree in sync and feeds the reactive
    // cache. (Its old delete-event crash came from us manually removing nodes
    // from storage.files — those manual removals are gone.)
    const provider = new MegaProvider();
    await provider.whenReady();

    await provider.login({ email: 'a@b.c', password: 'secret' });

    expect(storageState.lastOptions.keepalive).toBe(true);
    const listened = (provider as any).storage.on.mock.calls.map((c: any[]) => c[0]);
    expect(listened).toEqual(expect.arrayContaining(['add', 'move', 'delete', 'update']));
  });

  it('maps EMFAREQUIRED to a MFA_REQUIRED ProviderError', async () => {
    storageState.loginError = new Error('EMFAREQUIRED (-26): Multi-Factor Authentication Required');
    const provider = new MegaProvider();
    await provider.whenReady();

    await expect(provider.login({ email: 'a@b.c', password: 'secret' })).rejects.toMatchObject({
      code: 'MFA_REQUIRED'
    });
    expect(provider.isAuthenticated()).toBe(false);
    expect(localStorage.getItem('mega_session')).toBeNull();
  });
});

describe('MegaProvider session restore + migration', () => {
  it('migrates legacy email/password to a session blob on load', async () => {
    localStorage.setItem('mega_email', 'a@b.c');
    localStorage.setItem('mega_password', 'secret');

    const provider = new MegaProvider();
    await provider.whenReady();

    expect(provider.isAuthenticated()).toBe(true);
    expect(localStorage.getItem('mega_session')).toBeTruthy();
    expect(localStorage.getItem('mega_password')).toBeNull();
  });

  it('restores from an existing session blob without re-login', async () => {
    localStorage.setItem(
      'mega_session',
      JSON.stringify({ key: 'MASTERKEY', sid: 'SID123', name: 'n', user: 'u', options: {} })
    );

    const provider = new MegaProvider();
    await provider.whenReady();

    expect(provider.isAuthenticated()).toBe(true);
    const { Storage } = (await import('megajs')) as any;
    expect(Storage.fromJSON).toHaveBeenCalledOnce();
  });

  it('flags needs-attention when the stored session is expired (ESID)', async () => {
    storageState.reloadError = new Error(
      'ESID (-15): Invalid or expired user session, please relogin'
    );
    localStorage.setItem(
      'mega_session',
      JSON.stringify({
        key: 'MASTERKEY',
        sid: 'DEAD',
        name: 'n',
        user: 'u',
        options: { email: 'a@b.c' }
      })
    );

    const provider = new MegaProvider();
    await provider.whenReady();

    expect(provider.isAuthenticated()).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(true);
    expect(localStorage.getItem('mega_session')).toBeNull();
  });
});

describe('MegaProvider needs-attention', () => {
  it('exposes the stored email via getLastUsername after session expiry', async () => {
    storageState.reloadError = new Error('ESID (-15): please relogin');
    localStorage.setItem(
      'mega_session',
      JSON.stringify({ key: 'K', sid: 'DEAD', options: { email: 'me@host.dev' } })
    );
    const provider = new MegaProvider();
    await provider.whenReady();
    expect(provider.getLastUsername()).toBe('me@host.dev');
  });
});

describe('MegaProvider.logout()', () => {
  it('clears session, legacy keys, and needs-attention flag', async () => {
    localStorage.setItem('mega_session', JSON.stringify({ key: 'K', sid: 'S', options: {} }));
    localStorage.setItem('mega_email', 'a@b.c');
    localStorage.setItem('mega_password', 'p');
    localStorage.setItem('mega_folder_path', '/Mokuro');
    localStorage.setItem('active_cloud_provider', 'mega');

    const provider = new MegaProvider();
    await provider.whenReady();
    await provider.logout();

    expect(localStorage.getItem('mega_session')).toBeNull();
    expect(localStorage.getItem('mega_email')).toBeNull();
    expect(localStorage.getItem('mega_password')).toBeNull();
    expect(localStorage.getItem('mega_folder_path')).toBeNull();
    expect(localStorage.getItem('active_cloud_provider')).toBeNull();
    expect(provider.getStatus().needsAttention).toBe(false);
    expect(provider.isAuthenticated()).toBe(false);
  });
});

describe('MegaProvider.getWorkerUploadCredentials()', () => {
  it('returns the session blob, never a password', async () => {
    const sessionRaw = JSON.stringify({ key: 'K', sid: 'S', options: { email: 'a@b.c' } });
    localStorage.setItem('mega_session', sessionRaw);

    const provider = new MegaProvider();
    await provider.whenReady();
    const creds = await provider.getWorkerUploadCredentials();

    expect(creds).toEqual({ megaSession: sessionRaw });
    expect(creds).not.toHaveProperty('megaPassword');
    expect(creds).not.toHaveProperty('megaEmail');
  });
});

describe('MegaProvider.getWorkerDownloadCredentials() (Phase 2)', () => {
  it('returns sid + nodeId + encoded per-file key, never a share link or master key', async () => {
    localStorage.setItem('mega_session', JSON.stringify({ key: 'K', sid: 'SID123', options: {} }));
    const provider = new MegaProvider();
    await provider.whenReady();

    // Seed the restored storage's tree with a target node.
    (provider as any).storage = {
      sid: 'SID123',
      files: {
        node1: { nodeId: 'node1', directory: false, key: new Uint8Array([255, 255, 255]) }
      }
    };

    const creds = await provider.getWorkerDownloadCredentials('node1');
    expect(creds).toEqual({ sid: 'SID123', nodeId: 'node1', fileKey: '____' });
    expect(creds).not.toHaveProperty('megaShareUrl');
  });

  it('throws NOT_AUTHENTICATED when not authenticated', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();
    await expect(provider.getWorkerDownloadCredentials('node1')).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED'
    });
  });

  it('throws NODE_NOT_FOUND when the node is missing', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();
    (provider as any).storage = { sid: 'SID123', files: {} };
    await expect(provider.getWorkerDownloadCredentials('missing')).rejects.toMatchObject({
      code: 'NODE_NOT_FOUND'
    });
  });
});

describe('MegaProvider.reinitialize() — session-safe refresh', () => {
  // Regression: megajs storage.close() sends {a:'sml'}, which TERMINATES the shared
  // session sid server-side. Because every storage (login, restore, reinitialize) reuses
  // the one persisted sid, closing any of them invalidates the persisted token and every
  // subsequent request fails with ESID (-15). reinitialize must refresh the file tree in
  // place via reload(true) and NEVER call storage.close().
  it('reloads the existing session in place and never calls storage.close()', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();

    const reload = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    (provider as any).storage = {
      sid: 'SID123',
      files: { f1: { name: 'mokuro-reader', directory: true } },
      reload,
      close
    };

    await (provider as any).reinitialize();

    expect(reload).toHaveBeenCalledWith(true);
    expect(close).not.toHaveBeenCalled();
    expect(provider.isAuthenticated()).toBe(true);
  });

  it('marks the session expired (without closing) when in-place reload throws ESID', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();
    localStorage.setItem(
      'mega_session',
      JSON.stringify({ key: 'K', sid: 'SID', options: { email: 'a@b.c' } })
    );

    const close = vi.fn(async () => {});
    (provider as any).storage = {
      sid: 'SID',
      files: {},
      close,
      reload: vi.fn(async () => {
        throw new Error('ESID (-15): Invalid or expired user session, please relogin');
      })
    };

    await (provider as any).reinitialize();

    expect(close).not.toHaveBeenCalled();
    expect(provider.getStatus().needsAttention).toBe(true);
    expect(localStorage.getItem('mega_session')).toBeNull();
  });
});

describe('MegaProvider.prepareUploadTarget()', () => {
  it('returns the series folder node id so workers reuse it instead of mkdir-ing', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();
    (provider as any).storage = { files: {} };
    (provider as any).ensureMokuroFolder = vi.fn(async () => ({ nodeId: 'MOKURO' }));
    (provider as any).ensureSeriesFolder = vi.fn(async () => ({ nodeId: 'SERIES1' }));

    const result = await provider.prepareUploadTarget('My Series');

    expect(result).toEqual({ megaSeriesFolderNodeId: 'SERIES1' });
  });
});

describe('MegaProvider.removeDirectoryIfEmpty()', () => {
  async function providerWithSeriesFolder(serverNodes: any[]) {
    const provider = new MegaProvider();
    await provider.whenReady();
    await provider.login({ email: 'a@b.c', password: 'secret' });

    const storage = (provider as any).storage;
    const mokuroFolder = { name: 'mokuro-reader', directory: true, nodeId: 'root-1' };
    const seriesFolder = {
      name: 'Old Series',
      directory: true,
      nodeId: 'series-1',
      parent: mokuroFolder,
      delete: vi.fn((_permanent: boolean, cb: (e: Error | null) => void) => cb(null))
    };
    storage.files = { root: mokuroFolder, series: seriesFolder };
    storage.api = {
      request: vi.fn((_req: any, cb: (e: Error | null, r: any) => void) =>
        cb(null, { f: serverNodes })
      )
    };
    return { provider, seriesFolder, storage };
  }

  it('deletes the folder when the SERVER reports it empty', async () => {
    const { provider, seriesFolder, storage } = await providerWithSeriesFolder([
      { h: 'series-1' } // only the folder's own node comes back
    ]);

    await provider.removeDirectoryIfEmpty('Old Series');

    expect(storage.api.request).toHaveBeenCalledWith(
      expect.objectContaining({ a: 'f', n: 'series-1' }),
      expect.any(Function)
    );
    expect(seriesFolder.delete).toHaveBeenCalled();
  });

  it('does NOT delete when the server still reports contents (never a blind recursive delete)', async () => {
    const { provider, seriesFolder } = await providerWithSeriesFolder([
      { h: 'series-1' },
      { h: 'file-9', p: 'series-1' } // a straggler another device just added
    ]);

    await provider.removeDirectoryIfEmpty('Old Series');

    expect(seriesFolder.delete).not.toHaveBeenCalled();
  });

  it('no-ops when the folder does not exist', async () => {
    const { provider, storage } = await providerWithSeriesFolder([]);
    storage.files = { root: { name: 'mokuro-reader', directory: true, nodeId: 'root-1' } };

    await expect(provider.removeDirectoryIfEmpty('Ghost Series')).resolves.toBeUndefined();
    expect(storage.api.request).not.toHaveBeenCalled();
  });
});
