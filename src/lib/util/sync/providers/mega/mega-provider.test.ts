import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { megaCache } from './mega-cache';
import { ingestMarkerRead, resetCloudBunkoMarkersForTest } from '$lib/catalog/cloud-bunko-marker';

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
      upload: vi.fn((_opts: any, _buf: any, cb: (e: Error | null, f?: any) => void) => {
        // `timestamp` (epoch seconds) is the SERVER's stamp on the completed
        // node — the same field listCloudVolumes maps to `modifiedTime`.
        queueMicrotask(() => cb(null, { nodeId: 'fresh-node', timestamp: 1_780_000_000, size: 3 }));
      })
    } as any;
  }

  function makeFile(name: string, parent: any, deleteError: Error | null = null) {
    return {
      name,
      directory: false,
      parent,
      delete: vi.fn((_force: boolean, cb: (e: Error | null) => void) => {
        queueMicrotask(() => cb(deleteError));
      })
    } as any;
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

    // Mirror megajs reload() semantics: additive import of the server's
    // node set (which no longer contains the ghost).
    storage.reload = vi.fn(async () => {
      const server: Record<string, any> = { root: folder, real };
      for (const [handle, node] of Object.entries(server)) {
        if (!storage.files[handle]) storage.files[handle] = node;
      }
    });

    await (provider as any).reinitialize();

    expect(Object.keys(storage.files).sort()).toEqual(['real', 'root']);
  });

  it('reinitialize strips stale sc listeners before reloading (megajs stacks one per reload)', async () => {
    const folder = makeMokuroFolder();
    const provider = await loginWithTree({ root: folder });
    const storage = (provider as any).storage;
    storage.api = { removeAllListeners: vi.fn() };

    await (provider as any).reinitialize();

    expect(storage.api.removeAllListeners).toHaveBeenCalledWith('sc');
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

  function makeFolder(name = 'mokuro-reader', parent?: any) {
    return { name, directory: true, parent, children: [] as any[] } as any;
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
    const reinit = vi.spyOn(provider as any, 'reinitialize');

    const first = (await provider.readControlFile(MARKER)) as any;
    await provider.readControlFile(MARKER, { ifNoneMatch: first.etag });

    expect(reinit).not.toHaveBeenCalled();
    expect(storage.reload).not.toHaveBeenCalled();
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
