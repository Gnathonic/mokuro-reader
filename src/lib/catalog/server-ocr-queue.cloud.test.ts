/**
 * A cloud-direct Bunko (bunko design 0.8 §9.1, §9.5): the queue file lives in
 * the library folder and is read through the provider, behind the marker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { get } from 'svelte/store';

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_server_ocr_queue_cloud_test') };
});
const pullLayersForVolume = vi.hoisted(() => vi.fn(async () => 0));
const importFetchedLayers = vi.hoisted(() => vi.fn());
vi.mock('$lib/metadata/layer-sync', () => ({ pullLayersForVolume, importFetchedLayers }));
const requestOcrUpgradePass = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./ocr-upgrade-pass', () => ({ requestOcrUpgradePass }));
const loadVolumeManifest = vi.hoisted(() => vi.fn());
vi.mock('$lib/import/deep-link-manifest', () => ({ loadVolumeManifest }));
const getActiveProvider = vi.hoisted(() => vi.fn(() => null as unknown));
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { getActiveProvider: () => getActiveProvider() }
}));

import { db } from '$lib/catalog/db';
import type { ControlFileResult } from '$lib/util/sync/provider-interface';
import { resetCloudBunkoMarkersForTest } from './cloud-bunko-marker';
import { markVolumeShown, serverOcrQueueStatus, volumeQueueKey } from './server-ocr-pending';
import {
  QueuePoller,
  cloudSourceFor,
  ensureCloudPoller,
  parseQueueFile,
  resetServerOcrQueueForTest,
  setQueueRelistHook,
  settleCloudCompletionsForTest,
  watchCloudUpload,
  watchedEntries,
  type QueueFile,
  type QueueSource
} from './server-ocr-queue';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const KEY1 = volumeQueueKey('Kingdom', 'Kingdom 13');
const KEY2 = volumeQueueKey('Kingdom', 'Kingdom 12');

function queueBody(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    generated_at: '2026-10-12T10:00:00Z',
    instance_id: 'aaa',
    held: null,
    next_check_after: 120,
    pending_volumes: 837,
    truncated: true,
    volumes: [
      {
        series: 'Kingdom',
        volume: 'Kingdom 13',
        path: '/mokuro-reader/Kingdom/Kingdom%2013.cbz',
        manifest: '',
        jobs: [{ kind: 'ocr', id: 'mokuro', state: 'running', eta: null, progress: 0.4 }]
      }
    ],
    done: [] as unknown[],
    ...over
  };
}

const doneEntry = (volume: string, at: string) => ({
  series: 'Kingdom',
  volume,
  at,
  ocr: `Kingdom/${volume}.mokuro`,
  layers: [{ id: 'hayai', path: `Kingdom/${volume}.hayai.mokuro` }]
});

function markerBody(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: 'mokuro-bunko',
    instance_id: 'aaa',
    instance_name: 'nas',
    epoch: 1,
    claimed_at: '2026-10-12T09:00:00Z',
    heartbeat_at: new Date(Date.now()).toISOString(),
    ttl_s: 900,
    state: 'active',
    compiles: ['series.json', 'catalog.json'],
    ocr: true,
    queue: '.mokuro-queue.json',
    ...over
  };
}

function nodes(...bodies: Array<{ id: string; etag: string; body: unknown }>): ControlFileResult {
  return {
    etag: bodies.map((b) => `${b.id}=${b.etag}`).join('|'),
    nodes: bodies.map((b) => ({
      id: b.id,
      etag: b.etag,
      blob: new Blob([JSON.stringify(b.body)])
    }))
  };
}

/** A provider whose control files are whatever the test says they are. */
function cloudProvider(type = 'google-drive') {
  const files: Record<string, ControlFileResult> = {};
  const readControlFile = vi.fn(async (name: string, opts?: { ifNoneMatch?: string }) => {
    const current = files[name] ?? null;
    if (current && current !== 'not-modified' && opts?.ifNoneMatch === current.etag) {
      return 'not-modified' as const;
    }
    return current;
  });
  return { provider: { type, readControlFile }, files, readControlFile };
}

