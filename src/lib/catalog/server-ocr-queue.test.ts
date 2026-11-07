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
vi.mock('$lib/util/sync/provider-manager', async () => {
  const { writable } = await import('svelte/store');
  return {
    providerManager: {
      getActiveProvider: () => getActiveProvider(),
      // As a login / logout after start moves it.
      status: writable({ hasAnyAuthenticated: false, currentProviderType: null as string | null })
    }
  };
});

import { db } from '$lib/catalog/db';
import { providerManager } from '$lib/util/sync/provider-manager';
import { clearAllLayers } from '$lib/catalog/layer-store';
import { queueFixture } from './__fixtures__/mokuro-queue';
import type { Writable } from 'svelte/store';
import { markVolumeShown, serverOcrQueueStatus, volumeQueueKey } from './server-ocr-pending';
import {
  LEGACY_RECHECK_KEY,
  QUEUE_BACKOFF_MS,
  QueuePoller,
  cleanupLegacyRecheckEntries,
  fetchWithQueueAuth,
  parseQueueFile,
  pullCompletedVolume,
  type PendingOnServer,
  queueUrlForArchive,
  queueUrlForWebdav,
  resetServerOcrQueueForTest,
  startServerOcrQueue,
  watchServerOcr,
  watchedEntries
} from './server-ocr-queue';

