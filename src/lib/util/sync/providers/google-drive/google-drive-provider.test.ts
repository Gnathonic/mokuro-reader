import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/util/sync/providers/google-drive/token-manager', () => ({
  tokenManager: {
    isAuthenticated: vi.fn(() => true),
    requestNewToken: vi.fn(),
    // Kept as a controllable vi.fn() (not a plain arrow) so a test can defer
    // the callback (mockImplementationOnce) to simulate the real async OAuth
    // round-trip without other subscribe() call sites (which invoke the
    // returned unsubscribe immediately) breaking.
    token: { subscribe: vi.fn((cb: (v: string) => void) => (cb('TOKEN'), () => {})) },
    needsAttention: { subscribe: (cb: (v: boolean) => void) => (cb(false), () => {}) },
    // The implicit flow (no auth backend): the held token, nothing renewed.
    getAccessToken: vi.fn(async () => 'TOKEN'),
    isBackendMode: vi.fn(() => false),
    renewRejectedToken: vi.fn(async () => ({ kind: 'failed' })),
    connectViaBackend: vi.fn(),
    reconnect: vi.fn(),
    logout: vi.fn(async () => {})
  }
}));
vi.mock('$lib/util/sync/providers/google-drive/api-client', () => ({
  driveApiClient: {
    initialize: vi.fn(async () => {}),
    listFiles: vi.fn(async () => []),
    folderHasChildren: vi.fn(async () => false),
    deleteFile: vi.fn(async () => {}),
    createFolder: vi.fn(async () => 'created-folder'),
    updateFileMetadata: vi.fn(async () => ({})),
    getFileMetadata: vi.fn(async () => ({})),
    updateFileDescription: vi.fn(async () => {})
  },
  // The REAL escape, not a stand-in: the point of routing the folder queries
  // through the shared helper is that they get exactly this behaviour, and a
  // double would let production stop calling it without anything noticing.
  escapeNameForDriveQuery: (name: string) => name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}));
vi.mock('$lib/util/sync/providers/google-drive/drive-files-cache', () => ({
  driveFilesCache: {
    getReaderFolderId: vi.fn(async () => 'reader-root'),
    setReaderFolderId: vi.fn(),
    pickReaderFolder: vi.fn(async () => ({ id: null, topLevelKnown: true })),
    getDriveFilesBySeries: vi.fn(() => []),
    removeById: vi.fn(),
    clear: vi.fn(),
    // The whole-account refetch an upload must not perform — the upload
    // suites below assert on it directly.
    fetch: vi.fn(async () => {}),
    refreshFromChanges: vi.fn(async () => 'unchanged')
  }
}));
vi.mock('$lib/util/backup', () => ({ findFile: vi.fn() }));
vi.mock('../../cache-manager', () => ({
  cacheManager: { registerCache: vi.fn(), clearAll: vi.fn() }
}));
vi.mock('../../provider-manager', () => ({
  providerManager: { updateStatus: vi.fn() }
}));
vi.mock('../../provider-detection', () => ({
  setActiveProviderKey: vi.fn(),
  clearActiveProviderKey: vi.fn()
}));
vi.mock('../../core/cloud-provider-core-registry', () => ({
  getCloudProviderCore: vi.fn(() => ({}))
}));

import { googleDriveProvider } from './google-drive-provider';
import { driveApiClient } from '$lib/util/sync/providers/google-drive/api-client';
import { tokenManager } from '$lib/util/sync/providers/google-drive/token-manager';
import { driveFilesCache } from '$lib/util/sync/providers/google-drive/drive-files-cache';
import { providerManager } from '../../provider-manager';
import { isLoginCancelled, ProviderError } from '../../provider-interface';
import { driveStorageFullError } from '../../core/providers/drive-http';
import { setActiveProviderKey } from '../../provider-detection';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const JSON_MIME = 'application/json';

/**
 * Route the two live queries removeDirectoryIfEmpty makes:
 * - folder lookup by name under the reader root (`name='…' and … in parents …`)
 * - the SERVER-side emptiness check for that folder's children
 */
function mockDriveQueries({
  seriesFolderExists,
  children
}: {
  seriesFolderExists: boolean;
  children: Array<{ id: string }>;
}) {
  vi.mocked(driveApiClient.listFiles).mockImplementation(async (query: string) => {
    if (query.startsWith('name=')) {
      return seriesFolderExists
        ? [{ id: 'series-1', name: 'Old Series', mimeType: FOLDER_MIME, parents: ['reader-root'] }]
        : [];
    }
    if (query.startsWith("'series-1' in parents")) {
      return children.map((c) => ({ id: c.id, name: c.id, mimeType: 'application/zip' }));
    }
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tokenManager.isAuthenticated).mockReturnValue(true);
});

describe('GoogleDriveProvider.removeDirectoryIfEmpty()', () => {
  it('deletes the folder when the SERVER reports it empty', async () => {
    mockDriveQueries({ seriesFolderExists: true, children: [] });

    await googleDriveProvider.removeDirectoryIfEmpty('Old Series');

    // Emptiness must come from a live children query, not a cached listing.
    expect(driveApiClient.listFiles).toHaveBeenCalledWith(
      "'series-1' in parents and trashed=false",
      'files(id)'
    );
    expect(driveApiClient.deleteFile).toHaveBeenCalledWith('series-1');
  });

  it('does NOT delete when the server still reports contents (never a blind recursive delete)', async () => {
    mockDriveQueries({
      seriesFolderExists: true,
      children: [{ id: 'file-9' }] // a straggler another device just added
    });

    await googleDriveProvider.removeDirectoryIfEmpty('Old Series');

    expect(driveApiClient.deleteFile).not.toHaveBeenCalled();
  });

  it('no-ops when the folder does not exist', async () => {
    mockDriveQueries({ seriesFolderExists: false, children: [] });

    await expect(
      googleDriveProvider.removeDirectoryIfEmpty('Ghost Series')
    ).resolves.toBeUndefined();
    expect(driveApiClient.deleteFile).not.toHaveBeenCalled();
  });

  it('no-ops without touching the API when not authenticated', async () => {
    vi.mocked(tokenManager.isAuthenticated).mockReturnValue(false);

    await expect(googleDriveProvider.removeDirectoryIfEmpty('Old Series')).resolves.toBeUndefined();
    expect(driveApiClient.listFiles).not.toHaveBeenCalled();
    expect(driveApiClient.deleteFile).not.toHaveBeenCalled();
  });
});

