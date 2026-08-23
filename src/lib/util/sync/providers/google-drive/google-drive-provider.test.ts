import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/util/sync/providers/google-drive/token-manager', () => ({
  tokenManager: {
    isAuthenticated: vi.fn(() => true),
    token: { subscribe: (cb: (v: string) => void) => (cb('TOKEN'), () => {}) },
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
    removeById: vi.fn()
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
