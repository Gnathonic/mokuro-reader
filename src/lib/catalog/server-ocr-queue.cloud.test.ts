/**
 * A cloud-direct Bunko (queue file v2): no root queue file is read. The lease
 * marker is polled every ttl/3, and a series page reads its own series file
 * through the provider, trusted only when the marker's holder wrote it.
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
// The folder lookups of the series page: the listing holds the series as spelled.
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    resolveCloudFolderTitle: (title: string) => title,
    getCloudVolumesBySeries: () => [{}]
  }
}));

import { db } from '$lib/catalog/db';
import type { ControlFileResult } from '$lib/util/sync/provider-interface';
import { resetCloudBunkoMarkersForTest } from './cloud-bunko-marker';
import { seriesQueueStore, volumeQueueKey } from './server-ocr-pending';
import {
  connectedCloudLibrary,
  ensureMarkerPoller,
  followSeriesQueue,
  parseQueueFile,
  resetServerOcrQueueForTest,
  setQueueRelistHook,
  settleCloudCompletionsForTest,
  watchCloudUpload,
  watchedEntries
} from './server-ocr-queue';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const NOW_S = NOW / 1000;
const SERIES = 'Example Saga';
const KEY3 = volumeQueueKey(SERIES, 'Example Saga 03');

const SERIES_QUEUE_BLOCK = {
  v: 2,
  file: '.mokuro-series-queue.json',
  batch_s: 120,
  held: null,
  held_rows: [],
  clock: [
    [NOW_S, NOW_S],
    [NOW_S + 86_400, NOW_S + 86_400]
  ],
  clock_at: NOW_S
};

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
    queue: null,
    series_queue: SERIES_QUEUE_BLOCK,
    ...over
  };
}

function seriesBody(over: Record<string, unknown> = {}) {
  return {
    v: 2,
    instance_id: 'aaa',
    rev: 10,
    at: NOW_S,
    clock_at: NOW_S,
    series: SERIES,
    rows: [{ kind: 'ocr', id: 'hayai-nova' }],
    vols: { 'Example Saga 03': [[0, 'q', NOW_S + 600]] },
    done: {},
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

/** A provider whose control files are whatever the test says they are (`folder/name` for a series). */
function cloudProvider(type = 'google-drive') {
  const files: Record<string, ControlFileResult> = {};
  const readControlFile = vi.fn(
    async (name: string, opts?: { ifNoneMatch?: string; folder?: string }) => {
      const current = files[opts?.folder !== undefined ? `${opts.folder}/${name}` : name] ?? null;
      if (current && current !== 'not-modified' && opts?.ifNoneMatch === current.etag) {
        return 'not-modified' as const;
      }
      return current;
    }
  );
  return { provider: { type, readControlFile }, files, readControlFile };
}

const seriesPath = `${SERIES}/.mokuro-series-queue.json`;
const sliceOf = (series = SERIES) => get(seriesQueueStore).get(series.toLowerCase());
const reads = (c: ReturnType<typeof cloudProvider>, name: string) =>
  c.readControlFile.mock.calls.filter((call) => call[0] === name).length;

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

describe('parseQueueFile (cloud copy, from a 0.8 pre-release)', () => {
  it('still reads instance_id, truncated and done[]; a bunko server file has none', () => {
    const plain = parseQueueFile({ version: 1, volumes: [] });
    expect(plain?.instance_id).toBeUndefined();
    expect(plain?.truncated).toBe(false);
    expect(plain?.done).toEqual([]);
  });
});