describe('GoogleDriveProvider.listCloudVolumes() — root config paths', () => {
  /**
   * Root-config JSON is keyed by BASENAME alone, so a nested `<Series>/catalog.json`
   * (or any other root-config name a user happens to keep in a series folder) must
   * not be cached at the root key — Task 4's reader would download the wrong file.
   * Same guard MEGA applies with `isJson && pathParts.length === 0`.
   */
  beforeEach(() => {
    vi.mocked(driveApiClient.listFiles).mockImplementation(async (query: string) => {
      if (!query.startsWith("'me' in owners")) return [];
      return [
        { id: 'reader-root', name: 'mokuro-reader', mimeType: FOLDER_MIME },
        { id: 'series-1', name: 'Dr Stone', mimeType: FOLDER_MIME, parents: ['reader-root'] },
        { id: 'root-catalog', name: 'catalog.json', mimeType: JSON_MIME, parents: ['reader-root'] },
        { id: 'nested-catalog', name: 'catalog.json', mimeType: JSON_MIME, parents: ['series-1'] },
        {
          id: 'root-progress',
          name: 'volume-data.json',
          mimeType: JSON_MIME,
          parents: ['reader-root']
        }
      ];
    });
  });

  it('keeps the ROOT catalog.json at the root key', async () => {
    const files = await googleDriveProvider.listCloudVolumes();

    const atRootKey = files.filter((f) => f.path === 'catalog.json');
    expect(atRootKey).toHaveLength(1);
    expect(atRootKey[0].fileId).toBe('root-catalog');
    expect(files.find((f) => f.path === 'volume-data.json')?.fileId).toBe('root-progress');
  });

  it('never collides a NESTED catalog.json with the root one', async () => {
    const files = await googleDriveProvider.listCloudVolumes();

    const nested = files.find((f) => f.fileId === 'nested-catalog');
    // Either dropped or kept under its full path — never at the bare root key.
    expect(nested?.path).not.toBe('catalog.json');
  });
});

describe('GoogleDriveProvider getStatus().accountScope', () => {
  beforeEach(() => {
    // Reset private per-account cache state — this provider is a shared
    // singleton across the whole test file.
    (googleDriveProvider as unknown as { readerFolderId: string | null }).readerFolderId = null;
  });

  it('is undefined when not authenticated', () => {
    vi.mocked(tokenManager.isAuthenticated).mockReturnValue(false);

    expect(googleDriveProvider.getStatus().accountScope).toBeUndefined();
  });

  it('falls back to the coarse default scope before ensureReaderFolder() has resolved', () => {
    expect(googleDriveProvider.getStatus().accountScope).toBe('google-drive:default');
  });

  it('is `google-drive:<readerFolderId>` once the reader folder has been resolved', async () => {
    await googleDriveProvider.ensureReaderFolder();

    expect(googleDriveProvider.getStatus().accountScope).toBe('google-drive:reader-root');
  });
});

describe('GoogleDriveProvider login() account-switch scoping', () => {
  beforeEach(() => {
    // Reset private per-account cache state — this provider is a shared
    // singleton across the whole test file.
    (googleDriveProvider as unknown as { readerFolderId: string | null }).readerFolderId = null;
  });

  it("never reports a previous account's folder id as the new account's scope after a fresh login()", async () => {
    // Account A resolves and caches its reader folder.
    vi.mocked(driveFilesCache.getReaderFolderId).mockResolvedValueOnce('account-a-folder');
    await googleDriveProvider.ensureReaderFolder();
    expect(googleDriveProvider.getStatus().accountScope).toBe('google-drive:account-a-folder');

    // Simulate the consent-screen OAuth flow switching to a DIFFERENT Google
    // account without an explicit logout first. Defer the token callback
    // (a real OAuth round-trip is asynchronous) rather than firing it
    // synchronously from inside subscribe().
    vi.mocked(tokenManager.token.subscribe).mockImplementationOnce((cb) => {
      queueMicrotask(() => cb('NEW-ACCOUNT-TOKEN'));
      return () => {};
    });

    await googleDriveProvider.login();

    // login() must clear the old account's cached folder id via the same
    // mechanism logout's cacheManager.clearAll() uses on this cache.
    expect(driveFilesCache.clear).toHaveBeenCalled();
    const scopeRightAfterLogin = googleDriveProvider.getStatus().accountScope;
    expect(scopeRightAfterLogin).not.toBe('google-drive:account-a-folder');
    expect(scopeRightAfterLogin).toBe('google-drive:default');

    // Account B's first folder resolution scopes the cache to ITS folder —
    // never account A's stale id.
    vi.mocked(driveFilesCache.getReaderFolderId).mockResolvedValueOnce('account-b-folder');
    await googleDriveProvider.ensureReaderFolder();
    expect(googleDriveProvider.getStatus().accountScope).toBe('google-drive:account-b-folder');
  });
});

describe('GoogleDriveProvider login() with the token already there', () => {
  it('resolves when the token client answered before login() starts waiting', async () => {
    // A token client that answers synchronously (the interop rig's injected
    // token) has set the token by the time login() subscribes, so the store
    // calls back from INSIDE subscribe(), before its unsubscribe exists.
    vi.mocked(tokenManager.token.subscribe).mockImplementationOnce((cb) => {
      cb('ALREADY-SET');
      return () => {};
    });
    await expect(googleDriveProvider.login()).resolves.toBeUndefined();
  });
});

