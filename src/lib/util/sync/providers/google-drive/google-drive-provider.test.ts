import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    needsAttention: { subscribe: (cb: (v: boolean) => void) => (cb(false), () => {}) }
  }
}));
vi.mock('$lib/util/sync/providers/google-drive/api-client', () => ({
  driveApiClient: {
    initialize: vi.fn(async () => {}),
    listFiles: vi.fn(async () => []),
    deleteFile: vi.fn(async () => {})
  }
}));
vi.mock('$lib/util/sync/providers/google-drive/drive-files-cache', () => ({
  driveFilesCache: {
    getReaderFolderId: vi.fn(async () => 'reader-root'),
    setReaderFolderId: vi.fn(),
    getDriveFilesBySeries: vi.fn(() => []),
    removeById: vi.fn(),
    clear: vi.fn()
  }
}));
vi.mock('$lib/util/backup', () => ({ findFile: vi.fn() }));
vi.mock('../../cache-manager', () => ({
  cacheManager: { registerCache: vi.fn(), clearAll: vi.fn() }
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