/** A QueuePoller over a scripted source. */
function scripted(completion: QueueSource['completion'] = 'done-list') {
  const reads: Array<QueueFile | null | 'not-modified'> = [];
  const onDone = vi.fn();
  const onStatus = vi.fn();
  const watched: string[] = [];
  const source: QueueSource = {
    id: 'cloud:test',
    completion,
    keepAlive: true,
    minIntervalS: 60,
    read: vi.fn(async () => {
      const next = reads.length > 1 ? reads.shift()! : reads[0];
      return next === 'not-modified' ? 'not-modified' : { file: next ?? null, etag: null };
    })
  };
  const poller = new QueuePoller({
    source,
    watchedKeys: () => watched,
    isShown: () => false,
    onStatus,
    onDone,
    isHidden: () => false
  });
  return { poller, reads, onDone, onStatus, watched, source };
}

function file(over: Record<string, unknown> = {}): QueueFile {
  const parsed = parseQueueFile(queueBody(over));
  if (!parsed) throw new Error('bad fixture');
  return parsed;
}

beforeEach(async () => {
  // setImmediate stays real: fake-indexeddb runs on it.
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  localStorage.clear();
  resetServerOcrQueueForTest();
  resetCloudBunkoMarkersForTest();
  vi.clearAllMocks();
  getActiveProvider.mockReturnValue(null);
  await db.volumes.clear();
});

afterEach(() => {
  resetServerOcrQueueForTest();
  vi.useRealTimers();
});

describe('parseQueueFile (cloud copy)', () => {
  it('reads instance_id, truncated and done[] with their paths; a bunko server file has none', () => {
    const f = file({ done: [doneEntry('Kingdom 12', '2026-10-12T09:59:00Z')] });
    expect(f.instance_id).toBe('aaa');
    expect(f.truncated).toBe(true);
    expect(f.done).toEqual([
      {
        series: 'Kingdom',
        volume: 'Kingdom 12',
        at: '2026-10-12T09:59:00Z',
        ocr: 'Kingdom/Kingdom 12.mokuro',
        layers: [{ id: 'hayai', path: 'Kingdom/Kingdom 12.hayai.mokuro' }]
      }
    ]);
    const plain = parseQueueFile({ version: 1, volumes: [] });
    expect(plain?.instance_id).toBeUndefined();
    expect(plain?.truncated).toBe(false);
    expect(plain?.done).toEqual([]);
  });

  it('drops malformed done entries and layer refs on their own', () => {
    const f = file({
      done: [{ series: 'Kingdom' }, 3, { ...doneEntry('Kingdom 12', ''), layers: [{ id: 1 }] }]
    });
    expect(f.done).toHaveLength(1);
    expect(f.done[0].layers).toEqual([]);
    expect(f.done[0].ocr).toBe('Kingdom/Kingdom 12.mokuro');
  });
});

describe('QueuePoller with an injected QueueSource (done-list completion)', () => {
  it('reads through the source, not fetch', async () => {
    const s = scripted();
    s.reads.push(file());
    s.poller.trigger('start');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.source.read).toHaveBeenCalledTimes(1);
  });

  it('completes a watched volume only when done[] lists it', async () => {
    const s = scripted();
    s.watched.push(KEY1);
    s.reads.push(file());
    s.poller.trigger('upload');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.onDone).not.toHaveBeenCalled();

    // It left `volumes` but the list is truncated and done[] does not name it: waiting.
    s.reads.length = 0;
    s.reads.push(file({ volumes: [] }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.onDone).not.toHaveBeenCalled();

    s.reads.length = 0;
    s.reads.push(file({ volumes: [], done: [doneEntry('Kingdom 13', '2026-10-12T10:03:00Z')] }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.onDone).toHaveBeenCalledTimes(1);
    expect(s.onDone.mock.calls[0][0]).toBe(KEY1);
    expect(s.onDone.mock.calls[0][2]).toMatchObject({ volume: 'Kingdom 13' });

    // The same entry on later reads is not a second completion.
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.onDone).toHaveBeenCalledTimes(1);
  });

  it('a watched volume absent from a NON-truncated list is not done either', async () => {
    const s = scripted();
    s.watched.push(KEY1);
    s.reads.push(file({ volumes: [], truncated: false }));
    s.poller.trigger('upload');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.onDone).not.toHaveBeenCalled();
  });

  it('the first file is a baseline: earlier completions only count for watched volumes', async () => {
    const s = scripted();
    s.watched.push(KEY1);
    s.reads.push(
      file({
        done: [
          doneEntry('Kingdom 13', '2026-10-12T09:58:00Z'),
          doneEntry('Kingdom 12', '2026-10-12T09:50:00Z')
        ]
      })
    );
    s.poller.trigger('start');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.onDone.mock.calls.map((c) => c[0])).toEqual([KEY1]);

    // A new completion after the baseline counts for any volume.
    s.reads.length = 0;
    s.reads.push(
      file({
        done: [
          doneEntry('Kingdom 11', '2026-10-12T10:02:00Z'),
          doneEntry('Kingdom 13', '2026-10-12T09:58:00Z'),
          doneEntry('Kingdom 12', '2026-10-12T09:50:00Z')
        ]
      })
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.onDone.mock.calls.map((c) => c[0])).toEqual([
      KEY1,
      volumeQueueKey('Kingdom', 'Kingdom 11')
    ]);
  });

  it('keeps polling with nothing of interest (the marker must be watched), at the source floor', async () => {
    const s = scripted();
    s.reads.push(file({ next_check_after: 5 }));
    s.poller.trigger('start');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.poller.state).toBe('waiting');
    expect(s.poller.nextDelayMs).toBe(60_000);
    expect(s.onStatus).toHaveBeenLastCalledWith(null);
  });

  it('an untrusted read (no fresh marker) shows nothing and waits the unpriced 5 min', async () => {
    const s = scripted();
    s.reads.push(null);
    s.poller.trigger('start');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.onStatus).toHaveBeenLastCalledWith(null);
    expect(s.poller.nextDelayMs).toBe(300_000);
  });
});

