import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('../../cache-manager', () => ({
  cacheManager: { clearAll: vi.fn(), registerCache: vi.fn() }
}));

// The REAL cache over the REAL provider singleton and REAL megajs; only MEGA's
// HTTP is fake (mega-fake-server.ts).
import { megaCache } from './mega-cache';
import { megaProvider } from './mega-provider';
import { FakeMegaServer } from './mega-fake-server';
import { folderDeduplicator } from '../../folder-deduplicator';

let server: FakeMegaServer;

beforeEach(() => {
  localStorage.clear();
  megaCache.clear();
  server = new FakeMegaServer().install();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await megaProvider.logout();
  server.uninstall();
});

describe('T2 (V2): megaCache.fetch() while a fetch is already running', () => {
  it('a second caller does not resume until the listing it asked for is in the cache', async () => {
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
    localStorage.setItem('mega_session', JSON.stringify(server.sessionBlob()));
    await megaProvider.restorePersistedSession();
    expect(megaProvider.isAuthenticated()).toBe(true);

    // A catalog open starts a full fetch; MEGA answers slowly.
    const held = server.holdNextFullLoad();
    const first = megaCache.fetch();
    await held.arrived;

    // A backup run's finishing refresh (or a series.json write's fresh
    // listing) asks for the cache meanwhile and reads it once it resumes.
    const seenBySecondCaller = megaCache.fetch().then(() =>
      megaCache
        .getAllFiles()
        .map((f) => f.path)
        .sort()
    );
    await server.flush();
    held.release();
    await first;

    expect(await seenBySecondCaller).toEqual(['Ippo/Ippo 01.cbz']);
  });
});

describe('dedup after a fetch', () => {
  it('a duplicate that never empties does not turn fetch -> dedup -> refetch into a loop', async () => {
    const other = await server.otherDevice();
    server.clock = 1_780_000_000;
    const older = await other.mkdir(server.rootHandle, 'mokuro-reader');
    await other.upload(await other.mkdir(older, 'SeriesA'), 'a.cbz');
    server.clock = 1_790_000_000;
    const newer = await other.mkdir(server.rootHandle, 'mokuro-reader');
    await other.upload(await other.mkdir(newer, 'SeriesB'), 'b.cbz');
    localStorage.setItem('mega_session', JSON.stringify(server.sessionBlob()));
    await megaProvider.restorePersistedSession();
    // The server keeps reporting nodes in the duplicate (a device writing there).
    vi.spyOn(megaProvider as any, 'serverFolderContentCount').mockResolvedValue(1);
    const runs = vi.spyOn(folderDeduplicator, 'deduplicateAll');

    await megaCache.fetch(true);
    await vi.waitFor(() => expect(runs).toHaveBeenCalledTimes(3), { timeout: 3000 });
    await Promise.allSettled(runs.mock.results.map((r) => r.value));
    await server.flush(50);
    await new Promise((r) => setTimeout(r, 200));

    // The first run and two refetches' runs, then it waits for the next fetch.
    expect(runs).toHaveBeenCalledTimes(3);
    expect(megaCache.isFetching()).toBe(false);
  });
});
