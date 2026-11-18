/**
 * The throttled `history/` listing for providers without a change feed
 * (#288), against the real WebDAV and Local Folder caches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudCache } from './cloud-cache-interface';
import type { CloudFileMetadata, ProviderType, SyncProvider } from './provider-interface';

const h = vi.hoisted(() => ({
  listCloudVolumes: vi.fn<() => Promise<CloudFileMetadata[]>>(),
  provider: {} as Record<string, unknown>
}));
vi.mock('./providers/webdav/webdav-provider', () => ({ webdavProvider: h.provider }));
vi.mock('./providers/filesystem/filesystem-provider', () => ({ filesystemProvider: h.provider }));

import { webdavCache } from './providers/webdav/webdav-cache';
import { filesystemCache } from './providers/filesystem/filesystem-cache';
import {
  HISTORY_REFRESH_MS,
  _setHistoryRefreshIntervalForTests,
  refreshHistoryListing
} from './history-listing-refresh';

const OWN = 'dev-own';
let type: ProviderType = 'webdav';
const seg = (device: string, month: string, stamp: Partial<CloudFileMetadata> = {}) => ({
  provider: type,
  fileId: `history/${device}/${month}.events`,
  path: `history/${device}/${month}.events`,
  modifiedTime: '2026-11-01T00:00:00.000Z',
  size: 10,
  ...stamp
});

describe.each([
  ['webdav', webdavCache],
  ['filesystem', filesystemCache]
] as [ProviderType, CloudCache<CloudFileMetadata>][])('%s', (name, cache) => {
  let listFolder: ReturnType<typeof vi.fn<(folder: string) => Promise<CloudFileMetadata[]>>>;
  let status: { historySync?: boolean; serverCompilesMetadata?: boolean };
  let provider: SyncProvider;
  const own = async () => OWN;

  beforeEach(async () => {
    type = name;
    _setHistoryRefreshIntervalForTests();
    // By default the server holds what the full listing showed.
    listFolder = vi.fn(async () => [seg('dev-a', '2026-10'), seg(OWN, '2026-11')]);
    status = {};
    Object.assign(h.provider, {
      isAuthenticated: () => true,
      listCloudVolumes: h.listCloudVolumes
    });
    provider = {
      type: name,
      listFolder,
      getStatus: () => status,
      listCloudVolumes: h.listCloudVolumes
    } as unknown as SyncProvider;
    cache.clear();
    h.listCloudVolumes.mockReset();
    h.listCloudVolumes.mockResolvedValue([seg('dev-a', '2026-10'), seg(OWN, '2026-11')]);
    await cache.fetch();
  });

  afterEach(() => _setHistoryRefreshIntervalForTests());

  it("imports another device's new month mid-session without a full listing", async () => {
    const later = Date.now() + HISTORY_REFRESH_MS;
    listFolder.mockResolvedValueOnce([
      seg('dev-a', '2026-10'),
      seg('dev-a', '2026-11'),
      seg(OWN, '2026-11'),
      // listFolder returns every syncable file under the folder; only history counts.
      { ...seg('dev-a', 'x'), path: 'history/dev-a/notes.json' }
    ]);

    expect(await refreshHistoryListing(provider, cache, own, later)).toBe('applied');

    expect(listFolder).toHaveBeenCalledExactlyOnceWith('history');
    expect(h.listCloudVolumes, 'no full walk').toHaveBeenCalledTimes(1);
    expect(cache.has('history/dev-a/2026-11.events')).toBe(true);
    expect(cache.has('history/dev-a/notes.json')).toBe(false);
  });

  it('lists history/ at most once per interval', async () => {
    const t0 = Date.now() + HISTORY_REFRESH_MS;
    expect(await refreshHistoryListing(provider, cache, own, t0)).toBe('unchanged');
    expect(await refreshHistoryListing(provider, cache, own, t0 + 1_000)).toBe('not-due');
    expect(await refreshHistoryListing(provider, cache, own, t0 + HISTORY_REFRESH_MS - 1)).toBe(
      'not-due'
    );
    expect(listFolder).toHaveBeenCalledTimes(1);
    expect(await refreshHistoryListing(provider, cache, own, t0 + HISTORY_REFRESH_MS)).toBe(
      'unchanged'
    );
    expect(listFolder).toHaveBeenCalledTimes(2);
  });

  it('is not due while the last full listing is younger than the interval', async () => {
    // beforeEach's listing just installed.
    expect(await refreshHistoryListing(provider, cache, own)).toBe('not-due');
    expect(listFolder).not.toHaveBeenCalled();
  });

  it('a failed listing leaves the cache as it was and still waits out the interval', async () => {
    const t0 = Date.now() + HISTORY_REFRESH_MS;
    const before = cache.revision!();
    listFolder.mockRejectedValueOnce(new Error('503'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await refreshHistoryListing(provider, cache, own, t0)).toBe('failed');
    expect(cache.revision!()).toBe(before);
    expect(cache.getAllFiles().map((f) => f.path)).toEqual([
      'history/dev-a/2026-10.events',
      `history/${OWN}/2026-11.events`
    ]);
    expect(await refreshHistoryListing(provider, cache, own, t0 + 1_000)).toBe('not-due');
    expect(listFolder).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a listing that finishes after a sign-out installs nothing', async () => {
    let release!: (files: CloudFileMetadata[]) => void;
    listFolder.mockReturnValueOnce(new Promise((r) => (release = r)));
    const run = refreshHistoryListing(provider, cache, own, Date.now() + HISTORY_REFRESH_MS);
    cache.clear();
    release([seg('dev-a', '2026-11')]);

    expect(await run).toBe('superseded');
    expect(cache.getAllFiles()).toEqual([]);
  });

  it('does nothing where the server cannot keep history per user', async () => {
    status = { serverCompilesMetadata: true };
    expect(await refreshHistoryListing(provider, cache, own, Date.now() + HISTORY_REFRESH_MS)).toBe(
      'off'
    );
    expect(listFolder).not.toHaveBeenCalled();
  });

  it('needs the provider to list one folder', async () => {
    const { listFolder: _omit, ...without } = provider as unknown as Record<string, unknown>;
    expect(
      await refreshHistoryListing(
        without as unknown as SyncProvider,
        cache,
        own,
        Date.now() + HISTORY_REFRESH_MS
      )
    ).toBe('unsupported');
  });
});

it('a cache without a history patch is never listed (Drive, OneDrive, MEGA)', async () => {
  const listFolder = vi.fn(async () => []);
  const provider = { type: 'mega', listFolder, getStatus: () => ({}) } as unknown as SyncProvider;
  const cache = { getAllFiles: () => [] } as unknown as CloudCache;
  expect(await refreshHistoryListing(provider, cache, async () => OWN, Date.now() * 2)).toBe(
    'unsupported'
  );
  expect(listFolder).not.toHaveBeenCalled();
});