describe('GoogleDriveProvider.logout() scope', () => {
  it('this device only by default: the token manager is not asked to sign out everywhere', async () => {
    await googleDriveProvider.logout();
    expect(tokenManager.logout).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tokenManager.logout).mock.calls[0][0]?.everywhere).not.toBe(true);
  });

  it('passes an explicit everywhere through', async () => {
    await googleDriveProvider.logout({ everywhere: true });
    expect(tokenManager.logout).toHaveBeenCalledWith({ everywhere: true });
  });

  it('answers what the token manager said, so the cloud page never claims a revoke that failed', async () => {
    const said = { copyMayStillWork: false, revoked: false, pendingEverywhere: true };
    vi.mocked(tokenManager.logout).mockResolvedValueOnce(said);
    expect(await googleDriveProvider.logout({ everywhere: true })).toEqual(said);
  });
});

describe('GoogleDriveProvider login() through the auth backend', () => {
  beforeEach(() => {
    vi.mocked(tokenManager.isBackendMode).mockReturnValue(true);
    vi.mocked(tokenManager.requestNewToken).mockClear();
    vi.mocked(tokenManager.connectViaBackend).mockReset();
    vi.mocked(setActiveProviderKey).mockClear();
  });
  afterEach(() => {
    vi.mocked(tokenManager.isBackendMode).mockReturnValue(false);
    vi.unstubAllGlobals();
  });

  it('a live session reconnects without the popup', async () => {
    vi.mocked(tokenManager.connectViaBackend).mockResolvedValue('connected');
    await googleDriveProvider.login();
    expect(tokenManager.requestNewToken).not.toHaveBeenCalled();
    expect(setActiveProviderKey).toHaveBeenCalledWith('google-drive');
  });

  it('no backend here: the popup sign-in, as before', async () => {
    vi.mocked(tokenManager.connectViaBackend).mockResolvedValue('popup');
    await googleDriveProvider.login();
    expect(tokenManager.requestNewToken).toHaveBeenCalledWith(true);
  });

  it('may leave the page only once the user has acted on it', async () => {
    vi.mocked(tokenManager.connectViaBackend).mockResolvedValue('connected');
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: false, isActive: false } });
    await googleDriveProvider.login();
    expect(tokenManager.connectViaBackend).toHaveBeenLastCalledWith(false);
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: true, isActive: false } });
    await googleDriveProvider.login();
    // Sticky, not transient: the chunk a click loads may outlast the click.
    expect(tokenManager.connectViaBackend).toHaveBeenLastCalledWith(true);
  });

  it('Back from Google’s page (the cloud page restored from bfcache) is a quiet cancel', async () => {
    vi.mocked(tokenManager.connectViaBackend).mockResolvedValue('redirecting');
    const login = googleDriveProvider.login();
    const settled = login.then(
      () => 'resolved',
      (error: unknown) => error
    );
    await new Promise((r) => setTimeout(r, 0));
    // A page shown fresh (not from the cache) says nothing about the sign-in.
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    const error = await settled;
    expect(isLoginCancelled(error)).toBe(true);
    expect(tokenManager.requestNewToken).not.toHaveBeenCalled();
  });

  it('a redirect that never leaves the page fails after 30 s, as an error to show', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(tokenManager.connectViaBackend).mockResolvedValue('redirecting');
      const settled = googleDriveProvider.login().then(
        () => 'resolved',
        (error: unknown) => error
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await settled;
      expect(isLoginCancelled(error)).toBe(false);
      expect((error as Error).message).toMatch(/did not open/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reauthenticate (a cloud-page button) is the interactive reconnect', async () => {
    await googleDriveProvider.reauthenticate();
    expect(tokenManager.reconnect).toHaveBeenCalled();
  });
});

describe('GoogleDriveProvider login() releases the in-flight folder-resolution mutex', () => {
  beforeEach(() => {
    (googleDriveProvider as unknown as { readerFolderId: string | null }).readerFolderId = null;
    (
      googleDriveProvider as unknown as { readerFolderPromise: Promise<string> | null }
    ).readerFolderPromise = null;
  });

  it('never hands a post-login caller the resolution that was still in flight for the previous account', async () => {
    // Account A's resolution parks mid-flight: its mutex-internal recheck of
    // driveFilesCache never resolves until we release it below.
    let releaseStuckRecheck!: (v: string | null) => void;
    const stuckRecheck = new Promise<string | null>((res) => {
      releaseStuckRecheck = res;
    });

    let call = 0;
    vi.mocked(driveFilesCache.getReaderFolderId).mockImplementation(async () => {
      call++;
      if (call === 1) return null; // account A: outer cache check — nothing cached yet
      if (call === 2) return stuckRecheck; // account A: mutex-internal recheck — stuck
      if (call === 3) return 'account-b-folder'; // account B: post-login caller's outer check
      return null;
    });

    // Kick off account A's resolution but don't await it — it parks on the
    // stuck recheck, leaving `readerFolderPromise` set on the instance.
    const staleResolution = googleDriveProvider.ensureReaderFolder();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      (googleDriveProvider as unknown as { readerFolderPromise: unknown }).readerFolderPromise
    ).not.toBeNull();

    // Switch accounts via the consent-screen flow (no explicit logout first).
    vi.mocked(tokenManager.token.subscribe).mockImplementationOnce((cb) => {
      queueMicrotask(() => cb('NEW-ACCOUNT-TOKEN'));
      return () => {};
    });
    await googleDriveProvider.login();

    // login() must release the mutex, not just the id and driveFilesCache.
    expect(
      (googleDriveProvider as unknown as { readerFolderPromise: unknown }).readerFolderPromise
    ).toBeNull();

    // A post-login caller starts its OWN resolution instead of being handed
    // account A's still-pending one via the `if (this.readerFolderPromise)`
    // mutex check, and correctly resolves to account B's folder.
    const resultB = await googleDriveProvider.ensureReaderFolder();
    expect(resultB).toBe('account-b-folder');
    expect(googleDriveProvider.getStatus().accountScope).toBe('google-drive:account-b-folder');

    // Account A's stale resolution is never blocking anyone at this point —
    // it settles entirely on its own, independent of the mutex field we
    // already reset and reused above.
    releaseStuckRecheck('account-a-folder');
    await expect(staleResolution).resolves.toBe('account-a-folder');

    // NOT asserted here (deliberately, see task-1-report.md "Fix round 3"):
    // that orphaned resolution's own `this.readerFolderId = recheckFolderId`
    // write executes unconditionally when it settles, so accountScope CAN
    // still flip back to the stale account-A value at this point. Closing
    // that needs a generation check in ensureReaderFolder()'s mutex — out of
    // scope for this one-line fix (same class as the parked
    // driveFilesCache.fetchAllFiles() writer finding).
  });
});