describe('cloudSourceFor (marker, then the holder’s queue file)', () => {
  it('trusts the queue file only when instance_id names the top-ranked fresh marker', async () => {
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    c.files['.mokuro-bunko.json'] = nodes(
      { id: 'm1', etag: '1', body: markerBody({ instance_id: 'aaa', epoch: 1 }) },
      { id: 'm2', etag: '1', body: markerBody({ instance_id: 'bbb', epoch: 2 }) }
    );
    c.files['.mokuro-queue.json'] = nodes(
      { id: 'q1', etag: '1', body: queueBody({ instance_id: 'aaa' }) },
      { id: 'q2', etag: '1', body: queueBody({ instance_id: 'bbb', volumes: [] }) }
    );
    const source = cloudSourceFor('google-drive');
    const read = await source.read({ etag: null, file: null });
    if (read === 'not-modified' || read === 'unavailable') throw new Error(String(read));
    // bbb holds the lease (higher epoch): its file, not aaa's.
    expect(read.file?.instance_id).toBe('bbb');

    c.files['.mokuro-queue.json'] = nodes({
      id: 'q1',
      etag: '2',
      body: queueBody({ instance_id: 'aaa' })
    });
    const second = await source.read({ etag: null, file: null });
    if (second === 'not-modified' || second === 'unavailable') throw new Error(String(second));
    expect(second.file).toBeNull();
  });

  it('without a fresh marker the queue file is not even read', async () => {
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    c.files['.mokuro-queue.json'] = nodes({ id: 'q1', etag: '1', body: queueBody() });
    const read = await cloudSourceFor('google-drive').read({ etag: null, file: null });
    expect(read).toEqual({ file: null, etag: null });
    expect(c.readControlFile.mock.calls.map((call) => call[0])).toEqual(['.mokuro-bunko.json']);

    c.files['.mokuro-bunko.json'] = nodes({
      id: 'm1',
      etag: '1',
      body: markerBody({ state: 'released' })
    });
    expect(await cloudSourceFor('google-drive').read({ etag: null, file: null })).toEqual({
      file: null,
      etag: null
    });
  });

  it('asks with If-None-Match and reuses the parsed file on not-modified', async () => {
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '1', body: markerBody() });
    c.files['.mokuro-queue.json'] = nodes({ id: 'q1', etag: '1', body: queueBody() });
    const source = cloudSourceFor('google-drive');
    await source.read({ etag: null, file: null });
    const again = await source.read({ etag: null, file: null });
    expect(c.readControlFile).toHaveBeenLastCalledWith('.mokuro-queue.json', {
      ifNoneMatch: 'q1=1'
    });
    if (again === 'not-modified' || again === 'unavailable') throw new Error(String(again));
    expect(again.file?.volumes).toHaveLength(1);
  });

  it('is unavailable once its provider is no longer the connected one', async () => {
    getActiveProvider.mockReturnValue(cloudProvider('mega').provider);
    expect(await cloudSourceFor('google-drive').read({ etag: null, file: null })).toBe(
      'unavailable'
    );
  });
});

