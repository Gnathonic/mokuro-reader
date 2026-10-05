/**
 * The deep link's download half: with a `manifest` param the server's volume
 * manifest decides every file; without one (or with one that cannot be used)
 * the sidecars are guessed from the `.cbz` URL, exactly as before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for the file-processing worker: it fetches through the same
// (stubbed) global fetch the real worker would, so every URL it tries is seen.
const workerTasks = vi.hoisted(() => [] as Array<Record<string, unknown>>);
/** The shared pool's user tally, and what it was when each task was handed over. */
const poolUsers = vi.hoisted(() => ({ count: 0, atAddTask: [] as number[] }));
vi.mock('$lib/util/file-processing-pool', () => ({
  incrementPoolUsers: () => {
    poolUsers.count++;
  },
  decrementPoolUsers: () => {
    poolUsers.count--;
  },
  getFileProcessingPool: async () => ({
    addTask: (task: {
      data: { archiveUrl: string; mokuroUrls: string[]; coverUrls: string[] };
      onComplete: (result: unknown, done: () => void) => void;
      onError: (error: { error: string }) => void;
    }) => {
      workerTasks.push(task.data);
      poolUsers.atAddTask.push(poolUsers.count);
      void (async () => {
        const archive = await fetch(task.data.archiveUrl, { cache: 'no-store' });
        if (!archive.ok) {
          task.onError({ error: `HTTP download failed: ${archive.status}` });
          return;
        }
        const optional = async (urls: string[]) => {
          for (const url of urls) {
            try {
              const r = await fetch(url, { cache: 'no-store' });
              if (r.ok) return { url, data: await r.arrayBuffer() };
            } catch {
              // best effort, as the worker
            }
          }
          return undefined;
        };
        const mokuro = await optional(task.data.mokuroUrls);
        const cover = await optional(task.data.coverUrls);
        task.onComplete(
          {
            bundle: {
              archive: { url: task.data.archiveUrl, data: await archive.arrayBuffer() },
              ...(mokuro ? { mokuro } : {}),
              ...(cover ? { cover } : {})
            }
          },
          () => {}
        );
      })();
    }
  })
}));

import {
  htmlDownloadProvider,
  parseHtmlDownloadRequest,
  type HtmlDownloadRequest
} from './html-download-provider';

const ORIGIN = 'https://bunko.example';
const BASE = `${ORIGIN}/mokuro-reader/Dr%20Stone/`;
const CBZ = `${BASE}Dr%20Stone%2001.cbz`;
const MANIFEST = `${ORIGIN}/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001`;

