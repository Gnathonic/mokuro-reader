import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('./api-client', () => ({
  driveApiClient: {
    listFiles: vi.fn(),
    getFileMetadata: vi.fn(),
    getStartPageToken: vi.fn(),
    listChanges: vi.fn()
  },
  escapeNameForDriveQuery: vi.fn((name: string) => name),
  isDriveAuthFailure: (error: unknown) => (error as { kind?: unknown })?.kind === 'auth'
}));

vi.mock('../../folder-deduplicator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../folder-deduplicator')>()),
  folderDeduplicator: { deduplicateAll: vi.fn().mockResolvedValue({ groupsMerged: 0 }) }
}));

vi.mock('./google-drive-provider', () => ({
  googleDriveProvider: {
    type: 'google-drive',
    isAuthenticated: vi.fn(() => false),
    getFolderOperations: vi.fn(() => ({})),
    adoptListedReaderFolder: vi.fn(),
    // No Bunko marker in the library: the dedup is the reader's to run.
    readControlFile: vi.fn(async () => null)
  }
}));

import { driveApiClient } from './api-client';
import type { DriveChange, DriveFile } from './constants';
import { folderDeduplicator } from '../../folder-deduplicator';
import { googleDriveProvider } from './google-drive-provider';
import {
  CHANGE_FEED_MAX_AGE_MS,
  FULL_LISTING_REUSE_MS,
  MAX_CHANGE_PAGES,
  driveFilesCache
} from './drive-files-cache';
import { uploadCacheEntry, type CacheAddMetadata } from '../../cloud-cache-interface';
import type { DriveFileMetadata } from '../../provider-interface';
import { CACHE_MUTATION_COALESCE_MS } from '../../coalesced-cache-store';

const api = vi.mocked(driveApiClient);
const FOLDER = 'application/vnd.google-apps.folder';
const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-02T10:00:00.000Z';

/** The account as the whole-account listing sees it before each test. */
const LISTING: DriveFile[] = [
  { id: 'reader', name: 'mokuro-reader', mimeType: FOLDER },
  { id: 'series-a', name: 'Series A', mimeType: FOLDER, parents: ['reader'] },
  { id: 'hist', name: 'history', mimeType: FOLDER, parents: ['reader'] },
  { id: 'dev', name: 'dev-a', mimeType: FOLDER, parents: ['hist'] },
  {
    id: 'v1',
    name: 'Volume 1.cbz',
    mimeType: 'application/x-cbz',
    parents: ['series-a'],
    modifiedTime: T0,
    size: '100'
  },
  {
    id: 'v1-mokuro',
    name: 'Volume 1.mokuro',
    mimeType: 'application/json',
    parents: ['series-a'],
    modifiedTime: T0,
    size: '10'
  },
  {
    id: 'vd',
    name: 'volume-data.json',
    mimeType: 'application/json',
    parents: ['reader'],
    modifiedTime: T0,
    size: '50'
  },
  {
    id: 'seg',
    name: '2026-10.events',
    mimeType: 'application/octet-stream',
    parents: ['dev'],
    modifiedTime: T0,
    size: '42'
  }
];

/** A file as a change entry carries it: current state, ours, live. */
function changed(file: Partial<DriveFile> & { id: string }): DriveChange {
  return {
    fileId: file.id,
    removed: false,
    file: { mimeType: 'application/octet-stream', ownedByMe: true, ...file } as DriveFile
  };
}

/** The next `changes.list` read returns these changes, then position `next`. */
function feed(changes: DriveChange[], next = 'token-2') {
  api.listChanges.mockResolvedValueOnce({ changes, newStartPageToken: next });
}

const paths = () =>
  driveFilesCache
    .getAllFiles()
    .map((f) => f.path)
    .sort();

/** The clock, `ms` from now (the last full listing stays where it was). */
function later(ms: number): void {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + ms);
}

