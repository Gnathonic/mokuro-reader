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
