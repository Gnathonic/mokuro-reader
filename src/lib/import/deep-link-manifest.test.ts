import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confineManifestToOrigins,
  fetchVolumeManifest,
  parseVolumeManifest
} from './deep-link-manifest';

const MANIFEST_URL =
  'https://bunko.example/catalog/api/manifest?series=Dr%20Stone&volume=Dr%20Stone%2001';

/** The example from the contract, stamps and all. */
function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    series: 'Dr Stone',
    volume: 'Dr Stone 01',
    archive: {
      url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz',
      size: 123,
      modified: '2026-09-27T01:02:03Z'
    },
    ocr: {
      url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.mokuro',
      size: 45,
      modified: '2026-09-27T01:02:04Z'
    },
    layers: [
      {
        id: 'hayai-nova-ppocr',
        url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.hayai-nova-ppocr.mokuro',
        size: 67,
        modified: '2026-09-27T01:02:05Z'
      }
    ],
    cover: {
      url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.webp',
      size: 8,
      modified: '2026-09-27T01:02:06Z'
    },
    series_file: {
      url: '/mokuro-reader/Dr%20Stone/series.json',
      size: 9,
      modified: '2026-09-27T01:02:07Z'
    },
    ...overrides
  };
}

describe('parseVolumeManifest', () => {
  it('reads every entry and resolves each URL against the manifest URL', () => {
    const manifest = parseVolumeManifest(sample(), MANIFEST_URL);
    expect(manifest).toEqual({
      series: 'Dr Stone',
      volume: 'Dr Stone 01',
      archive: {
        url: 'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz',
        size: 123,
        modified: '2026-09-27T01:02:03Z'
      },
      ocr: {
        url: 'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.mokuro',
        size: 45,
        modified: '2026-09-27T01:02:04Z',
        gz: false
      },
      layers: [
        {
          id: 'hayai-nova-ppocr',
          url: 'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.hayai-nova-ppocr.mokuro',
          size: 67,
          modified: '2026-09-27T01:02:05Z',
          gz: false
        }
      ],
      cover: {
        url: 'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.webp',
        size: 8,
        modified: '2026-09-27T01:02:06Z'
      },
      series_file: {
        url: 'https://bunko.example/mokuro-reader/Dr%20Stone/series.json',
        size: 9,
        modified: '2026-09-27T01:02:07Z'
      },
      pending: [],
      recheck_after: null
    });
  });

  it('reads pending jobs and recheck_after, dropping junk entries', () => {
    const manifest = parseVolumeManifest(
      sample({
        pending: [
          { kind: 'ocr', id: 'mokuro-fp16', eta: '2026-09-27T21:14:00Z' },
          { kind: 'layer', id: 'hayai-nova-ppocr', eta: null },
          { kind: 'layer', id: 'paddle', eta: 'soon' },
          { kind: 'other', id: 'x', eta: null },
          { kind: 'ocr', eta: null },
          'junk'
        ],
        recheck_after: 95
      }),
      MANIFEST_URL
    )!;
    expect(manifest.pending).toEqual([
      { kind: 'ocr', id: 'mokuro-fp16', eta: '2026-09-27T21:14:00Z' },
      { kind: 'layer', id: 'hayai-nova-ppocr', eta: null },
      { kind: 'layer', id: 'paddle', eta: null }
    ]);
    expect(manifest.recheck_after).toBe(95);
    expect(parseVolumeManifest(sample({ recheck_after: 'x' }), MANIFEST_URL)!.recheck_after).toBe(
      null
    );
  });

  it('resolves relative and absolute URLs the way new URL(url, manifestUrl) does', () => {
    const manifest = parseVolumeManifest(
      sample({
        archive: { url: 'https://cdn.example/a/Vol%201.cbz' },
        ocr: { url: '../files/Vol%201.mokuro.gz' },
        cover: { url: 'Vol%201.webp' }
      }),
      'https://bunko.example/catalog/api/manifest?series=A'
    )!;
    expect(manifest.archive.url).toBe('https://cdn.example/a/Vol%201.cbz');
    expect(manifest.ocr).toMatchObject({
      url: 'https://bunko.example/catalog/files/Vol%201.mokuro.gz',
      gz: true
    });
    expect(manifest.cover!.url).toBe('https://bunko.example/catalog/api/Vol%201.webp');
  });

  it('keeps an entry whose stamps are missing or junk, without the stamps', () => {
    const manifest = parseVolumeManifest(
      sample({ ocr: { url: '/x/Vol.mokuro', size: 'big', modified: 'yesterday' } }),
      MANIFEST_URL
    )!;
    expect(manifest.ocr).toEqual({ url: 'https://bunko.example/x/Vol.mokuro', gz: false });
  });

  it('reads null and absent optional entries as "none"', () => {
    const manifest = parseVolumeManifest(
      { version: 1, archive: { url: '/a/Vol.cbz' }, ocr: null, cover: null, series_file: null },
      MANIFEST_URL
    )!;
    expect(manifest.ocr).toBeNull();
    expect(manifest.cover).toBeNull();
    expect(manifest.series_file).toBeNull();
    expect(manifest.layers).toEqual([]);
  });

  it('refuses a manifest of another version', () => {
    expect(parseVolumeManifest(sample({ version: 2 }), MANIFEST_URL)).toBeNull();
    expect(parseVolumeManifest(sample({ version: '1' }), MANIFEST_URL)).toBeNull();
    const { version: _v, ...noVersion } = sample();
    expect(parseVolumeManifest(noVersion, MANIFEST_URL)).toBeNull();
  });

  it('refuses a manifest without an archive URL', () => {
    expect(parseVolumeManifest(sample({ archive: null }), MANIFEST_URL)).toBeNull();
    expect(parseVolumeManifest(sample({ archive: {} }), MANIFEST_URL)).toBeNull();
    expect(parseVolumeManifest(sample({ archive: { url: '' } }), MANIFEST_URL)).toBeNull();
    expect(parseVolumeManifest(sample({ archive: { url: 42 } }), MANIFEST_URL)).toBeNull();
  });

  it('refuses things that are not a manifest at all', () => {
    expect(parseVolumeManifest(null, MANIFEST_URL)).toBeNull();
    expect(parseVolumeManifest([], MANIFEST_URL)).toBeNull();
    expect(parseVolumeManifest('{"version":1}', MANIFEST_URL)).toBeNull();
  });

  it('drops a malformed optional entry and keeps the rest', () => {
    const manifest = parseVolumeManifest(
      sample({ ocr: { url: 7 }, cover: 'Vol.webp', series_file: { size: 3 } }),
      MANIFEST_URL
    )!;
    expect(manifest.ocr).toBeNull();
    expect(manifest.cover).toBeNull();
    expect(manifest.series_file).toBeNull();
    expect(manifest.archive.url).toContain('Dr%20Stone%2001.cbz');
  });

  it('keeps only layers with a valid id and a URL, in manifest order', () => {
    const manifest = parseVolumeManifest(
      sample({
        layers: [
          { id: 'paddle', url: '/s/V.paddle.mokuro' },
          { id: 'Bad_Id', url: '/s/V.Bad_Id.mokuro' },
          { id: 'x'.repeat(33), url: '/s/V.long.mokuro' },
          { id: 'no-url' },
          null,
          'hayai',
          { id: 'hayai-nova', url: '/s/V.hayai-nova.mokuro.gz' }
        ]
      }),
      MANIFEST_URL
    )!;
    expect(manifest.layers.map((l) => [l.id, l.gz])).toEqual([
      ['paddle', false],
      ['hayai-nova', true]
    ]);
  });

  it('reads a layers value that is not an array as no layers', () => {
    expect(parseVolumeManifest(sample({ layers: {} }), MANIFEST_URL)!.layers).toEqual([]);
  });

  it('keeps one copy per layer id, the plain file beating the .gz', () => {
    const manifest = parseVolumeManifest(
      sample({
        layers: [
          { id: 'paddle', url: '/s/V.paddle.mokuro.gz', size: 1 },
          { id: 'hayai', url: '/s/V.hayai.mokuro' },
          { id: 'paddle', url: '/s/V.paddle.mokuro', size: 2 },
          { id: 'hayai', url: '/s/V.hayai.mokuro.gz' }
        ]
      }),
      MANIFEST_URL
    )!;
    expect(manifest.layers.map((l) => [l.id, l.gz, l.size])).toEqual([
      ['paddle', false, 2],
      ['hayai', false, undefined]
    ]);
  });
});