/**
 * `findOrCreateFolder` CREATES a folder when its lookup finds nothing, so a
 * lookup that misses a folder which really is there does not fail — it forks
 * the series into two folders and every write after that lands in the wrong
 * one. Drive's `name='…'` filter is byte-wise, and a folder name that has been
 * through a decomposing filesystem comes back NFD while the local title stays
 * NFC. Japanese titles are the common case: が is one code point composed and
 * two decomposed.
 */
describe('google drive folder lookup and unicode form', () => {
  const NFC_TITLE = 'ダンジョン飯'; // composed
  const NFD_TITLE = NFC_TITLE.normalize('NFD'); // what a decomposing filesystem stores

  beforeEach(() => {
    vi.mocked(driveFilesCache.getReaderFolderId).mockResolvedValue('reader-root');
  });

  it('reuses a folder Drive stored in a different unicode form', async () => {
    // The exact-name query misses (NFD bytes on Drive, NFC bytes in the
    // query); the broad parent listing is where the folder actually is.
    vi.mocked(driveApiClient.listFiles).mockImplementation(async (query: string) => {
      if (query.startsWith('name=')) return [];
      return [
        {
          id: 'existing-folder',
          name: NFD_TITLE,
          mimeType: FOLDER_MIME,
          parents: ['reader-root'],
          createdTime: '2026-01-01T00:00:00.000Z'
        }
      ];
    });

    const id = await googleDriveProvider.findOrCreateFolder('reader-root', NFC_TITLE);

    expect(id).toBe('existing-folder');
    expect(driveApiClient.createFolder).not.toHaveBeenCalled();
  });

  it('still creates the folder when the parent genuinely has no match', async () => {
    // The parent has folders — just not this one, in any unicode form. The
    // fallback must not widen into "reuse whatever is there".
    vi.mocked(driveApiClient.listFiles).mockImplementation(async (query: string) =>
      query.startsWith('name=')
        ? []
        : [
            {
              id: 'someone-else',
              name: 'Another Series',
              mimeType: FOLDER_MIME,
              parents: ['reader-root'],
              createdTime: '2026-01-01T00:00:00.000Z'
            }
          ]
    );

    const id = await googleDriveProvider.findOrCreateFolder('reader-root', NFC_TITLE);

    expect(id).toBe('created-folder');
    expect(driveApiClient.createFolder).toHaveBeenCalledWith(NFC_TITLE, 'reader-root');
  });

  it('escapes a quote in the folder name through the shared helper', async () => {
    vi.mocked(driveApiClient.listFiles).mockResolvedValue([]);

    await googleDriveProvider.findOrCreateFolder('reader-root', "Haven't You Heard");

    const exactQuery = vi.mocked(driveApiClient.listFiles).mock.calls[0][0] as string;
    expect(exactQuery).toContain("name='Haven\\'t You Heard'");
  });

  it('does not pay for the broad listing when the exact name matches', async () => {
    vi.mocked(driveApiClient.listFiles).mockImplementation(async (query: string) =>
      query.startsWith('name=')
        ? [
            {
              id: 'exact-folder',
              name: NFC_TITLE,
              mimeType: FOLDER_MIME,
              parents: ['reader-root'],
              createdTime: '2026-01-01T00:00:00.000Z'
            }
          ]
        : []
    );

    const id = await googleDriveProvider.findOrCreateFolder('reader-root', NFC_TITLE);

    expect(id).toBe('exact-folder');
    // One query, not two: the fallback is for a miss, not for every upload.
    expect(vi.mocked(driveApiClient.listFiles).mock.calls).toHaveLength(1);
  });
});

/**
 * `getStatus().accountScope` is a function of the reader-folder id, and the app
 * reads that scope two ways: live (`cloud-cache-key.ts`, used by
 * `acquireCover`/`refreshCoverKeys`/`cover-persist.ts`) and off the status
 * STORE (`account-scope-store.ts`, which every cover-drawing surface joins into
 * its claim key). Resolving the folder without telling the store makes the two
 * disagree — covers get written and refreshed under `google-drive:<id>` while
 * mounted cards still hold handles under `google-drive:default`, which is a
 * blank cover no re-request can repair.
 */
describe('google drive account scope', () => {
  it('publishes a status update when the reader folder resolves', async () => {
    // A FRESH module graph: the provider is a module singleton and other
    // tests in this file have already resolved its folder, which is exactly
    // the state this test needs not to start from.
    vi.resetModules();
    const { googleDriveProvider: provider } = await import('./google-drive-provider');
    const { providerManager: manager } = await import('../../provider-manager');

    // Before resolution the scope is the coarse fallback...
    expect(provider.getStatus().accountScope).toBe('google-drive:default');

    await provider.ensureReaderFolder();

    // ...and resolving it both moves the scope AND says so.
    expect(provider.getStatus().accountScope).toBe('google-drive:reader-root');
    expect(manager.updateStatus).toHaveBeenCalled();
  });
});

describe('GoogleDriveProvider.adoptListedReaderFolder()', () => {
  beforeEach(() => {
    (googleDriveProvider as unknown as { readerFolderId: string | null }).readerFolderId = null;
  });

  it('re-points a pinned write root at the root the latest listing chose', async () => {
    // A missed lookup minted a newer root and the session pinned it; another
    // merger (Bunko, another device) has since trashed it into the older one.
    vi.mocked(driveFilesCache.getReaderFolderId).mockResolvedValueOnce('newer-root');
    expect(await googleDriveProvider.ensureReaderFolder()).toBe('newer-root');

    googleDriveProvider.adoptListedReaderFolder('older-root');

    expect(await googleDriveProvider.ensureReaderFolder()).toBe('older-root');
    expect(googleDriveProvider.getStatus().accountScope).toBe('google-drive:older-root');
  });

  it('pins nothing before the session resolved a root of its own', () => {
    googleDriveProvider.adoptListedReaderFolder('older-root');

    expect(googleDriveProvider.getStatus().accountScope).toBe('google-drive:default');
  });
});

