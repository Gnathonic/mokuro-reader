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
    expect(uploaded).toEqual({
      fileId: 'fresh-node',
      modifiedTime: new Date(1_780_000_000 * 1000).toISOString(),
      size: 3
    });
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
