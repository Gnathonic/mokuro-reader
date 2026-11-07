import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { CloudCache } from '../cloud-cache-interface';
import type { CloudFileMetadata, ProviderType } from '../provider-interface';

// The caches that install a provider's whole listing in one swap. Each
// listing is held open by the test, so a write lands exactly where it does in
// a real sync: after the walk read the folder, before the swap.
const h = vi.hoisted(() => {
  const list = vi.fn<() => Promise<CloudFileMetadata[]>>();
  return {
    list,
    provider: {
      isAuthenticated: () => true,
      listCloudVolumes: list,
      // OneDrive's walk, with the folder map its change feed resumes from
      // (none here: the feed is onedrive-change-feed.test.ts's).
      listLibrary: async () => ({ files: await list(), folders: new Map(), rootId: null }),
      getFolderOperations: () => ({})
    }
  };
});

vi.mock('./onedrive/onedrive-provider', () => ({ onedriveProvider: h.provider }));
// OneDrive takes its change-feed position before each walk.
vi.mock('./onedrive/token-manager', () => ({
  onedriveTokenManager: { getAccessToken: async () => 'TOKEN' }
}));
vi.mock('./onedrive/graph-client', () => ({
  startDelta: async () => 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=0',
  readDelta: async () => 'resync'
}));
vi.mock('./webdav/webdav-provider', () => ({ webdavProvider: h.provider }));
vi.mock('./filesystem/filesystem-provider', () => ({ filesystemProvider: h.provider }));
vi.mock('./mega/mega-provider', () => ({ megaProvider: h.provider }));
// MEGA dedups after every listing; nothing here to merge.
vi.mock('../folder-deduplicator', () => ({
  folderDeduplicator: { deduplicateAll: async () => ({ groupsMerged: 0 }) }
}));

import { onedriveCache } from './onedrive/onedrive-cache';
import { webdavCache } from './webdav/webdav-cache';
import { filesystemCache } from './filesystem/filesystem-cache';
import { megaCache } from './mega/mega-cache';

let provider: ProviderType = 'onedrive';
const file = (
  path: string,
  fileId: string,
  stamp: Partial<CloudFileMetadata> = {}
): CloudFileMetadata => ({
  provider,
  fileId,
  path,
  modifiedTime: '2026-10-30T00:00:00.000Z',
  size: 10,
  ...stamp
});

function heldListing(): (files: CloudFileMetadata[]) => void {
  let release!: (files: CloudFileMetadata[]) => void;
  h.list.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
  return (files) => release(files);
}

