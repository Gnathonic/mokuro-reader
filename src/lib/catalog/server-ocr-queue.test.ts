/**
 * Addendum C: ONE poller per bunko server reads `<dav root>/.mokuro-queue.json`
 * and drives the "Server OCR" status and the pull of finished volumes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { get } from 'svelte/store';

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_server_ocr_queue_test') };
});
const upgradeOcrFromSidecarBlob = vi.hoisted(() => vi.fn());
vi.mock('$lib/catalog/cloud-ocr-upgrade', () => ({ upgradeOcrFromSidecarBlob }));
const importFetchedLayers = vi.hoisted(() => vi.fn());
vi.mock('$lib/metadata/layer-sync', () => ({ importFetchedLayers }));
const getActiveProvider = vi.hoisted(() => vi.fn(() => null as unknown));
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { getActiveProvider: () => getActiveProvider() }
}));

import { db } from '$lib/catalog/db';
import { clearAllLayers } from '$lib/catalog/layer-store';
import { queueFixture } from './__fixtures__/mokuro-queue';
import { markVolumeShown, serverOcrQueueStatus, volumeQueueKey } from './server-ocr-pending';
import {
  LEGACY_RECHECK_KEY,
  QUEUE_BACKOFF_MS,
  QueuePoller,
  cleanupLegacyRecheckEntries,
  parseQueueFile,
  pullCompletedVolume,
  queueUrlForArchive,
  queueUrlForWebdav,
  resetServerOcrQueueForTest,
  startServerOcrQueue,
  watchServerOcr,
  watchedEntries
} from './server-ocr-queue';

const QUEUE = 'https://bunko.example/mokuro-reader/.mokuro-queue.json';
const NOW = Date.parse('2026-09-28T15:00:00Z');
const KEY1 = volumeQueueKey('Dr Stone', 'Dr Stone 01');
const KEY2 = volumeQueueKey('Dr Stone', 'Dr Stone 02');

type Answer = { status: number; body?: unknown; etag?: string } | Error;

function response(a: Exclude<Answer, Error>) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (a.etag) headers.ETag = a.etag;
  return new Response(a.status === 304 ? null : JSON.stringify(a.body ?? {}), {
    status: a.status,
    headers
  });
}

describe('parseQueueFile', () => {
  it('reads the spec body', () => {
    const file = parseQueueFile(queueFixture(NOW))!;
    expect(file.next_check_after).toBe(95);
    expect(file.held).toBeNull();
    expect(file.volumes.map((v) => [v.series, v.volume, v.jobs.length])).toEqual([
      ['Dr Stone', 'Dr Stone 01', 3],
      ['Dr Stone', 'Dr Stone 02', 1]
    ]);
    expect(file.volumes[0].jobs[0]).toEqual({
      kind: 'ocr',
      id: 'mokuro-fp16',
      state: 'running',
      eta: expect.any(String),
      progress: 0.42
    });
  });

  it('refuses another version or a body without volumes, and drops junk entries', () => {
    expect(parseQueueFile({ ...queueFixture(NOW), version: 2 })).toBeNull();
    expect(parseQueueFile({ version: 1 })).toBeNull();
    const file = parseQueueFile({
      ...queueFixture(NOW),
      held: { reason: 'no-processor' },
      next_check_after: null,
      volumes: [
        ...queueFixture(NOW).volumes,
        { series: 'x' },
        { series: 'S', volume: 'V', jobs: [{ kind: 'weird', id: 'a', state: 'queued' }] }
      ]
    })!;
    expect(file.held).toEqual({ reason: 'no-processor' });
    expect(file.next_check_after).toBeNull();
    expect(file.volumes).toHaveLength(3);
    expect(file.volumes[2].jobs).toEqual([]);
  });
});

describe('QueuePoller', () => {
  let answers: Answer[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let hidden: boolean;
  let watched: string[];
  let shownKeys: Set<string>;
  let statuses: Array<unknown>;
  let done: string[];
  let init: RequestInit | null;

  function poller() {
    return new QueuePoller({
      queueUrl: QUEUE,
      requestInit: async () => init,
      watchedKeys: () => watched,
      isShown: (k) => shownKeys.has(k),
      onStatus: (file) => statuses.push(file),
      onDone: (key) => done.push(key),
      isHidden: () => hidden,
      fetch: fetchMock as unknown as typeof fetch
    });
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    answers = [];
    hidden = false;
    watched = [KEY1];
    shownKeys = new Set();
    statuses = [];
    done = [];
    init = { cache: 'no-store' };
    fetchMock = vi.fn(async () => {
      const a = answers.shift() ?? { status: 200, body: queueFixture(NOW), etag: '"e1"' };
      if (a instanceof Error) throw a;
      return response(a);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('an upload starts it at once; it waits next_check_after, then asks with If-None-Match', async () => {
    const p = poller();
    p.trigger('upload');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(QUEUE);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    expect(p.nextDelayMs).toBe(95_000);

    answers = [{ status: 304 }];
    await vi.advanceTimersByTimeAsync(94_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ 'If-None-Match': '"e1"' });
    // A 304 keeps the last file: still interesting, still polling.
    expect(p.nextDelayMs).toBe(95_000);
    expect(done).toEqual([]);
  });

  it('never polls faster than every 30 s, and waits 5 min when nothing is priced', async () => {
    answers = [{ status: 200, body: { ...queueFixture(NOW), next_check_after: 5 } }];
    const p = poller();
    p.trigger('upload');
    await settle();
    expect(p.nextDelayMs).toBe(30_000);
    answers = [{ status: 200, body: { ...queueFixture(NOW), next_check_after: null } }];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(p.nextDelayMs).toBe(300_000);
  });

  it('stops when no volume of interest is in the file, and resumes on the next trigger', async () => {
    watched = [];
    const p = poller();
    p.trigger('start');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(p.state).toBe('idle');
    expect(p.nextDelayMs).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    watched = [KEY1];
    p.trigger('upload');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(p.state).toBe('waiting');
  });

  it('keeps polling for a volume the catalog is showing', async () => {
    watched = [];
    shownKeys = new Set([KEY2]);
    const p = poller();
    p.trigger('start');
    await settle();
    expect(p.state).toBe('waiting');
  });

  it('reports a watched volume that left the file as done, once', async () => {
    const p = poller();
    p.trigger('upload');
    await settle();
    expect(done).toEqual([]);
    const without1 = queueFixture(NOW);
    without1.volumes = without1.volumes.slice(1);
    answers = [{ status: 200, body: without1, etag: '"e2"' }];
    await vi.advanceTimersByTimeAsync(95_000);
    expect(done).toEqual([KEY1]);
    // Nothing of interest left: it stops.
    expect(p.state).toBe('idle');
  });

  it('reports a shown volume that was pending and left as done', async () => {
    watched = [];
    shownKeys = new Set([KEY2]);
    const p = poller();
    p.trigger('start');
    await settle();
    const without2 = queueFixture(NOW);
    without2.volumes = without2.volumes.slice(0, 1);
    answers = [{ status: 200, body: without2 }];
    await vi.advanceTimersByTimeAsync(95_000);
    expect(done).toEqual([KEY2]);
  });

  it('a watched volume never seen in the file is already done', async () => {
    watched = [volumeQueueKey('Other', 'Other 01')];
    const p = poller();
    p.trigger('upload');
    await settle();
    expect(done).toEqual([volumeQueueKey('Other', 'Other 01')]);
  });

  it('backs off 60 s, 120 s … up to 10 min on errors, and resets on success', async () => {
    expect(QUEUE_BACKOFF_MS).toEqual([60_000, 120_000, 240_000, 480_000, 600_000]);
    answers = [
      new TypeError('Failed to fetch'),
      { status: 502 },
      { status: 200, body: { nope: true } },
      new TypeError('x'),
      new TypeError('x'),
      new TypeError('x')
    ];
    const p = poller();
    p.trigger('upload');
    await settle();
    const delays: Array<number | null> = [p.nextDelayMs];
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(p.nextDelayMs!);
      delays.push(p.nextDelayMs);
    }
    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    // Next answer is the default 200: back to the file's own interval.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(p.nextDelayMs).toBe(95_000);
  });

  it('pauses while the tab is hidden and polls once when it is visible again', async () => {
    const p = poller();
    p.trigger('upload');
    await settle();
    hidden = true;
    p.onVisibilityChange();
    expect(p.state).toBe('paused');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    hidden = false;
    p.onVisibilityChange();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(p.state).toBe('waiting');
  });

  it('a trigger while hidden waits for the tab to come back', async () => {
    hidden = true;
    const p = poller();
    p.trigger('upload');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    hidden = false;
    p.onVisibilityChange();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces a trigger that arrives mid-fetch into one more poll', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(response({ status: 200, body: queueFixture(NOW), etag: '"e1"' }));
        })
    );
    const p = poller();
    p.trigger('upload');
    await settle();
    p.trigger('upload');
    p.trigger('upload');
    release();
    await settle();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not poll without the account it needs', async () => {
    init = null;
    const p = poller();
    p.trigger('upload');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(p.state).toBe('idle');
  });

  it('publishes the file, and withdraws it when it stops', async () => {
    const p = poller();
    p.trigger('upload');
    await settle();
    expect(statuses.at(-1)).toMatchObject({ version: 1 });
    watched = [];
    const empty = { ...queueFixture(NOW), volumes: [], next_check_after: null };
    answers = [{ status: 200, body: empty }];
    await vi.advanceTimersByTimeAsync(95_000);
    expect(statuses.at(-1)).toBeNull();
  });
});

describe('pulling a volume whose jobs are done', () => {
  const routes = new Map<string, string | number>();

  beforeEach(async () => {
    resetServerOcrQueueForTest();
    localStorage.clear();
    routes.clear();
    upgradeOcrFromSidecarBlob.mockReset().mockResolvedValue(true);
    importFetchedLayers.mockReset().mockResolvedValue(2);
    await Promise.all([
      db.volumes.clear(),
      db.volume_ocr.clear(),
      db.volume_files.clear(),
      clearAllLayers(db)
    ]);
    await db.volumes.put({
      volume_uuid: 'v1',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'Dr Stone 01',
      mokuro_version: '',
      page_count: 4,
      character_count: 0,
      page_char_counts: [0, 0, 0, 0]
    } as never);
    await db.volume_ocr.put({ volume_uuid: 'v1', pages: [] });
    await db.volume_files.put({ volume_uuid: 'v1', files: {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const r = routes.get(String(url));
        if (r === undefined) return new Response('', { status: 404 });
        if (typeof r === 'number') return new Response('', { status: r });
        return new Response(r, { status: 200 });
      })
    );
    const base = 'https://bunko.example/mokuro-reader/Dr%20Stone/';
    routes.set(
      'https://bunko.example/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001',
      JSON.stringify({
        version: 1,
        archive: { url: `/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz` },
        ocr: { url: `/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.mokuro` },
        layers: [
          { id: 'hayai-nova', url: `/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.hayai-nova.mokuro` },
          { id: 'paddle', url: `/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.paddle.mokuro.gz` }
        ],
        pending: [],
        recheck_after: null
      })
    );
    routes.set(`${base}Dr%20Stone%2001.mokuro`, '{"pages":[]}');
    routes.set(`${base}Dr%20Stone%2001.hayai-nova.mokuro`, '{"pages":[]}');
    routes.set(`${base}Dr%20Stone%2001.paddle.mokuro.gz`, 'gz');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetServerOcrQueueForTest();
  });

  const entry = {
    series: 'Dr Stone',
    volume: 'Dr Stone 01',
    path: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz',
    manifest: '/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001',
    jobs: []
  };
  const target = { queueUrl: QUEUE, init: { cache: 'no-store' as const }, source: 'webdav' };

  it('pulls the primary through the OCR upgrade and the layers through the shared importer', async () => {
    expect(await pullCompletedVolume(KEY1, entry, target)).toBe(true);
    expect(upgradeOcrFromSidecarBlob).toHaveBeenCalledWith(
      'v1',
      'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.mokuro',
      expect.any(Blob)
    );
    const [uuid, source, files] = importFetchedLayers.mock.calls[0];
    expect([uuid, source]).toEqual(['v1', 'webdav']);
    expect(files.map((f: { layerId: string; gz: boolean }) => [f.layerId, f.gz])).toEqual([
      ['hayai-nova', false],
      ['paddle', true]
    ]);
  });

  it('runs at most one pull per volume at a time', async () => {
    const a = pullCompletedVolume(KEY1, entry, target);
    const b = pullCompletedVolume(KEY1, entry, target);
    expect(b).toBe(a);
    await a;
    expect(upgradeOcrFromSidecarBlob).toHaveBeenCalledTimes(1);
    expect(importFetchedLayers).toHaveBeenCalledTimes(1);
  });

  it('forgets the watch once the pull went through', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      watchServerOcr(
        {
          volumeUuid: 'v1',
          series: 'Dr Stone',
          volume: 'Dr Stone 01',
          queueUrl: QUEUE,
          manifestUrl:
            'https://bunko.example/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001',
          auth: 'none',
          source: 'html-download'
        },
        { start: false }
      );
      expect(watchedEntries().map((w) => w.key)).toEqual([KEY1]);
      await pullCompletedVolume(KEY1, entry, target);
      expect(watchedEntries()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed manifest read is quiet and keeps the watch for the next time', async () => {
    routes.clear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    watchServerOcr(
      {
        volumeUuid: 'v1',
        series: 'Dr Stone',
        volume: 'Dr Stone 01',
        queueUrl: QUEUE,
        manifestUrl: 'https://bunko.example/m',
        auth: 'none',
        source: 'html-download'
      },
      { start: false }
    );
    expect(await pullCompletedVolume(KEY1, entry, target)).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(watchedEntries()).toHaveLength(1);
    warn.mockRestore();
  });

  it('finds the local row by its titles when nothing was watched', async () => {
    expect(await pullCompletedVolume(KEY1, entry, target)).toBe(true);
    expect(upgradeOcrFromSidecarBlob.mock.calls[0][0]).toBe('v1');
  });

  it('does nothing for a volume this device does not have', async () => {
    const other = { ...entry, volume: 'Dr Stone 09' };
    expect(
      await pullCompletedVolume(volumeQueueKey('Dr Stone', 'Dr Stone 09'), other, target)
    ).toBe(false);
    expect(upgradeOcrFromSidecarBlob).not.toHaveBeenCalled();
  });
});

describe('the status the views read', () => {
  it('maps every volume in a polled file to its key', async () => {
    resetServerOcrQueueForTest();
    const { publishQueueStatus } = await import('./server-ocr-queue');
    publishQueueStatus(QUEUE, parseQueueFile({ ...queueFixture(NOW), held: { reason: 'paused' } }));
    const status = get(serverOcrQueueStatus);
    expect(status[KEY1].jobs).toHaveLength(3);
    expect(status[KEY2].held).toEqual({ reason: 'paused' });
    publishQueueStatus(QUEUE, null);
    expect(get(serverOcrQueueStatus)).toEqual({});
    const unmark = markVolumeShown(KEY1);
    unmark();
  });
});

describe('cleanup of the old per-volume rechecks', () => {
  it('removes their persisted entries once, and is harmless after', () => {
    localStorage.setItem(LEGACY_RECHECK_KEY, JSON.stringify([{ volume_uuid: 'v1' }]));
    localStorage.setItem('unrelated', 'kept');
    cleanupLegacyRecheckEntries();
    expect(localStorage.getItem(LEGACY_RECHECK_KEY)).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('kept');
    cleanupLegacyRecheckEntries();
    expect(localStorage.getItem('unrelated')).toBe('kept');
  });
});

describe('queue URLs', () => {
  it('sits at the WebDAV root', () => {
    expect(queueUrlForWebdav('http://127.0.0.1:8090/')).toBe(
      'http://127.0.0.1:8090/mokuro-reader/.mokuro-queue.json'
    );
    expect(
      queueUrlForArchive('https://b.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz')
    ).toBe('https://b.example/mokuro-reader/.mokuro-queue.json');
    expect(queueUrlForArchive('https://b.example/V.cbz')).toBeNull();
  });
});

describe('startServerOcrQueue (app start)', () => {
  const CONNECTED = 'http://127.0.0.1:8090/mokuro-reader/.mokuro-queue.json';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    resetServerOcrQueueForTest();
    localStorage.clear();
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ...queueFixture(NOW), volumes: [], next_check_after: null }),
          {
            status: 200,
            headers: { ETag: '"e"' }
          }
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    getActiveProvider.mockReturnValue({
      type: 'webdav',
      getWorkerUploadCredentials: async () => ({
        webdavUrl: 'http://127.0.0.1:8090',
        webdavUsername: 'reader',
        webdavPassword: 'pw',
        webdavPutVerified: true
      })
    });
  });

  afterEach(() => {
    resetServerOcrQueueForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    getActiveProvider.mockReturnValue(null);
  });

  it('drops the old recheck entries and polls every known server once', async () => {
    localStorage.setItem(LEGACY_RECHECK_KEY, '[{"volume_uuid":"v1"}]');
    watchServerOcr(
      {
        volumeUuid: 'v9',
        series: 'S',
        volume: 'V',
        queueUrl: QUEUE,
        manifestUrl: 'https://bunko.example/m',
        auth: 'none',
        source: 'html-download'
      },
      { start: false }
    );
    await startServerOcrQueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(localStorage.getItem(LEGACY_RECHECK_KEY)).toBeNull();
    const urls = fetchMock.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual([CONNECTED, QUEUE].sort());
    const connected = fetchMock.mock.calls.find((c) => c[0] === CONNECTED)!;
    expect(connected[1].headers.Authorization).toMatch(/^Basic /);
    const anonymous = fetchMock.mock.calls.find((c) => c[0] === QUEUE)!;
    expect(anonymous[1].headers.Authorization).toBeUndefined();
  });

  it('does not poll a WebDAV server that is not bunko', async () => {
    getActiveProvider.mockReturnValue({
      type: 'webdav',
      getWorkerUploadCredentials: async () => ({
        webdavUrl: 'https://nextcloud.example/dav',
        webdavPassword: 'pw',
        webdavPutVerified: false
      })
    });
    await startServerOcrQueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a card showing a volume nudges an idle poller, at most once a minute', async () => {
    await startServerOcrQueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const off = markVolumeShown(KEY1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // polled under a minute ago
    off();
    await vi.advanceTimersByTimeAsync(60_000);
    const off2 = markVolumeShown(KEY2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    off2();
  });
});
