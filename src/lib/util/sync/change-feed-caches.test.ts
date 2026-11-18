/**
 * Which listing caches have a change feed (`CloudCache.refreshFromChanges`).
 * The sync and the metadata writers gate the feed on the method alone
 * (`unified-sync-service.ts`, `unified-cloud-manager.ts`), never on the
 * provider type, so a cache that gained one by accident would start being
 * asked — and one that lost it would quietly go back to walking.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./providers/mega/mega-provider', () => ({ megaProvider: {} }));
vi.mock('./providers/webdav/webdav-provider', () => ({ webdavProvider: {} }));
vi.mock('./providers/filesystem/filesystem-provider', () => ({ filesystemProvider: {} }));
vi.mock('./providers/onedrive/onedrive-provider', () => ({ onedriveProvider: {} }));

describe('change feeds by cache', () => {
  it('OneDrive (Graph delta) and MEGA (the sc push stream) have one', async () => {
    const { onedriveCache } = await import('./providers/onedrive/onedrive-cache');
    const { megaCache } = await import('./providers/mega/mega-cache');
    expect(typeof onedriveCache.refreshFromChanges).toBe('function');
    expect(typeof megaCache.refreshFromChanges).toBe('function');
  });

  it('WebDAV and Local Folder have none', async () => {
    const { webdavCache } = await import('./providers/webdav/webdav-cache');
    const { filesystemCache } = await import('./providers/filesystem/filesystem-cache');
    for (const cache of [webdavCache, filesystemCache]) {
      expect('refreshFromChanges' in cache).toBe(false);
    }
  });

  it('WebDAV and Local Folder patch history/ instead — never a feed (history-listing-refresh.ts)', async () => {
    const { webdavCache } = await import('./providers/webdav/webdav-cache');
    const { filesystemCache } = await import('./providers/filesystem/filesystem-cache');
    const { onedriveCache } = await import('./providers/onedrive/onedrive-cache');
    const { megaCache } = await import('./providers/mega/mega-cache');
    const { driveFilesCache } = await import('./providers/google-drive/drive-files-cache');
    for (const cache of [webdavCache, filesystemCache]) {
      expect(typeof cache.beginHistoryPatch).toBe('function');
    }
    for (const cache of [driveFilesCache, onedriveCache, megaCache]) {
      expect('beginHistoryPatch' in cache).toBe(false);
    }
  });

  it("the scoped series pull reads a feed only where it never falls back to a whole-library listing: Drive's", async () => {
    // `unifiedCloudManager.refreshSeriesFolder` (queue file v2) takes the feed
    // when `changeFeedUsable()` says so, else lists the one folder. OneDrive's
    // delta falls back to a walk (one request per folder) and MEGA's sc feed
    // to a full tree load — the scoped pull must never cost either, and their
    // one-folder listing is as cheap (MEGA's filters the tree: no request).
    const { webdavCache } = await import('./providers/webdav/webdav-cache');
    const { filesystemCache } = await import('./providers/filesystem/filesystem-cache');
    const { onedriveCache } = await import('./providers/onedrive/onedrive-cache');
    const { megaCache } = await import('./providers/mega/mega-cache');
    const { driveFilesCache } = await import('./providers/google-drive/drive-files-cache');
    expect(typeof driveFilesCache.changeFeedUsable).toBe('function');
    for (const cache of [onedriveCache, megaCache, webdavCache, filesystemCache]) {
      expect('changeFeedUsable' in cache).toBe(false);
    }
    for (const cache of [driveFilesCache, onedriveCache, megaCache, webdavCache, filesystemCache]) {
      expect(typeof cache.replaceFolderEntries).toBe('function');
    }
  });
});
