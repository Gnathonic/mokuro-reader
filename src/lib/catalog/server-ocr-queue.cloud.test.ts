/**
 * A cloud-direct Bunko (queue file v2): no root queue file is read. The lease
 * marker is polled every ttl/3, and a series page reads its own series file
 * through the provider, trusted only when the marker's holder wrote it. A
 * finished volume is pulled by listing its one series (§8.6), and a watched
 * upload's series file is read on the watch schedule (§8.7).
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
const refreshSeriesFolder = vi.hoisted(() => vi.fn());
const fetchAllCloudVolumes = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    resolveCloudFolderTitle: (title: string) => title,
    getCloudVolumesBySeries: () => [{}],
    refreshSeriesFolder,
    fetchAllCloudVolumes
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
  flushWatches,
  pendingSeriesPullsForTest,
  resetServerOcrQueueForTest,
  SERIES_PULL_DEBOUNCE_MS,
  SERIES_PULL_RETRY_MS,
  settleSeriesPullsForTest,
  startServerOcrQueue,
  watchCloudUpload,
  watchedEntries,
  watchServerOcr
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

async function putVolume3(): Promise<void> {
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
}

/** A file of the series as the listing holds it. */
function listed(name: string, modified: number) {
  return {
    provider: 'google-drive' as const,
    fileId: `id-${name}`,
    path: `${SERIES}/${name}`,
    modifiedTime: new Date(modified).toISOString(),
    size: 10
  };
}

/** Advance the clock, then wait out the pulls that came due. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settleSeriesPullsForTest();
}

/** What `refreshSeriesFolder` answers: the folder's files now, and the paths that moved. */
function refreshed(files: ReturnType<typeof listed>[], changed: string[]) {
  return { providerType: 'google-drive', folder: SERIES, files, changed };
}

beforeEach(async () => {
  // setImmediate stays real: fake-indexeddb runs on it.
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  localStorage.clear();
  resetServerOcrQueueForTest();
  resetCloudBunkoMarkersForTest();
  vi.clearAllMocks();
  getActiveProvider.mockReturnValue(null);
  refreshSeriesFolder.mockResolvedValue(null);
  await db.volumes.clear();
});

