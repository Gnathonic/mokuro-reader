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
    getAccessToken: vi.fn().mockResolvedValue('TOKEN'),
    logout: vi.fn().mockResolvedValue(undefined)
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
  deleteItem,
  patchItem
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

describe('folder-id latch (uploads resolve their folders once per session)', () => {
  /** The server's folders, by path; an upload into a missing one 404s like Graph's session. */
  let folders: Set<string>;
  let uploads: Array<{ seriesTitle: string; filename: string }>;
  let failNext: string | null;

  function makeProvider(): OneDriveProvider {
    const provider = new OneDriveProvider();
    (provider as unknown as { cloudCore: unknown }).cloudCore = {
      uploadFile: vi.fn(async (args: { seriesTitle: string; filename: string }) => {
        if (failNext) {
          const message = failNext;
          failNext = null;
          throw new Error(message);
        }
        const parent = args.seriesTitle ? `mokuro-reader/${args.seriesTitle}` : 'mokuro-reader';
        if (!folders.has(parent)) {
          throw new Error('Failed to create OneDrive upload session: 404 Not Found');
        }
        uploads.push({ seriesTitle: args.seriesTitle, filename: args.filename });
        return { fileId: `id-${args.filename}`, revision: '"c:{x},1"' };
      })
    };
    return provider;
  }

  const lookups = () => vi.mocked(getItemByPath).mock.calls.map((c) => c[1]);

  beforeEach(() => {
    vi.clearAllMocks();
    folders = new Set(['mokuro-reader']);
    uploads = [];
    failNext = null;
    vi.mocked(getItemByPath).mockImplementation(async (_t, path) =>
      folders.has(path) ? { id: `id:${path}`, name: path.split('/').pop()!, folder: {} } : null
    );
    vi.mocked(createFolder).mockImplementation(async (_t, parent, name) => {
      await new Promise((r) => setTimeout(r, 5));
      const path = parent ? `${parent}/${name}` : name;
      folders.add(path);
      return { id: `id:${path}`, name, folder: {} };
    });
  });

  it('a second upload into the same folder asks the server nothing', async () => {
    folders.add('mokuro-reader/history');
    folders.add('mokuro-reader/history/dev-a');
    const provider = makeProvider();
    await provider.uploadFile('history/dev-a/2026-11.events', new Blob(['a']));
    const first = lookups().length;
    expect(first).toBeGreaterThan(0);

    await provider.uploadFile('history/dev-a/2026-11.events', new Blob(['ab']));
    await provider.uploadFile('history/dev-a/2026-12.events', new Blob(['c']));
    expect(lookups()).toHaveLength(first);
    expect(uploads).toHaveLength(3);
  });

  it('a root-file upload after the first asks the server nothing', async () => {
    const provider = makeProvider();
    await provider.uploadFile('positions.json', new Blob(['1']));
    expect(lookups()).toEqual(['mokuro-reader']);
    await provider.uploadFile('positions.json', new Blob(['2']));
    await provider.uploadFile('volume-data.json', new Blob(['3']));
    expect(lookups()).toEqual(['mokuro-reader']);
  });

  it('an upload failure forgets the folders: the next upload resolves them again', async () => {
    const provider = makeProvider();
    await provider.uploadFile('positions.json', new Blob(['1']));
    failNext = 'OneDrive upload failed after 5 attempts: HTTP 503';
    await expect(provider.uploadFile('positions.json', new Blob(['2']))).rejects.toThrow(/503/);
    expect(lookups()).toEqual(['mokuro-reader']);

    await provider.uploadFile('positions.json', new Blob(['3']));
    expect(lookups()).toEqual(['mokuro-reader', 'mokuro-reader']);
  });

  it('a remembered folder another device deleted is re-created and the upload lands, once', async () => {
    folders.add('mokuro-reader/Series A');
    const provider = makeProvider();
    await provider.uploadFile('Series A/Vol 1.mokuro', new Blob(['1']));
    // Another device deletes the series folder.
    folders.delete('mokuro-reader/Series A');

    await provider.uploadFile('Series A/Vol 2.mokuro', new Blob(['2']));
    expect(vi.mocked(createFolder).mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['mokuro-reader', 'Series A']
    ]);
    expect(uploads.map((u) => u.filename)).toEqual(['Vol 1.mokuro', 'Vol 2.mokuro']);
  });

  it('a missing parent with nothing remembered is not retried', async () => {
    const provider = makeProvider();
    // The lookup finds the folder, but the session still 404s: no memo was
    // trusted, so the failure is the server's answer.
    folders.add('mokuro-reader/Series A');
    vi.mocked(getItemByPath).mockResolvedValue({ id: 'ghost', name: 'Series A', folder: {} });
    folders.delete('mokuro-reader/Series A');
    await expect(provider.uploadFile('Series A/Vol 1.mokuro', new Blob(['1']))).rejects.toThrow(
      /404/
    );
    expect(uploads).toHaveLength(0);
  });

  it.each([
    ['deleteSeriesFolder', (p: OneDriveProvider) => p.deleteSeriesFolder('Series A')],
    ['removeDirectoryIfEmpty', (p: OneDriveProvider) => p.removeDirectoryIfEmpty('Series A')],
    [
      'renameFolder',
      async (p: OneDriveProvider) => {
        vi.mocked(listChildren).mockResolvedValue([]);
        vi.mocked(patchItem).mockResolvedValue({ id: 'id:x', name: 'Series B' });
        await p.renameFolder('Series A', 'Series B');
      }
    ],
    ['logout', (p: OneDriveProvider) => p.logout()]
  ])('%s forgets the folders', async (_name, act) => {
    folders.add('mokuro-reader/Series A');
    vi.mocked(listChildren).mockResolvedValue([]);
    const provider = makeProvider();
    await provider.uploadFile('Series A/Vol 1.mokuro', new Blob(['1']));
    await act(provider);
    folders.add('mokuro-reader/Series A');
    vi.mocked(getItemByPath).mockClear();

    await provider.uploadFile('Series A/Vol 2.mokuro', new Blob(['2']));
    expect(lookups()).toContain('mokuro-reader/Series A');
  });

  it('renameFile resolves its destination folder on the server, never from the memo', async () => {
    folders.add('mokuro-reader/Series A');
    const provider = makeProvider();
    await provider.uploadFile('Series A/Vol 1.mokuro', new Blob(['1']));
    vi.mocked(getItemByPath).mockClear();
    vi.mocked(patchItem).mockResolvedValue({ id: 'f', name: 'Vol 9.mokuro' });

    await provider.renameFile(
      {
        provider: 'onedrive',
        fileId: 'f',
        path: 'Series A/Vol 1.mokuro',
        modifiedTime: '',
        size: 1
      },
      'Series A/Vol 9.mokuro'
    );
    // One lookup (the folder, by path), and its id is the move's target.
    expect(lookups()).toEqual(['mokuro-reader/Series A']);
    expect(vi.mocked(patchItem)).toHaveBeenCalledWith('TOKEN', 'f', {
      name: 'Vol 9.mokuro',
      parentReference: { id: 'id:mokuro-reader/Series A' }
    });
  });

  it('concurrent first uploads into a new series make one createFolder', async () => {
    const provider = makeProvider();
    await Promise.all([
      provider.uploadFile('Series N/Vol 1.cbz', new Blob(['1'])),
      provider.uploadFile('Series N/Vol 1.mokuro', new Blob(['2'])),
      provider.uploadFile('Series N/Vol 2.cbz', new Blob(['3']))
    ]);
    expect(vi.mocked(createFolder)).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(3);
  });

  it('prepareUploadTarget (before a worker upload) always asks the server', async () => {
    folders.add('mokuro-reader/Series A');
    const provider = makeProvider();
    await provider.uploadFile('Series A/Vol 1.mokuro', new Blob(['1']));
    vi.mocked(getItemByPath).mockClear();
    await provider.prepareUploadTarget('Series A');
    await provider.prepareUploadTarget('');
    expect(lookups()).toEqual(['mokuro-reader/Series A', 'mokuro-reader']);
  });
});
