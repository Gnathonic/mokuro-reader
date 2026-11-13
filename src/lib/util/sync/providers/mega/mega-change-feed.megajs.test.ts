import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('../../cache-manager', () => ({
  cacheManager: { clearAll: vi.fn(), registerCache: vi.fn() }
}));

// MEGA's change feed (#288) is the sc push stream: megajs applies every
// change made anywhere on the account to the session's tree as the server
// pushes it. `megaCache.refreshFromChanges` brings the listing current from
// that tree — no request — and loads the whole tree again only when the
// stream is not running. The REAL cache over the REAL provider singleton and
// REAL megajs; only MEGA's HTTP is fake (mega-fake-server.ts).
import { CHANGE_FEED_MAX_AGE_MS, megaCache } from './mega-cache';
import { megaProvider, SC_PROBE_TIMEOUT_MS, SC_QUIET_MS } from './mega-provider';
import { CLIENT_SID, FakeMegaServer } from './mega-fake-server';

let server: FakeMegaServer;

beforeEach(() => {
  localStorage.clear();
  megaCache.clear();
  server = new FakeMegaServer().install();
});

afterEach(async () => {
  megaProvider.scQuietMs = SC_QUIET_MS;
  megaProvider.scProbeTimeoutMs = SC_PROBE_TIMEOUT_MS;
  vi.restoreAllMocks();
  await megaProvider.logout();
  server.uninstall();
});

/** This device, restored from its stored session, with its listing loaded. */
async function listedSession(): Promise<void> {
  localStorage.setItem('mega_session', JSON.stringify(server.sessionBlob()));
  await megaProvider.restorePersistedSession();
  expect(megaProvider.isAuthenticated()).toBe(true);
  await megaCache.fetch(true);
  expect(megaCache.isLoaded()).toBe(true);
}

/** Full tree loads (`a:'f'` without `n`) this device has asked for. */
const fullLoads = () =>
  server.requests.filter((r) => r.sid === CLIENT_SID && r.body.a === 'f' && !r.body.n).length;

/** Every API request this device sent (the sc long-poll is not one). */
const ownRequests = () => server.requests.filter((r) => r.sid === CLIENT_SID).length;

const paths = () =>
  megaCache
    .getAllFiles()
    .map((f) => f.path)
    .sort();

