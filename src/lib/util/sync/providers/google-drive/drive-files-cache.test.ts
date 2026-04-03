import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api-client', () => ({
  driveApiClient: {
    listFiles: vi.fn()
  }
}));

vi.mock('../../folder-deduplicator', () => ({
  folderDeduplicator: {
    deduplicateAll: vi.fn().mockResolvedValue({ groupsMerged: 0 })
  }
}));

vi.mock('./google-drive-provider', () => ({
  googleDriveProvider: {
    isAuthenticated: vi.fn(() => false)
  }
}));

import { driveApiClient } from './api-client';
import { driveFilesCache } from './drive-files-cache';

describe('driveFilesCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    driveFilesCache.clear();
  });

  it('caches Drive sidecar files needed for downloads', async () => {
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'folder-1',
        name: 'Series',
        mimeType: 'application/vnd.google-apps.folder'
      },
      {
        id: 'cbz-1',
        name: 'Volume 1.cbz',
        mimeType: 'application/x-cbz',
        parents: ['folder-1'],
        modifiedTime: '2026-03-09T00:00:00.000Z',
        size: '100'
      },
      {
        id: 'mokuro-1',
        name: 'Volume 1.mokuro',
        mimeType: 'application/json',
        parents: ['folder-1'],
        modifiedTime: '2026-03-09T00:00:00.000Z',
        size: '20'
      },
      {
        id: 'mokurogz-1',
        name: 'Volume 1.mokuro.gz',
        mimeType: 'application/gzip',
        parents: ['folder-1'],
        modifiedTime: '2026-03-09T00:00:00.000Z',
        size: '10'
      },
      {
        id: 'webp-1',
        name: 'Volume 1.webp',
        mimeType: 'image/webp',
        parents: ['folder-1'],
        modifiedTime: '2026-03-09T00:00:00.000Z',
        size: '5'
      }
    ]);

    await driveFilesCache.fetch();

    expect(
      driveFilesCache
        .getAllFiles()
        .map((file) => file.path)
        .sort()
    ).toEqual([
      'Series/Volume 1.cbz',
      'Series/Volume 1.mokuro',
      'Series/Volume 1.mokuro.gz',
      'Series/Volume 1.webp'
    ]);
  });
});