const OCR_JSON = JSON.stringify({ version: '0.2.1', pages: [] });
const SERIES_JSON = JSON.stringify({
  version: 2,
  series_title: 'Dr Stone',
  external_ids: { anilist: 98416 },
  titles: {},
  synonyms: [],
  updated_at: '2026-09-27T00:00:00.000Z',
  volumes: []
});

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    series: 'Dr Stone',
    volume: 'Dr Stone 01',
    archive: { url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz', size: 3 },
    ocr: { url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.mokuro', size: OCR_JSON.length },
    layers: [
      {
        id: 'hayai-nova-ppocr',
        url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.hayai-nova-ppocr.mokuro',
        size: 67,
        modified: '2026-09-27T01:02:05Z'
      },
      {
        id: 'paddle',
        url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.paddle.mokuro.gz',
        size: 12
      }
    ],
    cover: { url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.webp', size: 4 },
    series_file: {
      url: '/mokuro-reader/Dr%20Stone/series.json',
      size: SERIES_JSON.length,
      modified: '2026-09-27T01:02:07Z'
    },
    ...overrides
  };
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** URL → response body (string/bytes), a status number, an Error to throw, or a Response. */
type Route = string | Uint8Array | number | Error | Response;
let routes: Map<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

function serve(url: string, route: Route) {
  routes.set(url, route);
}

beforeEach(() => {
  workerTasks.length = 0;
  poolUsers.count = 0;
  poolUsers.atAddTask.length = 0;
  routes = new Map();
  fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const route = routes.get(url);
    if (route === undefined) return new Response('missing', { status: 404 });
    if (route instanceof Error) throw route;
    if (typeof route === 'number') return new Response('nope', { status: route });
    if (route instanceof Response) return route.clone();
    return new Response(route as BodyInit, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  window.location.hash = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function requestFor(params: string): HtmlDownloadRequest {
  return parseHtmlDownloadRequest(new URLSearchParams(params))!;
}

function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe('parseHtmlDownloadRequest', () => {
  it('carries the manifest URL of a cbz link', () => {
    const request = requestFor(
      `cbz=${encodeURIComponent(CBZ)}&manifest=${encodeURIComponent(MANIFEST)}`
    );
    expect(request).toMatchObject({
      type: 'cbz',
      cbzUrl: CBZ,
      manga: 'Dr Stone',
      volume: 'Dr Stone 01',
      manifestUrl: MANIFEST
    });
  });

  it('has no manifest URL when the link carries none (old servers)', () => {
    expect(requestFor(`cbz=${encodeURIComponent(CBZ)}`).manifestUrl).toBeUndefined();
  });
});

describe('downloading a cbz deep link with a manifest', () => {
  const link = () =>
    requestFor(`cbz=${encodeURIComponent(CBZ)}&manifest=${encodeURIComponent(MANIFEST)}`);

  async function serveAll(overrides: Record<string, unknown> = {}) {
    serve(MANIFEST, JSON.stringify(manifest(overrides)));
    serve(CBZ, new Uint8Array([1, 2, 3]));
    serve(`${BASE}Dr%20Stone%2001.mokuro`, OCR_JSON);
    serve(`${BASE}Dr%20Stone%2001.hayai-nova-ppocr.mokuro`, '{"pages":[]}');
    serve(`${BASE}Dr%20Stone%2001.paddle.mokuro.gz`, await gzip('{"pages":[]}'));
    serve(`${BASE}Dr%20Stone%2001.webp`, new Uint8Array([9, 9, 9, 9]));
    serve(`${BASE}series.json`, SERIES_JSON);
  }

  it('holds the shared worker pool while its download runs, and lets go after', async () => {
    await serveAll();
    await htmlDownloadProvider.download(link());
    // Another user's count dropping to zero cannot terminate the pool under it.
    expect(poolUsers.atAddTask).toEqual([1]);
    expect(poolUsers.count).toBe(0);
  });

  it('lets go of the pool when the download fails too', async () => {
    await serveAll();
    serve(CBZ, 500);
    await expect(htmlDownloadProvider.download(link())).rejects.toThrow();
    expect(poolUsers.atAddTask).toEqual([1]);
    expect(poolUsers.count).toBe(0);
  });

  it('takes every file from the manifest, and guesses nothing', async () => {
    await serveAll();
    const result = await htmlDownloadProvider.download(link());

    expect(workerTasks).toHaveLength(1);
    expect(workerTasks[0]).toMatchObject({ archiveUrl: CBZ, mokuroUrls: [], coverUrls: [] });
    expect(fetchedUrls()[0]).toBe(MANIFEST);
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: 'no-store' });
    // Nothing that is not in the manifest was tried.
    expect(fetchedUrls().some((u) => u.endsWith('.mokuro.gz') && u.includes('01.mokuro'))).toBe(
      false
    );

    expect(result.archiveFile?.name).toBe('Dr Stone 01.cbz');
    expect(result.mokuroFile?.name).toBe('Dr Stone 01.mokuro');
    expect(await result.mokuroFile!.text()).toBe(OCR_JSON);
    expect(result.coverFile?.name).toBe('Dr Stone 01.webp');
    expect(result.bundleType).toBe('triple');
    expect(result.manifest?.archive.url).toBe(CBZ);
    expect(result.manifestUrl).toBe(MANIFEST);
  });

  it('hands the layers over raw, each with its id, gz flag, URL and stamps', async () => {
    await serveAll();
    const result = await htmlDownloadProvider.download(link());
    expect(result.layers.map((l) => [l.layerId, l.gz, l.label, l.size, l.modifiedTime])).toEqual([
      [
        'hayai-nova-ppocr',
        false,
        `${BASE}Dr%20Stone%2001.hayai-nova-ppocr.mokuro`,
        67,
        '2026-09-27T01:02:05Z'
      ],
      ['paddle', true, `${BASE}Dr%20Stone%2001.paddle.mokuro.gz`, 12, undefined]
    ]);
    expect(await result.layers[0].blob.text()).toBe('{"pages":[]}');
  });

  it('validates series.json through the import module and keeps it for after the save', async () => {
    await serveAll();
    const result = await htmlDownloadProvider.download(link());
    expect(result.seriesFile).toMatchObject({
      path: `${BASE}series.json`,
      size: SERIES_JSON.length,
      modifiedTime: '2026-09-27T01:02:07.000Z'
    });
    expect(result.seriesFile!.file.series_title).toBe('Dr Stone');
    expect(result.seriesFile!.file.external_ids).toEqual({ anilist: 98416 });
  });

  it('decompresses a .mokuro.gz primary', async () => {
    await serveAll({ ocr: { url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.mokuro.gz' } });
    serve(`${BASE}Dr%20Stone%2001.mokuro.gz`, await gzip(OCR_JSON));
    const result = await htmlDownloadProvider.download(link());
    expect(result.mokuroFile?.name).toBe('Dr Stone 01.mokuro');
    expect(await result.mokuroFile!.text()).toBe(OCR_JSON);
  });

  it('imports image-only when the manifest lists no OCR yet', async () => {
    await serveAll({ ocr: null, layers: [], cover: null, series_file: null });
    const result = await htmlDownloadProvider.download(link());
    expect(result.mokuroFile).toBeNull();
    expect(result.layers).toEqual([]);
    expect(result.seriesFile).toBeNull();
    expect(result.coverFile).toBeNull();
    expect(result.bundleType).toBe('single');
    expect(fetchedUrls()).toEqual([MANIFEST, CBZ]);
  });

  it('a cover param wins over the manifest cover', async () => {
    await serveAll();
    serve(`${ORIGIN}/covers/custom.png`, new Uint8Array([7]));
    const result = await htmlDownloadProvider.download(
      requestFor(
        `cbz=${encodeURIComponent(CBZ)}&manifest=${encodeURIComponent(MANIFEST)}&cover=${encodeURIComponent('covers/custom.png')}`
      )
    );
    expect(result.coverFile?.name).toBe('Dr Stone 01.png');
    expect(fetchedUrls()).not.toContain(`${BASE}Dr%20Stone%2001.webp`);
  });

  // bunko's catalog passes its library-relative cover path as `cover`, which
  // never resolves on the origin root: the manifest's own URL must still win out.
  it('falls back to the manifest cover when the cover param fails', async () => {
    await serveAll();
    const result = await htmlDownloadProvider.download(
      requestFor(
        `cbz=${encodeURIComponent(CBZ)}&manifest=${encodeURIComponent(MANIFEST)}&cover=${encodeURIComponent('Dr Stone/Dr Stone 01.webp')}`
      )
    );
    expect(fetchedUrls()).toContain(`${ORIGIN}/Dr%20Stone/Dr%20Stone%2001.webp`);
    expect(result.coverFile?.name).toBe('Dr Stone 01.webp');
    expect(new Uint8Array(await result.coverFile!.arrayBuffer())).toEqual(
      new Uint8Array([9, 9, 9, 9])
    );
  });

  // A series named `#Zombie Sagashitemasu`: unencoded, the `#` cut the URL to
  // the site root, whose catalog page was stored as the volume's cover.
  it('encodes a relative cover param, so a # in a name stays in the path', async () => {
    await serveAll();
    serve(
      `${ORIGIN}/`,
      new Response('<html>catalog</html>', { headers: { 'content-type': 'text/html' } })
    );
    serve(`${ORIGIN}/%23Zombie/%23Zombie%2001.png`, new Uint8Array([7]));
    const result = await htmlDownloadProvider.download(
      requestFor(
        `cbz=${encodeURIComponent(CBZ)}&manifest=${encodeURIComponent(MANIFEST)}&cover=${encodeURIComponent('#Zombie/#Zombie 01.png')}`
      )
    );
    expect(result.coverFile?.name).toBe('Dr Stone 01.png');
    expect(fetchedUrls()).not.toContain(`${ORIGIN}/`);
  });

  it('never takes a page that is not an image as the cover', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await serveAll();
    serve(
      `${BASE}Dr%20Stone%2001.webp`,
      new Response('<html>catalog</html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    );
    const result = await htmlDownloadProvider.download(link());
    expect(result.coverFile).toBeNull();
    expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain(
      'Dr%20Stone%2001.webp'
    );
  });

  it('survives every listed file failing, warning once per file by name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serve(MANIFEST, JSON.stringify(manifest()));
    serve(CBZ, new Uint8Array([1, 2, 3]));
    serve(`${BASE}Dr%20Stone%2001.mokuro`, 500);
    serve(`${BASE}Dr%20Stone%2001.hayai-nova-ppocr.mokuro`, new TypeError('Failed to fetch'));
    serve(`${BASE}Dr%20Stone%2001.paddle.mokuro.gz`, await gzip('{"pages":[]}'));
    serve(`${BASE}Dr%20Stone%2001.webp`, 403);
    serve(`${BASE}series.json`, '{ not json');

    const result = await htmlDownloadProvider.download(link());

    expect(result.archiveFile).not.toBeNull();
    expect(result.mokuroFile).toBeNull();
    expect(result.coverFile).toBeNull();
    expect(result.seriesFile).toBeNull();
    expect(result.layers.map((l) => l.layerId)).toEqual(['paddle']);
    const warned = warn.mock.calls.map((c) => c.map(String).join(' '));
    for (const name of [
      'Dr%20Stone%2001.mokuro',
      'Dr%20Stone%2001.hayai-nova-ppocr.mokuro',
      'Dr%20Stone%2001.webp',
      'series.json'
    ]) {
      expect(warned.filter((w) => w.includes(`${BASE}${name}`) || w.includes(name))).not.toEqual(
        []
      );
    }
  });

  it('still fails when the archive itself cannot be fetched', async () => {
    serve(MANIFEST, JSON.stringify(manifest()));
    serve(CBZ, 404);
    await expect(htmlDownloadProvider.download(link())).rejects.toThrow();
  });

  it('names what it is fetching in the progress text', async () => {
    await serveAll();
    const statuses: string[] = [];
    await htmlDownloadProvider.download(link(), (s) => statuses.push(s.status));
    expect(statuses).toContain('Fetching volume manifest...');
    expect(statuses).toContain('Fetching OCR...');
    expect(statuses).toContain('Fetching OCR layers (2)...');
    expect(statuses).toContain('Fetching cover...');
    expect(statuses).toContain('Fetching series info...');
  });
});

describe('falling back to guessing sidecars from the cbz URL', () => {
  const legacyMokuroUrls = [`${BASE}Dr%20Stone%2001.mokuro`, `${BASE}Dr%20Stone%2001.mokuro.gz`];

  it('guesses as before when the link has no manifest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serve(CBZ, new Uint8Array([1, 2, 3]));
    serve(`${BASE}Dr%20Stone%2001.mokuro`, OCR_JSON);
    const result = await htmlDownloadProvider.download(
      requestFor(`cbz=${encodeURIComponent(CBZ)}`)
    );
    expect(workerTasks[0]).toMatchObject({
      archiveUrl: CBZ,
      mokuroUrls: legacyMokuroUrls,
      coverUrls: [`${BASE}Dr%20Stone%2001.webp`]
    });
    expect(result.mokuroFile).not.toBeNull();
    expect(result.layers).toEqual([]);
    expect(result.seriesFile).toBeNull();
    expect(result.manifest).toBeNull();
    expect(result.manifestUrl).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  for (const [what, route] of [
    ['unreachable', new TypeError('Failed to fetch')],
    ['a 404', 404],
    ['not JSON', '<html>'],
    ['invalid', JSON.stringify({ version: 1, archive: null })]
  ] as Array<[string, Route]>) {
    it(`guesses as before, warning once, when the manifest is ${what}`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      serve(MANIFEST, route);
      serve(CBZ, new Uint8Array([1, 2, 3]));
      const result = await htmlDownloadProvider.download(
        requestFor(`cbz=${encodeURIComponent(CBZ)}&manifest=${encodeURIComponent(MANIFEST)}`)
      );
      expect(workerTasks[0]).toMatchObject({ archiveUrl: CBZ, mokuroUrls: legacyMokuroUrls });
      expect(result.archiveFile).not.toBeNull();
      expect(result.manifest).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0].map(String).join(' ')).toContain(MANIFEST);
    });
  }
});