afterEach(() => {
  resetServerOcrQueueForTest();
  vi.useRealTimers();
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

  it('a finished volume: its series is listed, then the upgrade pass and its layer pull', async () => {
    await putVolume3();
    const sidecar = listed('Example Saga 03.mokuro', NOW + 60_000);
    refreshSeriesFolder.mockResolvedValue(refreshed([sidecar], [sidecar.path]));
    const c = await connect();
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    const stop = await followSeriesQueue(SERIES);
    await vi.advanceTimersByTimeAsync(0);

    c.files[seriesPath] = nodes({
      id: 's1',
      etag: '2',
      body: seriesBody({ rev: 11, vols: {}, done: { 'Example Saga 03': NOW_S + 60 } })
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sliceOf()?.size).toBe(0);
    expect(refreshSeriesFolder).not.toHaveBeenCalled(); // debounced
    await vi.advanceTimersByTimeAsync(SERIES_PULL_DEBOUNCE_MS);
    await vi.waitFor(() => expect(pullLayersForVolume).toHaveBeenCalledWith('v3', 'google-drive'));
    expect(refreshSeriesFolder).toHaveBeenCalledExactlyOnceWith(SERIES);
    expect(requestOcrUpgradePass).toHaveBeenCalledWith('google-drive', [
      { title: SERIES, files: [sidecar] }
    ]);
    // Never the whole account, never a manifest.
    expect(fetchAllCloudVolumes).not.toHaveBeenCalled();
    expect(loadVolumeManifest).not.toHaveBeenCalled();
    stop();
  });

  it('a pull that brought nothing new is tried again at +60 s, +120 s and +240 s, then left', async () => {
    refreshSeriesFolder.mockResolvedValue(refreshed([], []));
    const c = await connect();
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    const stop = await followSeriesQueue(SERIES);
    await vi.advanceTimersByTimeAsync(0);
    c.files[seriesPath] = nodes({ id: 's1', etag: '2', body: seriesBody({ rev: 11, vols: {} }) });
    await vi.advanceTimersByTimeAsync(120_000);
    await advance(SERIES_PULL_DEBOUNCE_MS);
    expect(refreshSeriesFolder).toHaveBeenCalledTimes(1);
    stop();
    for (const [i, wait] of SERIES_PULL_RETRY_MS.entries()) {
      await advance(wait - 1);
      expect(refreshSeriesFolder).toHaveBeenCalledTimes(1 + i);
      await advance(1);
      expect(refreshSeriesFolder).toHaveBeenCalledTimes(2 + i);
    }
    await advance(3_600_000);
    expect(refreshSeriesFolder).toHaveBeenCalledTimes(1 + SERIES_PULL_RETRY_MS.length);
    expect(pendingSeriesPullsForTest()).toBe(0);
  });

  it('a retry stops once series.json or a sidecar of the finished volume moved', async () => {
    const seriesJson = listed('series.json', NOW + 90_000);
    refreshSeriesFolder
      .mockResolvedValueOnce(refreshed([], []))
      .mockResolvedValueOnce(refreshed([seriesJson], [seriesJson.path]));
    const c = await connect();
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    const stop = await followSeriesQueue(SERIES);
    await vi.advanceTimersByTimeAsync(0);
    c.files[seriesPath] = nodes({ id: 's1', etag: '2', body: seriesBody({ rev: 11, vols: {} }) });
    await vi.advanceTimersByTimeAsync(120_000);
    stop();
    await advance(SERIES_PULL_DEBOUNCE_MS);
    expect(refreshSeriesFolder).toHaveBeenCalledTimes(1);
    await advance(SERIES_PULL_RETRY_MS[0]);
    expect(refreshSeriesFolder).toHaveBeenCalledTimes(2);
    await advance(3_600_000);
    expect(refreshSeriesFolder).toHaveBeenCalledTimes(2);
  });

  it('two series finishing at once are each pulled on their own', async () => {
    refreshSeriesFolder.mockImplementation(async (title: string) => ({
      ...refreshed([], [`${title}/series.json`]),
      folder: title
    }));
    const c = await connect();
    const other = 'Other Saga';
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    c.files[`${other}/.mokuro-series-queue.json`] = nodes({
      id: 'o1',
      etag: '1',
      body: seriesBody({ series: other, vols: { 'Other Saga 01': [[0, 'q', NOW_S + 600]] } })
    });
    const stopA = await followSeriesQueue(SERIES);
    const stopB = await followSeriesQueue(other);
    await vi.advanceTimersByTimeAsync(0);
    c.files[seriesPath] = nodes({ id: 's1', etag: '2', body: seriesBody({ rev: 11, vols: {} }) });
    c.files[`${other}/.mokuro-series-queue.json`] = nodes({
      id: 'o1',
      etag: '2',
      body: seriesBody({ series: other, rev: 11, vols: {} })
    });
    await vi.advanceTimersByTimeAsync(120_000 + SERIES_PULL_DEBOUNCE_MS);
    expect(refreshSeriesFolder.mock.calls.map((call) => call[0]).sort()).toEqual([SERIES, other]);
    stopA();
    stopB();
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
  async function connect(marker = markerBody()) {
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '1', body: marker });
    await ensureMarkerPoller();
    await vi.advanceTimersByTimeAsync(0);
    return c;
  }
  const watch3 = () =>
    watchCloudUpload({ volumeUuid: 'v3', series: SERIES, volume: 'Example Saga 03' });
  const seriesReads = (c: ReturnType<typeof cloudProvider>) =>
    c.readControlFile.mock.calls.filter((call) => call[1]?.folder === SERIES).length;
  /** Drive's floor is 60 s, the marker's batch_s 120 s: W = 120 s. */
  const W = 120_000;

  it('by (series, volume), only while a holder with series_queue is fresh', async () => {
    const c = cloudProvider();
    getActiveProvider.mockReturnValue(c.provider);
    await watch3();
    expect(watchedEntries()).toEqual([]);

    c.files['.mokuro-bunko.json'] = nodes({ id: 'm1', etag: '1', body: markerBody() });
    await ensureMarkerPoller();
    await vi.advanceTimersByTimeAsync(0);
    const before = c.readControlFile.mock.calls.length;
    await watch3();
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
    // Nothing is read for it at once.
    expect(c.readControlFile.mock.calls.length).toBe(before);
  });

  it('a marker from a Bunko without series files watches nothing', async () => {
    const marker = markerBody();
    delete (marker as Record<string, unknown>).series_queue;
    await connect(marker);
    await watch3();
    expect(watchedEntries()).toEqual([]);
  });

  it('its series file is read at creation + 2 W, then at its ETA + W; done ends the watch', async () => {
    await putVolume3();
    const sidecar = listed('Example Saga 03.mokuro', NOW + 700_000);
    refreshSeriesFolder.mockResolvedValue(refreshed([sidecar], [sidecar.path]));
    const c = await connect();
    // Queued, ETA NOW + 600 s under the identity clock.
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    await watch3();
    await vi.advanceTimersByTimeAsync(2 * W - 1);
    expect(seriesReads(c)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(seriesReads(c)).toBe(1);
    // The card of the volume, though its page is not open, shows its job.
    expect(sliceOf()?.get('example saga 03')?.jobs[0].state).toBe('queued');

    c.files[seriesPath] = nodes({
      id: 's1',
      etag: '2',
      body: seriesBody({ rev: 11, vols: {}, done: { 'Example Saga 03': NOW_S + 650 } })
    });
    // Next: the ETA (NOW + 600 s) + W = NOW + 720 s.
    await vi.advanceTimersByTimeAsync(720_000 - 2 * W - 1);
    expect(seriesReads(c)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(seriesReads(c)).toBe(2);
    expect(watchedEntries()).toEqual([]);
    await advance(SERIES_PULL_DEBOUNCE_MS);
    expect(refreshSeriesFolder).toHaveBeenCalledExactlyOnceWith(SERIES);
    expect(pullLayersForVolume).toHaveBeenCalledWith('v3', 'google-drive');
    // Nothing left to watch: no more reads.
    await advance(3_600_000);
    expect(seriesReads(c)).toBe(2);
  });

  it('never listed after 2 reads: one scoped pull; a .mokuro newer than the watch completes it', async () => {
    const c = await connect();
    c.files[seriesPath] = nodes({
      id: 's1',
      etag: '1',
      body: seriesBody({ vols: { 'Example Saga 04': [[0, 'q', NOW_S + 600]] } })
    });
    const sidecar = listed('Example Saga 03.mokuro', NOW + 100_000);
    refreshSeriesFolder.mockResolvedValue(refreshed([sidecar], [sidecar.path]));
    await watch3();
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(seriesReads(c)).toBe(1);
    expect(refreshSeriesFolder).not.toHaveBeenCalled();
    // A second read 2 W later, then the pull.
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(seriesReads(c)).toBe(2);
    await advance(SERIES_PULL_DEBOUNCE_MS);
    expect(refreshSeriesFolder).toHaveBeenCalledTimes(1);
    expect(watchedEntries()).toEqual([]);
  });

  it('never listed, and nothing newer in the listing: the watch stays, read every 15 min', async () => {
    // A lease long enough that the marker stays fresh through the test.
    const c = await connect(markerBody({ ttl_s: 7_200 }));
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody({ vols: {} }) });
    const old = listed('Example Saga 03.mokuro', NOW - 3_600_000);
    refreshSeriesFolder.mockResolvedValue(refreshed([old], []));
    await watch3();
    await vi.advanceTimersByTimeAsync(4 * W);
    await advance(SERIES_PULL_DEBOUNCE_MS);
    expect(refreshSeriesFolder).toHaveBeenCalledTimes(1);
    expect(watchedEntries()).toHaveLength(1);
    const reads = seriesReads(c);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(seriesReads(c)).toBe(reads + 1);
    // One absent pull per watch: its retries aside, the later reads pull nothing.
    for (let i = 0; i < 60; i++) await advance(60_000);
    expect(refreshSeriesFolder).toHaveBeenCalledTimes(1 + SERIES_PULL_RETRY_MS.length);
    expect(watchedEntries()).toHaveLength(1);
  });

  it('its open series page reads it; the schedule does not', async () => {
    const c = await connect();
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    await watch3();
    const stop = await followSeriesQueue(SERIES);
    await vi.advanceTimersByTimeAsync(0);
    expect(seriesReads(c)).toBe(1);
    // The page reads every W; the schedule (due at 2 W) adds nothing.
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(seriesReads(c)).toBe(3);
    stop();
  });

  it('its open page never listing it: the one scoped pull still comes, with no read of its own', async () => {
    // Regression (rig S4/S6): with the page open the schedule read nothing, so a
    // watched volume the series file never listed waited the page out.
    const c = await connect(markerBody({ ttl_s: 7_200 }));
    c.files[seriesPath] = nodes({
      id: 's1',
      etag: '1',
      body: seriesBody({ vols: { 'Example Saga 04': [[0, 'q', NOW_S + 6_000]] } })
    });
    const sidecar = listed('Example Saga 03.mokuro', NOW + 100_000);
    refreshSeriesFolder.mockResolvedValue(refreshed([sidecar], [sidecar.path]));
    await watch3();
    const stop = await followSeriesQueue(SERIES);
    await vi.advanceTimersByTimeAsync(0);
    expect(seriesReads(c)).toBe(1);
    await vi.advanceTimersByTimeAsync(4 * W);
    // Only the page's reads (one per W).
    expect(seriesReads(c)).toBe(5);
    await advance(SERIES_PULL_DEBOUNCE_MS);
    expect(refreshSeriesFolder).toHaveBeenCalledTimes(1);
    expect(watchedEntries()).toEqual([]);
    stop();
  });

  it('nothing is read while another library is connected', async () => {
    const c = await connect();
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    await watch3();
    const other = cloudProvider('onedrive');
    getActiveProvider.mockReturnValue(other.provider);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(seriesReads(c)).toBe(0);
    expect(other.readControlFile.mock.calls.filter((call) => call[1]?.folder)).toEqual([]);
  });

  it('a burst of watches is written once, within a second; a hidden tab writes at once', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    try {
      for (let i = 0; i < 50; i++) {
        watchServerOcr(
          {
            volumeUuid: `v${i}`,
            series: SERIES,
            volume: `Example Saga ${i}`,
            queueUrl: 'cloud:google-drive',
            manifestUrl: '',
            auth: 'cloud',
            source: 'google-drive'
          },
          { start: false }
        );
      }
      expect(watchedEntries()).toHaveLength(50);
      const writes = () => setItem.mock.calls.filter((call) => call[0] === 'server-ocr-watch:v1');
      expect(writes()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writes()).toHaveLength(1);
      expect(JSON.parse(writes()[0][1])).toHaveLength(50);

      watchServerOcr(
        {
          volumeUuid: 'v50',
          series: SERIES,
          volume: 'Example Saga 50',
          queueUrl: 'cloud:google-drive',
          manifestUrl: '',
          auth: 'cloud',
          source: 'google-drive'
        },
        { start: false }
      );
      flushWatches();
      expect(writes()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writes()).toHaveLength(2);
    } finally {
      setItem.mockRestore();
    }
  });

  it('app start plans the persisted watches', async () => {
    const c = await connect();
    c.files[seriesPath] = nodes({ id: 's1', etag: '1', body: seriesBody() });
    await watch3();
    flushWatches();
    resetServerOcrQueueForTest(); // a new session: the watch comes back from storage
    getActiveProvider.mockReturnValue(c.provider);
    await startServerOcrQueue();
    await vi.advanceTimersByTimeAsync(2 * W);
    expect(seriesReads(c)).toBe(1);
  });
});
