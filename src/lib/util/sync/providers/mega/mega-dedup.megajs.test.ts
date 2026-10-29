import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('./mega-cache', () => ({ megaCache: { fetch: vi.fn(async () => {}) } }));
vi.mock('../../cache-manager', () => ({
  cacheManager: { clearAll: vi.fn(), registerCache: vi.fn() }
}));

import { MegaProvider } from './mega-provider';
import { folderDeduplicator } from '../../folder-deduplicator';
import { FakeMegaServer } from './mega-fake-server';

// Merging accounts that ALREADY have duplicate `mokuro-reader` roots, on REAL
// megajs over the fake MEGA backend: what ends up on the server, what the
// reader lists while the merge runs, and what it must never touch.

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

async function restoredProvider(): Promise<MegaProvider> {
  localStorage.setItem('mega_session', JSON.stringify(server.sessionBlob()));
  const provider = new MegaProvider();
  providers.push(provider);
  await provider.whenReady();
  return provider;
}

async function listed(provider: MegaProvider): Promise<string[]> {
  return (await provider.listCloudVolumes(true)).map((f) => f.path).sort();
}

const inTrash = (handle: string) => server.nodes.get(handle)?.p === server.trashHandle;

/** Four roots holding one series each, then a fifth holding the root json. */
async function fiveRootAccount() {
  const other = await server.otherDevice();
  const roots: string[] = [];
  for (const series of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
    server.clock += 100;
    const root = await other.mkdir(server.rootHandle, 'mokuro-reader');
    roots.push(root);
    const folder = await other.mkdir(root, series);
    await other.upload(folder, `${series} 01.cbz`);
    await other.upload(folder, `${series} 01.mokuro`);
    await other.upload(folder, 'series.json');
  }
  server.clock += 100;
  const fifth = await other.mkdir(server.rootHandle, 'mokuro-reader');
  roots.push(fifth);
  await other.upload(fifth, 'volume-data.json', '{}');
  await other.upload(fifth, 'profiles.json', '{}');
  return roots;
}

describe('merging duplicate mokuro-reader roots', () => {
  it('five roots become the oldest one, and the library lists the same before and after', async () => {
    const roots = await fiveRootAccount();
    const provider = await restoredProvider();
    const before = await listed(provider);

    await folderDeduplicator.deduplicateAll('mega', provider.getFolderOperations());
    await server.flush();

    const tree = await server.tree();
    expect(tree.find('mokuro-reader').map((n) => n.handle)).toEqual([roots[0]]);
    expect(tree.paths()).toHaveLength(1 + 4 * 4 + 2);
    expect(await listed(provider)).toEqual(before);
  });

  it('an interrupted merge lists the whole library at every step and finishes on the next run', async () => {
    await fiveRootAccount();
    const provider = await restoredProvider();
    const before = await listed(provider);
    const ops = provider.getFolderOperations();

    let moves = 0;
    const duringMerge: string[][] = [];
    await folderDeduplicator.deduplicateAll('mega', {
      ...ops,
      moveItem: async (...args: Parameters<typeof ops.moveItem>) => {
        await ops.moveItem(...args);
        duringMerge.push(await listed(provider));
        if (++moves === 2) throw new Error('tab closed mid-merge');
      }
    });

    expect((await server.tree()).count('mokuro-reader')).toBeGreaterThan(1);
    expect(duringMerge).toHaveLength(2);
    for (const listing of duringMerge) expect(listing).toEqual(before);

    await folderDeduplicator.deduplicateAll('mega', provider.getFolderOperations());
    await server.flush();

    expect((await server.tree()).count('mokuro-reader')).toBe(1);
    expect(await listed(provider)).toEqual(before);
  });

  it("never merges the user's own folders outside the library", async () => {
    const other = await server.otherDevice();
    await other.put('mokuro-reader/Alpha/Alpha 01.cbz');
    const photos1 = await other.mkdir(server.rootHandle, 'Photos');
    const notes1 = await other.upload(photos1, 'notes.txt', 'first');
    server.clock += 100;
    const photos2 = await other.mkdir(server.rootHandle, 'Photos');
    const notes2 = await other.upload(photos2, 'notes.txt', 'second');
    const provider = await restoredProvider();

    await folderDeduplicator.deduplicateAll('mega', provider.getFolderOperations());
    await server.flush();

    const tree = await server.tree();
    expect(tree.find('Photos').map((n) => n.handle)).toEqual([photos1, photos2]);
    expect(tree.find('Photos/notes.txt').map((n) => n.handle)).toEqual([notes1, notes2]);
  });

  it('two copies of one file keep the newer; the older goes to the Rubbish Bin, not away', async () => {
    const other = await server.otherDevice();
    server.clock += 100;
    const older = await other.mkdir(server.rootHandle, 'mokuro-reader');
    const oldCopy = await other.upload(older, 'profiles.json', '{"old":1}');
    server.clock += 100;
    const newer = await other.mkdir(server.rootHandle, 'mokuro-reader');
    const newCopy = await other.upload(newer, 'profiles.json', '{"new":1}');
    const provider = await restoredProvider();

    await folderDeduplicator.deduplicateAll('mega', provider.getFolderOperations());
    await server.flush();

    const tree = await server.tree();
    expect(tree.find('mokuro-reader').map((n) => n.handle)).toEqual([older]);
    expect(tree.find('mokuro-reader/profiles.json').map((n) => n.handle)).toEqual([newCopy]);
    expect(inTrash(oldCopy)).toBe(true);
  });

  it('keeps both copies of volume-data.json for the next sync to merge', async () => {
    const other = await server.otherDevice();
    server.clock += 100;
    const older = await other.mkdir(server.rootHandle, 'mokuro-reader');
    const first = await other.upload(older, 'volume-data.json', '{"a":{}}');
    server.clock += 100;
    const newer = await other.mkdir(server.rootHandle, 'mokuro-reader');
    const second = await other.upload(newer, 'volume-data.json', '{"b":{}}');
    const provider = await restoredProvider();

    await folderDeduplicator.deduplicateAll('mega', provider.getFolderOperations());
    await server.flush();

    const tree = await server.tree();
    expect(tree.count('mokuro-reader')).toBe(1);
    expect(
      tree
        .find('mokuro-reader/volume-data.json')
        .map((n) => n.handle)
        .sort()
    ).toEqual([first, second].sort());
  });
});
