import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../onedrive-provider', () => ({
  onedriveProvider: {
    isAuthenticated: vi.fn(() => true),
    listLibrary: vi.fn()
  }
}));

vi.mock('../token-manager', () => ({
  onedriveTokenManager: { getAccessToken: vi.fn(async () => 'TOKEN') }
}));

vi.mock('../graph-client', () => ({
  startDelta: vi.fn(),
  readDelta: vi.fn()
}));

import { onedriveProvider } from '../onedrive-provider';
import { readDelta, startDelta, type DriveItem } from '../graph-client';
import {
  CHANGE_FEED_MAX_AGE_MS,
  FULL_LISTING_REUSE_MS,
  MIN_DELTA_PAGES,
  onedriveCache
} from '../onedrive-cache';
import type { OneDriveFolderMap } from '../onedrive-delta';
import { uploadCacheEntry } from '../../../cloud-cache-interface';
import { ProviderError, type CloudFileMetadata } from '../../../provider-interface';

const provider = vi.mocked(onedriveProvider);
const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-02T10:00:00.000Z';
const LINK0 = 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=0';
const LINK1 = 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=1';

/** The library as the full walk sees it before each test. */
function library(): { files: CloudFileMetadata[]; folders: OneDriveFolderMap; rootId: string } {
  const folders: OneDriveFolderMap = new Map([
    ['R', { name: 'mokuro-reader', parent: 'DRIVE', path: '' }],
    ['SA', { name: 'Series A', parent: 'R', path: 'Series A' }],
    ['H', { name: 'history', parent: 'R', path: 'history' }],
    ['DA', { name: 'dev-a', parent: 'H', path: 'history/dev-a' }]
  ]);
  const file = (fileId: string, path: string, size: number): CloudFileMetadata => ({
    provider: 'onedrive',
    fileId,
    path,
    modifiedTime: T0,
    size,
    revision: `"c:{${fileId}},1"`
  });
  return {
    files: [
      file('v1', 'Series A/Volume 1.cbz', 100),
      file('v1m', 'Series A/Volume 1.mokuro', 10),
      file('vd', 'volume-data.json', 50),
      file('ha', 'history/dev-a/2026-10.events', 5)
    ],
    folders,
    rootId: 'R'
  };
}

const folderItem = (id: string, name: string, parent: string, childCount = 0): DriveItem => ({
  id,
  name,
  folder: { childCount },
  parentReference: { id: parent }
});
const fileItem = (
  id: string,
  name: string,
  parent: string,
  extra: Partial<DriveItem> = {}
): DriveItem => ({
  id,
  name,
  file: {},
  size: 7,
  lastModifiedDateTime: T1,
  cTag: `"c:{${id}},2"`,
  parentReference: { id: parent },
  ...extra
});
const deletedItem = (id: string, parent: string): DriveItem =>
  ({ id, deleted: { state: 'deleted' }, parentReference: { id: parent } }) as DriveItem;
/** The ancestors Graph reports beside every change. */
const ancestors = [
  { id: 'DRIVE', name: 'root', root: {}, folder: { childCount: 3 } },
  folderItem('R', 'mokuro-reader', 'DRIVE', 4)
];

function feed(items: DriveItem[], link = LINK1) {
  vi.mocked(readDelta).mockResolvedValueOnce({ items, deltaLink: link });
}

const paths = () =>
  onedriveCache
    .getAllFiles()
    .map((f) => f.path)
    .sort();

async function loadLibrary() {
  provider.listLibrary.mockResolvedValue(library());
  vi.mocked(startDelta).mockResolvedValue(LINK0);
  await onedriveCache.fetch();
  expect(onedriveCache.isLoaded()).toBe(true);
  provider.listLibrary.mockClear();
  vi.mocked(startDelta).mockClear();
}

let now = Date.parse('2026-11-07T12:00:00Z');

