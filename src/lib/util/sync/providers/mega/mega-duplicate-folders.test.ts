import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('./mega-cache', () => ({ megaCache: { fetch: vi.fn(async () => {}) } }));
vi.mock('../../cache-manager', () => ({
  cacheManager: { clearAll: vi.fn(), registerCache: vi.fn() }
}));

import { MegaProvider } from './mega-provider';
import { folderDeduplicator } from '../../folder-deduplicator';
import { CLIENT_SID, FakeMegaServer } from './mega-fake-server';

// Duplicate `mokuro-reader` roots on MEGA, reproduced against REAL megajs over
// a fake MEGA backend (mega-fake-server.ts): the library's own request, sc
// long-poll, reload and tree import all run; only the HTTP is fake. Every
// assertion is about what ends up on the server or in the listing — what the
// user sees in MEGA and in the reader — not about how the provider gets there.

let server: FakeMegaServer;
let providers: MegaProvider[] = [];

beforeEach(() => {
  localStorage.clear();
  server = new FakeMegaServer().install();
  providers = [];
});

afterEach(async () => {
  for (const provider of providers) await provider.logout();
  server.uninstall();
});

/**
 * This device's provider, restored from its stored session the way the app
 * does on load. `loginBorn` makes it the Storage a fresh interactive login
 * leaves behind (megajs only marks a Storage 'ready' from login()).
 */
async function restoredProvider({ loginBorn = false } = {}): Promise<MegaProvider> {
  localStorage.setItem('mega_session', JSON.stringify(server.sessionBlob()));
  const provider = new MegaProvider();
  providers.push(provider);
  await provider.whenReady();
  expect(provider.isAuthenticated()).toBe(true);
  if (loginBorn) (provider as any).storage.status = 'ready';
  return provider;
}

const bytes = (text = 'payload') => Uint8Array.from(new TextEncoder().encode(text));

/** The library as the reader lists it, without forcing a reload. */
async function listed(provider: MegaProvider): Promise<string[]> {
  return (await provider.listCloudVolumes(true)).map((f) => f.path).sort();
}

describe('fake MEGA backend (harness sanity)', () => {
  it('a restored session lists a library another device uploaded, and uploads land on the server', async () => {
    const other = await server.otherDevice();
    await other.put('mokuro-reader/Ippo/Ippo 01.cbz');
    await other.put('mokuro-reader/volume-data.json', '{}');

    const provider = await restoredProvider();
    expect(await listed(provider)).toEqual(['Ippo/Ippo 01.cbz', 'volume-data.json']);

    await provider.uploadFile('Ippo/Ippo 02.cbz', bytes());
    const tree = await server.tree();
    expect(tree.paths()).toEqual([
      'mokuro-reader',
      'mokuro-reader/Ippo',
      'mokuro-reader/Ippo/Ippo 01.cbz',
      'mokuro-reader/Ippo/Ippo 02.cbz',
      'mokuro-reader/volume-data.json'
    ]);
  });

  it('downloads a file another device uploaded, content intact', async () => {
    const other = await server.otherDevice();
    await other.put('mokuro-reader/volume-data.json', '{"vol":{"progress":7}}');
    const provider = await restoredProvider();

    const [file] = await provider.listCloudVolumes(true);
    const blob = await provider.downloadFile(file);

    expect(await blob.text()).toBe('{"vol":{"progress":7}}');
  });

  it("applies another device's changes through the sc stream", async () => {
    const other = await server.otherDevice();
    await other.put('mokuro-reader/Ippo/Ippo 01.cbz');
    const provider = await restoredProvider();

    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 02.cbz');
    await server.flush();

    expect(await listed(provider)).toEqual(['Ippo/Ippo 01.cbz', 'Ippo/Ippo 02.cbz']);
    expect(server.openPolls()).toBe(1);
  });
});

describe('T1 (V1): a tree reload must never leave a window where the library looks absent', () => {
  it('uploads made while the reload is in flight go into the existing library — one root, no duplicates', async () => {
    const other = await server.otherDevice();
    await other.put('mokuro-reader/SeriesA/a.cbz');
    const provider = await restoredProvider({ loginBorn: true });

    // A catalog refresh reloads the tree; MEGA answers slowly.
    const held = server.holdNextFullLoad();
    const listing = provider.listCloudVolumes(false);
    await held.arrived;

    // Meanwhile a backup run uploads progress and a new series.
    const progress = provider.uploadFile('volume-data.json', bytes('{}'));
    const volume = provider.uploadFile('SeriesB/x.cbz', bytes());
    await server.flush();
    held.release();
    await Promise.allSettled([listing, progress, volume]);

    const tree = await server.tree();
    expect(tree.paths()).toEqual([
      'mokuro-reader',
      'mokuro-reader/SeriesA',
      'mokuro-reader/SeriesA/a.cbz',
      'mokuro-reader/SeriesB',
      'mokuro-reader/SeriesB/x.cbz',
      'mokuro-reader/volume-data.json'
    ]);
  });
});