describe('GoogleDriveProvider uploads — no whole-account refetch (#288)', () => {
  /**
   * `uploadFile` used to end with `driveFilesCache.fetch()` — a FULL paged
   * listing walk per upload, paid by every progress sync that wrote
   * `volume-data.json`. Every caller records its upload from the receipt, and
   * other devices' writes arrive through the change feed, so it is gone.
   */
  const coreUpload = vi.fn(async () => ({
    fileId: 'uploaded-1',
    modifiedTime: '2026-08-27T00:00:00.000Z',
    size: 3
  }));

  beforeEach(() => {
    coreUpload.mockClear();
    vi.mocked(driveFilesCache.fetch).mockClear();
    vi.mocked(tokenManager.isAuthenticated).mockReturnValue(true);
    // The shared provider core the real upload rides; a root-level path keeps
    // the folder machinery down to the mocked reader-root lookup.
    (googleDriveProvider as unknown as { cloudCore: { uploadFile: typeof coreUpload } }).cloudCore =
      { uploadFile: coreUpload };
  });

  it('uploadFile uploads and returns the receipt, with NO listing request', async () => {
    const result = await googleDriveProvider.uploadFile('volume-data.json', new Blob(['abc']));
    // Positive control: the upload genuinely ran and returned its metadata.
    expect(coreUpload).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fileId: 'uploaded-1', size: 3 });
    // The point: neither a full listing nor a feed read rides an upload.
    expect(driveFilesCache.fetch).not.toHaveBeenCalled();
    expect(driveFilesCache.refreshFromChanges).not.toHaveBeenCalled();
    expect(driveApiClient.listFiles).not.toHaveBeenCalledWith(
      expect.stringContaining("'me' in owners"),
      expect.anything()
    );
  });

  it('a series upload does not refetch either', async () => {
    await googleDriveProvider.uploadFile('Series/Volume 1.cbz', new Blob(['abc']));
    expect(coreUpload).toHaveBeenCalledTimes(1);
    expect(driveFilesCache.fetch).not.toHaveBeenCalled();
  });

  it('a full drive keeps its QUOTA_EXCEEDED code and message, not UPLOAD_FAILED', async () => {
    coreUpload.mockRejectedValueOnce(driveStorageFullError());
    const error = await googleDriveProvider
      .uploadFile('volume-data.json', new Blob(['abc']))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('QUOTA_EXCEEDED');
    expect((error as ProviderError).message).toBe(driveStorageFullError().message);
    // Not a network blip to retry, not an expired session.
    expect((error as ProviderError).isNetworkError).toBe(false);
    expect((error as ProviderError).isAuthError).toBe(false);
  });

  it('any other upload failure is still UPLOAD_FAILED', async () => {
    coreUpload.mockRejectedValueOnce(new Error('Upload init failed: 500 Internal'));
    const error = await googleDriveProvider
      .uploadFile('volume-data.json', new Blob(['abc']))
      .catch((e: unknown) => e);
    expect((error as ProviderError).code).toBe('UPLOAD_FAILED');
  });

  it('a rate limit that outlasted its retries stays a retryable UPLOAD_FAILED', async () => {
    coreUpload.mockRejectedValueOnce(
      new Error('Upload init failed: 403 Forbidden [userRateLimitExceeded]')
    );

    const error = await googleDriveProvider
      .uploadFile('volume-data.json', new Blob(['abc']))
      .catch((e) => e);

    expect(error.code).toBe('UPLOAD_FAILED');
    expect(error.isNetworkError).toBe(true);
  });

  it('has no blindUploadFile: its uploadFile already is one (the interface contract)', () => {
    expect(
      (googleDriveProvider as unknown as { blindUploadFile?: unknown }).blindUploadFile
    ).toBeUndefined();
  });
});

