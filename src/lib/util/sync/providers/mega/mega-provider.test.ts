import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('./mega-cache', () => ({ megaCache: { fetch: vi.fn() } }));
vi.mock('../../cache-manager', () => ({
  cacheManager: { clearAll: vi.fn(), registerCache: vi.fn() }
}));
const updateStatus = vi.hoisted(() => vi.fn());
vi.mock('../../provider-manager', () => ({ providerManager: { updateStatus } }));
// The order an explicit logout does things in (see 'MegaProvider.logout()').
const logoutSteps = vi.hoisted(() => [] as string[]);
const cancelProviderUploads = vi.hoisted(() =>
  vi.fn(async (provider: string) => {
    logoutSteps.push(`cancel:${provider}`);
  })
);
vi.mock('../../upload-cancellation', () => ({ cancelProviderUploads }));

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
  // megajs's own handles on the Cloud Drive and Rubbish Bin nodes.
  root: undefined as any,
  trash: undefined as any,
  reloadError: null as Error | null
}));

/**
 * A stand-in for megajs's API object: request() plus the EventEmitter calls
 * the provider makes on its 'sc' channel.
 */
const fakeApi = vi.hoisted(() => (): any => {
  const handlers: Array<(...args: any[]) => void> = [];
  return {
    request: vi.fn(),
    on: (_event: string, handler: (...args: any[]) => void) => handlers.push(handler),
    listeners: () => [...handlers],
    listenerCount: () => handlers.length,
    removeAllListeners: () => handlers.splice(0),
    emit: (_event: string, ...args: any[]) => handlers.forEach((handler) => handler(...args))
  };
});