const statusFeed = providerManager.status as unknown as Writable<{
  hasAnyAuthenticated: boolean;
  currentProviderType: string | null;
}>;
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
      // An older server's file: no count of the waiting volumes.
      pending_volumes: undefined,
      volumes: [
        ...queueFixture(NOW).volumes,
        { series: 'x' },
        { series: 'S', volume: 'V', jobs: [{ kind: 'weird', id: 'a', state: 'queued' }] }
      ]
    })!;
    expect(file.held).toEqual({ reason: 'no-processor' });
    expect(file.next_check_after).toBeNull();
    expect(file.pending_volumes).toBeNull();
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
  /** What `onDone` answers per key (absent = the old fire-and-forget). */
  let outcomes: Map<string, Promise<boolean | PendingOnServer>>;
  let init: RequestInit | null;

  function poller() {
    return new QueuePoller({
      queueUrl: QUEUE,
      requestInit: async () => init,
      watchedKeys: () => watched,
      isShown: (k) => shownKeys.has(k),
      onStatus: (file) => statuses.push(file),
      onDone: (key) => {
        done.push(key);
        return outcomes.get(key);
      },
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
    outcomes = new Map();
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

  // bunko >= 0.5.1 lists the running volumes and only the next hundred waiting.
  it("reads the whole queue's waiting count", () => {
    expect(parseQueueFile({ ...queueFixture(NOW), pending_volumes: 4210 })!.pending_volumes).toBe(
      4210
    );
    expect(parseQueueFile({ ...queueFixture(NOW), pending_volumes: -1 })!.pending_volumes).toBe(
      null
    );
  });

  it('a watched volume past the hundred listed stays pending while its manifest says so', async () => {
    const far = volumeQueueKey('Other', 'Other 01');
    watched = [far];
    const pending: PendingOnServer = {
      series: 'Other',
      volume: 'Other 01',
      pending: [{ kind: 'ocr', id: 'mokuro-fp16', eta: '2026-09-28T19:00:00Z' }],
      recheckAfter: 600
    };
    outcomes.set(far, Promise.resolve(pending));
    const p = poller();
    p.trigger('upload');
    await settle();
    expect(done).toEqual([far]);
    // Not done: still polled, and shown from the manifest's jobs.
    expect(p.state).toBe('waiting');
    const shown = statuses.at(-1) as { volumes: Array<{ volume: string; jobs: unknown[] }> };
    expect(shown.volumes.find((v) => v.volume === 'Other 01')?.jobs).toEqual([
      {
        kind: 'ocr',
        id: 'mokuro-fp16',
        state: 'queued',
        eta: '2026-09-28T19:00:00Z',
        progress: null
      }
    ]);
    // The next queue polls (95 s apart) do not ask its manifest again before recheck_after.
    await vi.advanceTimersByTimeAsync(95_000 * 3);
    expect(done).toEqual([far]);
    // At recheck_after it is asked again; now the manifest calls it done.
    outcomes.set(far, Promise.resolve(true));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(done).toEqual([far, far]);
    const after = statuses.at(-1) as { volumes: Array<{ volume: string }> } | null;
    expect(after?.volumes.some((v) => v.volume === 'Other 01') ?? false).toBe(false);
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

  it('a manifest that still lists jobs is not done: nothing pulled, the watch kept', async () => {
    const url =
      'https://bunko.example/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001';
    const manifest = JSON.parse(routes.get(url) as string);
    routes.set(
      url,
      JSON.stringify({
        ...manifest,
        pending: [{ kind: 'layer', id: 'hayai-nova', eta: null }],
        recheck_after: 300
      })
    );
    watchServerOcr(
      {
        volumeUuid: 'v1',
        series: 'Dr Stone',
        volume: 'Dr Stone 01',
        queueUrl: QUEUE,
        manifestUrl: url,
        auth: 'none',
        source: 'webdav'
      },
      { start: false }
    );
    expect(await pullCompletedVolume(KEY1, entry, target)).toEqual({
      series: 'Dr Stone',
      volume: 'Dr Stone 01',
      pending: [{ kind: 'layer', id: 'hayai-nova', eta: null }],
      recheckAfter: 300
    });
    expect(upgradeOcrFromSidecarBlob).not.toHaveBeenCalled();
    expect(importFetchedLayers).not.toHaveBeenCalled();
    expect(watchedEntries()).toHaveLength(1);
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

describe("a link's watch stays on the servers the link named", () => {
  const MANIFEST =
    'https://bunko.example/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001';
  const LOOPBACK_OCR = 'http://127.0.0.1:9/Dr%20Stone%2001.mokuro';
  const THIRD_PARTY_LAYER = 'https://third.example/Dr%20Stone%2001.hayai-nova.mokuro';
  const SAME_ORIGIN_LAYER =
    'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.paddle.mokuro';
  /** url → body; `redirectTo` answers as if `fetch` had followed a redirect there. */
  const routes = new Map<string, { body: string; redirectTo?: string }>();
  let fetchMock: ReturnType<typeof vi.fn>;

  const entry = {
    series: 'Dr Stone',
    volume: 'Dr Stone 01',
    path: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz',
    manifest: '/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001',
    jobs: []
  };
  const linkTarget = {
    queueUrl: QUEUE,
    init: { cache: 'no-store' as const },
    source: 'html-download',
    auth: 'none' as const
  };

  function manifestListing(ocr: string, layers: Array<{ id: string; url: string }>): string {
    return JSON.stringify({
      version: 1,
      archive: { url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz' },
      ocr: { url: ocr },
      layers,
      pending: [],
      recheck_after: null
    });
  }

  function watchLink(source = 'html-download', auth: 'none' | 'webdav' = 'none'): void {
    watchServerOcr(
      {
        volumeUuid: 'v1',
        series: 'Dr Stone',
        volume: 'Dr Stone 01',
        queueUrl: QUEUE,
        manifestUrl: MANIFEST,
        auth,
        source
      },
      { start: false }
    );
  }

  const fetchedUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  beforeEach(async () => {
    resetServerOcrQueueForTest();
    localStorage.clear();
    routes.clear();
    upgradeOcrFromSidecarBlob.mockReset().mockResolvedValue(true);
    importFetchedLayers.mockReset().mockResolvedValue(1);
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
    fetchMock = vi.fn(async (url: string) => {
      const r = routes.get(String(url));
      if (!r) return new Response('', { status: 404 });
      const res = new Response(r.body, { status: 200 });
      if (r.redirectTo) {
        Object.defineProperty(res, 'redirected', { value: true });
        Object.defineProperty(res, 'url', { value: r.redirectTo });
      }
      return res;
    });
    vi.stubGlobal('fetch', fetchMock);
    routes.set(LOOPBACK_OCR, { body: '{"pages":[]}' });
    routes.set(THIRD_PARTY_LAYER, { body: '{"pages":[]}' });
    routes.set(SAME_ORIGIN_LAYER, { body: '{"pages":[]}' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetServerOcrQueueForTest();
  });

  it('never fetches or applies OCR a re-read manifest names on another server', async () => {
    routes.set(MANIFEST, {
      body: manifestListing(LOOPBACK_OCR, [
        { id: 'hayai-nova', url: THIRD_PARTY_LAYER },
        { id: 'paddle', url: SAME_ORIGIN_LAYER }
      ])
    });
    watchLink();
    expect(await pullCompletedVolume(KEY1, entry, linkTarget)).toBe(true);
    expect(fetchedUrls()).not.toContain(LOOPBACK_OCR);
    expect(fetchedUrls()).not.toContain(THIRD_PARTY_LAYER);
    expect(upgradeOcrFromSidecarBlob).not.toHaveBeenCalled();
    // The layer on the link's own server still arrives.
    const files = importFetchedLayers.mock.calls[0][2] as Array<{ layerId: string }>;
    expect(files.map((f) => f.layerId)).toEqual(['paddle']);
  });

  it('never reads a manifest the queue file names on another server', async () => {
    const elsewhere = 'https://elsewhere.example/manifest.json';
    routes.set(elsewhere, { body: manifestListing(LOOPBACK_OCR, []) });
    watchLink();
    expect(await pullCompletedVolume(KEY1, { ...entry, manifest: elsewhere }, linkTarget)).toBe(
      false
    );
    expect(fetchedUrls()).not.toContain(elsewhere);
    expect(upgradeOcrFromSidecarBlob).not.toHaveBeenCalled();
    expect(watchedEntries()).toHaveLength(1);
  });

  it('refuses a manifest that arrives through a redirect to this device', async () => {
    routes.set(MANIFEST, {
      body: manifestListing('/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.mokuro', []),
      redirectTo: 'http://127.0.0.1:9/manifest.json'
    });
    watchLink();
    expect(await pullCompletedVolume(KEY1, entry, linkTarget)).toBe(false);
    expect(upgradeOcrFromSidecarBlob).not.toHaveBeenCalled();
    expect(fetchedUrls()).toEqual([MANIFEST]);
  });

  it('refuses an OCR file that arrives through a redirect to this device', async () => {
    const ocr = 'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.mokuro';
    routes.set(MANIFEST, { body: manifestListing(ocr, []) });
    routes.set(ocr, { body: '{"pages":[]}', redirectTo: LOOPBACK_OCR });
    watchLink();
    await pullCompletedVolume(KEY1, entry, linkTarget);
    expect(fetchedUrls()).toContain(ocr);
    expect(upgradeOcrFromSidecarBlob).not.toHaveBeenCalled();
  });

  it("confines a link's watch even when the poller reads as the WebDAV account", async () => {
    routes.set(MANIFEST, { body: manifestListing(LOOPBACK_OCR, []) });
    watchLink();
    await pullCompletedVolume(KEY1, entry, { ...linkTarget, source: 'webdav', auth: 'webdav' });
    expect(fetchedUrls()).not.toContain(LOOPBACK_OCR);
    expect(upgradeOcrFromSidecarBlob).not.toHaveBeenCalled();
  });

  it('the anonymous poller a link started never reads a queue file redirected to this device', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      routes.set(QUEUE, {
        body: JSON.stringify({ ...queueFixture(NOW), volumes: [], next_check_after: null }),
        redirectTo: 'http://127.0.0.1:9/.mokuro-queue.json'
      });
      watchLink();
      await startServerOcrQueue();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchedUrls()).toEqual([QUEUE]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('unavailable'),
        expect.stringContaining('Refused')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("the bunko account's own queue still pulls files on any server, redirects and all", async () => {
    const cdnOcr = 'https://cdn.example/Dr%20Stone%2001.mokuro';
    const cdnLayer = 'https://cdn.example/Dr%20Stone%2001.paddle.mokuro';
    routes.set(MANIFEST, {
      body: manifestListing(cdnOcr, [{ id: 'paddle', url: cdnLayer }]),
      redirectTo: 'http://127.0.0.1:9/manifest.json'
    });
    routes.set(cdnOcr, { body: '{"pages":[]}', redirectTo: 'http://10.0.0.5/x.mokuro' });
    routes.set(cdnLayer, { body: '{"pages":[]}' });
    watchLink('webdav', 'webdav');
    const bunkoTarget = { ...linkTarget, source: 'webdav', auth: 'webdav' as const };
    expect(await pullCompletedVolume(KEY1, entry, bunkoTarget)).toBe(true);
    expect(upgradeOcrFromSidecarBlob).toHaveBeenCalledWith('v1', cdnOcr, expect.any(Blob));
    const [, source, files] = importFetchedLayers.mock.calls[0];
    expect(source).toBe('webdav');
    expect((files as Array<{ layerId: string }>).map((f) => f.layerId)).toEqual(['paddle']);
  });

  // Watch keys are not scoped to a queue, and a poller reports any key it is
  // SHOWN as done too: another link's anonymous poller can report this watch.
  const OTHER_QUEUE = 'https://other.example/mokuro-reader/.mokuro-queue.json';
  const OTHER_MANIFEST =
    'https://other.example/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001';
  const OTHER_OCR = 'https://other.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.mokuro';

  it("another queue's poller reporting a link's watch reads nothing and leaves the watch", async () => {
    routes.set(OTHER_MANIFEST, { body: manifestListing(OTHER_OCR, []) });
    routes.set(OTHER_OCR, { body: '{"pages":[]}' });
    watchLink();
    const otherTarget = { ...linkTarget, queueUrl: OTHER_QUEUE };
    expect(await pullCompletedVolume(KEY1, entry, otherTarget)).toBe(false);
    expect(fetchedUrls()).toEqual([]);
    expect(upgradeOcrFromSidecarBlob).not.toHaveBeenCalled();
    expect(watchedEntries().map((w) => w.queue_url)).toEqual([QUEUE]);
  });

  it("the watch's own queue still pulls it after another queue's poller was refused", async () => {
    const ocr = 'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.mokuro';
    routes.set(MANIFEST, { body: manifestListing(ocr, []) });
    routes.set(ocr, { body: '{"pages":[]}' });
    watchLink();
    expect(await pullCompletedVolume(KEY1, entry, { ...linkTarget, queueUrl: OTHER_QUEUE })).toBe(
      false
    );
    expect(await pullCompletedVolume(KEY1, entry, linkTarget)).toBe(true);
    expect(upgradeOcrFromSidecarBlob).toHaveBeenCalledWith('v1', ocr, expect.any(Blob));
    expect(watchedEntries()).toEqual([]);
  });

  it('an upload watch that landed on an anonymous poller reads as it always did', async () => {
    // Pollers are keyed by queue URL alone: a link to the user's own bunko
    // server may have created the anonymous one an upload watch then reuses.
    const cdnOcr = 'https://cdn.example/Dr%20Stone%2001.mokuro';
    routes.set(MANIFEST, {
      body: manifestListing(cdnOcr, []),
      redirectTo: 'https://mirror.example/manifest.json'
    });
    routes.set(cdnOcr, { body: '{"pages":[]}' });
    watchLink('webdav', 'webdav');
    expect(await pullCompletedVolume(KEY1, entry, linkTarget)).toBe(true);
    expect(upgradeOcrFromSidecarBlob).toHaveBeenCalledWith('v1', cdnOcr, expect.any(Blob));
  });

  it("another queue's poller reporting an UPLOAD watch reads nothing and leaves the watch", async () => {
    // The user's own upload waits on their bunko queue; a link to another
    // server lists the same (series, volume) as done while its card is shown.
    routes.set(OTHER_MANIFEST, { body: manifestListing(OTHER_OCR, []) });
    routes.set(OTHER_OCR, { body: '{"pages":[]}' });
    watchLink('webdav', 'webdav');
    const otherTarget = { ...linkTarget, queueUrl: OTHER_QUEUE };
    expect(
      await pullCompletedVolume(KEY1, { ...entry, manifest: OTHER_MANIFEST }, otherTarget)
    ).toBe(false);
    expect(fetchedUrls()).toEqual([]);
    expect(upgradeOcrFromSidecarBlob).not.toHaveBeenCalled();
    expect(watchedEntries().map((w) => w.queue_url)).toEqual([QUEUE]);
  });

  it('a pull that ends before its first await does not wedge later pulls of the key', async () => {
    // No entry and no watch: the pull has nothing to go on and ends at once.
    expect(await pullCompletedVolume(KEY1, undefined, linkTarget)).toBe(false);
    const ocr = 'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.mokuro';
    routes.set(MANIFEST, { body: manifestListing(ocr, []) });
    routes.set(ocr, { body: '{"pages":[]}' });
    watchLink();
    expect(await pullCompletedVolume(KEY1, entry, linkTarget)).toBe(true);
    expect(upgradeOcrFromSidecarBlob).toHaveBeenCalledWith('v1', ocr, expect.any(Blob));
  });

  it('an anonymous poller never reads an unwatched shown volume off its own server', async () => {
    routes.set(OTHER_MANIFEST, { body: manifestListing(OTHER_OCR, []) });
    routes.set(OTHER_OCR, { body: '{"pages":[]}' });
    expect(
      await pullCompletedVolume(KEY1, { ...entry, manifest: OTHER_MANIFEST }, linkTarget)
    ).toBe(false);
    expect(fetchedUrls()).toEqual([]);
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

describe('a WebDAV login after app start', () => {
  const CONNECTED = 'http://127.0.0.1:8090/mokuro-reader/.mokuro-queue.json';
  let fetchMock: ReturnType<typeof vi.fn>;
  const bunkoServer = {
    type: 'webdav',
    getWorkerUploadCredentials: async () => ({
      webdavUrl: 'http://127.0.0.1:8090',
      webdavUsername: 'reader',
      webdavPassword: 'pw',
      webdavPutVerified: true
    })
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    resetServerOcrQueueForTest();
    localStorage.clear();
    statusFeed.set({ hasAnyAuthenticated: false, currentProviderType: null });
    getActiveProvider.mockReturnValue(null);
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ...queueFixture(NOW), volumes: [], next_check_after: null }),
          { status: 200, headers: { ETag: '"e"' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetServerOcrQueueForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    getActiveProvider.mockReturnValue(null);
    statusFeed.set({ hasAnyAuthenticated: false, currentProviderType: null });
  });

  it('polls the bunko server it connected to, at once', async () => {
    await startServerOcrQueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled(); // nothing connected at start

    getActiveProvider.mockReturnValue(bunkoServer);
    statusFeed.set({ hasAnyAuthenticated: true, currentProviderType: 'webdav' });
    await vi.waitFor(() => expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([CONNECTED]));
  });

  it('does not poll again a server it already polled at start', async () => {
    getActiveProvider.mockReturnValue(bunkoServer);
    statusFeed.set({ hasAnyAuthenticated: true, currentProviderType: 'webdav' });
    await startServerOcrQueue();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000); // the login's own look would land by now
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poll a WebDAV server that is not bunko', async () => {
    await startServerOcrQueue();
    getActiveProvider.mockReturnValue({
      type: 'webdav',
      getWorkerUploadCredentials: async () => ({
        webdavUrl: 'https://nextcloud.example/dav',
        webdavPassword: 'pw',
        webdavPutVerified: false
      })
    });
    statusFeed.set({ hasAnyAuthenticated: true, currentProviderType: 'webdav' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// A switch from one bunko server to another keeps the type `webdav`: the old
// server's poller must not stay behind, sending unauthenticated GETs (its
// Authorization never crosses origins) and nudged by every card and tab show.
describe('switching to another WebDAV server', () => {
  const A = 'http://127.0.0.1:8090';
  const B = 'http://127.0.0.2:8091';
  const QUEUE_A = `${A}/mokuro-reader/.mokuro-queue.json`;
  const QUEUE_B = `${B}/mokuro-reader/.mokuro-queue.json`;
  let fetchMock: ReturnType<typeof vi.fn>;
  let server: string;
  const provider = {
    type: 'webdav',
    getWorkerUploadCredentials: async () => ({
      webdavUrl: server,
      webdavUsername: 'reader',
      webdavPassword: 'pw',
      webdavPutVerified: true
    })
  };
  let offShown: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    resetServerOcrQueueForTest();
    localStorage.clear();
    server = A;
    getActiveProvider.mockReturnValue(null);
    statusFeed.set({ hasAnyAuthenticated: false, currentProviderType: null });
    fetchMock = vi.fn(async (url: string) =>
      url === QUEUE_A
        ? new Response(JSON.stringify(queueFixture(NOW)), { status: 200 })
        : new Response(
            JSON.stringify({ ...queueFixture(NOW), volumes: [], next_check_after: null }),
            { status: 200 }
          )
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    offShown?.();
    offShown = null;
    resetServerOcrQueueForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    getActiveProvider.mockReturnValue(null);
    statusFeed.set({ hasAnyAuthenticated: false, currentProviderType: null });
  });

  const callsTo = (url: string) => fetchMock.mock.calls.filter((c) => c[0] === url).length;

  /** Logs in to server A after start, showing KEY1, which A's queue lists. */
  async function connectToA() {
    offShown = markVolumeShown(KEY1);
    await startServerOcrQueue();
    getActiveProvider.mockReturnValue(provider);
    statusFeed.set({ hasAnyAuthenticated: true, currentProviderType: 'webdav' });
    await vi.waitFor(() => expect(get(serverOcrQueueStatus)[KEY1]).toBeDefined());
    expect(callsTo(QUEUE_A)).toBe(1);
  }

  async function connectThenSwitch() {
    await connectToA();
    server = B;
    statusFeed.set({ hasAnyAuthenticated: true, currentProviderType: 'webdav' });
    await vi.waitFor(() => expect(callsTo(QUEUE_B)).toBe(1));
  }

  it('polls the new server and withdraws the old one', async () => {
    await connectThenSwitch();
    expect(get(serverOcrQueueStatus)[KEY1]).toBeUndefined();
    // Its timer, a card nudge and a tab show reach the old server no more.
    await vi.advanceTimersByTimeAsync(QUEUE_BACKOFF_MS.at(-1)! * 2);
    const off = markVolumeShown(KEY2);
    await vi.advanceTimersByTimeAsync(1_000);
    off();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callsTo(QUEUE_A)).toBe(1);
  });

  it('keeps a poller with watched volumes, but sends nothing to another origin', async () => {
    await connectToA();
    watchServerOcr(
      {
        volumeUuid: 'v1',
        series: 'Dr Stone',
        volume: 'Dr Stone 01',
        queueUrl: QUEUE_A,
        manifestUrl: `${A}/m`,
        auth: 'webdav',
        source: 'webdav'
      },
      { start: false }
    );
    server = B;
    statusFeed.set({ hasAnyAuthenticated: true, currentProviderType: 'webdav' });
    await vi.waitFor(() => expect(callsTo(QUEUE_B)).toBe(1));
    await vi.advanceTimersByTimeAsync(QUEUE_BACKOFF_MS.at(-1)! * 2);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callsTo(QUEUE_A)).toBe(1);
    expect(watchedEntries().map((w) => w.queue_url)).toEqual([QUEUE_A]);

    // Back on that account: the kept poller takes a look at once, as it.
    server = A;
    statusFeed.set({ hasAnyAuthenticated: true, currentProviderType: 'webdav' });
    await vi.waitFor(() => expect(callsTo(QUEUE_A)).toBe(2));
    const back = fetchMock.mock.calls.filter((c) => c[0] === QUEUE_A)[1];
    expect(back[1].headers.Authorization).toMatch(/^Basic /);
  });

  it('a logout withdraws the server it was connected to', async () => {
    await connectToA();
    getActiveProvider.mockReturnValue(null);
    statusFeed.set({ hasAnyAuthenticated: false, currentProviderType: null });
    await vi.waitFor(() => expect(get(serverOcrQueueStatus)[KEY1]).toBeUndefined());
    await vi.advanceTimersByTimeAsync(QUEUE_BACKOFF_MS.at(-1)! * 2);
    expect(callsTo(QUEUE_A)).toBe(1);
  });
});

describe('the queue under a bunko bearer token', () => {
  const SERVER = 'http://127.0.0.1:8090';
  const CONNECTED = `${SERVER}/mokuro-reader/.mokuro-queue.json`;
  let token: string;
  let reissue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    resetServerOcrQueueForTest();
    localStorage.clear();
    token = 'old';
    reissue = vi.fn(async (stale: string) => {
      if (stale !== `Bearer ${token}`) return true;
      token = 'new';
      return true;
    });
    getActiveProvider.mockReturnValue({
      type: 'webdav',
      reissueAfterUnauthorized: reissue,
      getWorkerUploadCredentials: async () => ({
        webdavUrl: SERVER,
        webdavUsername: 'reader',
        webdavToken: token,
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

  it('polls with Bearer, and a 401 re-issues once and retries with the fresh token', async () => {
    const auths: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      auths.push(auth);
      if (auth !== 'Bearer new') return new Response('', { status: 401 });
      return new Response(
        JSON.stringify({ ...queueFixture(NOW), volumes: [], next_check_after: null }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    await startServerOcrQueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([CONNECTED, CONNECTED]);
    expect(auths).toEqual(['Bearer old', 'Bearer new']);
    expect(reissue).toHaveBeenCalledTimes(1);
  });

  it('never sends the account header to another origin a manifest names', async () => {
    const fetchMock = vi.fn(async () => new Response('x', { status: 200 }));
    await fetchWithQueueAuth(
      'https://elsewhere.example/file.mokuro',
      { headers: { Authorization: 'Bearer old', 'X-Other': '1' } },
      CONNECTED,
      'webdav',
      fetchMock
    );
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual({ 'X-Other': '1' });
  });

  it('a refused re-issue leaves the 401 standing (no retry)', async () => {
    reissue.mockResolvedValue(false);
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
    const res = await fetchWithQueueAuth(
      `${SERVER}/mokuro-reader/S/V.json`,
      { headers: { Authorization: 'Bearer old' } },
      CONNECTED,
      'webdav',
      fetchMock
    );
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 503 + Retry-After is sent again after the wait, and composes with the 401 re-issue', async () => {
    const auths: string[] = [];
    const answers = [
      () => new Response('', { status: 401 }),
      () => new Response('', { status: 503, headers: { 'Retry-After': '2' } }),
      () => new Response('x', { status: 200 })
    ];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      auths.push((init?.headers as Record<string, string>).Authorization);
      return answers.shift()!();
    });
    const done = fetchWithQueueAuth(
      `${SERVER}/mokuro-reader/S/V.mokuro`,
      { headers: { Authorization: 'Bearer old' } },
      CONNECTED,
      'webdav',
      fetchMock
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await done).status).toBe(200);
    expect(auths).toEqual(['Bearer old', 'Bearer new', 'Bearer new']);
  });

  it('a 503 without a usable Retry-After is answered as is', async () => {
    const fetchMock = vi.fn(
      async () => new Response('', { status: 503, headers: { 'Retry-After': '600' } })
    );
    const res = await fetchWithQueueAuth(`${SERVER}/x`, {}, CONNECTED, 'none', fetchMock);
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 401 under Basic or on an anonymous queue is not retried', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
    await fetchWithQueueAuth(
      `${SERVER}/x`,
      { headers: { Authorization: 'Basic eDp5' } },
      CONNECTED,
      'webdav',
      fetchMock
    );
    await fetchWithQueueAuth(`${SERVER}/x`, {}, CONNECTED, 'none', fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reissue).not.toHaveBeenCalled();
  });
});
