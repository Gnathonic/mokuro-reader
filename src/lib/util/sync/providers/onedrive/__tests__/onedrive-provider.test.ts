import { describe, it, expect, beforeEach, vi } from 'vitest';

// Keep the constructor cheap (no MSAL init) by reporting a non-browser env.
vi.mock('$app/environment', () => ({ browser: false }));

// The provider grabs a worker core at construction; a dummy is enough here.
vi.mock('../../../core/cloud-provider-core-registry', () => ({
  getCloudProviderCore: vi.fn(() => ({}))
}));

// Token manager: authenticated with a static token.
vi.mock('../token-manager', () => ({
  onedriveTokenManager: {
    initialize: vi.fn().mockResolvedValue(undefined),
    isAuthenticated: vi.fn().mockReturnValue(true),
    getAccessToken: vi.fn().mockResolvedValue('TOKEN')
  }
}));

// Graph client: every network call is a spy we drive per test.
vi.mock('../graph-client', () => ({
  getItemByPath: vi.fn(),
  getItemStamp: vi.fn(),
  listChildren: vi.fn(),
  createFolder: vi.fn(),
  deleteItem: vi.fn(),
  getDriveQuota: vi.fn(),
  patchItem: vi.fn()
}));

import { OneDriveProvider } from '../onedrive-provider';
import {
  getItemByPath,
  getItemStamp,
  listChildren,
  createFolder,
  deleteItem
} from '../graph-client';
import { ProviderError } from '../../../provider-interface';
import { oneDriveStorageFullError } from '../graph-errors';

describe('OneDriveProvider.listCloudVolumes', () => {
  let provider: OneDriveProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OneDriveProvider();
  });

  it('returns empty when the root mokuro folder does not exist', async () => {
    vi.mocked(getItemByPath).mockResolvedValue(null);

    await expect(provider.listCloudVolumes()).resolves.toEqual([]);
    // Must not attempt to walk a folder it knows is absent.
    expect(vi.mocked(listChildren)).not.toHaveBeenCalled();
  });

  it('propagates a non-404 listing error instead of swallowing it', async () => {
    vi.mocked(getItemByPath).mockResolvedValue({ id: 'root', name: 'mokuro-reader' });
    vi.mocked(listChildren).mockRejectedValue(new Error('Graph 500 Internal Server Error: '));

    await expect(provider.listCloudVolumes()).rejects.toThrow(/500/);
  });

  it('does NOT swallow a 404 raised while listing a deep subfolder', async () => {
    vi.mocked(getItemByPath).mockResolvedValue({ id: 'root', name: 'mokuro-reader' });
    vi.mocked(listChildren)
      // Top-level mokuro folder lists one series subfolder...
      .mockResolvedValueOnce([{ id: 'series', name: 'Naruto', folder: {} }])
      // ...and listing that subfolder fails with a real 404.
      .mockRejectedValueOnce(new Error('Graph 404 Not Found: '));

    // A deep 404 means missing data, not "empty library" — it must surface,
    // not silently drop the affected volumes and return a partial set.
    await expect(provider.listCloudVolumes()).rejects.toThrow(/404/);
  });
});

describe('folder creation coalescing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a missing series folder exactly once under concurrent prepareUploadTarget calls', async () => {
    let created = false;
    vi.mocked(getItemByPath).mockImplementation(async (_t, path) => {
      if (path === 'mokuro-reader') return { id: 'root-id', name: 'mokuro-reader', folder: {} };
      return created ? { id: 'series-id', name: 'Series', folder: {} } : null;
    });
    vi.mocked(createFolder).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      created = true;
      return { id: 'series-id', name: 'Series', folder: {} };
    });

    const provider = new OneDriveProvider();
    await Promise.all([
      provider.prepareUploadTarget('Series'),
      provider.prepareUploadTarget('Series'),
      provider.prepareUploadTarget('Series')
    ]);

    // Two POSTs at most: one for the series folder. The mokuro root already
    // exists, so exactly one createFolder call total.
    expect(vi.mocked(createFolder)).toHaveBeenCalledTimes(1);
  });

  it('recovers when createFolder 409s because another client already created it', async () => {
    let probes = 0;
    vi.mocked(getItemByPath).mockImplementation(async (_t, path) => {
      if (path === 'mokuro-reader') return { id: 'root-id', name: 'mokuro-reader', folder: {} };
      probes++;
      // Missing on the first existence probe, present on the post-409 re-fetch.
      return probes > 1 ? { id: 'series-id', name: 'Series', folder: {} } : null;
    });
    vi.mocked(createFolder).mockRejectedValue(
      new ProviderError('Graph 409 Conflict: nameAlreadyExists', 'onedrive', 'GRAPH_409')
    );

    const provider = new OneDriveProvider();
    await expect(provider.prepareUploadTarget('Series')).resolves.not.toThrow();
  });
});