vi.mock('megajs', () => {
  class MockStorage {
    files: Record<string, any>;
    root: any;
    trash: any;
    sid = 'SID123';
    api = fakeApi();
    reload = vi.fn(async () => {});
    on = vi.fn();
    constructor(options: any, cb?: (e: Error | null) => void) {
      storageState.lastOptions = options;
      this.files = storageState.files;
      this.root = storageState.root;
      this.trash = storageState.trash;
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
import { megaCache } from './mega-cache';
import { ingestMarkerRead, resetCloudBunkoMarkersForTest } from '$lib/catalog/cloud-bunko-marker';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  storageState.loginError = null;
  storageState.reloadError = null;
  storageState.files = { f1: { name: 'mokuro-reader', directory: true } };
  storageState.root = undefined;
  storageState.trash = undefined;
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

  it('logs in without megajs keepalive, loads the tree once, and listens to storage change events', async () => {
    // The sc long-poll keeps the local tree in sync and feeds the reactive
    // cache — but megajs (keepalive:true) starts a new poll per full load and
    // never stops the old ones, so the provider runs the one poll itself.
    const provider = new MegaProvider();
    await provider.whenReady();

    await provider.login({ email: 'a@b.c', password: 'secret' });

    expect(storageState.lastOptions.keepalive).toBe(false);
    expect(storageState.lastOptions.autoload).toBe(false);
    expect((provider as any).storage.reload).toHaveBeenCalledOnce();
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

describe('MegaProvider getStatus().accountScope', () => {
  it('is undefined before any login/session restore', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();

    expect(provider.getStatus().accountScope).toBeUndefined();
  });

  it('is `mega:<email>` after a successful login', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();

    await provider.login({ email: 'a@b.c', password: 'secret' });

    expect(provider.getStatus().accountScope).toBe('mega:a@b.c');
  });

  it('lowercases the email so differently-cased logins share one cache scope', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();

    await provider.login({ email: 'A@B.COM', password: 'secret' });

    expect(provider.getStatus().accountScope).toBe('mega:a@b.com');
  });

  it('is populated after restoring a session blob, without a fresh login', async () => {
    localStorage.setItem(
      'mega_session',
      JSON.stringify({ key: 'K', sid: 'SID123', options: { email: 'restored@host.dev' } })
    );

    const provider = new MegaProvider();
    await provider.whenReady();

    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.getStatus().accountScope).toBe('mega:restored@host.dev');
  });
});

describe('MegaProvider.logout()', () => {
  beforeEach(() => {
    logoutSteps.length = 0;
  });

  /** A live session whose `close()` is `close` (megajs: sends `{a:'sml'}`). */
  async function connected(close: () => Promise<unknown>) {
    localStorage.setItem('mega_session', JSON.stringify({ key: 'K', sid: 'S', options: {} }));
    localStorage.setItem('active_cloud_provider', 'mega');
    const provider = new MegaProvider();
    await provider.whenReady();
    (provider as any).storage = { sid: 'S', files: {}, api: fakeApi(), close };
    return provider;
  }

  it('cancels the uploads, then ends the session on the server', async () => {
    const close = vi.fn(async () => {
      // Local state is already gone when the network call goes out.
      logoutSteps.push(`close:${localStorage.getItem('mega_session') ?? 'cleared'}`);
    });
    const provider = await connected(close);

    await provider.logout();
    await provider.whenServerLogoutSettled();

    expect(cancelProviderUploads).toHaveBeenCalledWith('mega', expect.any(String));
    expect(close).toHaveBeenCalledTimes(1);
    expect(logoutSteps).toEqual(['cancel:mega', 'close:cleared']);
    expect(provider.isAuthenticated()).toBe(false);
  });

  it('returns without waiting on the close, which gives up after 3 s', async () => {
    // The provider manager clears its caches and the active-provider key once
    // logout() resolves: a wait on the server there would leave the old
    // listing on screen, and wipe the key of a login made meanwhile.
    vi.useFakeTimers();
    try {
      const close = vi.fn(() => new Promise(() => {}));
      const provider = await connected(close);
      let closeSettled = false;

      await provider.logout();
      void provider.whenServerLogoutSettled().then(() => (closeSettled = true));

      expect(close).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('mega_session')).toBeNull();
      expect(localStorage.getItem('active_cloud_provider')).toBeNull();
      expect(provider.isAuthenticated()).toBe(false);

      await vi.advanceTimersByTimeAsync(2_999);
      expect(closeSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(closeSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears local state even when the server refuses the close', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = await connected(async () => {
      throw new Error('ESID (-15): Invalid or expired user session');
    });

    await expect(provider.logout()).resolves.toBeUndefined();
    await expect(provider.whenServerLogoutSettled()).resolves.toBeUndefined();

    expect(localStorage.getItem('mega_session')).toBeNull();
    expect(provider.isAuthenticated()).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
    warn.mockRestore();
  });

  it('ends a stored session that never came back online (no live Storage)', async () => {
    // A restore that failed on a network error leaves the blob and no
    // Storage: the sid is still valid at MEGA, so it is rebuilt to close it.
    const megajs = await import('megajs');
    const close = vi.fn(async () => {});
    const fromJSON = vi.mocked((megajs.Storage as any).fromJSON);
    const provider = new MegaProvider();
    await provider.whenReady();
    localStorage.setItem('mega_session', JSON.stringify({ key: 'K', sid: 'OLD', options: {} }));
    fromJSON.mockImplementationOnce((json: any) => ({ sid: json.sid, close }));

    await provider.logout();
    await provider.whenServerLogoutSettled();

    expect(fromJSON).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sid: 'OLD',
        options: expect.objectContaining({ keepalive: false })
      })
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('mega_session')).toBeNull();
  });

  it('rejects a main-thread upload still in flight instead of leaving it hanging', async () => {
    // megajs drops every response that lands after close() without calling
    // back: an upload waiting on one would never settle.
    const provider = await connected(async () => {});
    (provider as any).ensureMokuroFolder = vi.fn(() => new Promise(() => {}));

    const upload = provider.uploadFile('Series/Vol.mokuro', new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    await provider.logout();

    await expect(upload).rejects.toMatchObject({ code: 'UPLOAD_CANCELLED' });
  });

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
      api: fakeApi(),
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
      api: fakeApi(),
      close,
      reload: vi.fn(async () => {
        throw new Error('ESID (-15): Invalid or expired user session, please relogin');
      })
    };

    await (provider as any).reinitialize();

    expect(close).not.toHaveBeenCalled();
    expect(provider.getStatus().needsAttention).toBe(true);
    expect(localStorage.getItem('mega_session')).toBeNull();
    // Published: the navbar's banner and the cloud screen read the provider
    // manager's status, which moves only when asked.
    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalled());
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
    const mokuroFolder: any = {
      name: 'mokuro-reader',
      directory: true,
      nodeId: 'root-1',
      children: []
    };
    const seriesFolder = {
      name: 'Old Series',
      directory: true,
      nodeId: 'series-1',
      parent: mokuroFolder,
      delete: vi.fn((_permanent: boolean, cb: (e: Error | null) => void) => cb(null))
    };
    mokuroFolder.children.push(seriesFolder);
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

  it("counts only the folder's own subtree when the server answers with the whole tree", async () => {
    const { provider, seriesFolder } = await providerWithSeriesFolder([
      { h: 'drive' },
      { h: 'root-1', p: 'drive' },
      { h: 'series-1', p: 'root-1' },
      { h: 'other-series', p: 'root-1' },
      { h: 'file-1', p: 'other-series' }
    ]);

    await provider.removeDirectoryIfEmpty('Old Series');

    expect(seriesFolder.delete).toHaveBeenCalled();
  });

  it('counts nested contents as contents', async () => {
    const { provider, seriesFolder } = await providerWithSeriesFolder([
      { h: 'series-1', p: 'root-1' },
      { h: 'sub', p: 'series-1' },
      { h: 'deep', p: 'sub' }
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

describe('MegaProvider ghost-node handling', () => {
  // A "ghost" is a node deleted server-side that megajs never evicts from
  // storage.files: its sc delete handler only unlinks parent.children, and
  // reload() is purely additive (_importFile skips known handles). Ghosts
  // made every sync fail: the pre-upload replace delete hit server ENOENT (-9)
  // and the reload-based retry could never remove the ghost.

  function makeMokuroFolder() {
    return {
      name: 'mokuro-reader',
      directory: true,
      children: [],
      upload: vi.fn((_opts: any, _buf: any, cb: (e: Error | null, f?: any) => void) => {
        // `timestamp` (epoch seconds) is the SERVER's stamp on the completed
        // node — the same field listCloudVolumes maps to `modifiedTime`.
        queueMicrotask(() => cb(null, { nodeId: 'fresh-node', timestamp: 1_780_000_000, size: 3 }));
      })
    } as any;
  }

  function makeFile(name: string, parent: any, deleteError: Error | null = null) {
    const file = {
      name,
      directory: false,
      parent,
      delete: vi.fn((_force: boolean, cb: (e: Error | null) => void) => {
        queueMicrotask(() => cb(deleteError));
      })
    } as any;
    // Linked both ways, as megajs's _importFile links it.
    parent.children.push(file);
    return file;
  }

  async function loginWithTree(files: Record<string, any>) {
    storageState.files = files;
    const provider = new MegaProvider();
    await provider.whenReady();
    await provider.login({ email: 'a@b.c', password: 'secret' });
    return provider;
  }

  it('uploadFile tolerates ENOENT when deleting a ghost copy and still uploads', async () => {
    const folder = makeMokuroFolder();
    const ghost = makeFile(
      'volume-data.json',
      folder,
      new Error('ENOENT (-9): Object (typically, node or user) not found. Wrong password?')
    );
    const provider = await loginWithTree({ root: folder, ghost });

    const uploaded = await provider.uploadFile('volume-data.json', new Uint8Array([1, 2, 3]));

    expect(ghost.delete).toHaveBeenCalled();
    expect(folder.upload).toHaveBeenCalledOnce();
    // The result carries the node's SERVER timestamp as `modifiedTime`, so
    // the upload-time cache entry needs no provisional client-clock stamp.
    // ...and the new node's id as the revision (every upload mints one).
    expect(uploaded).toEqual({
      fileId: 'fresh-node',
      revision: 'fresh-node',
      modifiedTime: new Date(1_780_000_000 * 1000).toISOString(),
      size: 3
    });
  });

  it('statFile reads the node the session holds (no request): the node id is the revision', async () => {
    const folder = makeMokuroFolder();
    const node = makeFile('volume-data.json', folder);
    Object.assign(node, { nodeId: 'node-1', timestamp: 1_780_000_000, size: 9 });
    const provider = await loginWithTree({ root: folder, node });
    pollRunning(provider);
    const listed = {
      provider: 'mega' as const,
      fileId: 'node-1',
      path: 'volume-data.json',
      modifiedTime: '',
      size: 0
    };

    expect(await provider.statFile(listed)).toEqual({
      size: 9,
      modifiedTime: new Date(1_780_000_000 * 1000).toISOString(),
      revision: 'node-1'
    });
    // An unknown id, or a node no longer in its folder, is gone.
    expect(await provider.statFile({ ...listed, fileId: 'other' })).toBeNull();
    folder.children.splice(folder.children.indexOf(node), 1);
    expect(await provider.statFile(listed)).toBeNull();
  });

  /**
   * The tree is only as current as the `sc` poll that applies other devices'
   * changes to it. The unit mock starts no poll, so a test that wants one
   * running says so. (A real one runs from every full-tree load.)
   */
  function pollRunning(provider: MegaProvider): void {
    (provider as unknown as { stopServerChanges: () => void }).stopServerChanges = vi.fn();
  }

  // A poll that gave up (offline past its recovery backoff) leaves the tree
  // frozen: another device's replace deletes the node this tree still holds
  // linked. A stat answered from it would vouch for the deleted node, and the
  // root-file memo would return its old bytes on every sync. The download it
  // replaced failed ENOENT there, which reloads the tree; that must stay so.
  it('statFile vouches for no node while the server-change poll is not running', async () => {
    const folder = makeMokuroFolder();
    const node = makeFile('volume-data.json', folder);
    Object.assign(node, { nodeId: 'node-1', timestamp: 1_780_000_000, size: 3 });
    const provider = await loginWithTree({ root: folder, node });
    const listed = {
      provider: 'mega' as const,
      fileId: 'node-1',
      path: 'volume-data.json',
      modifiedTime: '',
      size: 3
    };
    const { readRootFile, clearRootFileMemo } = await import('../../root-file-memo');
    clearRootFileMemo();
    const download = vi
      .spyOn(provider, 'downloadFile')
      .mockImplementation(async () => new Blob([new Uint8Array([1, 2, 3])]));

    // Poll alive: the first read downloads and memoizes, the next is a stat.
    pollRunning(provider);
    await readRootFile(provider, listed);
    await readRootFile(provider, listed);
    expect(download).toHaveBeenCalledTimes(1);

    // Poll gone: the stat refuses, so the read downloads (and a gone node
    // fails there with ENOENT, which reloads the tree).
    (provider as unknown as { stopServerChanges: null }).stopServerChanges = null;
    await expect(provider.statFile(listed)).rejects.toThrow(/server-change/i);
    await readRootFile(provider, listed);
    expect(download).toHaveBeenCalledTimes(2);
    clearRootFileMemo();
  });

  it('uploadFile replaces every same-name copy, not just the first', async () => {
    const folder = makeMokuroFolder();
    const dupe1 = makeFile('volume-data.json', folder);
    const dupe2 = makeFile('volume-data.json', folder);
    const provider = await loginWithTree({ root: folder, dupe1, dupe2 });

    await provider.uploadFile('volume-data.json', new Uint8Array([1]));

    expect(dupe1.delete).toHaveBeenCalledOnce();
    expect(dupe2.delete).toHaveBeenCalledOnce();
    expect(folder.upload).toHaveBeenCalledOnce();
  });

  // A full account (or any failed upload) must not cost the cloud its only copy:
  // the old one is removed only once its replacement landed.
  it('uploadFile removes the old copy only after the new one landed', async () => {
    const folder = makeMokuroFolder();
    const old = makeFile('volume-data.json', folder);
    const provider = await loginWithTree({ root: folder, old });

    await provider.uploadFile('volume-data.json', new Uint8Array([1]));

    expect(old.delete).toHaveBeenCalledOnce();
    expect(folder.upload.mock.invocationCallOrder[0]).toBeLessThan(
      old.delete.mock.invocationCallOrder[0]
    );
  });

  // The new copy landed: a refused delete of an old one leaves a duplicate a
  // listing merges, not a failed upload (a caller's retry would upload a third).
  it('a refused delete of an old copy after the upload still answers the upload', async () => {
    const folder = makeMokuroFolder();
    const stuck = makeFile(
      'volume-data.json',
      folder,
      new Error('EACCESS (-11): Access violation')
    );
    const other = makeFile('volume-data.json', folder);
    const provider = await loginWithTree({ root: folder, stuck, other });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const uploaded = await provider.uploadFile('volume-data.json', new Uint8Array([1, 2, 3]));

    expect(uploaded).toMatchObject({ fileId: 'fresh-node' });
    expect(folder.upload).toHaveBeenCalledOnce();
    expect(stuck.delete).toHaveBeenCalledOnce();
    expect(other.delete).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/old copy/),
      expect.stringMatching(/EACCESS/)
    );
    warn.mockRestore();
  });

  it('a failed upload leaves the copy it would have replaced', async () => {
    const folder = makeMokuroFolder();
    folder.upload = vi.fn((_opts: any, _buf: any, cb: (e: Error | null, f?: any) => void) => {
      queueMicrotask(() => cb(new Error('EOVERQUOTA (-17): Request over quota')));
    });
    const old = makeFile('volume-data.json', folder);
    const provider = await loginWithTree({ root: folder, old });

    await expect(
      provider.uploadFile('volume-data.json', new Uint8Array([1]))
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(old.delete).not.toHaveBeenCalled();
  });

  it('reinitialize rebuilds storage.files so server-deleted ghosts are evicted', async () => {
    const folder = makeMokuroFolder();
    const ghost = makeFile('volume-data.json', folder);
    const real = makeFile('real.cbz', folder);
    const provider = await loginWithTree({ root: folder, ghost });
    const storage = (provider as any).storage;

    // Mirror megajs reload() semantics: one `{a:'f'}` request whose callback
    // imports the server's node set (which no longer contains the ghost)
    // ADDITIVELY into storage.files.
    const server: Record<string, any> = { root: folder, real };
    storage.api.request = vi.fn((_json: any, cb: (e: Error | null, r?: any) => void) => {
      queueMicrotask(() => cb(null, { f: Object.keys(server).map((h) => ({ h })), ok: [] }));
    });
    storage.reload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          storage.api.request({ a: 'f', c: 1 }, (_e: Error | null, response: any) => {
            for (const { h } of response.f) {
              if (!storage.files[h]) storage.files[h] = server[h];
            }
            resolve();
          });
        })
    );

    await (provider as any).reinitialize();

    expect(Object.keys(storage.files).sort()).toEqual(['real', 'root']);
  });

  it('reinitialize leaves ONE sc handler, however many reloads ran (megajs stacks one per reload)', async () => {
    const folder = makeMokuroFolder();
    const provider = await loginWithTree({ root: folder });
    const storage = (provider as any).storage;
    // megajs's reload() attaches a new api 'sc' handler on every call.
    const handlers: any[] = [];
    storage.reload = vi.fn(async () => {
      const handler = vi.fn();
      handlers.push(handler);
      storage.api.on('sc', handler);
    });

    await (provider as any).reinitialize();
    await (provider as any).reinitialize();
    storage.api.emit('sc', [{ a: 'u', n: 'x' }]);

    expect(storage.api.listenerCount('sc')).toBe(1);
    // Every packet is applied once, not once per reload.
    expect(handlers.map((h) => h.mock.calls.length)).toEqual([0, 1]);
  });

  it('reinitialize keeps the previous tree when the reload fails transiently', async () => {
    const folder = makeMokuroFolder();
    const ghost = makeFile('volume-data.json', folder);
    const provider = await loginWithTree({ root: folder, ghost });
    const storage = (provider as any).storage;
    storage.reload = vi.fn(async () => {
      throw new Error('ETEMPUNAVAIL (-18): A temporary congestion or server malfunction');
    });

    await (provider as any).reinitialize();

    expect(provider.isAuthenticated()).toBe(true);
    expect(Object.keys(storage.files).sort()).toEqual(['ghost', 'root']);
  });
});