describe.each([
  ['onedrive', onedriveCache],
  ['webdav', webdavCache],
  ['filesystem', filesystemCache],
  ['mega', megaCache]
] as [ProviderType, CloudCache<CloudFileMetadata>][])('%s listing cache', (name, cache) => {
  beforeEach(() => {
    h.list.mockReset();
    cache.clear();
    provider = name;
  });

  /** A first listing, finished: the cache holds these records as the server's. */
  async function listed(files: CloudFileMetadata[]): Promise<void> {
    h.list.mockResolvedValueOnce(files);
    await cache.fetch();
  }

  // Ids outlive an overwrite (OneDrive keeps the item, WebDAV and Local
  // Folder key by path): a walk that read the folder after another device
  // wrote over this upload holds the newer revision under the same id.
  const older = { modifiedTime: '2026-10-30T00:00:00.000Z', size: 10 };
  const theirs = { modifiedTime: '2026-10-30T00:00:05.000Z', size: 42 };

  it("keeps another device's overwrite the walk read after this upload", async () => {
    await listed([file('volume-data.json', 'V1', older)]);
    const finish = heldListing();
    const fetched = cache.fetch();
    cache.add!('volume-data.json', {
      ...file('volume-data.json', 'V1', { size: 20, modifiedTime: '2026-10-30T00:00:03.000Z' }),
      modifiedTimeProvisional: true
    });
    finish([file('volume-data.json', 'V1', theirs)]);
    await fetched;

    expect(cache.getAll('volume-data.json')).toMatchObject([theirs]);
  });

  it('takes the upload over the revision the walk read before it', async () => {
    await listed([file('volume-data.json', 'V1', older)]);
    const finish = heldListing();
    const fetched = cache.fetch();
    const mine = { size: 20, modifiedTime: '2026-10-30T00:00:03.000Z' };
    cache.add!('volume-data.json', {
      ...file('volume-data.json', 'V1', mine),
      modifiedTimeProvisional: true
    });
    cache.add!('volume-data.json', {
      ...file('volume-data.json', 'V1', { size: 21 }),
      modifiedTimeProvisional: true
    });
    finish([file('volume-data.json', 'V1', older)]);
    await fetched;

    expect(cache.getAll('volume-data.json')).toMatchObject([{ size: 21 }]);
  });

  it('keeps a file re-created at a deleted path the walk read after the delete', async () => {
    await listed([file('Series/Vol 1.cbz', 'C1', older)]);
    const finish = heldListing();
    const fetched = cache.fetch();
    cache.removeById!('C1');
    finish([file('Series/Vol 1.cbz', 'C1', theirs)]);
    await fetched;

    expect(cache.getAll('Series/Vol 1.cbz')).toMatchObject([theirs]);
  });

  it('a fetch after a clear() lists again instead of joining the dead listing', async () => {
    const finishDead = heldListing();
    const dead = cache.fetch();
    cache.clear();
    const finish = heldListing();
    const fetched = cache.fetch();
    // OneDrive walks once its change-feed position is in: not synchronously.
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    expect(get(cache.isFetchingState!)).toBe(true);

    finish([file('volume-data.json', 'V2')]);
    await fetched;
    finishDead([file('volume-data.json', 'V1')]);
    await dead;

    expect(cache.getAllFiles().map((f) => f.fileId)).toEqual(['V2']);
    expect(cache.isLoaded()).toBe(true);
    expect(get(cache.isFetchingState!)).toBe(false);
  });

  it('keeps a root file uploaded while a listing was in flight', async () => {
    // The walk read the root before the first volume-data.json went up: a
    // sync after the swap would find no cloud copy and write over it unread.
    const finish = heldListing();
    const fetched = cache.fetch();
    cache.add!('volume-data.json', {
      ...file('volume-data.json', 'V1'),
      modifiedTimeProvisional: true
    });
    finish([file('profiles.json', 'R1'), file('Series/Vol 1.cbz', 'C1')]);
    await fetched;

    expect(cache.getAll('volume-data.json').map((f) => f.fileId)).toEqual(['V1']);
    expect(cache.get('profiles.json')?.fileId).toBe('R1');
  });

  it('keeps a delete made while a listing was in flight', async () => {
    const finish = heldListing();
    const fetched = cache.fetch();
    cache.removeById!('C1');
    finish([file('Series/Vol 1.cbz', 'C1'), file('volume-data.json', 'V1')]);
    await fetched;

    expect(cache.has('Series/Vol 1.cbz')).toBe(false);
    expect(cache.has('volume-data.json')).toBe(true);
  });

  it('a fetch while one is in flight resolves once that listing is in', async () => {
    const finish = heldListing();
    const first = cache.fetch();
    let joined = false;
    const second = cache.fetch().then(() => (joined = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(joined, 'resolved before the listing it joined').toBe(false);

    finish([file('volume-data.json', 'V1')]);
    await Promise.all([first, second]);
    expect(cache.get('volume-data.json')?.fileId).toBe('V1');
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it('a listing that ends after a clear() installs nothing', async () => {
    const finish = heldListing();
    const fetched = cache.fetch();
    cache.clear();
    finish([file('volume-data.json', 'V1')]);
    await fetched;

    expect(cache.getAllFiles()).toEqual([]);
    expect(cache.isLoaded()).toBe(false);
  });
});

// `history/` alone, between full listings (history-listing-refresh.ts): the
// caches of the providers without a change feed.
describe.each([
  ['webdav', webdavCache],
  ['filesystem', filesystemCache]
] as [ProviderType, CloudCache<CloudFileMetadata>][])('%s history patch', (name, cache) => {
  const OWN = 'dev-own';
  const seg = (device: string, month: string, stamp: Partial<CloudFileMetadata> = {}) =>
    file(`history/${device}/${month}.events`, `/mokuro-reader/history/${device}/${month}`, stamp);

  beforeEach(() => {
    h.list.mockReset();
    cache.clear();
    provider = name;
  });

  async function listed(files: CloudFileMetadata[]): Promise<void> {
    h.list.mockResolvedValueOnce(files);
    await cache.fetch();
  }

  it("replaces other devices' entries and keeps this device's own newer receipts", async () => {
    await listed([
      seg('dev-a', '2026-10'),
      seg('dev-gone', '2026-09'),
      seg(OWN, '2026-11', { size: 5 }),
      // A series that happens to be called "history" is not history.
      file('history/Vol 1.cbz', 'CBZ'),
      file('volume-data.json', 'V1')
    ]);
    const patch = cache.beginHistoryPatch!();
    // This device's upload lands while the PROPFIND runs: its receipt is newer.
    cache.add!(seg(OWN, '2026-11').path, {
      ...seg(OWN, '2026-11', { size: 9, modifiedTime: '2026-11-07T10:00:00.000Z' }),
      modifiedTimeProvisional: false
    });

    expect(
      patch.apply(
        [
          seg('dev-a', '2026-10', { size: 30, modifiedTime: '2026-11-07T09:00:00.000Z' }),
          seg('dev-a', '2026-11'),
          seg('dev-b', '2026-11'),
          seg(OWN, '2026-11', { size: 5 }), // the PROPFIND's older view of this device's month
          file(`history/${OWN}/device.json`, 'OWN-FACTS') // on the server, not held
        ],
        OWN
      )
    ).toBe('applied');

    const byPath = new Map(cache.getAllFiles().map((f) => [f.path, f]));
    expect(byPath.get('history/dev-a/2026-10.events')).toMatchObject({ size: 30 });
    expect(byPath.has('history/dev-a/2026-11.events')).toBe(true);
    expect(byPath.has('history/dev-b/2026-11.events')).toBe(true);
    expect(byPath.has('history/dev-gone/2026-09.events'), 'removed remotely').toBe(false);
    expect(byPath.get(`history/${OWN}/2026-11.events`)).toMatchObject({ size: 9 });
    expect(byPath.has(`history/${OWN}/device.json`)).toBe(true);
    expect(byPath.has('history/Vol 1.cbz')).toBe(true);
    expect(byPath.has('volume-data.json')).toBe(true);
  });

  it('a listing that changes nothing keeps the cache identity and publishes nothing', async () => {
    await listed([seg('dev-a', '2026-10'), seg(OWN, '2026-10')]);
    const before = cache.revision!();
    const patch = cache.beginHistoryPatch!();
    // The listing need not hold this device's own files, nor in the same order.
    expect(patch.apply([seg('dev-a', '2026-10')], OWN)).toBe('unchanged');
    expect(cache.revision!()).toBe(before);
    expect((cache.store as unknown as { hasPendingPublish(): boolean }).hasPendingPublish()).toBe(
      false
    );
  });

  it('a patch applied while a full listing is in flight yields to that walk', async () => {
    await listed([seg('dev-a', '2026-10')]);
    const finish = heldListing();
    const fetched = cache.fetch();
    const patch = cache.beginHistoryPatch!();
    expect(patch.apply([seg('dev-a', '2026-10'), seg('dev-a', '2026-11')], OWN)).toBe('applied');
    expect(cache.has('history/dev-a/2026-11.events')).toBe(true);
    // The walk read history/ itself: its view wins, whichever is newer.
    finish([seg('dev-a', '2026-10', { size: 77 })]);
    await fetched;

    expect(cache.getAllFiles()).toMatchObject([{ path: 'history/dev-a/2026-10.events', size: 77 }]);
  });

  it('a patch begun before a full install or a clear installs nothing', async () => {
    await listed([seg('dev-a', '2026-10')]);
    const beforeInstall = cache.beginHistoryPatch!();
    await listed([seg('dev-a', '2026-10'), file('volume-data.json', 'V1')]);
    expect(beforeInstall.apply([seg('dev-a', '2026-11')], OWN)).toBe('superseded');
    expect(cache.has('history/dev-a/2026-11.events')).toBe(false);

    const beforeClear = cache.beginHistoryPatch!();
    cache.clear();
    expect(beforeClear.apply([seg('dev-a', '2026-11')], OWN)).toBe('superseded');
    expect(cache.getAllFiles()).toEqual([]);
  });

  it('reports when its last full listing was installed', async () => {
    expect(cache.beginHistoryPatch!().listedAt).toBe(0);
    const before = Date.now();
    await listed([]);
    expect(cache.beginHistoryPatch!().listedAt).toBeGreaterThanOrEqual(before);
    cache.clear();
    expect(cache.beginHistoryPatch!().listedAt).toBe(0);
  });
});

describe('caches with a change feed or a live tree take no history patch', () => {
  it.each([
    ['onedrive', onedriveCache],
    ['mega', megaCache]
  ] as [string, CloudCache][])('%s', (_name, cache) => {
    expect('beginHistoryPatch' in cache).toBe(false);
  });
});