describe('GoogleDriveProvider receipts and stat (conditional root-file reads)', () => {
  const coreUpload = vi.fn(async (_args: unknown) => ({
    fileId: 'uploaded-1',
    modifiedTime: '2026-11-02T10:00:00.000Z',
    size: 3,
    revision: '42'
  }));

  beforeEach(() => {
    coreUpload.mockClear();
    vi.mocked(tokenManager.isAuthenticated).mockReturnValue(true);
    (googleDriveProvider as unknown as { cloudCore: { uploadFile: typeof coreUpload } }).cloudCore =
      { uploadFile: coreUpload };
  });

  it('an upload receipt names the revision, the folder written into and the name', async () => {
    const result = await googleDriveProvider.uploadFile('volume-data.json', new Blob(['abc']));
    // The folder the core was told to write into (the reader root here).
    const target = (coreUpload.mock.calls[0][0] as { credentials: { seriesFolderId: string } })
      .credentials.seriesFolderId;
    expect(target).toBeTruthy();
    expect(result).toEqual({
      fileId: 'uploaded-1',
      modifiedTime: '2026-11-02T10:00:00.000Z',
      size: 3,
      revision: '42',
      parentId: target,
      name: 'volume-data.json'
    });
  });

  it("keeps the response's own parent and name when it carried them", async () => {
    coreUpload.mockResolvedValueOnce({
      fileId: 'uploaded-1',
      modifiedTime: '2026-11-02T10:00:00.000Z',
      size: 3,
      revision: '42',
      parentId: 'parent-from-response',
      name: 'positions.json'
    } as never);
    const result = await googleDriveProvider.uploadFile('positions.json', new Blob(['abc']));
    expect(result).toMatchObject({ parentId: 'parent-from-response', name: 'positions.json' });
  });

  it('a description update after the upload drops the revision (it changed the file again)', async () => {
    const result = await googleDriveProvider.uploadFile(
      'volume-data.json',
      new Blob(['abc']),
      'a description'
    );
    expect(driveApiClient.updateFileDescription).toHaveBeenCalledWith(
      'uploaded-1',
      'a description'
    );
    expect(result.revision).toBeUndefined();
    expect(result.fileId).toBe('uploaded-1');
  });

  const file = {
    provider: 'google-drive' as const,
    fileId: 'file-1',
    path: 'volume-data.json',
    modifiedTime: '',
    size: 0
  };

  it('statFile reads the stamp fields only; version is the revision', async () => {
    vi.mocked(driveApiClient.getFileMetadata).mockResolvedValueOnce({
      id: 'file-1',
      size: '28542',
      modifiedTime: '2026-11-02T10:00:00.000Z',
      version: '17',
      md5Checksum: 'abc'
    });
    expect(await googleDriveProvider.statFile(file)).toEqual({
      size: 28542,
      modifiedTime: '2026-11-02T10:00:00.000Z',
      revision: '17'
    });
    const [fileId, fields] = vi.mocked(driveApiClient.getFileMetadata).mock.calls.at(-1)!;
    expect(fileId).toBe('file-1');
    expect(fields.split(',')).toEqual(
      expect.arrayContaining(['id', 'size', 'modifiedTime', 'version', 'md5Checksum'])
    );
  });

  it('statFile: a 404 or a trashed file is gone', async () => {
    vi.mocked(driveApiClient.getFileMetadata).mockRejectedValueOnce(
      Object.assign(new Error('File not found'), { status: 404 })
    );
    expect(await googleDriveProvider.statFile(file)).toBeNull();
    vi.mocked(driveApiClient.getFileMetadata).mockResolvedValueOnce({
      id: 'file-1',
      size: '3',
      modifiedTime: '2026-11-02T10:00:00.000Z',
      version: '3',
      trashed: true
    });
    expect(await googleDriveProvider.statFile(file)).toBeNull();
  });

  it('statFile: any other failure propagates (the memo then downloads)', async () => {
    vi.mocked(driveApiClient.getFileMetadata).mockRejectedValueOnce(
      Object.assign(new Error('Backend error'), { status: 500 })
    );
    await expect(googleDriveProvider.statFile(file)).rejects.toThrow('Backend error');
  });
});

/**
 * Parity with MEGA's dedup (#308): Drive's folder listing sees every folder
 * the app can reach, so the deduplicator must only ever be handed the library
 * (`mokuro-reader` folders and what is inside them), a duplicate folder goes
 * to the trash only once the SERVER lists it empty, and only a top-level root
 * may become the write root.
 */
describe('GoogleDriveProvider.getFolderOperations() — dedup parity', () => {
  const folder = (id: string, name: string, parent?: string, createdTime?: string) => ({
    id,
    name,
    mimeType: FOLDER_MIME,
    parents: parent ? [parent] : undefined,
    createdTime
  });

  it('lists only library folders: roots anywhere, and their descendants', async () => {
    vi.mocked(driveApiClient.listFiles).mockResolvedValue([
      folder('TOP', 'mokuro-reader', 'MY_DRIVE'),
      folder('SERIES', 'Ippo', 'TOP'),
      folder('BACKUP', 'Backup', 'MY_DRIVE'),
      folder('NESTED', 'mokuro-reader', 'BACKUP'),
      folder('NESTED_SERIES', 'Ippo', 'NESTED'),
      // A same-named pair of the user's own, outside the library.
      folder('STUFF', 'Stuff', 'MY_DRIVE'),
      folder('PHOTOS_1', 'Photos', 'STUFF'),
      folder('PHOTOS_2', 'Photos', 'STUFF')
    ]);

    const folders = await googleDriveProvider.getFolderOperations().listFolders();

    expect(folders.map((f) => f.id).sort()).toEqual(['NESTED', 'NESTED_SERIES', 'SERIES', 'TOP']);
    expect(folders.find((f) => f.id === 'NESTED')?.parentId).toBe('BACKUP');
  });

  it('does not trash a duplicate folder the server still lists children for', async () => {
    vi.mocked(driveApiClient.folderHasChildren).mockResolvedValue(true);
    const ops = googleDriveProvider.getFolderOperations();

    // Kept, and reported as kept: the deduplicator must not count it.
    await expect(ops.deleteFolder('DUP')).resolves.toBe(false);

    // The server is asked whether ANYTHING is left, not for the whole listing.
    expect(driveApiClient.folderHasChildren).toHaveBeenCalledWith('DUP');
    expect(driveApiClient.listFiles).not.toHaveBeenCalled();
    expect(driveApiClient.updateFileMetadata).not.toHaveBeenCalled();
    expect(driveApiClient.deleteFile).not.toHaveBeenCalled();

    // Kept once already this run and still not empty: give up on it rather than loop.
    await expect(ops.deleteFolder('DUP')).rejects.toThrow(/still holds/);
    expect(driveApiClient.updateFileMetadata).not.toHaveBeenCalled();
  });

  it('trashes an empty duplicate folder, never deletes it', async () => {
    vi.mocked(driveApiClient.folderHasChildren).mockResolvedValue(false);

    await expect(googleDriveProvider.getFolderOperations().deleteFolder('DUP')).resolves.toBe(true);

    expect(driveApiClient.updateFileMetadata).toHaveBeenCalledWith(
      'DUP',
      { trashed: true },
      { fields: 'id' }
    );
    expect(driveApiClient.deleteFile).not.toHaveBeenCalled();
  });

  it('only confirms the root the cache picks as the write root (top-level first)', async () => {
    vi.mocked(driveApiClient.listFiles).mockResolvedValue([
      folder('TOP', 'mokuro-reader', 'MY_DRIVE'),
      folder('NESTED', 'mokuro-reader', 'BACKUP'),
      folder('NESTED_SERIES', 'Ippo', 'NESTED')
    ]);
    vi.mocked(driveFilesCache.pickReaderFolder).mockResolvedValueOnce({
      id: 'TOP',
      topLevelKnown: true
    });
    const ops = googleDriveProvider.getFolderOperations();
    await ops.listFolders();

    // The same rule the cache's listing uses, over the roots only.
    expect(
      vi
        .mocked(driveFilesCache.pickReaderFolder)
        .mock.calls[0][0].map((f) => f.id)
        .sort()
    ).toEqual(['NESTED', 'TOP']);

    // A merged group of nested roots has a canonical too: read, never written to.
    ops.onRootFolderConfirmed?.('NESTED');
    expect(driveFilesCache.setReaderFolderId).not.toHaveBeenCalled();

    ops.onRootFolderConfirmed?.('TOP');
    expect(driveFilesCache.setReaderFolderId).toHaveBeenCalledWith('TOP');
  });

  it('confirms a nested root when the cache picks it (no top-level root)', async () => {
    vi.mocked(driveApiClient.listFiles).mockResolvedValue([
      folder('NESTED_A', 'mokuro-reader', 'BACKUP'),
      folder('NESTED_B', 'mokuro-reader', 'BACKUP')
    ]);
    vi.mocked(driveFilesCache.pickReaderFolder).mockResolvedValueOnce({
      id: 'NESTED_A',
      topLevelKnown: true
    });
    const ops = googleDriveProvider.getFolderOperations();
    await ops.listFolders();

    ops.onRootFolderConfirmed?.('NESTED_A');
    expect(driveFilesCache.setReaderFolderId).toHaveBeenCalledWith('NESTED_A');
  });

  it('confirms NO root when the cache could not tell which roots are top-level', async () => {
    vi.mocked(driveApiClient.listFiles).mockResolvedValue([
      folder('TOP', 'mokuro-reader', 'MY_DRIVE'),
      folder('NESTED', 'mokuro-reader', 'BACKUP')
    ]);
    // The query failed: the pick is a guess, and a guess must not move writes.
    vi.mocked(driveFilesCache.pickReaderFolder).mockResolvedValueOnce({
      id: 'NESTED',
      topLevelKnown: false
    });
    const ops = googleDriveProvider.getFolderOperations();
    await ops.listFolders();

    // The ids of everything listed ride along, for the fallback ranking.
    expect(vi.mocked(driveFilesCache.pickReaderFolder).mock.calls[0][1]).toEqual(
      new Set(['TOP', 'NESTED'])
    );
    ops.onRootFolderConfirmed?.('NESTED');
    ops.onRootFolderConfirmed?.('TOP');
    expect(driveFilesCache.setReaderFolderId).not.toHaveBeenCalled();
  });

  it('breaks a creation-time tie by id when several folders share a name', async () => {
    const same = '2026-01-01T00:00:00.000Z';
    vi.mocked(driveApiClient.listFiles).mockResolvedValue([
      folder('b-folder', 'Ippo', 'reader-root', same),
      folder('a-folder', 'Ippo', 'reader-root', same)
    ]);

    expect(await googleDriveProvider.findOrCreateFolder('reader-root', 'Ippo')).toBe('a-folder');
  });
});