describe('T3 (V3): a restored session can create the library folder', () => {
  it('the first upload on an account with no mokuro-reader folder creates it and succeeds', async () => {
    // A page reload restores the session from the stored token (no login).
    const provider = await restoredProvider();

    await expect(provider.uploadFile('volume-data.json', bytes('{}'))).resolves.toMatchObject({
      fileId: expect.any(String)
    });

    const tree = await server.tree();
    expect(tree.paths()).toEqual(['mokuro-reader', 'mokuro-reader/volume-data.json']);
  });
});

describe('T4 (V4): reloading the tree does not multiply the server-change stream', () => {
  async function libraryReloadedTwice() {
    const other = await server.otherDevice();
    // 'Other' is a non-library folder beside the library at the Cloud Drive root.
    await other.mkdir(server.rootHandle, 'Other');
    await other.put('mokuro-reader/SeriesA/a.cbz');
    await other.put('mokuro-reader/SeriesB/b.cbz');
    await other.put('mokuro-reader/SeriesC/c.cbz');
    const provider = await restoredProvider({ loginBorn: true });
    // Two catalog refreshes, each a full tree reload.
    await provider.listCloudVolumes(false);
    await provider.listCloudVolumes(false);
    await server.flush();
    return { provider, other };
  }

  it('keeps at most one server-change long-poll open for the session', async () => {
    await libraryReloadedTwice();

    expect(server.openPolls()).toBeLessThanOrEqual(1);
  });

  it('another device deleting one series leaves every other series listed', async () => {
    const { provider, other } = await libraryReloadedTwice();

    await other.delete(other.node('mokuro-reader/SeriesA').nodeId);
    await server.flush();

    expect(await listed(provider)).toEqual(['SeriesB/b.cbz', 'SeriesC/c.cbz']);
  });

  it('another device deleting an unrelated folder does not make the library look gone (no second root)', async () => {
    const { provider, other } = await libraryReloadedTwice();

    await other.delete(other.node('Other').nodeId);
    await server.flush();
    await provider.uploadFile('volume-data.json', bytes('{}'));

    const tree = await server.tree();
    expect(tree.paths()).toEqual([
      'mokuro-reader',
      'mokuro-reader/SeriesA',
      'mokuro-reader/SeriesA/a.cbz',
      'mokuro-reader/SeriesB',
      'mokuro-reader/SeriesB/b.cbz',
      'mokuro-reader/SeriesC',
      'mokuro-reader/SeriesC/c.cbz',
      'mokuro-reader/volume-data.json'
    ]);
    expect(await listed(provider)).toEqual([
      'SeriesA/a.cbz',
      'SeriesB/b.cbz',
      'SeriesC/c.cbz',
      'volume-data.json'
    ]);
  });
});

describe('T5 (V4): one unexpected server-change packet does not freeze the tree', () => {
  it('a delete notice for a node this device never had does not stop later changes from arriving', async () => {
    const other = await server.otherDevice();
    await other.put('mokuro-reader/Ippo/Ippo 01.cbz');
    const provider = await restoredProvider();

    // E.g. another device's short-lived temp file, or a node already dropped here.
    server.pushPackets([{ a: 'd', n: 'NEVERSEEN' }]);
    await server.flush();
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 02.cbz');
    await server.flush();

    expect(await listed(provider)).toEqual(['Ippo/Ippo 01.cbz', 'Ippo/Ippo 02.cbz']);
  });

  it('a dropped server-change poll is restarted, so later changes still arrive', async () => {
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
    const provider = await restoredProvider();

    server.failPolls(); // e.g. the connection dropped
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 02.cbz');
    await vi.waitFor(() => expect(server.openPolls()).toBe(1), { timeout: 4000 });
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 03.cbz');
    await server.flush();

    expect(await listed(provider)).toEqual([
      'Ippo/Ippo 01.cbz',
      'Ippo/Ippo 02.cbz',
      'Ippo/Ippo 03.cbz'
    ]);
  });

  it('a poll that dies after every reload backs off and stops, instead of reloading forever', async () => {
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 01.cbz');
    const provider = await restoredProvider();
    const fullLoads = () =>
      server.requests.filter((r) => r.sid === CLIENT_SID && r.body.a === 'f' && !r.body.n).length;
    const before = fullLoads();

    vi.useFakeTimers();
    try {
      server.rejectPollsOf = CLIENT_SID; // /sc rejected, /cs fine
      server.failPolls();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }

    // 1 + 2 + 4 + 8 + 16 + 32 s of backoff: six reloads, then it waits for
    // the next load. Unbounded, it reloaded about once a second.
    expect(fullLoads() - before).toBe(6);
    expect(server.openPolls()).toBe(0);

    // The next load restarts the poll; once it answers, a later drop is
    // recovered from the start of the backoff again.
    server.rejectPollsOf = null;
    await provider.listCloudVolumes(false);
    expect(server.openPolls()).toBe(1);
    await (await server.otherDevice()).put('mokuro-reader/Ippo/Ippo 02.cbz');
    await server.flush();
    server.failPolls();
    await vi.waitFor(() => expect(server.openPolls()).toBe(1), { timeout: 4000 });
    expect(await listed(provider)).toEqual(['Ippo/Ippo 01.cbz', 'Ippo/Ippo 02.cbz']);
  });

  it('logging out stops the server-change poll', async () => {
    const provider = await restoredProvider();
    expect(server.openPolls()).toBe(1);

    await provider.logout();

    expect(server.openPolls()).toBe(0);
  });
});