describe('fetchVolumeManifest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('fetches with no-store and returns the resolved manifest', async () => {
    const fetchMock = stubFetch(
      async () => new Response(JSON.stringify(sample()), { status: 200 })
    );
    const manifest = await fetchVolumeManifest(MANIFEST_URL);
    expect(manifest?.archive.url).toBe(
      'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz'
    );
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST_URL, { cache: 'no-store' });
  });

  it('is null with one warning when the manifest answers an error status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(async () => new Response('nope', { status: 404 }));
    expect(await fetchVolumeManifest(MANIFEST_URL)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(' '))).toContain(MANIFEST_URL);
  });

  it('is null with one warning when the fetch itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchVolumeManifest(MANIFEST_URL)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is null with one warning when the body is not JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(async () => new Response('<html>', { status: 200 }));
    expect(await fetchVolumeManifest(MANIFEST_URL)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is null with one warning when the JSON fails validation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(async () => new Response(JSON.stringify(sample({ version: 2 })), { status: 200 }));
    expect(await fetchVolumeManifest(MANIFEST_URL)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('confineManifestToOrigins', () => {
  const CBZ = 'https://bunko.example/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.cbz';

  it('keeps a manifest whose every file is on the servers the link named', () => {
    const manifest = parseVolumeManifest(sample(), MANIFEST_URL)!;
    expect(confineManifestToOrigins(manifest, [MANIFEST_URL, CBZ])).toEqual({ manifest });
  });

  it('refuses the whole manifest when the archive is elsewhere — scheme and port count', () => {
    for (const url of [
      'http://bunko.example/a.cbz',
      'https://bunko.example:8443/a.cbz',
      'https://192.168.0.9/a.cbz',
      'data:application/zip;base64,UEsDBA=='
    ]) {
      const manifest = parseVolumeManifest(sample({ archive: { url } }), MANIFEST_URL)!;
      expect(confineManifestToOrigins(manifest, [MANIFEST_URL, CBZ])).toHaveProperty('error');
    }
  });

  it('drops each off-origin sidecar on its own, warning once per file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manifest = parseVolumeManifest(
      sample({
        ocr: { url: 'http://localhost:9000/x.mokuro' },
        layers: [
          { id: 'kept', url: '/mokuro-reader/Dr%20Stone/Dr%20Stone%2001.kept.mokuro' },
          { id: 'gone', url: 'https://10.0.0.2/x.gone.mokuro' }
        ],
        cover: { url: 'blob:https://bunko.example/1234' },
        series_file: { url: 'https://elsewhere.example/series.json' }
      }),
      MANIFEST_URL
    )!;
    const confined = confineManifestToOrigins(manifest, [MANIFEST_URL, CBZ]);
    if (!('manifest' in confined)) throw new Error('expected a manifest');
    expect(confined.manifest.ocr).toBeNull();
    expect(confined.manifest.layers.map((l) => l.id)).toEqual(['kept']);
    expect(confined.manifest.cover).toBeNull();
    expect(confined.manifest.series_file).toBeNull();
    expect(confined.manifest.archive).toEqual(manifest.archive);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it('counts no origin for an absent or non-web allowed URL', () => {
    const manifest = parseVolumeManifest(sample(), MANIFEST_URL)!;
    expect(confineManifestToOrigins(manifest, [undefined, 'data:,x'])).toHaveProperty('error');
  });
});

describe('fetchVolumeManifest and redirects', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses a manifest the server redirected to a private address', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const r = new Response(JSON.stringify(sample()), { status: 200 });
        Object.defineProperty(r, 'redirected', { value: true });
        Object.defineProperty(r, 'url', { value: 'https://192.168.1.1/manifest' });
        return r;
      })
    );
    expect(await fetchVolumeManifest(MANIFEST_URL)).toBeNull();
    expect(String(warn.mock.calls[0].join(' '))).toContain('192.168.1.1');
  });
});