describe('GoogleDriveProvider quick-tier reads (no account-wide listing)', () => {
  type Query = string;
  const files = {
    readers: [{ id: 'r1' }, { id: 'r2' }],
    history: [{ id: 'h1', name: 'history' }],
    deviceFolders: [{ id: 'd1', name: 'dev-a', mimeType: FOLDER_MIME, parents: ['h1'] }],
    segments: [
      {
        id: 'f1',
        name: '2026-10.events',
        mimeType: 'application/octet-stream',
        modifiedTime: '2026-10-30T00:00:00.000Z',
        size: '123',
        parents: ['d1']
      },
      {
        id: 'f2',
        name: 'device.json',
        mimeType: JSON_MIME,
        modifiedTime: '2026-10-29T00:00:00.000Z',
        size: '45',
        parents: ['d1']
      },
      { id: 'x', name: 'notes.txt', mimeType: 'text/plain', parents: ['d1'] }
    ]
  };

  beforeEach(() => {
    (googleDriveProvider as unknown as { quickReaderIds: unknown }).quickReaderIds = null;
    vi.mocked(tokenManager.isAuthenticated).mockReturnValue(true);
    vi.mocked(driveApiClient.listFiles).mockReset();
    vi.mocked(driveApiClient.listFiles).mockImplementation(async (query: Query) => {
      if (query.startsWith("name='mokuro-reader'")) return files.readers as never;
      if (query.includes("name='history'")) {
        expect(query).toContain("'r1' in parents or 'r2' in parents");
        return files.history as never;
      }
      if (query.includes("name='positions.json'")) {
        return [{ id: 'p1' }, { id: 'p2' }] as never;
      }
      if (query.startsWith("('h1' in parents)")) return files.deviceFolders as never;
      if (query.startsWith("('d1' in parents)")) return files.segments as never;
      return [] as never;
    });
  });

  it('listFolder walks reader → history → device folders with one query per level', async () => {
    const { driveHistoryPath } = await import('./drive-history-path');
    const listed = await googleDriveProvider.listFolder('history');
    expect(listed.map((f) => f.path).sort()).toEqual([
      'history/dev-a/2026-10.events',
      'history/dev-a/device.json'
    ]);
    const segment = listed.find((f) => f.fileId === 'f1')!;
    // The same entry the Drive files cache makes, so import stamps still match.
    expect(segment).toMatchObject({
      provider: 'google-drive',
      size: 123,
      modifiedTime: '2026-10-30T00:00:00.000Z',
      parentId: 'd1',
      name: '2026-10.events'
    });
    const folders = new Map([
      ['d1', { name: 'dev-a', parent: 'h1' }],
      ['h1', { name: 'history', parent: 'r1' }],
      ['r1', { name: 'mokuro-reader' }]
    ]);
    expect(segment.path).toBe(driveHistoryPath(files.segments[0], folders, 'mokuro-reader'));
    // reader folders, history, device folders, segments
    expect(driveApiClient.listFiles).toHaveBeenCalledTimes(4);
    for (const [query] of vi.mocked(driveApiClient.listFiles).mock.calls) {
      // Owned files only, like the full listing — but never its account-wide query.
      expect(query).toContain("'me' in owners");
      expect(query).not.toBe("'me' in owners and trashed=false");
    }
  });

  it('no reader folder → nothing, after one query', async () => {
    vi.mocked(driveApiClient.listFiles).mockImplementation(async () => []);
    expect(await googleDriveProvider.listFolder('history')).toEqual([]);
    expect(driveApiClient.listFiles).toHaveBeenCalledTimes(1);
  });

  it('readRootFileCopies reads every copy in any reader folder; the folder lookup is shared', async () => {
    const download = vi
      .spyOn(googleDriveProvider, 'downloadFile')
      .mockImplementation(async (file) => new Blob([file.fileId]));
    const blobs = await googleDriveProvider.readRootFileCopies('positions.json');
    expect(await Promise.all(blobs.map((b) => b.text()))).toEqual(['p1', 'p2']);
    await googleDriveProvider.listFolder('history');
    const readerLookups = vi
      .mocked(driveApiClient.listFiles)
      .mock.calls.filter(([q]) => q.startsWith("name='mokuro-reader'"));
    expect(readerLookups).toHaveLength(1);
    download.mockRestore();
  });
});

