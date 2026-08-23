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

/**
 * The cache — NOT `GoogleDriveProvider.listCloudVolumes()` — is Drive's real
 * sync path (`cacheManager.registerCache('google-drive', driveFilesCache)`), so
 * the root-config classification has to be right HERE.
 *
 * Root config files are keyed by BASENAME, and `get()/has()` resolve a key from
 * `path.split('/')[0]`. A `<Series>/catalog.json` cached at the bare name would
 * therefore shadow the real root catalog and readers would fetch the wrong file.
 */
describe('driveFilesCache root config classification', () => {
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  beforeEach(() => {
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'reader-root', name: 'mokuro-reader', mimeType: FOLDER_MIME },
      { id: 'series-1', name: 'Dr Stone', mimeType: FOLDER_MIME, parents: ['reader-root'] },
      {
        id: 'root-catalog',
        name: 'catalog.json',
        mimeType: 'application/json',
        parents: ['reader-root'],
        modifiedTime: '2026-08-23T00:00:00.000Z',
        size: '30'
      },
      {
        id: 'nested-catalog',
        name: 'catalog.json',
        mimeType: 'application/json',
        parents: ['series-1'],
        modifiedTime: '2026-08-23T00:00:00.000Z',
        size: '40'
      },
      {
        id: 'root-progress',
        name: 'volume-data.json',
        mimeType: 'application/json',
        parents: ['reader-root'],
        modifiedTime: '2026-08-23T00:00:00.000Z',
        size: '50'
      }
    ]);
  });

  it('caches the ROOT catalog.json at its bare name', async () => {
    await driveFilesCache.fetch();

    expect(driveFilesCache.getAll('catalog.json').map((f) => f.fileId)).toEqual(['root-catalog']);
  });

  it('never lets a NESTED catalog.json shadow the root one', async () => {
    await driveFilesCache.fetch();

    // Grouped under its series, addressable by its full path — never at the root key.
    expect(driveFilesCache.get('Dr Stone/catalog.json')?.fileId).toBe('nested-catalog');
    expect(driveFilesCache.getAllFiles().filter((f) => f.path === 'catalog.json')).toHaveLength(1);
  });

  it('still caches volume-data.json for the progress sync path', async () => {
    await driveFilesCache.fetch();

    expect(driveFilesCache.getVolumeDataFileId()).toBe('root-progress');
  });
});

/**
 * `<Series>/series.json` is a sidecar of the SERIES FOLDER. Drive's cache is the
 * only listing that hand-rolled its sidecar test, so the file was invisible here
 * while every other provider listed it through the shared allowlist — the whole
 * series-index read/refresh path was dead against Drive.
 */
describe('driveFilesCache series.json sidecar', () => {
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  function listing(files: Array<Record<string, unknown>>) {
    (driveApiClient.listFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'reader-root', name: 'mokuro-reader', mimeType: FOLDER_MIME },
      { id: 'series-1', name: 'Dr Stone', mimeType: FOLDER_MIME, parents: ['reader-root'] },
      ...files
    ]);
  }

  it('caches <Series>/series.json under its series folder', async () => {
    listing([
      {
        id: 'series-file-1',
        name: 'series.json',
        mimeType: 'application/json',
        parents: ['series-1'],
        modifiedTime: '2026-08-23T00:00:00.000Z',
        size: '60'
      }
    ]);

    await driveFilesCache.fetch();

    expect(driveFilesCache.get('Dr Stone/series.json')?.fileId).toBe('series-file-1');
    expect(driveFilesCache.getBySeries('Dr Stone').map((f) => f.path)).toEqual([
      'Dr Stone/series.json'
    ]);
  });

  it('still ignores a .json that merely ENDS with series.json', async () => {
    listing([
      {
        id: 'not-ours',
        name: 'my-series.json',
        mimeType: 'application/json',
        parents: ['series-1'],
        modifiedTime: '2026-08-23T00:00:00.000Z',
        size: '60'
      }
    ]);

    await driveFilesCache.fetch();

    expect(driveFilesCache.getAllFiles()).toEqual([]);
  });
});