describe('megaCache.refreshFromChanges (the sc push stream)', () => {
  it("lists another device's upload from the pushed tree, with no request", async () => {
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
    await listedSession();
    const loadsBefore = fullLoads();
    const requestsBefore = ownRequests();

    await (await server.otherDevice()).put('mokuro-reader/history/dev-b/2026-11.events');
    await server.flush();

    expect(await megaCache.refreshFromChanges()).toBe('applied');
    expect(paths()).toEqual(['Ippo/Ippo 01.cbz', 'history/dev-b/2026-11.events']);
    expect(fullLoads()).toBe(loadsBefore);
    expect(ownRequests()).toBe(requestsBefore);
  });

  it('answers unchanged, and leaves the listing alone, when the tree has not moved', async () => {
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
    await listedSession();
    await server.flush();
    await megaCache.refreshFromChanges();
    const revision = megaCache.revision();

    expect(await megaCache.refreshFromChanges()).toBe('unchanged');
    expect(megaCache.revision()).toBe(revision);
  });

  it("drops another device's delete", async () => {
    const other = await server.otherDevice();
    await other.put('mokuro-reader/Ippo/Ippo 01.cbz');
    const gone = await other.put('mokuro-reader/Ippo/Ippo 02.cbz');
    await listedSession();
    expect(paths()).toEqual(['Ippo/Ippo 01.cbz', 'Ippo/Ippo 02.cbz']);

    await (await server.otherDevice()).delete(gone);
    await server.flush();

    expect(await megaCache.refreshFromChanges()).toBe('applied');
    expect(paths()).toEqual(['Ippo/Ippo 01.cbz']);
  });

  it('loads the whole tree again when the stream is not running, and the stream with it', async () => {
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
    await listedSession();
    // The poll died and gave up recovering: nothing reaches the tree now.
    (megaProvider as unknown as { stopServerChanges: () => void }).stopServerChanges();
    expect(megaProvider.hasLiveServerChanges()).toBe(false);
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 02.cbz');
    await server.flush();
    const loadsBefore = fullLoads();

    expect(await megaCache.refreshFromChanges()).toBe('reset');
    expect(fullLoads()).toBe(loadsBefore + 1);
    expect(paths()).toEqual(['Ippo/Ippo 01.cbz', 'Ippo/Ippo 02.cbz']);
    expect(megaProvider.hasLiveServerChanges()).toBe(true);
  });

  it('rejects when the reload did not bring the stream back (a writer must not prune)', async () => {
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
    await listedSession();
    (megaProvider as unknown as { stopServerChanges: () => void }).stopServerChanges();
    // The reload fails transiently, which keeps the old (frozen) tree.
    vi.spyOn(
      megaProvider as unknown as { refreshTree: () => Promise<void> },
      'refreshTree'
    ).mockRejectedValue(new Error('Failed to fetch'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(megaCache.refreshFromChanges()).rejects.toThrow(/could not be brought current/);
    expect(paths()).toEqual(['Ippo/Ippo 01.cbz']);
  });

  // megajs puts no timeout on the long-poll: one left on a half-open
  // connection (a laptop that slept) never settles and never errors, so
  // "the poll runs" alone would vouch for a frozen tree forever — and a
  // metadata writer would prune another device's new volumes against it.
  describe('a poll that has gone quiet', () => {
    /** Every poll counts as quiet: each refresh probes it. */
    const quiet = () => {
      megaProvider.scQuietMs = 0;
    };

    it('is probed by restarting it, which brings in what the hung one missed', async () => {
      await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
      await listedSession();
      server.hangPolls(); // the open poll sits on a dead connection
      await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 02.cbz');
      await server.flush();
      expect(paths()).toEqual(['Ippo/Ippo 01.cbz']); // never reached this tree
      quiet();
      const loadsBefore = fullLoads();

      expect(await megaCache.refreshFromChanges()).toBe('applied');
      expect(paths()).toEqual(['Ippo/Ippo 01.cbz', 'Ippo/Ippo 02.cbz']);
      expect(fullLoads()).toBe(loadsBefore);
      expect(server.openPolls()).toBe(1); // the hung one was aborted, not stacked
    });

    it('costs one sc request on a quiet, healthy account, and no reload', async () => {
      server.waitWhenCaughtUp = true; // real MEGA: a caught-up poll gets a wait URL
      await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
      await listedSession();
      await server.flush();
      await megaCache.refreshFromChanges();
      quiet();
      const loadsBefore = fullLoads();
      const pollsBefore = server.scPolls;
      const revision = megaCache.revision();

      expect(await megaCache.refreshFromChanges()).toBe('unchanged');
      expect(server.scPolls).toBe(pollsBefore + 1);
      expect(fullLoads()).toBe(loadsBefore);
      expect(megaCache.revision()).toBe(revision);
    });

    it('loads the whole tree again when the restarted poll does not answer either', async () => {
      await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
      await listedSession();
      server.hangPolls(undefined, { newOnesToo: true });
      await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 02.cbz');
      await server.flush();
      quiet();
      megaProvider.scProbeTimeoutMs = 20;
      const loadsBefore = fullLoads();

      expect(await megaCache.refreshFromChanges()).toBe('reset');
      expect(fullLoads()).toBe(loadsBefore + 1);
      expect(paths()).toEqual(['Ippo/Ippo 01.cbz', 'Ippo/Ippo 02.cbz']);
    });
  });

  it('loads the whole tree again once a day, whatever the stream says', async () => {
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
    await listedSession();
    const loadedAt = megaProvider.treeLoadedAt();
    expect(loadedAt).toBeGreaterThan(0);
    const loadsBefore = fullLoads();
    vi.spyOn(Date, 'now').mockReturnValue(loadedAt + CHANGE_FEED_MAX_AGE_MS + 1);

    expect(await megaCache.refreshFromChanges()).toBe('reset');
    expect(fullLoads()).toBe(loadsBefore + 1);
  });

  it('rejects when the tree moved and no rebuild could be installed', async () => {
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
    await listedSession();
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 02.cbz');
    await server.flush();
    // Every rebuild fails transiently (each fetch logs and swallows its error).
    vi.spyOn(megaProvider, 'listCloudVolumes').mockRejectedValue(new Error('Failed to fetch'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(megaCache.refreshFromChanges()).rejects.toThrow(/could not be brought current/);
  });
});
