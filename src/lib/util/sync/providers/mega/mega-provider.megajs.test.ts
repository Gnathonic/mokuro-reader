import { describe, expect, it, vi } from 'vitest';
import { Storage } from 'megajs';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('./mega-cache', () => ({ megaCache: { fetch: vi.fn() } }));
vi.mock('../../cache-manager', () => ({
  cacheManager: { clearAll: vi.fn(), registerCache: vi.fn() }
}));

import { MegaProvider } from './mega-provider';

// The listing against REAL megajs tree handling, network stubbed: what its
// reload() and sc handler do to storage.files after MEGA confirms a delete or
// a move to the Rubbish Bin. mega-provider.test.ts models that linkage by
// hand; this file pins it to the library, so a megajs upgrade that changes it
// fails here.

const NAMES: Record<string, string> = {
  MOKU: 'mokuro-reader',
  IPPO: 'Ippo',
  VOL1: 'Ippo 01.cbz',
  SJSN: 'series.json'
};

async function providerOnRealTree() {
  const storage: any = Storage.fromJSON({
    key: btoa(String.fromCharCode(...new Uint8Array(16))),
    sid: 'fake',
    name: 'x',
    user: 'u',
    options: { keepalive: false }
  } as any);
  const node = (h: string, p: string | undefined, t: number) => ({ h, p, t, ts: 1_780_000_000 });
  const tree = [
    node('ROOT', undefined, 2),
    node('TRASH', undefined, 4),
    node('MOKU', 'ROOT', 1),
    node('IPPO', 'MOKU', 1),
    node('VOL1', 'IPPO', 0),
    node('SJSN', 'IPPO', 0)
  ];
  storage.api.request = (json: any, cb: (e: Error | null, r?: any) => void) => {
    if (json.a === 'f') cb(null, { f: tree, ok: [] });
  };
  await storage.reload(true);
  // Names are encrypted attributes; the fake nodes carry none.
  for (const [handle, name] of Object.entries(NAMES)) storage.files[handle].name = name;

  const provider = new MegaProvider();
  await provider.whenReady();
  (provider as any).storage = storage;
  const listed = async () => (await provider.listCloudVolumes(true)).map((f) => f.path).sort();
  return { storage, listed };
}

describe('MegaProvider listing on real megajs trees', () => {
  it('lists the library before anything changes', async () => {
    const { listed } = await providerOnRealTree();

    expect(await listed()).toEqual(['Ippo/Ippo 01.cbz', 'Ippo/series.json']);
  });

  it('drops a series folder once its sc delete arrives, though megajs keeps the nodes', async () => {
    const { storage, listed } = await providerOnRealTree();

    storage.api.emit('sc', [{ a: 'd', n: 'IPPO' }]);

    expect(Object.keys(storage.files)).toEqual(expect.arrayContaining(['IPPO', 'VOL1']));
    expect(await listed()).toEqual([]);
  });

  it('drops the library once MEGA reports it moved to the Rubbish Bin', async () => {
    const { storage, listed } = await providerOnRealTree();

    storage.api.emit('sc', [
      { a: 'd', n: 'MOKU' },
      { a: 't', t: { f: [{ h: 'MOKU', p: 'TRASH', t: 1, ts: 1_780_000_000 }] } }
    ]);

    expect(storage.files.MOKU.parent).toBe(storage.trash);
    // With no live library the listing makes a new one at the root; this is
    // what megajs does with the server's mkdir answer.
    storage.mkdir = (name: string, cb: (e: Error | null, f?: any) => void) => {
      const folder = storage._importFile({ h: 'FRESH', p: 'ROOT', t: 1, ts: 1_780_000_000 });
      folder.name = name;
      cb(null, folder);
    };
    expect(await listed()).toEqual([]);
    expect(storage.files.FRESH.parent).toBe(storage.root);
  });
});