describe('a cloud upload, watched and completed', () => {
  async function seedLocalRow() {
    await db.volumes.put({
      volume_uuid: 'k13',
      series_uuid: 's',
      series_title: 'Kingdom',
      volume_title: 'Kingdom 13',
      mokuro_version: '',
      page_count: 1,
      character_count: 0,
      page_char_counts: [0]
    } as never);
  }

  it('watches by (series, volume) only while the marker is fresh', async () => {
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    await watchCloudUpload({ volumeUuid: 'k13', series: 'Kingdom', volume: 'Kingdom 13' });
    expect(watchedEntries()).toEqual([]);

    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '1', body: markerBody() });
    const poller = await ensureCloudPoller();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller?.id).toBe('cloud:google-drive');
    await watchCloudUpload({ volumeUuid: 'k13', series: 'Kingdom', volume: 'Kingdom 13' });
    expect(watchedEntries()).toEqual([
      expect.objectContaining({
        key: KEY1,
        queue_url: 'cloud:google-drive',
        manifest_url: '',
        auth: 'cloud',
        source: 'google-drive'
      })
    ]);
  });

  it('on done[]: relists, then upgrade pass + layer pull — never the manifest pull', async () => {
    await seedLocalRow();
    const relist = vi.fn(async () => {});
    setQueueRelistHook(relist);
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '1', body: markerBody() });
    c.files['.mokuro-queue.json'] = nodes({ id: 'q1', etag: '1', body: queueBody() });
    await ensureCloudPoller(); // app start: reads the marker
    await vi.advanceTimersByTimeAsync(0);
    const off = markVolumeShown(KEY1);
    await watchCloudUpload({ volumeUuid: 'k13', series: 'Kingdom', volume: 'Kingdom 13' });
    await vi.advanceTimersByTimeAsync(0);
    // The queue file shows its job on the card.
    expect(get(serverOcrQueueStatus)[KEY1]?.jobs[0]).toMatchObject({ state: 'running' });

    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '2', body: markerBody() });
    c.files['.mokuro-queue.json'] = nodes({
      id: 'q1',
      etag: '2',
      body: queueBody({ volumes: [], done: [doneEntry('Kingdom 13', '2026-10-12T10:01:00Z')] })
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await settleCloudCompletionsForTest();

    expect(relist).toHaveBeenCalledTimes(1);
    expect(requestOcrUpgradePass).toHaveBeenCalledWith('google-drive', [{ title: 'Kingdom' }]);
    expect(pullLayersForVolume).toHaveBeenCalledWith('k13', 'google-drive');
    expect(relist.mock.invocationCallOrder[0]).toBeLessThan(
      pullLayersForVolume.mock.invocationCallOrder[0]
    );
    expect(loadVolumeManifest).not.toHaveBeenCalled();
    expect(watchedEntries()).toEqual([]);
    off();
  });

  it('batches completions: one relist per spacing window', async () => {
    const relist = vi.fn(async () => {});
    setQueueRelistHook(relist);
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '1', body: markerBody() });
    c.files['.mokuro-queue.json'] = nodes({ id: 'q1', etag: '1', body: queueBody() });
    await ensureCloudPoller();
    await vi.advanceTimersByTimeAsync(0); // baseline
    c.files['.mokuro-queue.json'] = nodes({
      id: 'q1',
      etag: '2',
      body: queueBody({
        done: [
          doneEntry('Kingdom 13', '2026-10-12T10:01:00Z'),
          doneEntry('Kingdom 12', '2026-10-12T10:00:30Z')
        ]
      })
    });
    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '2', body: markerBody() });
    await vi.advanceTimersByTimeAsync(120_000);
    await settleCloudCompletionsForTest();
    expect(relist).toHaveBeenCalledTimes(1);
    expect(requestOcrUpgradePass).toHaveBeenCalledTimes(1);
    expect(KEY2).not.toBe(KEY1);
  });
});

describe('MEGA: the live tree pushes control-file changes', () => {
  it('a control-file event triggers a look between scheduled polls', async () => {
    const c = cloudProvider('mega');
    let fire: (name: string) => void = () => {};
    const provider = {
      ...c.provider,
      onControlFileChange: vi.fn((listener: (name: string) => void) => {
        fire = listener;
        return () => {};
      })
    };
    getActiveProvider.mockReturnValue(provider);
    c.files['.mokuro-bunko.json'] = nodes({ id: 'h1', etag: 'h1', body: markerBody() });
    await ensureCloudPoller();
    await vi.advanceTimersByTimeAsync(0);
    const reads = c.readControlFile.mock.calls.length;
    fire('.mokuro-bunko.json');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.readControlFile.mock.calls.length).toBeGreaterThan(reads);
    expect(provider.onControlFileChange).toHaveBeenCalledTimes(1);
  });
});