describe('MegaProvider listing — nodes MEGA no longer shows', () => {
  // megajs never evicts a node from storage.files. Its sc delete handler only
  // splices the node out of parent.children, and a move to the Rubbish Bin
  // only re-parents it. The reader must still treat both as gone, the way
  // MEGA's own apps do: a deleted volume that keeps being listed has a dead
  // handle (every download fails with ENOENT -9), and a trashed library keeps
  // showing every series it had.

  /** A tree linked the way megajs's _importFile and sc handler link it. */
  function megaTree() {
    const files: Record<string, any> = {};
    const add = (handle: string, name: string, parent: any, directory = false) => {
      const node: any = { nodeId: handle, name, directory, timestamp: 1_780_000_000, size: 1 };
      if (directory) {
        node.children = [];
        node.mkdir = vi.fn((childName: string, cb: (e: Error | null, f?: any) => void) => {
          queueMicrotask(() => cb(null, add(`${handle}/${childName}`, childName, node, true)));
        });
        node.upload = vi.fn((opts: any, _buf: any, cb: (e: Error | null, f?: any) => void) => {
          queueMicrotask(() => cb(null, add(`${handle}/${opts.name}`, opts.name, node)));
        });
      }
      files[handle] = node;
      if (parent) {
        node.parent = parent;
        parent.children.push(node);
      }
      return node;
    };
    const root = add('ROOT', 'Cloud Drive', null, true);
    const trash = add('TRASH', 'Rubbish Bin', null, true);
    /** megajs's sc `d` handler: unlinked from the parent, kept in storage.files. */
    const scDelete = (node: any) => {
      node.parent.children.splice(node.parent.children.indexOf(node), 1);
    };
    /** megajs's sc `t` handler for a known node: re-parented and re-linked. */
    const scMove = (node: any, to: any) => {
      scDelete(node);
      node.parent = to;
      to.children.push(node);
    };
    return { files, root, trash, add, scDelete, scMove };
  }

  function seriesLibrary(tree: ReturnType<typeof megaTree>, parent: any, series: string) {
    const library = tree.add(`${series}-lib`, 'mokuro-reader', parent, true);
    const folder = tree.add(`${series}-dir`, series, library, true);
    const volume = tree.add(`${series}-v1`, `${series} 01.cbz`, folder);
    tree.add(`${series}-index`, 'series.json', folder);
    return { library, folder, volume };
  }

  async function loginWithTree(tree: ReturnType<typeof megaTree>) {
    storageState.files = tree.files;
    storageState.root = tree.root;
    storageState.trash = tree.trash;
    // A new library folder comes from the Cloud Drive node's own mkdir.
    const provider = new MegaProvider();
    await provider.whenReady();
    await provider.login({ email: 'a@b.c', password: 'secret' });
    return provider;
  }

  const listedPaths = async (provider: MegaProvider) =>
    (await provider.listCloudVolumes(true)).map((f) => f.path).sort();

  it('does not list a mokuro-reader folder that was moved to the Rubbish Bin', async () => {
    const tree = megaTree();
    seriesLibrary(tree, tree.trash, 'Ippo');
    const provider = await loginWithTree(tree);

    expect(await listedPaths(provider)).toEqual([]);
  });

  it('lists only the live library when a trashed mokuro-reader sits beside it', async () => {
    const tree = megaTree();
    seriesLibrary(tree, tree.trash, 'Ippo');
    seriesLibrary(tree, tree.root, 'Live');
    const provider = await loginWithTree(tree);

    expect(await listedPaths(provider)).toEqual(['Live/Live 01.cbz', 'Live/series.json']);
  });

  it('never uploads into a mokuro-reader folder that is in the Rubbish Bin', async () => {
    const tree = megaTree();
    const trashed = seriesLibrary(tree, tree.trash, 'Ippo');
    const provider = await loginWithTree(tree);

    await provider.uploadFile('volume-data.json', new Uint8Array([1]));

    expect(trashed.library.upload).not.toHaveBeenCalled();
    const fresh = tree.root.children.find((n: any) => n.name === 'mokuro-reader');
    expect(fresh?.upload).toHaveBeenCalledOnce();
  });

  it('stops listing a volume once the sc stream deletes it', async () => {
    const tree = megaTree();
    const { volume } = seriesLibrary(tree, tree.root, 'Ippo');
    const provider = await loginWithTree(tree);
    expect(await listedPaths(provider)).toEqual(['Ippo/Ippo 01.cbz', 'Ippo/series.json']);

    tree.scDelete(volume);

    expect(await listedPaths(provider)).toEqual(['Ippo/series.json']);
  });

  it('stops listing every file of a series folder the sc stream deletes', async () => {
    const tree = megaTree();
    const { folder } = seriesLibrary(tree, tree.root, 'Ippo');
    const provider = await loginWithTree(tree);

    tree.scDelete(folder);

    expect(await listedPaths(provider)).toEqual([]);
  });

  it('stops listing a library another device moved to the Rubbish Bin mid-session', async () => {
    const tree = megaTree();
    const { library } = seriesLibrary(tree, tree.root, 'Ippo');
    const provider = await loginWithTree(tree);

    tree.scMove(library, tree.trash);

    expect(await listedPaths(provider)).toEqual([]);
  });

  it('uploads into a new series folder, not one the sc stream deleted', async () => {
    const tree = megaTree();
    const { library, folder } = seriesLibrary(tree, tree.root, 'Ippo');
    const provider = await loginWithTree(tree);
    tree.scDelete(folder);

    await provider.uploadFile('Ippo/Ippo 02.cbz', new Uint8Array([1]));

    expect(folder.upload).not.toHaveBeenCalled();
    expect(library.mkdir).toHaveBeenCalledWith('Ippo', expect.any(Function));
  });

  it('keeps deleted and trashed folders out of the dedup pass', async () => {
    const tree = megaTree();
    seriesLibrary(tree, tree.trash, 'Trashed');
    const { folder } = seriesLibrary(tree, tree.root, 'Ippo');
    const ghost = tree.add('ghost-dir', 'Ghost', folder.parent, true);
    const provider = await loginWithTree(tree);
    tree.scDelete(ghost);

    const ops = provider.getFolderOperations();
    const names = (await ops.listFolders()).map((f) => f.name).sort();
    const contents = (await ops.listFolderContents(folder.parent.nodeId)).map((f) => f.name);

    // Only the library: the Cloud Drive itself is not the dedup's to merge.
    expect(names).toEqual(['Ippo', 'mokuro-reader']);
    expect(contents).toEqual(['Ippo']);
  });
});