describe('GoogleDriveProvider worker credentials and their renewal', () => {
  beforeEach(() => {
    vi.mocked(tokenManager.getAccessToken).mockClear();
    vi.mocked(tokenManager.renewRejectedToken).mockReset();
  });

  it('hands a worker a token good for at least 15 minutes', async () => {
    await googleDriveProvider.getWorkerDownloadCredentials('f');
    await googleDriveProvider.getWorkerUploadCredentials();
    expect(vi.mocked(tokenManager.getAccessToken).mock.calls).toEqual([
      [15 * 60 * 1000],
      [15 * 60 * 1000]
    ]);
  });

  it('a worker’s refused token is renewed on the main thread (worker-auth-refresh)', async () => {
    const { answerAuthRefresh } = await import('$lib/util/worker-auth-refresh');
    vi.mocked(tokenManager.renewRejectedToken).mockResolvedValue({
      kind: 'renewed',
      token: 'NEW'
    } as never);
    const answer = await answerAuthRefresh({
      type: 'auth-refresh',
      requestId: 7,
      provider: 'google-drive',
      staleAuthorization: 'Bearer OLD'
    });
    expect(tokenManager.renewRejectedToken).toHaveBeenCalledWith('OLD');
    expect(answer).toEqual({
      type: 'auth-refresh-result',
      requestId: 7,
      credentials: expect.objectContaining({ accessToken: 'NEW' })
    });
  });

  it('nothing to renew with: null, and the 401 stands', async () => {
    vi.mocked(tokenManager.renewRejectedToken).mockResolvedValue({ kind: 'failed' } as never);
    expect(await googleDriveProvider.refreshedWorkerCredentials('Bearer OLD')).toBeNull();
  });

  it('a backend that is down is a transient failure, never the 401', async () => {
    const { answerAuthRefresh, isTransientAuthRefreshError } = await import(
      '$lib/util/worker-auth-refresh'
    );
    vi.mocked(tokenManager.renewRejectedToken).mockResolvedValue({ kind: 'transient' } as never);
    await expect(googleDriveProvider.refreshedWorkerCredentials('Bearer OLD')).rejects.toSatisfy(
      isTransientAuthRefreshError
    );
    const answer = await answerAuthRefresh({
      type: 'auth-refresh',
      requestId: 8,
      provider: 'google-drive',
      staleAuthorization: 'Bearer OLD'
    });
    expect(answer).toMatchObject({ credentials: null, transient: true });
  });
});

describe('GoogleDriveProvider.getStorageQuota()', () => {
  const quota = { result: { storageQuota: { usage: '100', limit: '1000' } } };
  const refused = { status: 401, result: { error: { code: 401, message: 'Invalid Credentials' } } };
  let aboutGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    aboutGet = vi.fn();
    vi.stubGlobal('gapi', { client: { drive: { about: { get: aboutGet } } } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the token manager for a live token before it calls Drive (backend mode renews one)', async () => {
    aboutGet.mockResolvedValue(quota);

    expect(await googleDriveProvider.getStorageQuota()).toEqual({
      used: 100,
      total: 1000,
      available: 900
    });
    expect(tokenManager.getAccessToken).toHaveBeenCalled();
    expect(vi.mocked(tokenManager.getAccessToken).mock.invocationCallOrder[0]).toBeLessThan(
      aboutGet.mock.invocationCallOrder[0]
    );
  });

  it('a 401 renews the refused token and sends the request once more', async () => {
    aboutGet.mockRejectedValueOnce(refused).mockResolvedValueOnce(quota);
    vi.mocked(tokenManager.renewRejectedToken).mockResolvedValueOnce({
      kind: 'renewed',
      token: 'NEW'
    } as never);

    expect(await googleDriveProvider.getStorageQuota()).toMatchObject({ used: 100 });
    expect(tokenManager.renewRejectedToken).toHaveBeenCalledWith('TOKEN');
    expect(aboutGet).toHaveBeenCalledTimes(2);
  });

  it('retries only once: a second 401 fails the call', async () => {
    aboutGet.mockRejectedValue(refused);
    vi.mocked(tokenManager.renewRejectedToken).mockResolvedValue({
      kind: 'renewed',
      token: 'NEW'
    } as never);

    await expect(googleDriveProvider.getStorageQuota()).rejects.toMatchObject({
      code: 'QUOTA_FETCH_FAILED'
    });
    expect(tokenManager.renewRejectedToken).toHaveBeenCalledTimes(1);
    expect(aboutGet).toHaveBeenCalledTimes(2);
  });

  it('no renewal to be had: the 401 stands, nothing sent again', async () => {
    aboutGet.mockRejectedValue(refused);
    vi.mocked(tokenManager.renewRejectedToken).mockResolvedValue({ kind: 'failed' } as never);

    await expect(googleDriveProvider.getStorageQuota()).rejects.toMatchObject({
      code: 'QUOTA_FETCH_FAILED'
    });
    expect(aboutGet).toHaveBeenCalledTimes(1);
  });
});