describe('removeDirectoryIfEmpty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes a folder the server reports empty', async () => {
    vi.mocked(getItemByPath).mockResolvedValue({ id: 'dir-id', name: 'Old', folder: {} });
    vi.mocked(listChildren).mockResolvedValue([]);

    const provider = new OneDriveProvider();
    await provider.removeDirectoryIfEmpty('Old Series');

    expect(vi.mocked(deleteItem)).toHaveBeenCalledWith(expect.anything(), 'dir-id');
  });

  it('keeps a folder that still has children', async () => {
    vi.mocked(getItemByPath).mockResolvedValue({ id: 'dir-id', name: 'Old', folder: {} });
    vi.mocked(listChildren).mockResolvedValue([{ id: 'x', name: 'v.cbz', file: {} }]);

    const provider = new OneDriveProvider();
    await provider.removeDirectoryIfEmpty('Old Series');

    expect(vi.mocked(deleteItem)).not.toHaveBeenCalled();
  });

  it('no-ops when the folder is already gone', async () => {
    vi.mocked(getItemByPath).mockResolvedValue(null);

    const provider = new OneDriveProvider();
    await expect(provider.removeDirectoryIfEmpty('Old Series')).resolves.toBeUndefined();

    expect(vi.mocked(deleteItem)).not.toHaveBeenCalled();
  });
});

describe('upload failure classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getItemByPath).mockResolvedValue({
      id: 'root-id',
      name: 'mokuro-reader',
      folder: {}
    });
  });

  function providerWithCoreFailure(failure: string | Error): OneDriveProvider {
    const error = typeof failure === 'string' ? new Error(failure) : failure;
    const provider = new OneDriveProvider();
    (provider as unknown as { cloudCore: unknown }).cloudCore = {
      uploadFile: vi.fn().mockRejectedValue(error),
      downloadFile: vi.fn().mockRejectedValue(error)
    };
    return provider;
  }

  it('a full drive (the core’s storage-full error) stays QUOTA_EXCEEDED, not a retryable 5xx', async () => {
    const provider = providerWithCoreFailure(oneDriveStorageFullError());

    const err = await provider.uploadFile('volume-data.json', new Blob(['x'])).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.isNetworkError).toBe(false);
    expect(err.message).toMatch(/storage is full/);

    // A download through the same core passes it through the same way.
    const download = await provider
      .downloadFile({ fileId: 'f', name: 'v.cbz', path: 'S/v.cbz' } as never)
      .catch((e) => e);
    expect(download.code).toBe('QUOTA_EXCEEDED');
  });

  it('other 5xx failures stay retryable UPLOAD_FAILED', async () => {
    const provider = providerWithCoreFailure('OneDrive upload failed after 5 attempts: HTTP 503');
    const err = await provider.uploadFile('volume-data.json', new Blob(['x'])).catch((e) => e);
    expect(err.code).toBe('UPLOAD_FAILED');
    expect(err.isNetworkError).toBe(true);
  });
});

describe('nested folders (reading history)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates history/<device> one segment at a time, never a name with a slash', async () => {
    const existing = new Set(['mokuro-reader']);
    vi.mocked(getItemByPath).mockImplementation(async (_t, path) =>
      existing.has(path) ? { id: path, name: path.split('/').pop()!, folder: {} } : null
    );
    vi.mocked(createFolder).mockImplementation(async (_t, parent, name) => {
      existing.add(`${parent}/${name}`);
      return { id: `${parent}/${name}`, name, folder: {} };
    });

    const provider = new OneDriveProvider();
    await provider.prepareUploadTarget('history/dev-a');

    expect(vi.mocked(createFolder).mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['mokuro-reader', 'history'],
      ['mokuro-reader/history', 'dev-a']
    ]);
  });
});

describe('OneDriveProvider.statFile (conditional root-file reads)', () => {
  const file = {
    provider: 'onedrive' as const,
    fileId: 'item-1',
    path: 'volume-data.json',
    modifiedTime: '',
    size: 0
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is the item by id, $select-ed: cTag is the revision, else eTag', async () => {
    vi.mocked(getItemStamp).mockResolvedValueOnce({
      id: 'item-1',
      name: 'volume-data.json',
      size: 28542,
      lastModifiedDateTime: '2026-11-02T10:00:00Z',
      eTag: '"{E},3"',
      cTag: '"c:{E},3"',
      file: {}
    });
    const provider = new OneDriveProvider();
    expect(await provider.statFile(file)).toEqual({
      size: 28542,
      modifiedTime: '2026-11-02T10:00:00Z',
      revision: '"c:{E},3"'
    });
    expect(vi.mocked(getItemStamp)).toHaveBeenCalledWith('TOKEN', 'item-1');

    vi.mocked(getItemStamp).mockResolvedValueOnce({
      id: 'item-1',
      name: 'volume-data.json',
      size: 2,
      lastModifiedDateTime: '2026-11-02T10:00:00Z',
      eTag: '"{E},4"',
      file: {}
    });
    expect((await provider.statFile(file))?.revision).toBe('"{E},4"');
  });

  it('a 404 (or a folder under that id) is gone', async () => {
    const provider = new OneDriveProvider();
    vi.mocked(getItemStamp).mockResolvedValueOnce(null);
    expect(await provider.statFile(file)).toBeNull();
    vi.mocked(getItemStamp).mockResolvedValueOnce({ id: 'item-1', name: 'x', folder: {} });
    expect(await provider.statFile(file)).toBeNull();
  });
});
