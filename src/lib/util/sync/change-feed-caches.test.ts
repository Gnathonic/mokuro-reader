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
  it('OneDrive has one (Graph delta)', async () => {
    const { onedriveCache } = await import('./providers/onedrive/onedrive-cache');
    expect(typeof onedriveCache.refreshFromChanges).toBe('function');
  });

  it('MEGA, WebDAV and Local Folder have none', async () => {
    const { megaCache } = await import('./providers/mega/mega-cache');
    const { webdavCache } = await import('./providers/webdav/webdav-cache');
    const { filesystemCache } = await import('./providers/filesystem/filesystem-cache');
    for (const cache of [megaCache, webdavCache, filesystemCache]) {
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
});