describe('the marker poll (no root queue file any more)', () => {
  it('reads only the marker, every ttl/3 (300 s), never .mokuro-queue.json', async () => {
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '1', body: markerBody() });
    c.files['.mokuro-queue.json'] = nodes({ id: 'q1', etag: '1', body: { version: 1 } });
    const poller = await ensureMarkerPoller();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller?.id).toBe('cloud:google-drive');
    expect(reads(c, '.mokuro-bunko.json')).toBe(1);
    expect(poller?.nextDelayMs).toBe(300_000);
    await vi.advanceTimersByTimeAsync(299_000);
    expect(reads(c, '.mokuro-bunko.json')).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads(c, '.mokuro-bunko.json')).toBe(2);
    expect(reads(c, '.mokuro-queue.json')).toBe(0);
  });

  it('a longer lease reads less often (ttl/3)', async () => {
    const c = cloudProvider('mega');
    getActiveProvider.mockReturnValue(c.provider);
    c.files['.mokuro-bunko.json'] = nodes({
      id: 'm1',
      etag: '1',
      body: markerBody({ ttl_s: 3600 })
    });
    const poller = await ensureMarkerPoller();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller?.nextDelayMs).toBe(1_200_000);
  });

  it('a failed read backs off 60 s, then 120 s', async () => {
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    c.readControlFile.mockRejectedValue(new Error('offline'));
    const poller = await ensureMarkerPoller();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller?.nextDelayMs).toBe(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poller?.nextDelayMs).toBe(120_000);
  });

  it('a Local Folder library is polled like any other; one without control files is not', async () => {
    getActiveProvider.mockReturnValue(cloudProvider('filesystem').provider);
    expect(await connectedCloudLibrary()).toBe('filesystem');
    getActiveProvider.mockReturnValue({ type: 'filesystem' });
    expect(await connectedCloudLibrary()).toBeNull();
    expect(await ensureMarkerPoller()).toBeNull();
  });

  it('MEGA: a root control-file event triggers a look; a series file event does not', async () => {
    const c = cloudProvider('mega');
    let fire: (name: string, folder?: string) => void = () => {};
    const provider = {
      ...c.provider,
      onControlFileChange: vi.fn((listener: (name: string, folder?: string) => void) => {
        fire = listener;
        return () => {};
      })
    };
    getActiveProvider.mockReturnValue(provider);
    c.files['.mokuro-bunko.json'] = nodes({ id: 'h1', etag: 'h1', body: markerBody() });
    await ensureMarkerPoller();
    await vi.advanceTimersByTimeAsync(0);
    const before = reads(c, '.mokuro-bunko.json');
    fire('.mokuro-series-queue.json', SERIES);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads(c, '.mokuro-bunko.json')).toBe(before);
    fire('.mokuro-bunko.json');
    await vi.advanceTimersByTimeAsync(0);
    expect(reads(c, '.mokuro-bunko.json')).toBe(before + 1);
    expect(provider.onControlFileChange).toHaveBeenCalledTimes(1);
  });
});