describe('MegaProvider over-quota handling', () => {
  it('uploadFile maps EOVERQUOTA to a typed QUOTA_EXCEEDED error with a friendly message', async () => {
    const folder: any = {
      name: 'mokuro-reader',
      directory: true,
      upload: vi.fn((_opts: any, _buf: any, cb: (e: Error | null, f?: any) => void) => {
        queueMicrotask(() => cb(new Error('EOVERQUOTA (-17): Request over quota')));
      })
    };
    storageState.files = { root: folder };
    const provider = new MegaProvider();
    await provider.whenReady();
    await provider.login({ email: 'a@b.c', password: 'secret' });

    await expect(
      provider.uploadFile('volume-data.json', new Uint8Array([1]))
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      message: expect.stringContaining('storage is full')
    });
  });
});

describe('MegaProvider.renameFile() — modifiedTime provenance', () => {
  // A rename must never fabricate a client-clock `modifiedTime`: it changes
  // no content, so the cache entry the shared rename layer writes back
  // (unified-cloud-manager's replaceCachedFile) must carry the ORIGINAL
  // file's real mtime — otherwise cloud-sidecar-stamps.ts would publish a
  // client-clock stamp into series.json and trigger a spurious re-pull on
  // the next listing.

  function makeMokuroFolder() {
    return { name: 'mokuro-reader', directory: true } as any;
  }

  function makeRenameableFile(parent: any) {
    const file: any = {
      nodeId: 'file-1',
      name: 'Volume 1.cbz',
      directory: false,
      parent,
      rename: vi.fn(async (newName: string) => {
        file.name = newName;
      }),
      moveTo: vi.fn(async () => {})
    };
    return file;
  }

  async function loginWithTree(files: Record<string, any>) {
    storageState.files = files;
    const provider = new MegaProvider();
    await provider.whenReady();
    await provider.login({ email: 'a@b.c', password: 'secret' });
    return provider;
  }

  it('preserves the source file’s real modifiedTime through a single-file rename (never the wall clock)', async () => {
    const folder = makeMokuroFolder();
    const file = makeRenameableFile(folder);
    const provider = await loginWithTree({ root: folder, file });

    const source = {
      provider: 'mega' as const,
      fileId: 'file-1',
      path: 'Volume 1.cbz',
      modifiedTime: '2020-01-01T00:00:00.000Z',
      size: 100
    };

    const result = await provider.renameFile(source, 'Volume 2.cbz');

    expect(file.rename).toHaveBeenCalledWith('Volume 2.cbz');
    expect(result.path).toBe('Volume 2.cbz');
    // MUST equal the ORIGINAL exactly — not "close to now".
    expect(result.modifiedTime).toBe('2020-01-01T00:00:00.000Z');
    expect(result.modifiedTimeProvisional).toBeUndefined();
  });

  it('keeps modifiedTimeProvisional through a rename when the source was only ever a client-clock guess', async () => {
    const folder = makeMokuroFolder();
    const file = makeRenameableFile(folder);
    const provider = await loginWithTree({ root: folder, file });

    const source = {
      provider: 'mega' as const,
      fileId: 'file-1',
      path: 'Volume 1.cbz',
      modifiedTime: '2020-01-01T00:00:00.000Z',
      modifiedTimeProvisional: true,
      size: 100
    };

    const result = await provider.renameFile(source, 'Volume 2.cbz');

    expect(result.modifiedTime).toBe('2020-01-01T00:00:00.000Z');
    expect(result.modifiedTimeProvisional).toBe(true);
  });
});

