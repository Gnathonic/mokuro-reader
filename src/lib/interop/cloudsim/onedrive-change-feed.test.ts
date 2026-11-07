/**
 * OneDrive's change feed against cloudsim (`CLOUDSIM_URL`): the real listing
 * cache, provider and Graph client, Graph pointed at the simulator. Another
 * device's writes are made straight on the simulator (seed, or a raw Graph
 * call with the same account's token), as a second device's would land; the
 * simulator's request log shows what the reader paid to see them. Skipped
 * without a simulator; run with `--no-file-parallelism` (the suites share one).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloudsimForSuite,
  fetchWithoutForeignSignals,
  refuseNonLocalRequests,
  sendBlobsAsBytes,
  sim,
  type SimLogEntry
} from '../cloudsim';
import { setCloudTestBases, setCloudTestToken } from '$lib/util/sync/cloud-test-hooks';
import { uploadCacheEntry } from '$lib/util/sync/cloud-cache-interface';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));

const SERIES = Array.from({ length: 6 }, (_, i) => `Series ${i + 1}`);

describe.skipIf(!cloudsimForSuite())('OneDrive change feed (Graph delta) against cloudsim', () => {
  type Cache = typeof import('$lib/util/sync/providers/onedrive/onedrive-cache').onedriveCache;
  type Provider =
    typeof import('$lib/util/sync/providers/onedrive/onedrive-provider').onedriveProvider;
  let cache: Cache;
  let provider: Provider;
  let accessToken = '';
  let restoreXhr = () => {};
  let restoreFetch = () => {};
  let restoreLocal = () => {};

  const paths = () =>
    cache
      .getAllFiles()
      .map((f) => f.path)
      .sort();
  const of = (log: SimLogEntry[], cls: string) => log.filter((e) => e.class === cls);

  /** A raw Graph call as another device signed in to the same account would make it. */
  async function otherDevice(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${sim.bases().graph}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  }

  async function nodeId(name: string): Promise<string> {
    const node = (await sim.tree('microsoft')).find((n) => n.name === name);
    if (!node) throw new Error(`${name} not in the simulator's tree`);
    return node.id;
  }

  beforeAll(async () => {
    restoreLocal = refuseNonLocalRequests();
    restoreXhr = sendBlobsAsBytes();
    restoreFetch = fetchWithoutForeignSignals();
    setCloudTestBases(sim.bases());
    ({ onedriveCache: cache } = await import('$lib/util/sync/providers/onedrive/onedrive-cache'));
    ({ onedriveProvider: provider } = await import(
      '$lib/util/sync/providers/onedrive/onedrive-provider'
    ));
  });

  beforeEach(async () => {
    await sim.reset();
    await sim.seed('microsoft', [
      ...SERIES.flatMap((s) => [
        { path: `mokuro-reader/${s}/Vol 1.cbz`, data: `cbz ${s}` },
        { path: `mokuro-reader/${s}/Vol 1.mokuro`, data: `{"title":"${s}"}` }
      ]),
      { path: 'mokuro-reader/volume-data.json', data: '{}' },
      { path: 'mokuro-reader/history/dev-a/2026-10.events', data: 'a\n' },
      { path: 'Pictures/holiday.jpg', data: 'jpeg' }
    ]);
    const t = await sim.token('microsoft');
    accessToken = t.access_token;
    setCloudTestToken('onedrive', t.access_token);
    cache.clear();
    await cache.fetch();
    expect(cache.isLoaded()).toBe(true);
    await sim.clearLog();
  });

  afterEach(async () => {
    expect(await sim.takeViolations()).toEqual([]);
  });

  afterAll(async () => {
    cache?.clear();
    setCloudTestToken('onedrive', null);
    setCloudTestBases(null);
    restoreXhr();
    restoreFetch();
    restoreLocal();
    await sim.reset();
  });

  it("another device's new file and its deletion arrive through delta, with no walk", async () => {
    expect(paths()).toHaveLength(14);
    // Another device's first history segment: a new folder and a file in it.
    await sim.seed('microsoft', [
      { path: 'mokuro-reader/history/dev-b/2026-11.events', data: 'b1\nb2\n' }
    ]);
    // ...and a stranger elsewhere in the drive, which the feed also carries.
    await sim.seed('microsoft', [{ path: 'Pictures/beach.jpg', data: 'jpeg2' }]);

    expect(await cache.refreshFromChanges()).toBe('applied');
    expect(cache.get('history/dev-b/2026-11.events')).toMatchObject({ size: 6 });
    expect(paths().some((p) => p.includes('beach'))).toBe(false);
    let log = await sim.log();
    expect(of(log, 'changes')).toHaveLength(1);
    expect(of(log, 'list')).toHaveLength(0);
    expect(log).toHaveLength(1);

    // The other device deletes a volume's sidecar.
    await sim.clearLog();
    const gone = await otherDevice('DELETE', `/me/drive/items/${await nodeId('Vol 1.mokuro')}`);
    expect(gone.status).toBe(204);
    expect(await cache.refreshFromChanges()).toBe('applied');
    expect(paths().filter((p) => p.endsWith('.mokuro'))).toHaveLength(SERIES.length - 1);
    log = await sim.log();
    // The DELETE itself plus one delta read; no children listing.
    expect(of(log, 'changes')).toHaveLength(1);
    expect(of(log, 'list')).toHaveLength(0);

    // Nothing new: one request, and the map keeps its identity.
    await sim.clearLog();
    const before = cache.store.read();
    expect(await cache.refreshFromChanges()).toBe('unchanged');
    expect(cache.store.read()).toBe(before);
    expect(await sim.log()).toHaveLength(1);
  });

  it("this device's own upload echoes back as 'unchanged'", async () => {
    const bytes = new Blob(['{"p":1}']);
    const uploaded = await provider.uploadFile('positions.json', bytes);
    cache.add('positions.json', uploadCacheEntry('onedrive', 'positions.json', 7, uploaded));
    const before = cache.store.read();
    expect(await cache.refreshFromChanges()).toBe('unchanged');
    expect(cache.store.read()).toBe(before);
    expect(cache.get('positions.json')?.revision).toBe(uploaded.revision);
  });

  it('a 410 for an expired position falls back to a full listing', async () => {
    await sim.knobs('microsoft', { lost_below: 1_000_000 });
    await sim.seed('microsoft', [{ path: 'mokuro-reader/Series 9/Vol 1.cbz', data: 'new' }]);
    try {
      expect(await cache.refreshFromChanges()).toBe('reset');
    } finally {
      await sim.knobs('microsoft', { lost_below: 0 });
    }
    expect(paths()).toContain('Series 9/Vol 1.cbz');
    const log = await sim.log();
    const changes = of(log, 'changes');
    expect(changes[0].status).toBe(410);
    // The walk: one children listing per folder of the library.
    expect(of(log, 'list').length).toBeGreaterThanOrEqual(SERIES.length + 3);
  });

  it('a folder renamed by another device falls back to a full listing, at the new paths', async () => {
    const renamed = await otherDevice('PATCH', `/me/drive/items/${await nodeId('Series 2')}`, {
      name: 'Series Two'
    });
    expect(renamed.ok).toBe(true);
    expect(await cache.refreshFromChanges()).toBe('reset');
    expect(paths()).toContain('Series Two/Vol 1.cbz');
    expect(paths()).not.toContain('Series 2/Vol 1.cbz');
    expect(of(await sim.log(), 'list').length).toBeGreaterThan(0);

    // The walk took its own position: the next read is the feed again.
    await sim.clearLog();
    expect(await cache.refreshFromChanges()).toBe('unchanged');
    expect(of(await sim.log(), 'list')).toHaveLength(0);
  });

  it('a whole series folder deleted by another device takes its files with it', async () => {
    const gone = await otherDevice('DELETE', `/me/drive/items/${await nodeId('Series 3')}`);
    expect(gone.status).toBe(204);
    expect(await cache.refreshFromChanges()).toBe('applied');
    expect(paths().some((p) => p.startsWith('Series 3/'))).toBe(false);
    expect(paths()).toHaveLength(12);
    expect(of(await sim.log(), 'list')).toHaveLength(0);
  });
});