describe('T6 (V5): writers and the deduplicator agree on which root is the library', () => {
  it('with two live roots, uploads go to the root the deduplicator keeps (the oldest)', async () => {
    const other = await server.otherDevice();
    // The server lists the newer root first.
    server.clock = 1_790_000_000;
    const newer = await other.mkdir(server.rootHandle, 'mokuro-reader');
    server.clock = 1_780_000_000;
    const older = await other.mkdir(server.rootHandle, 'mokuro-reader');
    await other.upload(await other.mkdir(older, 'SeriesA'), 'a.cbz');
    expect(newer).not.toBe(older);
    const provider = await restoredProvider({ loginBorn: true });

    await provider.uploadFile('volume-data.json', bytes('{}'));

    const tree = await server.tree();
    const [uploaded] = tree.find('mokuro-reader/volume-data.json');
    expect(uploaded.parent).toBe(older);
  });
});

describe('T7 (V6): merging duplicate roots never destroys content the server still has', () => {
  it('a file another device put in the duplicate root, not yet known here, survives the merge', async () => {
    const other = await server.otherDevice();
    server.clock = 1_780_000_000;
    const older = await other.mkdir(server.rootHandle, 'mokuro-reader');
    await other.upload(await other.mkdir(older, 'SeriesA'), 'a.cbz');
    server.clock = 1_790_000_000;
    const newer = await other.mkdir(server.rootHandle, 'mokuro-reader');
    await other.upload(await other.mkdir(newer, 'SeriesB'), 'b.cbz');
    const provider = await restoredProvider({ loginBorn: true });

    // Another device's backup lands in the duplicate root; its sc packet has
    // not reached this device yet.
    await server.withholdSc(async () => {
      const late = await server.otherDevice();
      await late.upload(await late.mkdir(newer, 'SeriesC'), 'c.cbz');
    });

    await folderDeduplicator.deduplicateAll('mega', provider.getFolderOperations());
    await server.flush();

    // One library holding all three series, whichever root survived.
    const tree = await server.tree();
    expect(tree.paths()).toEqual([
      'mokuro-reader',
      'mokuro-reader/SeriesA',
      'mokuro-reader/SeriesA/a.cbz',
      'mokuro-reader/SeriesB',
      'mokuro-reader/SeriesB/b.cbz',
      'mokuro-reader/SeriesC',
      'mokuro-reader/SeriesC/c.cbz'
    ]);
  });
});

describe('T7b (V6): the merge is decided by the server, whatever it answers', () => {
  async function twoRoots() {
    const other = await server.otherDevice();
    server.clock = 1_780_000_000;
    const older = await other.mkdir(server.rootHandle, 'mokuro-reader');
    await other.upload(await other.mkdir(older, 'SeriesA'), 'a.cbz');
    server.clock = 1_790_000_000;
    const newer = await other.mkdir(server.rootHandle, 'mokuro-reader');
    await other.upload(await other.mkdir(newer, 'SeriesB'), 'b.cbz');
    return { older, newer };
  }
  const fullLoads = () =>
    server.requests.filter((r) => r.sid === CLIENT_SID && r.body.a === 'f' && !r.body.n).length;

  it('a server that answers a subtree query with the whole tree still gets its duplicate root merged away', async () => {
    await twoRoots();
    server.subtreeFetchReturnsAll = true;
    const provider = await restoredProvider({ loginBorn: true });

    await folderDeduplicator.deduplicateAll('mega', provider.getFolderOperations());
    await server.flush();

    const tree = await server.tree();
    expect(tree.paths()).toEqual([
      'mokuro-reader',
      'mokuro-reader/SeriesA',
      'mokuro-reader/SeriesA/a.cbz',
      'mokuro-reader/SeriesB',
      'mokuro-reader/SeriesB/b.cbz'
    ]);
  });

  it('a duplicate the server never reports empty is kept, and the run stops after one reload', async () => {
    const { newer } = await twoRoots();
    const provider = await restoredProvider({ loginBorn: true });
    // E.g. another device keeps writing into it.
    vi.spyOn(provider as any, 'serverFolderContentCount').mockResolvedValue(1);
    const before = fullLoads();

    await folderDeduplicator.deduplicateAll('mega', provider.getFolderOperations());

    expect(fullLoads() - before).toBe(1);
    expect((await server.tree()).byHandle(newer)).toBeDefined();
  });
});