describe('MegaProvider.readControlFile() — live tree', () => {
  const MARKER = '.mokuro-bunko.json';

  function markerBody(extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      version: 1,
      kind: 'mokuro-bunko',
      instance_id: 'aaa',
      instance_name: 'nas',
      epoch: 1,
      claimed_at: '2026-10-12T09:00:00Z',
      heartbeat_at: new Date().toISOString(),
      ttl_s: 900,
      state: 'active',
      compiles: ['series.json', 'catalog.json'],
      ocr: true,
      queue: '.mokuro-queue.json',
      ...extra
    });
  }

  /** A folder node, linked into `parent.children` like megajs leaves it. */
  function makeFolder(name = 'mokuro-reader', parent?: any) {
    const folder = { name, directory: true, parent, children: [] as any[] } as any;
    parent?.children.push(folder);
    return folder;
  }

  /** A file node linked into `parent.children` like megajs leaves it. */
  function makeNode(
    handle: string,
    name: string,
    parent: any,
    timestamp: number,
    body: string | Error = markerBody()
  ) {
    const node: any = {
      nodeId: handle,
      name,
      directory: false,
      parent,
      timestamp,
      download: vi.fn((cb: (e: Error | null, d?: Uint8Array) => void) => {
        queueMicrotask(() =>
          body instanceof Error ? cb(body) : cb(null, new TextEncoder().encode(body))
        );
      })
    };
    parent.children.push(node);
    return node;
  }

  async function loginWithTree(files: Record<string, any>) {
    storageState.files = files;
    const provider = new MegaProvider();
    await provider.whenReady();
    await provider.login({ email: 'a@b.c', password: 'secret' });
    return provider;
  }

  async function textOf(node: { blob: Blob }) {
    return new TextDecoder().decode(await node.blob.arrayBuffer());
  }

  beforeEach(() => {
    resetCloudBunkoMarkersForTest();
    localStorage.clear();
  });

  it('returns the marker of every mokuro-reader folder, newest first', async () => {
    const a = makeFolder();
    const b = makeFolder();
    const older = makeNode('H-old', MARKER, a, 1_780_000_000, markerBody({ instance_id: 'old' }));
    const newer = makeNode('H-new', MARKER, b, 1_780_000_500, markerBody({ instance_id: 'new' }));
    const provider = await loginWithTree({ a, b, older, newer });

    const result = await provider.readControlFile(MARKER);

    expect(result).not.toBeNull();
    expect(result).not.toBe('not-modified');
    const read = result as Exclude<typeof result, null | 'not-modified'>;
    expect(read.nodes.map((n) => n.id)).toEqual(['H-new', 'H-old']);
    expect(read.nodes[0]).toMatchObject({
      etag: 'H-new:1780000500',
      modified: new Date(1_780_000_500 * 1000).toISOString()
    });
    expect(JSON.parse(await textOf(read.nodes[0])).instance_id).toBe('new');
    expect(JSON.parse(await textOf(read.nodes[1])).instance_id).toBe('old');
  });

  it('answers not-modified for an unchanged tree without downloading', async () => {
    const folder = makeFolder();
    const marker = makeNode('H1', MARKER, folder, 1_780_000_000);
    const provider = await loginWithTree({ folder, marker });

    const first = (await provider.readControlFile(MARKER)) as any;
    expect(marker.download).toHaveBeenCalledTimes(1);

    const again = await provider.readControlFile(MARKER, { ifNoneMatch: first.etag });
    expect(again).toBe('not-modified');
    expect(marker.download).toHaveBeenCalledTimes(1);

    // Without ifNoneMatch the cached body is served, still no second download.
    const plain = (await provider.readControlFile(MARKER)) as any;
    expect(plain.nodes).toHaveLength(1);
    expect(marker.download).toHaveBeenCalledTimes(1);
  });

  it('downloads the new node after a live-tree replace (new handle), and the old one is gone', async () => {
    const folder = makeFolder();
    const v1 = makeNode('H1', MARKER, folder, 1_780_000_000, markerBody({ instance_name: 'one' }));
    const provider = await loginWithTree({ folder, v1 });
    const storage = (provider as any).storage;
    const first = (await provider.readControlFile(MARKER)) as any;

    // megajs's sc stream: the rewrite arrives as an add (new handle) + a delete
    // (the old handle is unlinked from its parent but lingers in storage.files).
    folder.children.splice(folder.children.indexOf(v1), 1);
    const v2 = makeNode('H2', MARKER, folder, 1_780_000_900, markerBody({ instance_name: 'two' }));
    storage.files.v2 = v2;

    const second = await provider.readControlFile(MARKER, { ifNoneMatch: first.etag });

    expect(second).not.toBe('not-modified');
    const read = second as any;
    expect(read.nodes.map((n: any) => n.id)).toEqual(['H2']);
    expect(JSON.parse(await textOf(read.nodes[0])).instance_name).toBe('two');
    expect(v2.download).toHaveBeenCalledTimes(1);
    expect(v1.download).toHaveBeenCalledTimes(1); // only the original read
    expect(read.etag).not.toBe(first.etag);
  });

  it('skips a node whose download fails with ENOENT and still resolves, retrying it next read', async () => {
    const folder = makeFolder();
    const good = makeNode('Hgood', MARKER, folder, 1_780_000_000);
    const gone = makeNode(
      'Hgone',
      MARKER,
      folder,
      1_780_000_500,
      new Error('ENOENT (-9): Object (typically, node or user) not found')
    );
    const provider = await loginWithTree({ folder, good, gone });

    const result = (await provider.readControlFile(MARKER)) as any;

    expect(result.nodes.map((n: any) => n.id)).toEqual(['Hgood']);
    expect(gone.download).toHaveBeenCalledTimes(1);

    // The skipped handle is retried once an sc event touches a control file.
    const storage = (provider as any).storage;
    const handlers = storage.on.mock.calls.filter((c: any[]) => c[0] === 'delete');
    for (const [, handler] of handlers) handler({ name: MARKER });
    await provider.readControlFile(MARKER);
    expect(gone.download).toHaveBeenCalledTimes(2);
  });

  it('ignores nodes in the Rubbish Bin and in folders that are not mokuro-reader', async () => {
    const live = makeFolder();
    const other = makeFolder('Documents');
    const bin = makeFolder('Rubbish Bin');
    const trashedLibrary = makeFolder('mokuro-reader', bin);
    const sub = makeFolder('Some Series', live);
    const ok = makeNode('Hok', MARKER, live, 1_780_000_000);
    const inOther = makeNode('Hother', MARKER, other, 1_780_000_100);
    const inBin = makeNode('Hbin', MARKER, bin, 1_780_000_200);
    const inTrashedLibrary = makeNode('Htrashlib', MARKER, trashedLibrary, 1_780_000_300);
    const inSub = makeNode('Hsub', MARKER, sub, 1_780_000_400);
    // megajs's own Rubbish Bin handle: the trashed library is fully linked,
    // so only the trash check (not a broken link) can turn it away.
    storageState.trash = bin;
    const provider = await loginWithTree({
      live,
      other,
      bin,
      trashedLibrary,
      sub,
      ok,
      inOther,
      inBin,
      inTrashedLibrary,
      inSub
    });

    const result = (await provider.readControlFile(MARKER)) as any;

    expect(result.nodes.map((n: any) => n.id)).toEqual(['Hok']);
    expect(inOther.download).not.toHaveBeenCalled();
    expect(inBin.download).not.toHaveBeenCalled();
    expect(inTrashedLibrary.download).not.toHaveBeenCalled();
    expect(inSub.download).not.toHaveBeenCalled();
  });

  it('returns null when no node of that name exists', async () => {
    const folder = makeFolder();
    const provider = await loginWithTree({ folder });
    expect(await provider.readControlFile(MARKER)).toBeNull();
  });

  it('never reinitializes or reloads the storage', async () => {
    const folder = makeFolder();
    const marker = makeNode('H1', MARKER, folder, 1_780_000_000);
    const provider = await loginWithTree({ folder, marker });
    const storage = (provider as any).storage;
    // Login itself loads the tree once (loadTree → reload); reads add none.
    const loadsAtLogin = storage.reload.mock.calls.length;
    const reinit = vi.spyOn(provider as any, 'reinitialize');
    const refresh = vi.spyOn(provider as any, 'refreshTree');

    const first = (await provider.readControlFile(MARKER)) as any;
    await provider.readControlFile(MARKER, { ifNoneMatch: first.etag });

    expect(reinit).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(storage.reload).toHaveBeenCalledTimes(loadsAtLogin);
  });

  it.each([
    ['logout', (p: any) => p.logout()],
    ['session expiry', (p: any) => p.markSessionExpired()]
  ])('%s empties the control cache, skipped handles and any pending notify', async (_, end) => {
    vi.useFakeTimers();
    try {
      const folder = makeFolder();
      makeNode('H1', MARKER, folder, 1_780_000_000);
      makeNode('Hgone', MARKER, folder, 1_780_000_500, new Error('ENOENT (-9): not found'));
      const provider = (await loginWithTree({ ...folder.children, folder })) as any;
      await provider.readControlFile(MARKER);
      const seen: string[] = [];
      provider.onControlFileChange((name: string) => seen.push(name));
      provider.scheduleControlNotify(MARKER, provider.storage);
      expect(provider.controlCache.byName.size).toBe(1);
      expect(provider.vanishedControlHandles.size).toBe(1);

      await end(provider);

      expect(provider.controlCache.byName.size).toBe(0);
      expect(provider.vanishedControlHandles.size).toBe(0);
      expect(provider.controlPendingNames.size).toBe(0);
      expect(provider.controlNotifyTimer).toBeNull();
      await vi.advanceTimersByTimeAsync(1000);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws an auth ProviderError when not authenticated', async () => {
    const provider = new MegaProvider();
    await provider.whenReady();
    await expect(provider.readControlFile(MARKER)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'NOT_AUTHENTICATED',
      isAuthError: true
    });
  });

  it('maps a session expiry during the download to an auth ProviderError', async () => {
    const folder = makeFolder();
    const marker = makeNode(
      'H1',
      MARKER,
      folder,
      1_780_000_000,
      new Error('ESID (-15): Invalid or expired user session, please relogin')
    );
    const provider = await loginWithTree({ folder, marker });

    await expect(provider.readControlFile(MARKER)).rejects.toMatchObject({
      name: 'ProviderError',
      isAuthError: true
    });
    expect(provider.isAuthenticated()).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(true);
  });

  it('getStatus() folds in a fresh marker verdict: serverCompilesMetadata true after, false before', async () => {
    const folder = makeFolder();
    const marker = makeNode('H1', MARKER, folder, 1_780_000_000);
    const provider = await loginWithTree({ folder, marker });
    expect(provider.getStatus().serverCompilesMetadata).toBeFalsy();

    await ingestMarkerRead('mega', (await provider.readControlFile(MARKER)) as any);

    const status = provider.getStatus();
    expect(status.serverCompilesMetadata).toBe(true);
    expect(status.cloudBunko?.fresh).toBe(true);
  });
});

