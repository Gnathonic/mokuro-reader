/**
 * Targeted rechecks of a server's volume manifest for OCR still being made:
 * registered after a WebDAV upload (or a deep link) that the server queued,
 * run when due, pulling what landed through the shared importers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { get } from 'svelte/store';

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_server_ocr_recheck_test') };
});
const upgradeOcrFromSidecarBlob = vi.hoisted(() => vi.fn());
vi.mock('$lib/catalog/cloud-ocr-upgrade', () => ({ upgradeOcrFromSidecarBlob }));
const importFetchedLayers = vi.hoisted(() => vi.fn());
vi.mock('$lib/metadata/layer-sync', () => ({ importFetchedLayers }));
const getActiveProvider = vi.hoisted(() => vi.fn());
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { getActiveProvider: () => getActiveProvider() }
}));

import { db } from '$lib/catalog/db';
import { clearAllLayers, putLayerWithPages } from '$lib/catalog/layer-store';
import {
  describePendingJobs,
  peekPending,
  registerServerOcrRecheck,
  resetServerOcrRechecksForTest,
  runDueServerOcrRechecks,
  serverOcrPending,
  RECHECK_GIVE_UP_MS
} from './server-ocr-recheck';

const MANIFEST = 'https://bunko.example/catalog/api/manifest?series=S&volume=V';
const BASE = 'https://bunko.example/mokuro-reader/S/';
const T0 = Date.parse('2026-09-27T20:00:00Z');

async function seedVolume(overrides: Record<string, unknown> = {}) {
  await db.volumes.put({
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'S',
    volume_title: 'V',
    mokuro_version: '',
    page_count: 1,
    character_count: 0,
    page_char_counts: [0],
    ...overrides
  } as never);
  await db.volume_ocr.put({ volume_uuid: 'v1', pages: [] });
  await db.volume_files.put({ volume_uuid: 'v1', files: {} });
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    archive: { url: '/mokuro-reader/S/V.cbz' },
    ocr: null,
    layers: [],
    cover: null,
    series_file: null,
    pending: [],
    recheck_after: null,
    ...overrides
  };
}

let routes: Map<string, string | number>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  localStorage.clear();
  resetServerOcrRechecksForTest();
  upgradeOcrFromSidecarBlob.mockReset().mockResolvedValue(true);
  importFetchedLayers.mockReset().mockResolvedValue(1);
  getActiveProvider.mockReset().mockReturnValue(null);
  await Promise.all([
    db.volumes.clear(),
    db.volume_ocr.clear(),
    db.volume_files.clear(),
    clearAllLayers(db)
  ]);
  routes = new Map();
  fetchMock = vi.fn(async (input: string) => {
    const route = routes.get(String(input));
    if (route === undefined) return new Response('missing', { status: 404 });
    if (typeof route === 'number') return new Response('x', { status: route });
    return new Response(route, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetServerOcrRechecksForTest();
});

function register(overrides: Partial<Parameters<typeof registerServerOcrRecheck>[0]> = {}) {
  registerServerOcrRecheck(
    {
      volumeUuid: 'v1',
      manifestUrl: MANIFEST,
      recheckAfter: 95,
      auth: 'none',
      source: 'html-download',
      pending: [{ kind: 'ocr', id: 'mokuro-fp16', eta: '2026-09-27T20:01:25Z' }],
      ...overrides
    },
    T0
  );
}

describe('registering', () => {
  it('persists the recheck and exposes its pending jobs', () => {
    register();
    expect(get(serverOcrPending)).toEqual({
      v1: [{ kind: 'ocr', id: 'mokuro-fp16', eta: '2026-09-27T20:01:25Z' }]
    });
    const stored = JSON.parse(localStorage.getItem('server-ocr-rechecks:v1')!);
    expect(stored).toEqual([
      expect.objectContaining({
        volume_uuid: 'v1',
        manifest_url: MANIFEST,
        recheck_at: T0 + 95_000,
        registered_at: T0
      })
    ]);
  });

  it('is not due before recheckAt', async () => {
    await seedVolume();
    register();
    await runDueServerOcrRechecks(T0 + 94_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the first registration time when the same volume registers again', () => {
    register();
    registerServerOcrRecheck(
      {
        volumeUuid: 'v1',
        manifestUrl: MANIFEST,
        recheckAfter: 30,
        auth: 'none',
        source: 'html-download'
      },
      T0 + 60_000
    );
    const [entry] = JSON.parse(localStorage.getItem('server-ocr-rechecks:v1')!);
    expect(entry.registered_at).toBe(T0);
    expect(entry.recheck_at).toBe(T0 + 90_000);
  });
});

describe('peeking right after an upload', () => {
  it('fills in the jobs for the chip, without pulling or moving the recheck time', async () => {
    await seedVolume();
    const pending = [{ kind: 'ocr', id: 'mokuro-fp16', eta: '2026-09-27T20:01:25Z' }];
    routes.set(
      MANIFEST,
      JSON.stringify(
        manifest({ ocr: { url: '/mokuro-reader/S/V.mokuro' }, pending, recheck_after: 95 })
      )
    );
    register({ pending: undefined });
    expect(get(serverOcrPending)).toEqual({ v1: null });
    await peekPending('v1');
    expect(get(serverOcrPending)).toEqual({ v1: pending });
    expect(upgradeOcrFromSidecarBlob).not.toHaveBeenCalled();
    const [entry] = JSON.parse(localStorage.getItem('server-ocr-rechecks:v1')!);
    expect(entry.recheck_at).toBe(T0 + 95_000);
  });
});

describe('a due recheck', () => {
  it('pulls a primary that landed into an image-only volume through the OCR upgrade', async () => {
    await seedVolume();
    register();
    routes.set(MANIFEST, JSON.stringify(manifest({ ocr: { url: '/mokuro-reader/S/V.mokuro' } })));
    routes.set(`${BASE}V.mokuro`, '{"pages":[]}');
    upgradeOcrFromSidecarBlob.mockImplementation(async () => {
      await db.volumes.update('v1', { mokuro_version: '0.2.1' });
      return true;
    });

    await runDueServerOcrRechecks(T0 + 95_000);

    expect(fetchMock.mock.calls[0]).toEqual([MANIFEST, { cache: 'no-store' }]);
    expect(upgradeOcrFromSidecarBlob).toHaveBeenCalledWith(
      'v1',
      `${BASE}V.mokuro`,
      expect.any(Blob)
    );
    // Nothing pending and everything listed is here: done.
    expect(get(serverOcrPending)).toEqual({});
    expect(localStorage.getItem('server-ocr-rechecks:v1')).toBeNull();
  });

  it('pulls only the layers this device lacks, through the shared layer importer', async () => {
    await seedVolume({ mokuro_version: '0.2.1' });
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'paddle',
      name: 'Paddle',
      kind: 'ocr',
      created_at: 'x',
      updated_at: 'x',
      pages: []
    });
    register();
    routes.set(
      MANIFEST,
      JSON.stringify(
        manifest({
          ocr: { url: '/mokuro-reader/S/V.mokuro' },
          layers: [
            { id: 'paddle', url: '/mokuro-reader/S/V.paddle.mokuro' },
            {
              id: 'hayai-nova',
              url: '/mokuro-reader/S/V.hayai-nova.mokuro.gz',
              size: 9,
              modified: '2026-09-27T20:01:00Z'
            }
          ]
        })
      )
    );
    routes.set(`${BASE}V.hayai-nova.mokuro.gz`, 'gzbytes');

    await runDueServerOcrRechecks(T0 + 95_000);

    // The primary is already here (the volume has OCR): not fetched.
    expect(upgradeOcrFromSidecarBlob).not.toHaveBeenCalled();
    expect(importFetchedLayers).toHaveBeenCalledTimes(1);
    const [uuid, source, files] = importFetchedLayers.mock.calls[0];
    expect(uuid).toBe('v1');
    expect(source).toBe('html-download');
    expect(files).toEqual([
      expect.objectContaining({
        layerId: 'hayai-nova',
        gz: true,
        label: `${BASE}V.hayai-nova.mokuro.gz`,
        size: 9,
        modifiedTime: '2026-09-27T20:01:00Z'
      })
    ]);
  });

  it('reschedules by recheck_after while jobs are still pending, and updates them', async () => {
    await seedVolume();
    register();
    const pending = [{ kind: 'layer', id: 'hayai-nova', eta: '2026-09-27T20:10:00Z' }];
    routes.set(MANIFEST, JSON.stringify(manifest({ pending, recheck_after: 420 })));

    await runDueServerOcrRechecks(T0 + 95_000);

    expect(get(serverOcrPending)).toEqual({ v1: pending });
    const [entry] = JSON.parse(localStorage.getItem('server-ocr-rechecks:v1')!);
    expect(entry.recheck_at).toBe(T0 + 95_000 + 420_000);
  });

  it('keeps looking while a listed file is still missing here, even with nothing pending', async () => {
    await seedVolume();
    register();
    routes.set(MANIFEST, JSON.stringify(manifest({ ocr: { url: '/mokuro-reader/S/V.mokuro' } })));
    routes.set(`${BASE}V.mokuro`, 503);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runDueServerOcrRechecks(T0 + 95_000);

    expect(warn.mock.calls.some((c) => c.map(String).join(' ').includes(`${BASE}V.mokuro`))).toBe(
      true
    );
    const [entry] = JSON.parse(localStorage.getItem('server-ocr-rechecks:v1')!);
    expect(entry.recheck_at).toBe(T0 + 95_000 + 300_000);
  });

  it('is quiet about an unreachable manifest and retries later', async () => {
    await seedVolume();
    register();
    routes.set(MANIFEST, 502);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runDueServerOcrRechecks(T0 + 95_000);

    expect(warn).toHaveBeenCalledTimes(1);
    const [entry] = JSON.parse(localStorage.getItem('server-ocr-rechecks:v1')!);
    expect(entry.recheck_at).toBe(T0 + 95_000 + 300_000);
    // The last known jobs still show.
    expect(get(serverOcrPending).v1).toHaveLength(1);
  });

  it('stops when the volume is gone', async () => {
    register();
    await runDueServerOcrRechecks(T0 + 95_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('server-ocr-rechecks:v1')).toBeNull();
    expect(get(serverOcrPending)).toEqual({});
  });

  it('stops after 24 hours', async () => {
    await seedVolume();
    register();
    await runDueServerOcrRechecks(T0 + RECHECK_GIVE_UP_MS);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('server-ocr-rechecks:v1')).toBeNull();
  });

  it('survives a reload: the persisted entry is picked up again', async () => {
    await seedVolume();
    register();
    resetServerOcrRechecksForTest({ keepStorage: true });
    routes.set(MANIFEST, JSON.stringify(manifest()));
    await runDueServerOcrRechecks(T0 + 95_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('an upload-registered recheck', () => {
  function webdavProvider(url = 'https://bunko.example/', password = 'pw') {
    return {
      type: 'webdav',
      getWorkerUploadCredentials: async () => ({
        webdavUrl: url,
        webdavUsername: 'reader',
        webdavPassword: password
      })
    };
  }

  it('authenticates the manifest and file fetches as the connected WebDAV account', async () => {
    await seedVolume();
    getActiveProvider.mockReturnValue(webdavProvider());
    register({ auth: 'webdav', source: 'webdav' });
    routes.set(MANIFEST, JSON.stringify(manifest({ ocr: { url: '/mokuro-reader/S/V.mokuro' } })));
    routes.set(`${BASE}V.mokuro`, '{"pages":[]}');

    await runDueServerOcrRechecks(T0 + 95_000);

    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toEqual({
        cache: 'no-store',
        headers: { Authorization: expect.stringMatching(/^Basic /) }
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never sends the WebDAV credentials to another origin', async () => {
    await seedVolume();
    getActiveProvider.mockReturnValue(webdavProvider('https://elsewhere.example/dav/'));
    register({ auth: 'webdav', source: 'webdav' });
    routes.set(MANIFEST, JSON.stringify(manifest()));
    await runDueServerOcrRechecks(T0 + 95_000);
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: 'no-store' });
  });

  it('waits for the WebDAV account when it is not connected', async () => {
    await seedVolume();
    register({ auth: 'webdav', source: 'webdav' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runDueServerOcrRechecks(T0 + 95_000);
    expect(fetchMock).not.toHaveBeenCalled();
    const [entry] = JSON.parse(localStorage.getItem('server-ocr-rechecks:v1')!);
    expect(entry.recheck_at).toBe(T0 + 95_000 + 300_000);
  });
});

describe('describePendingJobs', () => {
  const at = (iso: string) => new Date(iso);
  const hhmm = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  it('names the earliest priced job, and lists every job in the tooltip', () => {
    const d = describePendingJobs([
      { kind: 'layer', id: 'hayai-nova-ppocr', eta: '2026-09-27T21:19:30Z' },
      { kind: 'ocr', id: 'mokuro-fp16', eta: '2026-09-27T21:14:00Z' },
      { kind: 'layer', id: 'paddle', eta: null }
    ])!;
    expect(d.label).toBe(`OCR ~${hhmm(at('2026-09-27T21:14:00Z'))}`);
    expect(d.tooltip).toBe(
      [
        `hayai-nova-ppocr layer ~${hhmm(at('2026-09-27T21:19:30Z'))}`,
        `mokuro-fp16 OCR ~${hhmm(at('2026-09-27T21:14:00Z'))}`,
        'paddle layer queued'
      ].join('\n')
    );
  });

  it('says "OCR queued" when nothing is priced or the jobs are not known yet', () => {
    expect(describePendingJobs([{ kind: 'ocr', id: 'm', eta: null }])!.label).toBe('OCR queued');
    expect(describePendingJobs(null)!.label).toBe('OCR queued');
  });

  it('is nothing when nothing is pending', () => {
    expect(describePendingJobs([])).toBeNull();
    expect(describePendingJobs(undefined)).toBeNull();
  });
});