describe('T8 (V7): a series folder resolved before a tree rebuild is still recognised after it', () => {
  it('a re-upload that straddles a rebuild replaces the existing copy in the same series folder', async () => {
    const other = await server.otherDevice();
    await other.put('mokuro-reader/Ippo/Ippo 01.cbz', 'old');
    const provider = await restoredProvider({ loginBorn: true });

    // The payload is read after the target folder is resolved; hold it there.
    let reached!: () => void;
    let open!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (open = r));
    class GatedBlob extends Blob {
      async arrayBuffer(): Promise<ArrayBuffer> {
        reached();
        await gate;
        return super.arrayBuffer();
      }
    }
    const upload = provider.uploadFile('Ippo/Ippo 01.cbz', new GatedBlob(['new']));
    await atGate;

    // A catalog refresh rebuilds the tree to completion meanwhile.
    await provider.listCloudVolumes(false);
    open();
    await upload;

    const tree = await server.tree();
    expect(tree.paths()).toEqual([
      'mokuro-reader',
      'mokuro-reader/Ippo',
      'mokuro-reader/Ippo/Ippo 01.cbz'
    ]);
  });
});

describe('T9 (V4): an sc batch is sanitized in order, as megajs applies it', () => {
  // Real MEGA answers a poll that fell behind (a sleeping device, the first
  // poll after a snapshot) with every action since its sequence number in ONE
  // batch; later packets there depend on earlier ones.

  it('a volume moved into a folder created earlier in the same batch stays listed, in its new folder', async () => {
    const other = await server.otherDevice();
    const volume = await other.put('mokuro-reader/Old/v1.cbz');
    const provider = await restoredProvider();
    expect(await listed(provider)).toEqual(['Old/v1.cbz']);

    const release = await server.withholdSc(
      async () => {
        const renamed = await other.mkdir(other.node('mokuro-reader').nodeId, 'New');
        await other.move(volume, renamed);
      },
      { oneBatch: true }
    );
    release();
    await server.flush();

    expect(await listed(provider)).toEqual(['New/v1.cbz']);
  });

  it('a folder and a node moved into it, delivered in one packet, are both applied', async () => {
    const other = await server.otherDevice();
    const volume = await other.put('mokuro-reader/Old/v1.cbz');
    const provider = await restoredProvider();

    let renamed = '';
    await server.withholdSc(async () => {
      renamed = await other.mkdir(other.node('mokuro-reader').nodeId, 'New');
      await other.move(volume, renamed);
    });
    server.pushPackets([
      { a: 'd', n: volume, m: 1 },
      { a: 't', t: { f: [server.nodes.get(renamed), server.nodes.get(volume)] } }
    ]);
    await server.flush();

    expect(await listed(provider)).toEqual(['New/v1.cbz']);
  });

  it('a file created and deleted within one batch is not listed as live', async () => {
    const other = await server.otherDevice();
    await other.put('mokuro-reader/Ippo/Ippo 01.cbz');
    const provider = await restoredProvider();

    let kept = '';
    const release = await server.withholdSc(
      async () => {
        const library = other.node('mokuro-reader').nodeId;
        // Another device rewrites its progress file twice (replace-uploads).
        const first = await other.upload(library, 'volume-data.json', '1');
        await other.delete(first);
        kept = await other.upload(library, 'volume-data.json', '2');
      },
      { oneBatch: true }
    );
    release();
    await server.flush();

    const volumes = await provider.listCloudVolumes(true);
    expect(volumes.map((f) => f.path).sort()).toEqual(['Ippo/Ippo 01.cbz', 'volume-data.json']);
    expect(volumes.find((f) => f.path === 'volume-data.json')?.fileId).toBe(kept);
  });
});