describe('MegaProvider.onControlFileChange()', () => {
  async function loggedIn() {
    storageState.files = { f1: { name: 'mokuro-reader', directory: true } };
    const provider = new MegaProvider();
    await provider.whenReady();
    await provider.login({ email: 'a@b.c', password: 'secret' });
    const storage = (provider as any).storage;
    const emit = (event: string, node: any) => {
      for (const [name, handler] of storage.on.mock.calls) if (name === event) handler(node);
    };
    return { provider, emit };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(megaCache.fetch).mockResolvedValue(undefined as any);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires (debounced) for a control-file event and not for a .cbz event', async () => {
    const { provider, emit } = await loggedIn();
    const seen: string[] = [];
    provider.onControlFileChange((name) => seen.push(name));

    emit('add', { name: 'Vol 1.cbz' });
    emit('update', { name: 'Vol 1.mokuro' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([]);

    emit('add', { name: '.mokuro-bunko.json' });
    emit('update', { name: '.mokuro-bunko.json' });
    emit('delete', { name: '.mokuro-queue.json' });
    expect(seen).toEqual([]); // debounced
    await vi.advanceTimersByTimeAsync(600);
    expect(seen.sort()).toEqual(['.mokuro-bunko.json', '.mokuro-queue.json']);
  });

  it('fires once for a control file whose handles a full tree load changed', async () => {
    // After an sc outage the provider reloads the whole tree (refreshTree):
    // a marker rewritten meanwhile arrives with no sc event of its own.
    const folder = { name: 'mokuro-reader', directory: true, children: [] as any[] } as any;
    const node = (handle: string, name: string) => {
      const n = { nodeId: handle, name, directory: false, parent: folder, timestamp: 1 } as any;
      folder.children.push(n);
      return n;
    };
    const marker = node('M1', '.mokuro-bunko.json');
    const queue = node('Q1', '.mokuro-queue.json');
    storageState.files = { folder, marker, queue };
    const provider = new MegaProvider();
    await provider.whenReady();
    await provider.login({ email: 'a@b.c', password: 'secret' });
    const storage = (provider as any).storage;
    const seen: string[] = [];
    provider.onControlFileChange((name) => seen.push(name));

    storage.reload.mockImplementationOnce(async () => {
      folder.children.splice(folder.children.indexOf(marker), 1);
      storage.files.marker2 = node('M2', '.mokuro-bunko.json');
    });
    await (provider as any).refreshTree();
    await vi.advanceTimersByTimeAsync(600);
    expect(seen).toEqual(['.mokuro-bunko.json']);

    // A load that changes no control handle notifies nobody.
    seen.length = 0;
    await (provider as any).refreshTree();
    await vi.advanceTimersByTimeAsync(600);
    expect(seen).toEqual([]);
  });

  it('stops firing after unsubscribe, and keeps working after listeners are re-attached', async () => {
    const { provider, emit } = await loggedIn();
    const seen: string[] = [];
    const off = provider.onControlFileChange((name) => seen.push(name));
    // reinitialize() re-attaches nothing new on the same storage, but a new
    // storage (restore) calls attachChangeListeners again: listeners are on the provider.
    (provider as any).attachChangeListeners((provider as any).storage);

    emit('move', { name: '.mokuro-queue.json' });
    await vi.advanceTimersByTimeAsync(600);
    expect(seen.length).toBeGreaterThan(0);

    off();
    seen.length = 0;
    emit('add', { name: '.mokuro-bunko.json' });
    await vi.advanceTimersByTimeAsync(600);
    expect(seen).toEqual([]);
  });
});

describe('MegaProvider listing of reading history', () => {
  it('lists history/<device>/ files by full path, not look-alikes in a series folder', async () => {
    // Every node linked into its parent's children: a node its parent does
    // not list is a deleted one (isLiveNode) and is never listed.
    const node = (fields: Record<string, any>) => {
      const n: any = { children: [], ...fields };
      n.parent?.children.push(n);
      return n;
    };
    const root = node({ name: 'mokuro-reader', directory: true });
    const hist = node({ name: 'history', directory: true, parent: root });
    const dev = node({ name: 'dev-a', directory: true, parent: hist });
    const series = node({ name: 'Series', directory: true, parent: root });
    storageState.files = {
      r: root,
      h: hist,
      d: dev,
      s: series,
      seg: node({
        name: '2026-10.events',
        parent: dev,
        nodeId: 'seg',
        timestamp: 1790000000,
        size: 10
      }),
      stray: node({
        name: 'device.json',
        parent: series,
        nodeId: 'stray',
        timestamp: 1790000000,
        size: 5
      })
    };
    const provider = new MegaProvider();
    await provider.whenReady();
    await provider.login({ email: 'a@b.c', password: 'secret' });

    const files = await provider.listCloudVolumes(true);

    expect(files.map((f) => f.path)).toEqual(['history/dev-a/2026-10.events']);
  });
});