describe('OneDrive change feed (Graph delta) on the listing cache', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    provider.isAuthenticated.mockReturnValue(true);
    now = Date.parse('2026-11-07T12:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    onedriveCache.clear();
    await loadLibrary();
    // Past the reuse window: a refresh with no position walks.
    now += FULL_LISTING_REUSE_MS + 1;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the position is taken BEFORE the walk, so a write during the walk arrives by the feed', async () => {
    const order: string[] = [];
    onedriveCache.clear();
    vi.mocked(startDelta).mockImplementation(async () => {
      order.push('position');
      return LINK0;
    });
    provider.listLibrary.mockImplementation(async () => {
      order.push('walk');
      return library();
    });
    await onedriveCache.fetch();
    expect(order).toEqual(['position', 'walk']);

    feed([...ancestors, fileItem('late', 'catalog.json', 'R')]);
    expect(await onedriveCache.refreshFromChanges()).toBe('applied');
    expect(vi.mocked(readDelta)).toHaveBeenCalledWith('TOKEN', LINK0, MIN_DELTA_PAGES);
    expect(paths()).toContain('catalog.json');
  });

  it("another device's new history segment (new folder and file) arrives without a walk", async () => {
    // The file before its folder: delta promises no order.
    feed([
      ...ancestors,
      fileItem('hb', '2026-11.events', 'DB'),
      folderItem('DB', 'dev-b', 'H', 1),
      folderItem('H', 'history', 'R', 2)
    ]);
    expect(await onedriveCache.refreshFromChanges()).toBe('applied');
    expect(provider.listLibrary).not.toHaveBeenCalled();
    const entry = onedriveCache.get('history/dev-b/2026-11.events');
    expect(entry).toMatchObject({
      fileId: 'hb',
      size: 7,
      modifiedTime: T1,
      revision: '"c:{hb},2"'
    });
    expect(onedriveCache.getAllFiles().map((f) => f.path)).toContain(
      'history/dev-b/2026-11.events'
    );

    // The next read resumes from the deltaLink this one returned.
    feed([...ancestors], 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=2');
    expect(await onedriveCache.refreshFromChanges()).toBe('unchanged');
    expect(vi.mocked(readDelta).mock.calls[1][1]).toBe(LINK1);
  });

  it("the echo of this device's own upload is 'unchanged', and the map keeps its identity", async () => {
    onedriveCache.add(
      'Series A/Volume 2.cbz',
      uploadCacheEntry('onedrive', 'Series A/Volume 2.cbz', 7, {
        fileId: 'v2',
        modifiedTime: T1,
        size: 7,
        revision: '"c:{v2},2"'
      })
    );
    const before = onedriveCache.store.read();
    feed([
      ...ancestors,
      folderItem('SA', 'Series A', 'R', 3),
      fileItem('v2', 'Volume 2.cbz', 'SA')
    ]);
    expect(await onedriveCache.refreshFromChanges()).toBe('unchanged');
    expect(onedriveCache.store.read()).toBe(before);
  });

  it('a changed file (same id, new content) replaces its entry', async () => {
    feed([...ancestors, fileItem('vd', 'volume-data.json', 'R', { size: 60 })]);
    expect(await onedriveCache.refreshFromChanges()).toBe('applied');
    expect(onedriveCache.get('volume-data.json')).toMatchObject({ size: 60, modifiedTime: T1 });
  });

  it('a receipt newer than the feed entry is kept', async () => {
    onedriveCache.add(
      'volume-data.json',
      uploadCacheEntry('onedrive', 'volume-data.json', 70, {
        fileId: 'vd',
        modifiedTime: '2026-11-03T10:00:00.000Z',
        size: 70,
        revision: '"c:{vd},3"'
      })
    );
    feed([...ancestors, fileItem('vd', 'volume-data.json', 'R', { size: 60 })]);
    expect(await onedriveCache.refreshFromChanges()).toBe('unchanged');
    expect(onedriveCache.get('volume-data.json')?.size).toBe(70);
  });

  it('a file delete is applied', async () => {
    feed([...ancestors, folderItem('SA', 'Series A', 'R', 1), deletedItem('v1m', 'SA')]);
    expect(await onedriveCache.refreshFromChanges()).toBe('applied');
    expect(paths()).not.toContain('Series A/Volume 1.mokuro');
    expect(paths()).toContain('Series A/Volume 1.cbz');
  });

  it('a folder delete removes every file under it', async () => {
    feed([...ancestors, deletedItem('H', 'R')]);
    expect(await onedriveCache.refreshFromChanges()).toBe('applied');
    expect(paths()).toEqual([
      'Series A/Volume 1.cbz',
      'Series A/Volume 1.mokuro',
      'volume-data.json'
    ]);
    // Its subfolder went with it: a later file "under" dev-a is outside.
    feed([...ancestors, fileItem('zz', 'late.events', 'DA')]);
    expect(await onedriveCache.refreshFromChanges()).toBe('unchanged');
  });

  it('a folder deleted and made again at the same path in one batch keeps the new folder', async () => {
    // Series A removed and uploaded again before this device read the feed:
    // the old id deleted (with its files), a new id at the same name.
    feed([
      ...ancestors,
      deletedItem('v1', 'SA'),
      deletedItem('v1m', 'SA'),
      deletedItem('SA', 'R'),
      folderItem('SA2', 'Series A', 'R', 1),
      fileItem('n1', 'Volume 1.cbz', 'SA2')
    ]);
    expect(await onedriveCache.refreshFromChanges()).toBe('applied');
    expect(provider.listLibrary).not.toHaveBeenCalled();
    expect(onedriveCache.getBySeries('Series A').map((f) => f.fileId)).toEqual(['n1']);
    // The new folder is in the folder map: a later file there is placed.
    feed([
      ...ancestors,
      folderItem('SA2', 'Series A', 'R', 2),
      fileItem('n2', 'Volume 2.cbz', 'SA2')
    ]);
    expect(await onedriveCache.refreshFromChanges()).toBe('applied');
    expect(paths()).toContain('Series A/Volume 2.cbz');
    expect(provider.listLibrary).not.toHaveBeenCalled();
  });

  it('a removed folder takes its descendants by id: a re-made subtree stays, one under the old tree goes', async () => {
    feed([
      ...ancestors,
      deletedItem('H', 'R'),
      // `history` made again, with a device folder and a segment in it.
      folderItem('H2', 'history', 'R', 1),
      folderItem('DB', 'dev-b', 'H2', 1),
      fileItem('hb', '2026-11.events', 'DB'),
      // A folder under the OLD tree's dev-a: gone with it.
      folderItem('X', 'stray', 'DA', 0)
    ]);
    expect(await onedriveCache.refreshFromChanges()).toBe('applied');
    expect(paths()).toEqual([
      'Series A/Volume 1.cbz',
      'Series A/Volume 1.mokuro',
      'history/dev-b/2026-11.events',
      'volume-data.json'
    ]);
    // dev-b is known, the stray folder is not.
    feed([
      ...ancestors,
      fileItem('hb2', '2026-12.events', 'DB'),
      fileItem('xs', 'late.events', 'X')
    ]);
    expect(await onedriveCache.refreshFromChanges()).toBe('applied');
    expect(paths()).toContain('history/dev-b/2026-12.events');
    expect(paths().some((p) => p.includes('late.events'))).toBe(false);
  });

  it('a file renamed or moved within the library gets its new path; moved out, it goes', async () => {
    feed([
      ...ancestors,
      fileItem('v1m', 'Volume 01.mokuro', 'SA', { size: 10, lastModifiedDateTime: T0 })
    ]);
    expect(await onedriveCache.refreshFromChanges()).toBe('applied');
    expect(onedriveCache.get('Series A/Volume 01.mokuro')?.fileId).toBe('v1m');
    expect(onedriveCache.get('Series A/Volume 1.mokuro')).toBeNull();

    feed([...ancestors, fileItem('v1', 'Volume 1.cbz', 'ELSEWHERE')]);
    expect(await onedriveCache.refreshFromChanges()).toBe('applied');
    expect(paths()).not.toContain('Series A/Volume 1.cbz');
  });

  it('items outside the mokuro tree (root-scoped feed) are ignored', async () => {
    const before = onedriveCache.store.read();
    feed([
      { id: 'DRIVE', name: 'root', root: {}, folder: { childCount: 3 } },
      folderItem('PICS', 'Pictures', 'DRIVE', 1),
      fileItem('photo', 'IMG_0001.jpg', 'PICS'),
      fileItem('stray', 'volume-data.json', 'DRIVE'),
      deletedItem('unknown', 'PICS')
    ]);
    expect(await onedriveCache.refreshFromChanges()).toBe('unchanged');
    expect(onedriveCache.store.read()).toBe(before);
    expect(provider.listLibrary).not.toHaveBeenCalled();
  });

  it('a non-syncable file inside the library is not cached', async () => {
    feed([...ancestors, fileItem('junk', 'notes.txt', 'SA')]);
    expect(await onedriveCache.refreshFromChanges()).toBe('unchanged');
  });

  it.each([
    ['renamed', [folderItem('SA', 'Series A (2020)', 'R', 2)]],
    ['moved', [folderItem('DA', 'dev-a', 'R', 1)]],
    ['moved in with contents', [folderItem('NEW', 'Series B', 'R', 3)]],
    ['the mokuro folder removed', [deletedItem('R', 'DRIVE')]]
  ])('a folder %s triggers a full walk', async (_what, items) => {
    feed([...ancestors.slice(0, 1), ...items]);
    provider.listLibrary.mockResolvedValue(library());
    expect(await onedriveCache.refreshFromChanges()).toBe('reset');
    expect(provider.listLibrary).toHaveBeenCalledTimes(1);
    // The walk took a fresh position.
    expect(vi.mocked(startDelta)).toHaveBeenCalledTimes(1);
  });

  it('a 410 (resync) triggers a full walk', async () => {
    vi.mocked(readDelta).mockResolvedValueOnce('resync');
    provider.listLibrary.mockResolvedValue(library());
    expect(await onedriveCache.refreshFromChanges()).toBe('reset');
    expect(provider.listLibrary).toHaveBeenCalledTimes(1);
  });

  it('the page cap (the folder count, at least MIN_DELTA_PAGES) triggers a full walk', async () => {
    vi.mocked(readDelta).mockResolvedValueOnce('too-long');
    provider.listLibrary.mockResolvedValue(library());
    expect(await onedriveCache.refreshFromChanges()).toBe('reset');
    expect(vi.mocked(readDelta).mock.calls[0][2]).toBe(MIN_DELTA_PAGES);
    expect(provider.listLibrary).toHaveBeenCalledTimes(1);
  });

  it('a listing over a day old is walked, not fed', async () => {
    now += CHANGE_FEED_MAX_AGE_MS;
    provider.listLibrary.mockResolvedValue(library());
    expect(await onedriveCache.refreshFromChanges()).toBe('reset');
    expect(vi.mocked(readDelta)).not.toHaveBeenCalled();
    expect(provider.listLibrary).toHaveBeenCalledTimes(1);
  });

  it('a transient feed failure walks; a walk that fails too REJECTS (the cache is not current)', async () => {
    vi.mocked(readDelta).mockRejectedValueOnce(
      new ProviderError('Graph 503', 'onedrive', 'GRAPH_503', false, true)
    );
    provider.listLibrary.mockResolvedValue(library());
    expect(await onedriveCache.refreshFromChanges()).toBe('reset');

    vi.mocked(readDelta).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    provider.listLibrary.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const before = onedriveCache.store.read();
    await expect(onedriveCache.refreshFromChanges()).rejects.toThrow(/Failed to fetch/);
    // The snapshot and its position stay: the next refresh reads the feed again.
    expect(onedriveCache.store.read()).toBe(before);
    feed([...ancestors]);
    expect(await onedriveCache.refreshFromChanges()).toBe('unchanged');
  });

  it('an auth failure rethrows without a walk', async () => {
    vi.mocked(readDelta).mockRejectedValueOnce(
      new ProviderError('Graph 401', 'onedrive', 'GRAPH_401', true)
    );
    await expect(onedriveCache.refreshFromChanges()).rejects.toThrow(/401/);
    expect(provider.listLibrary).not.toHaveBeenCalled();
  });

  it('a 403 turns the feed off for the session: walks take no position, refreshes walk', async () => {
    vi.mocked(readDelta).mockRejectedValueOnce(
      new ProviderError('Graph 403', 'onedrive', 'GRAPH_403')
    );
    provider.listLibrary.mockResolvedValue(library());
    expect(await onedriveCache.refreshFromChanges()).toBe('reset');
    expect(vi.mocked(startDelta)).not.toHaveBeenCalled();
    // Within the reuse window the walk just made stands.
    expect(await onedriveCache.refreshFromChanges()).toBe('unchanged');
    now += FULL_LISTING_REUSE_MS + 1;
    expect(await onedriveCache.refreshFromChanges()).toBe('reset');
    expect(vi.mocked(readDelta)).toHaveBeenCalledTimes(1);
    expect(provider.listLibrary).toHaveBeenCalledTimes(2);
  });

  it('no mokuro folder at the walk: no position, so the next refresh walks', async () => {
    onedriveCache.clear();
    provider.listLibrary.mockResolvedValue({ files: [], folders: new Map(), rootId: null });
    vi.mocked(startDelta).mockResolvedValue(LINK0);
    await onedriveCache.fetch();
    now += FULL_LISTING_REUSE_MS + 1;
    provider.listLibrary.mockClear();
    expect(await onedriveCache.refreshFromChanges()).toBe('reset');
    expect(vi.mocked(readDelta)).not.toHaveBeenCalled();
    expect(provider.listLibrary).toHaveBeenCalledTimes(1);
  });

  it('clear() while a feed read is out installs nothing', async () => {
    let release: (v: Awaited<ReturnType<typeof readDelta>>) => void = () => {};
    vi.mocked(readDelta).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const pending = onedriveCache.refreshFromChanges();
    await Promise.resolve();
    await Promise.resolve();
    onedriveCache.clear();
    release({ items: [...ancestors, fileItem('x', 'catalog.json', 'R')], deltaLink: LINK1 });
    expect(await pending).toBe('reset');
    expect(onedriveCache.getAllFiles()).toEqual([]);
    expect(onedriveCache.isLoaded()).toBe(false);
  });

  it('a walk that overtakes a feed read drops the read', async () => {
    let release: (v: Awaited<ReturnType<typeof readDelta>>) => void = () => {};
    vi.mocked(readDelta).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const pending = onedriveCache.refreshFromChanges();
    await Promise.resolve();
    await Promise.resolve();
    provider.listLibrary.mockResolvedValue(library());
    const walk = onedriveCache.fetch();
    release({ items: [...ancestors, fileItem('x', 'catalog.json', 'R')], deltaLink: LINK1 });
    await walk;
    expect(await pending).toBe('reset');
    expect(paths()).not.toContain('catalog.json');
  });

  it('a walk that overtakes a feed read and FAILS leaves the snapshot: the batch is applied', async () => {
    let release: (v: Awaited<ReturnType<typeof readDelta>>) => void = () => {};
    vi.mocked(readDelta).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const pending = onedriveCache.refreshFromChanges();
    await Promise.resolve();
    await Promise.resolve();
    provider.listLibrary.mockRejectedValueOnce(
      new ProviderError('Graph 429', 'onedrive', 'GRAPH_429', false, true)
    );
    const walk = onedriveCache.fetch();
    release({ items: [...ancestors, fileItem('x', 'catalog.json', 'R')], deltaLink: LINK1 });
    await walk;
    expect(await pending).toBe('applied');
    expect(paths()).toContain('catalog.json');
    // The read stepped the position on.
    feed([...ancestors]);
    expect(await onedriveCache.refreshFromChanges()).toBe('unchanged');
    expect(vi.mocked(readDelta).mock.calls[1][1]).toBe(LINK1);
  });

  it('concurrent callers share one read', async () => {
    feed([...ancestors]);
    const [a, b] = await Promise.all([
      onedriveCache.refreshFromChanges(),
      onedriveCache.refreshFromChanges()
    ]);
    expect([a, b]).toEqual(['unchanged', 'unchanged']);
    expect(vi.mocked(readDelta)).toHaveBeenCalledTimes(1);
  });
});