/** Let the dedup pass a fetch fires from its `finally` finish (dynamic imports). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('driveFilesCache change feed (#288)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(googleDriveProvider.isAuthenticated).mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    driveFilesCache.clear();
    api.listFiles.mockResolvedValue(LISTING);
    api.getStartPageToken.mockResolvedValue('token-1');
    api.getFileMetadata.mockRejectedValue(new Error('not mocked'));
    await driveFilesCache.fetch();
    await settle();
    api.listFiles.mockClear();
    api.getStartPageToken.mockClear();
    vi.mocked(folderDeduplicator.deduplicateAll).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('takes the feed position BEFORE the whole-account walk', async () => {
    driveFilesCache.clear();
    await driveFilesCache.fetch();
    const token = api.getStartPageToken.mock.invocationCallOrder[0];
    const walk = api.listFiles.mock.invocationCallOrder[0];
    expect(token).toBeLessThan(walk);
  });

  it('nothing changed: one feed read, no listing, the same map', async () => {
    const before = get(driveFilesCache.store);
    const revision = driveFilesCache.revision();
    feed([], 'token-1b');

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');

    expect(api.listChanges).toHaveBeenCalledTimes(1);
    expect(api.listChanges).toHaveBeenCalledWith(
      'token-1',
      expect.stringContaining('ownedByMe'),
      MAX_CHANGE_PAGES
    );
    expect(api.listFiles).not.toHaveBeenCalled();
    expect(get(driveFilesCache.store)).toBe(before);
    expect(driveFilesCache.revision()).toBe(revision);

    // The next read resumes where this one ended.
    feed([]);
    await driveFilesCache.refreshFromChanges();
    expect(api.listChanges).toHaveBeenLastCalledWith('token-1b', expect.any(String), 13);
  });

  it('adds a new file in a known folder', async () => {
    feed([
      changed({
        id: 'v2',
        name: 'Volume 2.cbz',
        mimeType: 'application/x-cbz',
        parents: ['series-a'],
        modifiedTime: T1,
        size: '200',
        version: '3'
      })
    ]);

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('applied');

    expect(driveFilesCache.get('Series A/Volume 2.cbz')).toMatchObject({
      fileId: 'v2',
      size: 200,
      modifiedTime: T1,
      parentId: 'series-a',
      name: 'Volume 2.cbz',
      revision: '3'
    });
    expect(api.listFiles).not.toHaveBeenCalled();
  });

  it('updates a changed file in place', async () => {
    feed([changed({ ...LISTING[4], modifiedTime: T1, size: '150' })]);

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('applied');

    expect(driveFilesCache.getAll('Series A/Volume 1.cbz')).toEqual([
      expect.objectContaining({ fileId: 'v1', size: 150, modifiedTime: T1 })
    ]);
  });

  it('drops a removed file and a trashed one', async () => {
    feed([{ fileId: 'v1', removed: true }, changed({ ...LISTING[6], trashed: true })]);

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('applied');

    expect(driveFilesCache.get('Series A/Volume 1.cbz')).toBeNull();
    expect(driveFilesCache.get('volume-data.json')).toBeNull();
    expect(driveFilesCache.get('Series A/Volume 1.mokuro')).not.toBeNull();
  });

  it('places a history file at its full history/<device>/<file> path', async () => {
    feed([
      changed({
        id: 'seg-2',
        name: '2026-11.events',
        parents: ['dev'],
        modifiedTime: T1,
        size: '7'
      })
    ]);

    await driveFilesCache.refreshFromChanges();

    expect(driveFilesCache.get('history/dev-a/2026-11.events')?.fileId).toBe('seg-2');
  });

  it('a root config file in the reader folder is root; in a series folder it is the series’', async () => {
    feed([
      changed({
        id: 'prof',
        name: 'profiles.json',
        mimeType: 'application/json',
        parents: ['reader'],
        modifiedTime: T1,
        size: '5'
      }),
      changed({
        id: 'nested-cat',
        name: 'catalog.json',
        mimeType: 'application/json',
        parents: ['series-a'],
        modifiedTime: T1,
        size: '6'
      })
    ]);

    await driveFilesCache.refreshFromChanges();

    expect(driveFilesCache.get('profiles.json')?.fileId).toBe('prof');
    expect(driveFilesCache.get('Series A/catalog.json')?.fileId).toBe('nested-cat');
    // A nested copy never shadows the root one.
    expect(driveFilesCache.get('catalog.json')).toBeNull();
  });

  it('a folder rename re-paths everything under it, history included', async () => {
    feed([
      changed({ id: 'series-a', name: 'Series B', mimeType: FOLDER, parents: ['reader'] }),
      changed({ id: 'dev', name: 'dev-b', mimeType: FOLDER, parents: ['hist'] })
    ]);

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('applied');

    expect(paths()).toEqual([
      'Series B/Volume 1.cbz',
      'Series B/Volume 1.mokuro',
      'history/dev-b/2026-10.events',
      'volume-data.json'
    ]);
    expect(driveFilesCache.getBySeries('Series A')).toEqual([]);
    expect(
      driveFilesCache
        .getBySeries('Series B')
        .map((f) => f.fileId)
        .sort()
    ).toEqual(['v1', 'v1-mokuro']);

    // A later change in that folder is placed by its NEW name.
    feed([
      changed({
        id: 'v2',
        name: 'Volume 2.cbz',
        parents: ['series-a'],
        modifiedTime: T1,
        size: '1'
      })
    ]);
    await driveFilesCache.refreshFromChanges();
    expect(driveFilesCache.get('Series B/Volume 2.cbz')?.fileId).toBe('v2');
  });

  it('a removed folder takes its files with it', async () => {
    feed([{ fileId: 'series-a', removed: true }]);

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('applied');

    expect(paths()).toEqual(['history/dev-a/2026-10.events', 'volume-data.json']);
  });

  it('a trashed history folder takes the device folders and files under it', async () => {
    feed([changed({ id: 'hist', name: 'history', mimeType: FOLDER, trashed: true })]);

    await driveFilesCache.refreshFromChanges();
    expect(driveFilesCache.get('history/dev-a/2026-10.events')).toBeNull();

    // `dev` left the folder map with it: a new file there is unplaceable now.
    api.getFileMetadata.mockResolvedValue({ id: 'dev', name: 'dev-a', trashed: true });
    feed([changed({ id: 'seg-3', name: '2026-12.events', parents: ['dev'], size: '1' })]);
    await driveFilesCache.refreshFromChanges();
    expect(driveFilesCache.get('history/dev-a/2026-12.events')).toBeNull();
  });

  describe('another device’s dedup merge: folders moved OUT of a folder removed in the same batch', () => {
    /**
     * A duplicate `mokuro-reader` root with a series and a history device in
     * it, beside the listing's own root. FolderDeduplicator merges it by
     * moving every child into the canonical root, then deleting it: this
     * device reads the moves and the deletion in ONE batch.
     */
    const DUPLICATE: DriveFile[] = [
      { id: 'reader-b', name: 'mokuro-reader', mimeType: FOLDER },
      { id: 'series-s', name: 'Series S', mimeType: FOLDER, parents: ['reader-b'] },
      { id: 'hist-b', name: 'history', mimeType: FOLDER, parents: ['reader-b'] },
      { id: 'dev-b', name: 'dev-b', mimeType: FOLDER, parents: ['hist-b'] },
      {
        id: 's1',
        name: 'Volume S.cbz',
        mimeType: 'application/x-cbz',
        parents: ['series-s'],
        modifiedTime: T0,
        size: '300'
      },
      {
        id: 's1-mokuro',
        name: 'Volume S.mokuro',
        mimeType: 'application/json',
        parents: ['series-s'],
        modifiedTime: T0,
        size: '30'
      },
      {
        id: 'seg-b',
        name: '2026-09.events',
        mimeType: 'application/octet-stream',
        parents: ['dev-b'],
        modifiedTime: T0,
        size: '9'
      }
    ];
    const MOVED_OUT = [
      changed({ id: 'series-s', name: 'Series S', mimeType: FOLDER, parents: ['reader'] }),
      changed({ id: 'hist-b', name: 'history', mimeType: FOLDER, parents: ['reader'] })
    ];
    const ROOT_REMOVED: DriveChange = { fileId: 'reader-b', removed: true };

    beforeEach(async () => {
      driveFilesCache.clear();
      // The walk, then the top-level query: `reader` is the write root.
      api.listFiles
        .mockResolvedValueOnce([...LISTING, ...DUPLICATE])
        .mockResolvedValueOnce([
          { id: 'reader', name: 'mokuro-reader', mimeType: FOLDER, parents: ['my-drive'] }
        ]);
      await driveFilesCache.fetch();
      await settle();
      api.listFiles.mockClear();
      expect(await driveFilesCache.getReaderFolderId()).toBe('reader');
      expect(paths()).toEqual([
        'Series A/Volume 1.cbz',
        'Series A/Volume 1.mokuro',
        'Series S/Volume S.cbz',
        'Series S/Volume S.mokuro',
        'history/dev-a/2026-10.events',
        'history/dev-b/2026-09.events',
        'volume-data.json'
      ]);
    });

    it.each([
      ['the moves first', [...MOVED_OUT, ROOT_REMOVED]],
      ['the deletion first', [ROOT_REMOVED, ...MOVED_OUT]]
    ])('keeps what moved out, and its folders (%s)', async (_order, changes) => {
      const before = paths();
      feed(changes);

      await driveFilesCache.refreshFromChanges();

      // Nothing under the moved folders was in the batch, and nothing left.
      expect(paths()).toEqual(before);
      expect(api.listFiles).not.toHaveBeenCalled();

      // The folder map still knows them: a new file in each is placed, with
      // no lookup (an unknown parent would be looked up, and that rejects).
      feed([
        changed({ id: 's2', name: 'Volume S2.cbz', parents: ['series-s'], size: '1' }),
        changed({ id: 'seg-b2', name: '2026-10.events', parents: ['dev-b'], size: '1' })
      ]);
      await driveFilesCache.refreshFromChanges();
      expect(api.getFileMetadata).not.toHaveBeenCalled();
      expect(driveFilesCache.get('Series S/Volume S2.cbz')?.fileId).toBe('s2');
      expect(driveFilesCache.get('history/dev-b/2026-10.events')?.fileId).toBe('seg-b2');
    });

    it('a folder moved INTO the removed one goes with it', async () => {
      feed([
        changed({ id: 'series-a', name: 'Series A', mimeType: FOLDER, parents: ['reader-b'] }),
        ROOT_REMOVED
      ]);

      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('applied');

      // Series A went in, then the root went with everything it held.
      expect(paths()).toEqual(['history/dev-a/2026-10.events', 'volume-data.json']);
    });
  });

  it('lists in full when the reader folder sits under a folder the batch removed', async () => {
    // The user filed the reader folder away, then trashed the folder holding it.
    feed([
      changed({ id: 'outer', name: 'Archive', mimeType: FOLDER, parents: ['my-drive'] }),
      changed({ id: 'reader', name: 'mokuro-reader', mimeType: FOLDER, parents: ['outer'] })
    ]);
    await driveFilesCache.refreshFromChanges();
    expect(api.listFiles).not.toHaveBeenCalled();

    feed([changed({ id: 'outer', name: 'Archive', mimeType: FOLDER, trashed: true })]);
    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
    expect(api.listFiles).toHaveBeenCalledTimes(1);
  });

  it('looks an unknown parent folder up ONCE, then knows it', async () => {
    api.getFileMetadata.mockResolvedValue({
      id: 'series-n',
      name: 'Series N',
      mimeType: FOLDER,
      parents: ['reader'],
      ownedByMe: true
    });
    feed([
      changed({ id: 'n1', name: 'Volume 1.cbz', parents: ['series-n'], size: '1' }),
      changed({ id: 'n2', name: 'Volume 2.cbz', parents: ['series-n'], size: '2' })
    ]);

    await driveFilesCache.refreshFromChanges();

    expect(api.getFileMetadata).toHaveBeenCalledTimes(1);
    expect(api.getFileMetadata).toHaveBeenCalledWith('series-n', expect.stringContaining('name'));
    expect(driveFilesCache.getBySeries('Series N').map((f) => f.path)).toEqual([
      'Series N/Volume 1.cbz',
      'Series N/Volume 2.cbz'
    ]);

    feed([changed({ id: 'n3', name: 'Volume 3.cbz', parents: ['series-n'], size: '3' })]);
    await driveFilesCache.refreshFromChanges();
    expect(api.getFileMetadata).toHaveBeenCalledTimes(1);
    expect(driveFilesCache.get('Series N/Volume 3.cbz')?.fileId).toBe('n3');
  });

  it('a parent the lookup says is not ours stays unknown, as it is to the listing', async () => {
    api.getFileMetadata.mockResolvedValue({
      id: 'shared',
      name: 'Shared',
      mimeType: FOLDER,
      parents: ['reader'],
      ownedByMe: false
    });
    feed([changed({ id: 's1', name: 'Volume 1.cbz', parents: ['shared'], size: '1' })]);

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
    expect(driveFilesCache.getBySeries('Shared')).toEqual([]);
  });

  it("a parent Drive answers 404 for (not this app's) stays unknown too", async () => {
    api.getFileMetadata.mockRejectedValue(
      Object.assign(new Error('File not found: 404'), { status: 404, kind: 'other' })
    );
    feed([changed({ id: 's1', name: 'Volume 1.cbz', parents: ['elsewhere'], size: '1' })]);

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
    expect(api.listFiles).not.toHaveBeenCalled();
  });

  // A lookup that FAILED says nothing about the folder. Leaving it unknown
  // dropped the file and stepped the feed past it for good: another device's
  // new series stayed invisible until some full listing happened to run.
  it.each([
    ['a 503 past its retries', { status: 503, kind: 'transient' }],
    ['a 429 past its retries', { status: 429, kind: 'rate-limit' }],
    ['offline (no status)', {}]
  ])('a parent lookup that fails (%s) lists in full instead', async (_label, failure) => {
    api.getFileMetadata.mockRejectedValue(Object.assign(new Error('lookup failed'), failure));
    feed([changed({ id: 'n1', name: 'Volume 1.cbz', parents: ['series-n'], size: '1' })]);
    api.listFiles.mockResolvedValueOnce([
      ...LISTING,
      { id: 'series-n', name: 'Series N', mimeType: FOLDER, parents: ['reader'] },
      {
        id: 'n1',
        name: 'Volume 1.cbz',
        mimeType: 'application/x-cbz',
        parents: ['series-n'],
        modifiedTime: T1,
        size: '1'
      }
    ]);
    api.getStartPageToken.mockResolvedValueOnce('token-fresh');

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');

    expect(api.listFiles).toHaveBeenCalledTimes(1);
    expect(driveFilesCache.get('Series N/Volume 1.cbz')?.fileId).toBe('n1');
    // The feed resumes from that listing's position, never past the batch.
    feed([]);
    await driveFilesCache.refreshFromChanges();
    expect(api.listChanges).toHaveBeenLastCalledWith(
      'token-fresh',
      expect.any(String),
      MAX_CHANGE_PAGES
    );
  });

  it('a batch that cannot be applied lists in full instead of failing every sync', async () => {
    feed([changed({ ...LISTING[4], size: '101', modifiedTime: T1 })]);
    vi.spyOn(
      driveFilesCache as unknown as { planFeed: () => never },
      'planFeed'
    ).mockImplementationOnce(() => {
      throw new Error('unexpected change shape');
    });

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
    expect(api.listFiles).toHaveBeenCalledTimes(1);
  });

  it('ignores a file this account does not own, and drops one it no longer owns', async () => {
    feed([
      changed({
        id: 'theirs',
        name: 'Volume 9.cbz',
        parents: ['series-a'],
        size: '9',
        ownedByMe: false
      })
    ]);
    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
    expect(driveFilesCache.get('Series A/Volume 9.cbz')).toBeNull();

    feed([changed({ ...LISTING[4], ownedByMe: false })]);
    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('applied');
    expect(driveFilesCache.get('Series A/Volume 1.cbz')).toBeNull();
  });

  describe('the echo of this device’s own upload', () => {
    /** What the unified layer adds after an upload: `uploadCacheEntry` of the receipt. */
    const receipt = (revision: string, size = 60) =>
      uploadCacheEntry('google-drive', 'volume-data.json', size, {
        fileId: 'vd',
        modifiedTime: T1,
        size,
        revision,
        parentId: 'reader',
        name: 'volume-data.json'
      }) as CacheAddMetadata<DriveFileMetadata>;

    it('re-emits nothing: the receipt already holds what the feed reports', async () => {
      vi.useFakeTimers();
      const emitted: unknown[] = [];
      const unsubscribe = driveFilesCache.store.subscribe((map) => emitted.push(map));
      driveFilesCache.add('volume-data.json', receipt('7'));
      vi.advanceTimersByTime(CACHE_MUTATION_COALESCE_MS);
      const published = emitted.length;
      const map = get(driveFilesCache.store);
      const revision = driveFilesCache.revision();

      // The same instant, spelled the way the files resource may spell it.
      feed([
        changed({
          ...LISTING[6],
          modifiedTime: '2026-11-02T10:00:00Z',
          size: '60',
          version: '7'
        })
      ]);
      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
      vi.advanceTimersByTime(CACHE_MUTATION_COALESCE_MS * 2);

      expect(emitted.length).toBe(published);
      expect(get(driveFilesCache.store)).toBe(map);
      expect(driveFilesCache.revision()).toBe(revision);
      unsubscribe();
    });

    it('keeps a receipt NEWER than the feed’s state of the file', async () => {
      driveFilesCache.add('volume-data.json', receipt('43', 70));
      feed([changed({ ...LISTING[6], modifiedTime: T0, size: '60', version: '42' })]);

      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
      expect(driveFilesCache.get('volume-data.json')).toMatchObject({ size: 70, revision: '43' });
    });

    it('takes the feed’s state over an OLDER receipt', async () => {
      driveFilesCache.add('volume-data.json', receipt('41', 70));
      feed([
        changed({
          ...LISTING[6],
          modifiedTime: '2026-11-02T11:00:00.000Z',
          size: '80',
          version: '42'
        })
      ]);

      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('applied');
      expect(driveFilesCache.getAll('volume-data.json')).toEqual([
        expect.objectContaining({ fileId: 'vd', size: 80, revision: '42' })
      ]);
    });
  });

  it('never toggles the fetching or loaded state', async () => {
    const fetching: boolean[] = [];
    const loaded: boolean[] = [];
    const offFetching = driveFilesCache.isFetchingState.subscribe((v) => fetching.push(v));
    const offLoaded = driveFilesCache.cacheLoaded.subscribe((v) => loaded.push(v));
    feed([changed({ ...LISTING[4], size: '101', modifiedTime: T1 })]);

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('applied');

    expect(fetching).toEqual([false]);
    expect(loaded).toEqual([true]);
    offFetching();
    offLoaded();
  });

  it('a folder colliding with another of its name under one parent starts the dedup', async () => {
    vi.mocked(googleDriveProvider.isAuthenticated).mockReturnValue(true);
    feed([changed({ id: 'series-a2', name: 'Series A', mimeType: FOLDER, parents: ['reader'] })]);

    await driveFilesCache.refreshFromChanges();

    await vi.waitFor(() => expect(folderDeduplicator.deduplicateAll).toHaveBeenCalledTimes(1));
  });

  it('keeps the listed reader folders in step: a new root joins, a removed one leaves', async () => {
    // The control-file reads look for Bunko's marker in every live
    // `mokuro-reader` folder, nested ones included (`resolveControlRoots`).
    expect(driveFilesCache.getListedReaderFolderIds()).toEqual(['reader']);
    feed([
      changed({ id: 'backup', name: 'Backup', mimeType: FOLDER }),
      changed({ id: 'nested', name: 'mokuro-reader', mimeType: FOLDER, parents: ['backup'] })
    ]);
    await driveFilesCache.refreshFromChanges();
    expect(driveFilesCache.getListedReaderFolderIds()?.sort()).toEqual(['nested', 'reader']);

    feed([{ fileId: 'nested', removed: true }]);
    await driveFilesCache.refreshFromChanges();
    expect(driveFilesCache.getListedReaderFolderIds()).toEqual(['reader']);
    expect(api.listFiles).not.toHaveBeenCalled();
  });

  it('a folder of a new name starts no dedup', async () => {
    vi.mocked(googleDriveProvider.isAuthenticated).mockReturnValue(true);
    feed([changed({ id: 'series-c', name: 'Series C', mimeType: FOLDER, parents: ['reader'] })]);

    await driveFilesCache.refreshFromChanges();
    await settle();

    expect(folderDeduplicator.deduplicateAll).not.toHaveBeenCalled();
  });

  describe('falls back to the full listing', () => {
    it('when Drive refuses the position', async () => {
      api.listChanges.mockRejectedValueOnce(
        Object.assign(new Error('Invalid pageToken: 400'), { status: 400, kind: 'other' })
      );
      api.getStartPageToken.mockResolvedValueOnce('token-fresh');

      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');

      expect(api.listFiles).toHaveBeenCalledTimes(1);
      // The listing takes a new position, and the feed resumes from it.
      feed([]);
      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
      expect(api.listChanges).toHaveBeenLastCalledWith('token-fresh', expect.any(String), 13);
    });

    it('when the log is longer than a listing', async () => {
      api.listChanges.mockResolvedValueOnce(null);

      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
      expect(api.listFiles).toHaveBeenCalledTimes(1);
    });

    it('when the last full listing is over a day old', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + CHANGE_FEED_MAX_AGE_MS + 1);

      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
      expect(api.listChanges).not.toHaveBeenCalled();
      expect(api.listFiles).toHaveBeenCalledTimes(1);
    });

    it('when the listing took no position, once that listing is not fresh', async () => {
      driveFilesCache.clear();
      api.getStartPageToken.mockRejectedValueOnce(new Error('offline'));
      await driveFilesCache.fetch();
      api.listFiles.mockClear();

      // Startup lists, then syncs at once: that sync walks nothing again.
      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
      expect(api.listFiles).not.toHaveBeenCalled();

      later(FULL_LISTING_REUSE_MS + 1);
      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
      expect(api.listChanges).not.toHaveBeenCalled();
      expect(api.listFiles).toHaveBeenCalledTimes(1);
    });

    it('after the cache was cleared (sign-out, account switch)', async () => {
      driveFilesCache.clear();

      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
      expect(api.listChanges).not.toHaveBeenCalled();
      expect(api.listFiles).toHaveBeenCalledTimes(1);
      expect(paths()).toContain('Series A/Volume 1.cbz');
    });

    it('when the reader folder itself was removed', async () => {
      feed([{ fileId: 'reader', removed: true }]);

      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
      expect(api.listFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe('a feed Drive will not serve this session (a 403): no re-auth, full listings', () => {
    const unavailable = (status: number) =>
      Object.assign(new Error(`changes: ${status}`), {
        status,
        kind: 'other',
        feedUnavailable: true
      });

    it('a 403 from changes.list lists in full, then stops calling the feed', async () => {
      api.listChanges.mockRejectedValueOnce(unavailable(403));

      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
      expect(api.listFiles).toHaveBeenCalledTimes(1);
      // That listing took no position, and neither does the next.
      expect(api.getStartPageToken).not.toHaveBeenCalled();

      // A refresh straight after reuses that listing: no second walk.
      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
      expect(api.listFiles).toHaveBeenCalledTimes(1);

      later(FULL_LISTING_REUSE_MS + 1);
      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
      expect(api.listChanges).toHaveBeenCalledTimes(1);
      expect(api.getStartPageToken).not.toHaveBeenCalled();
      expect(api.listFiles).toHaveBeenCalledTimes(2);
    });

    it('a 403 from changes.getStartPageToken still lists, and the feed stays off', async () => {
      driveFilesCache.clear();
      api.getStartPageToken.mockRejectedValueOnce(unavailable(403));
      await driveFilesCache.fetch();
      expect(driveFilesCache.isLoaded()).toBe(true);
      expect(paths()).toContain('Series A/Volume 1.cbz');
      api.listFiles.mockClear();
      api.getStartPageToken.mockClear();

      // The first sync after that listing (startup) walks nothing again.
      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
      expect(api.listFiles).not.toHaveBeenCalled();

      later(FULL_LISTING_REUSE_MS + 1);
      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
      expect(api.listChanges).not.toHaveBeenCalled();
      expect(api.getStartPageToken).not.toHaveBeenCalled();
      expect(api.listFiles).toHaveBeenCalledTimes(1);
    });

    // A 5xx or rate limit the client did NOT mark (it clears by itself):
    // that call lists in full, the next asks the feed again.
    it('a transient feed failure costs one listing, and the feed resumes', async () => {
      api.listChanges.mockRejectedValueOnce(
        Object.assign(new Error('changes: 503'), { status: 503, kind: 'transient' })
      );
      api.getStartPageToken.mockResolvedValueOnce('token-after');

      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
      expect(api.listFiles).toHaveBeenCalledTimes(1);

      feed([]);
      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
      expect(api.listChanges).toHaveBeenLastCalledWith(
        'token-after',
        expect.any(String),
        MAX_CHANGE_PAGES
      );
      expect(api.listFiles).toHaveBeenCalledTimes(1);
    });

    // Offline wake: the feed read fails and so does the listing it falls back
    // to. The cache is still the exact snapshot at the old position, so the
    // position must survive: back online, ONE feed read catches up, never a
    // whole-account listing.
    it('a listing that fails offline keeps the old position for the next feed read', async () => {
      api.listChanges.mockRejectedValueOnce(new Error('offline'));
      api.listFiles.mockRejectedValueOnce(new Error('offline'));

      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('reset');
      expect(api.listFiles).toHaveBeenCalledTimes(1);

      later(FULL_LISTING_REUSE_MS + 1000);
      feed([]);
      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
      expect(api.listChanges).toHaveBeenLastCalledWith(
        'token-1',
        expect.any(String),
        MAX_CHANGE_PAGES
      );
      expect(api.listFiles).toHaveBeenCalledTimes(1);
    });

    it('the next login (a cache clear) tries the feed again', async () => {
      api.listChanges.mockRejectedValueOnce(unavailable(403));
      await driveFilesCache.refreshFromChanges();

      driveFilesCache.clear();
      api.getStartPageToken.mockClear();
      await driveFilesCache.fetch();
      expect(api.getStartPageToken).toHaveBeenCalledTimes(1);
      feed([]);
      await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
    });
  });

  it('an AUTH failure is rethrown, and no full listing follows it', async () => {
    api.listChanges.mockRejectedValueOnce(
      Object.assign(new Error('Authentication expired'), { status: 401, kind: 'auth' })
    );

    await expect(driveFilesCache.refreshFromChanges()).rejects.toThrow(/Authentication/);
    expect(api.listFiles).not.toHaveBeenCalled();
  });

  it('concurrent callers share one feed read', async () => {
    feed([changed({ ...LISTING[4], size: '101', modifiedTime: T1 })]);

    const [a, b] = await Promise.all([
      driveFilesCache.refreshFromChanges(),
      driveFilesCache.refreshFromChanges()
    ]);

    expect([a, b]).toEqual(['applied', 'applied']);
    expect(api.listChanges).toHaveBeenCalledTimes(1);
  });

  it('a full listing that starts while the feed is read wins: the batch is dropped', async () => {
    let answer!: (value: { changes: DriveChange[]; newStartPageToken: string }) => void;
    api.listChanges.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const refresh = driveFilesCache.refreshFromChanges();
    await Promise.resolve();
    const listing = driveFilesCache.fetch();
    answer({
      changes: [changed({ id: 'late', name: 'Volume 7.cbz', parents: ['series-a'], size: '7' })],
      newStartPageToken: 'token-late'
    });
    await listing;

    await expect(refresh).resolves.toBe('reset');
    expect(driveFilesCache.get('Series A/Volume 7.cbz')).toBeNull();
    // The listing's own position stands; the feed resumes from it.
    feed([]);
    await driveFilesCache.refreshFromChanges();
    expect(api.listChanges).toHaveBeenLastCalledWith('token-1', expect.any(String), 13);
  });

  it('waits for a full listing in flight, then reads the feed from its position', async () => {
    driveFilesCache.clear();
    api.getStartPageToken.mockResolvedValueOnce('token-walk');
    const listing = driveFilesCache.fetch();
    feed([]);

    await expect(driveFilesCache.refreshFromChanges()).resolves.toBe('unchanged');
    await listing;
    expect(api.listFiles).toHaveBeenCalledTimes(1);
    expect(api.listChanges).toHaveBeenCalledWith('token-walk', expect.any(String), 13);
  });
});