describe('a series page on a cloud library', () => {
  async function connect(marker = markerBody()) {
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '1', body: marker });
    await ensureMarkerPoller();
    await vi.advanceTimersByTimeAsync(0);
    return c;
  }

  it('reads exactly its series file, and shows its jobs under the marker clock', async () => {
    const c = await connect();
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    const stop = await followSeriesQueue(SERIES);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.readControlFile).toHaveBeenCalledWith('.mokuro-series-queue.json', {
      folder: SERIES,
      ifNoneMatch: undefined
    });
    expect(reads(c, '.mokuro-queue.json')).toBe(0);
    const status = sliceOf()?.get('example saga 03');
    expect(status?.jobs).toEqual([
      expect.objectContaining({
        kind: 'ocr',
        id: 'hayai-nova',
        state: 'queued',
        eta: new Date(NOW + 600_000).toISOString()
      })
    ]);
    // Drive: max(floor 60 s, batch_s 120 s), with the version token.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.readControlFile).toHaveBeenLastCalledWith('.mokuro-series-queue.json', {
      folder: SERIES,
      ifNoneMatch: 's1=1'
    });
    stop();
  });

  it('without a holder that carries series_queue nothing is read or shown', async () => {
    const marker = markerBody();
    delete (marker as Record<string, unknown>).series_queue;
    const c = await connect(marker);
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    const stop = await followSeriesQueue(SERIES);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads(c, '.mokuro-series-queue.json')).toBe(0);
    expect(sliceOf()).toBeUndefined();
    stop();
  });

  it('a file another Bunko wrote is not trusted', async () => {
    const c = await connect();
    c.files[seriesPath] = nodes({
      id: 's1',
      etag: '1',
      body: seriesBody({ instance_id: 'someone-else' })
    });
    const stop = await followSeriesQueue(SERIES);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads(c, '.mokuro-series-queue.json')).toBe(1);
    expect(sliceOf()).toBeUndefined();
    stop();
  });

  it('a finished volume: relist, upgrade pass and layer pull for its series', async () => {
    await db.volumes.put({
      volume_uuid: 'v3',
      series_uuid: 's',
      series_title: SERIES,
      volume_title: 'Example Saga 03',
      mokuro_version: '',
      page_count: 1,
      character_count: 0,
      page_char_counts: [0]
    } as never);
    const relist = vi.fn(async () => {});
    setQueueRelistHook(relist);
    const c = await connect();
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    const stop = await followSeriesQueue(SERIES);
    await vi.advanceTimersByTimeAsync(0);
    expect(relist).not.toHaveBeenCalled();

    c.files[seriesPath] = nodes({
      id: 's1',
      etag: '2',
      body: seriesBody({ rev: 11, vols: {}, done: { 'Example Saga 03': NOW_S + 60 } })
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await settleCloudCompletionsForTest();
    expect(relist).toHaveBeenCalledTimes(1);
    expect(requestOcrUpgradePass).toHaveBeenCalledWith('google-drive', [{ title: SERIES }]);
    expect(pullLayersForVolume).toHaveBeenCalledWith('v3', 'google-drive');
    expect(loadVolumeManifest).not.toHaveBeenCalled();
    expect(sliceOf()?.size).toBe(0);
    stop();
  });

  it('a refit in the marker moves the ETAs without reading the series file again', async () => {
    const c = await connect();
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    const stop = await followSeriesQueue(SERIES);
    await vi.advanceTimersByTimeAsync(0);
    const before = reads(c, '.mokuro-series-queue.json');
    // Bunko halved its speed: twice the time per unit of work.
    c.files['.mokuro-bunko.json'] = nodes({
      id: 'm1',
      etag: '2',
      body: markerBody({
        series_queue: {
          ...SERIES_QUEUE_BLOCK,
          clock: [
            [NOW_S, NOW_S],
            [NOW_S + 86_400, NOW_S + 2 * 86_400]
          ]
        }
      })
    });
    const poller = await ensureMarkerPoller();
    poller!.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads(c, '.mokuro-series-queue.json')).toBe(before);
    expect(sliceOf()?.get('example saga 03')?.jobs[0].eta).toBe(
      new Date(NOW + 1_200_000).toISOString()
    );
    stop();
  });
});

describe('a cloud upload is watched', () => {
  it('by (series, volume), only while a holder with series_queue is fresh; no poller', async () => {
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    await watchCloudUpload({ volumeUuid: 'v3', series: SERIES, volume: 'Example Saga 03' });
    expect(watchedEntries()).toEqual([]);

    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '1', body: markerBody() });
    await ensureMarkerPoller();
    await vi.advanceTimersByTimeAsync(0);
    const before = c.readControlFile.mock.calls.length;
    await watchCloudUpload({ volumeUuid: 'v3', series: SERIES, volume: 'Example Saga 03' });
    await vi.advanceTimersByTimeAsync(0);
    expect(watchedEntries()).toEqual([
      expect.objectContaining({
        key: KEY3,
        queue_url: 'cloud:google-drive',
        manifest_url: '',
        auth: 'cloud',
        source: 'google-drive'
      })
    ]);
    // Nothing is read for it outside its series page.
    expect(c.readControlFile.mock.calls.length).toBe(before);
  });

  it('a marker from a Bunko without series files watches nothing', async () => {
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    const marker = markerBody();
    delete (marker as Record<string, unknown>).series_queue;
    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '1', body: marker });
    await ensureMarkerPoller();
    await vi.advanceTimersByTimeAsync(0);
    await watchCloudUpload({ volumeUuid: 'v3', series: SERIES, volume: 'Example Saga 03' });
    expect(watchedEntries()).toEqual([]);
  });
});
