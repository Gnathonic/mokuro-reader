/**
 * The reader parses what Bunko actually answers: every fixture here comes from
 * mokuro-bunko's `interop/contract/bunko/` (exported from a seeded server by
 * its `contract_export` test), fed through the reader's real parsing code. A
 * field Bunko renames or drops fails here, in the reader's own terms.
 *
 * The seed: `reader` (uploader), `viewer` (no write rights), `admin`; series
 * `Contract Series` (Volume 01 with OCR, Volume 02 without) and `日本語シリーズ`
 * (`第1巻`, with OCR).
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { WebDAVClient } from 'webdav';

// The `webdav` library binds `fetch` when it loads: a delegating stub goes in
// before anything can import it, and each test points it at its own handler.
const fetchHandler = vi.hoisted(() => {
  const state: { impl: typeof fetch | null } = { impl: null };
  const delegate = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!state.impl) throw new Error('fetch called without a handler');
    return state.impl(input, init);
  }) as typeof fetch;
  globalThis.fetch = delegate;
  if (typeof window !== 'undefined') window.fetch = delegate;
  return state;
});

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/util/sync/core/cloud-provider-core-registry', () => ({
  getCloudProviderCore: () => ({ uploadFile: vi.fn(), downloadFile: vi.fn() })
}));
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { updateStatus: vi.fn() }
}));
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: { registerCache: vi.fn() }
}));
vi.mock('$lib/util/sync/providers/webdav/webdav-cache', () => ({ webdavCache: {} }));

import { QUEUE_SNAPSHOT } from '$lib/catalog/__fixtures__/mokuro-queue';
import { MARKER_SNAPSHOT } from '$lib/catalog/__fixtures__/bunko-marker';
import {
  EPOCH_MS,
  describeContract,
  fixtureFetch,
  fixtureHeader,
  loadBunkoFixture,
  loadSeed,
  type Fixture
} from './contract';
import { fetchServerIdentity } from '$lib/util/sync/providers/webdav/identity';
import { requestBunkoToken, revokeBunkoToken } from '$lib/util/sync/providers/webdav/bunko-token';
import { loadVolumeManifest, parseVolumeManifest } from '$lib/import/deep-link-manifest';
import { parseQueueFile } from '$lib/catalog/server-ocr-queue';
import {
  isMarkerFresh,
  parseBunkoMarker,
  type MarkerNodeRecord
} from '$lib/catalog/cloud-bunko-marker';
import { parseSeriesFileWithReport } from '$lib/metadata/series-file';
import { parseCatalogFile } from '$lib/metadata/catalog-file';
import {
  WebdavUploadError,
  readServerOcrHeaders,
  uploadFileWithClient
} from '$lib/util/sync/providers/webdav/webdav-upload';
import { classifyWriteError } from '$lib/util/sync/providers/webdav/webdav-errors';

const SERVER = 'https://bunko.example';
const NOW = Date.parse('2026-10-28T12:00:00Z');

/**
 * Keys of `raw` (Bunko's object) that `parsed` (the reader's) lost, beyond `ignored`.
 * The reader's parsers drop unknown keys silently, so a field Bunko renames would
 * otherwise vanish without a failing test.
 */
function lostKeys(raw: object, parsed: object, ignored: readonly string[] = []): string[] {
  return Object.keys(raw).filter((k) => !(k in parsed) && !ignored.includes(k));
}

const fx = (name: string, now = NOW) => loadBunkoFixture(name, { now });
const password = (user: string) => loadSeed().users.find((u) => u.username === user)!.password;

afterEach(() => {
  fetchHandler.impl = null;
});

describeContract('identity (`/login/api/me`) as Bunko answers it', () => {
  const identify = (name: string, user?: string, pw?: string, token?: string) =>
    fetchServerIdentity(SERVER, user, pw, fixtureFetch([fx(name)]).fetch, token);

  it('an uploader may write progress and add files, and owns no series yet', async () => {
    const result = await identify('login-me-basic', 'reader', password('reader'));
    expect(result).toEqual({
      kind: 'authenticated',
      username: 'reader',
      role: 'uploader',
      permissions: {
        canWriteProgress: true,
        canAddFiles: true,
        canModifyDelete: false,
        metadata: { scope: 'owned', ownedSeries: [] }
      },
      endpoint: `${SERVER}/login/api/me`
    });
  });

  it('a bearer token signs in as the same account', async () => {
    const result = await identify('login-me-bearer', undefined, undefined, '<token>');
    expect(result).toMatchObject({ kind: 'authenticated', username: 'reader' });
  });

  it('an account without write rights may neither write progress nor add files', async () => {
    const result = await identify('login-me-viewer', 'viewer', password('viewer'));
    expect(result).toMatchObject({
      kind: 'authenticated',
      username: 'viewer',
      permissions: { canWriteProgress: false, canAddFiles: false, canModifyDelete: false }
    });
  });

  it('a hot limiter is rate-limited, a dead token is invalid', async () => {
    expect(await identify('login-me-rate-limited', 'reader', password('reader'))).toEqual({
      kind: 'rate-limited'
    });
    expect(await identify('login-me-bearer-invalid', undefined, undefined, 'dead')).toEqual({
      kind: 'invalid-credentials'
    });
  });

  it('no credentials is anonymous, a wrong password is invalid', async () => {
    expect(await identify('login-me-anonymous')).toEqual({ kind: 'anonymous' });
    expect(await identify('login-me-bad-password', 'reader', 'not-the-password')).toEqual({
      kind: 'invalid-credentials'
    });
  });
});

describeContract('bearer tokens (`/login/api/token`) as Bunko answers them', () => {
  const ENDPOINT = `${SERVER}/login/api/token`;

  it('sends exactly the body Bunko took, and reads the token and its expiry', async () => {
    const issue = fx('login-token-issue');
    const { fetch, calls } = fixtureFetch([issue]);
    const result = await requestBunkoToken(
      ENDPOINT,
      'reader',
      password('reader'),
      'mokuro-reader',
      fetch
    );
    expect(result).toEqual({
      kind: 'issued',
      token: '<token>',
      expiresAt: Math.floor(NOW / 1000) * 1000
    });
    const sent = JSON.parse(String(calls[0].init?.body));
    expect({ ...sent, password: '<password:reader>' }).toEqual(issue.request.body);
  });

  it('a hot limiter is rate-limited', async () => {
    const { fetch } = fixtureFetch([fx('login-token-rate-limited')]);
    expect(await requestBunkoToken(ENDPOINT, 'reader', password('reader'), 'x', fetch)).toEqual({
      kind: 'rate-limited'
    });
  });

  it('a sign-out is acknowledged', async () => {
    const { fetch } = fixtureFetch([fx('login-token-revoke')]);
    expect(await revokeBunkoToken(ENDPOINT, '<token>', fetch)).toBe(true);
  });
});

describeContract('the volume manifest as Bunko answers it', () => {
  const parse = (name: string) => {
    const f = fx(name);
    return parseVolumeManifest(f.body, `${SERVER}${f.request.path}`)!;
  };

  it('every field the manifest carries survives the parse', () => {
    for (const name of ['manifest-with-ocr', 'manifest-without-ocr', 'manifest-japanese']) {
      const raw = fx(name).body;
      const m = parseVolumeManifest(raw, `${SERVER}${fx(name).request.path}`)!;
      // `version` is checked, not kept.
      expect(lostKeys(raw, m, ['version'])).toEqual([]);
      for (const key of ['archive', 'ocr', 'cover', 'series_file'] as const) {
        if (raw[key] === null) continue;
        // `sha256`: the reader hashes the sidecar it fetched itself (cloud-ocr-upgrade.ts).
        expect(lostKeys(raw[key], m[key]!, ['sha256'])).toEqual([]);
      }
      raw.layers.forEach((l: Record<string, unknown>, i: number) => {
        expect(lostKeys(l, m.layers[i])).toEqual([]);
      });
    }
  });

  it('a volume with OCR: archive, sidecar, layer, cover and series file, resolved on the server', () => {
    const raw = fx('manifest-with-ocr').body;
    const m = parse('manifest-with-ocr');
    const at = new Date(NOW).toISOString().replace(/\.\d{3}Z$/, 'Z');
    expect(m.series_file).toEqual({
      url: `${SERVER}/mokuro-reader/Contract%20Series/series.json`,
      size: raw.series_file.size,
      modified: at
    });
    expect(m.series_file!.size).toBeGreaterThan(0);
    expect(m.layers).toEqual([
      {
        id: 'hayai-nova',
        url: `${SERVER}/mokuro-reader/Contract%20Series/Volume%2001.hayai-nova.mokuro`,
        size: raw.layers[0].size,
        modified: at,
        gz: false
      }
    ]);
    expect(m.cover).toEqual({
      url: `${SERVER}/mokuro-reader/Contract%20Series/Volume%2001.webp`,
      size: raw.cover.size,
      modified: at
    });
    expect(m.series).toBe('Contract Series');
    expect(m.volume).toBe('Volume 01');
    expect(m.archive.url).toBe(`${SERVER}/mokuro-reader/Contract%20Series/Volume%2001.cbz`);
    expect(m.archive.size).toBeGreaterThan(0);
    expect(m.ocr).toMatchObject({
      url: `${SERVER}/mokuro-reader/Contract%20Series/Volume%2001.mokuro`,
      gz: false
    });
    expect(m.series_file?.url).toBe(`${SERVER}/mokuro-reader/Contract%20Series/series.json`);
    expect(m.pending).toEqual([]);
    expect(m.recheck_after).toBeNull();
  });

  it('a volume without OCR: no sidecar, its OCR pending, a recheck delay', () => {
    const m = parse('manifest-without-ocr');
    expect(m.ocr).toBeNull();
    expect(m.pending).toHaveLength(1);
    expect(m.pending[0]).toMatchObject({ kind: 'ocr', eta: null });
    expect(m.recheck_after).toBeGreaterThan(0);
  });

  it('Japanese names round-trip, percent-encoded in every URL', () => {
    const m = parse('manifest-japanese');
    expect(m.series).toBe('日本語シリーズ');
    expect(m.volume).toBe('第1巻');
    const dir = `${SERVER}/mokuro-reader/${encodeURIComponent('日本語シリーズ')}`;
    expect(m.archive.url).toBe(`${dir}/${encodeURIComponent('第1巻')}.cbz`);
    expect(m.ocr?.url).toBe(`${dir}/${encodeURIComponent('第1巻')}.mokuro`);
    expect(decodeURIComponent(new URL(m.series_file!.url).pathname)).toBe(
      '/mokuro-reader/日本語シリーズ/series.json'
    );
  });

  it('an unknown volume is an error the deep link reports', async () => {
    const f = fx('manifest-unknown-volume');
    const { fetch } = fixtureFetch([f]);
    expect(await loadVolumeManifest(`${SERVER}${f.request.path}`, undefined, fetch)).toEqual({
      error: 'HTTP 404'
    });
  });
});

describeContract('the snapshots used without a Bunko checkout', () => {
  it('match Bunko’s fixtures', () => {
    expect(QUEUE_SNAPSHOT).toEqual(loadBunkoFixture('queue-file-http', { now: EPOCH_MS }).body);
    expect(MARKER_SNAPSHOT).toEqual(loadBunkoFixture('marker-active', { now: EPOCH_MS }).body);
  });
});

describeContract('the OCR queue file as Bunko writes it', () => {
  it('the HTTP copy: the volume without OCR waits, held for want of a processor', () => {
    const file = parseQueueFile(fx('queue-file-http').body)!;
    expect(file).not.toBeNull();
    expect(file.held).toEqual({ reason: 'no-processor' });
    expect(file.pending_volumes).toBe(1);
    expect(file.next_check_after).toBeGreaterThan(0);
    expect(file.volumes).toEqual([
      {
        series: 'Contract Series',
        volume: 'Volume 02',
        path: '/mokuro-reader/Contract%20Series/Volume%2002.cbz',
        manifest: '/catalog/api/manifest?series=Contract%20Series&volume=Volume%2002',
        jobs: [expect.objectContaining({ kind: 'ocr', state: 'held', eta: null, progress: null })]
      }
    ]);
    expect(file.done).toEqual([]);
    expect(file.truncated).toBe(false);
  });

  it('the cloud copy: done entries with their sidecars and layers', () => {
    const file = parseQueueFile(fx('queue-file-cloud').body)!;
    expect(file.instance_id).toBeTruthy();
    expect(file.truncated).toBe(false);
    expect(file.done).toEqual([
      {
        series: 'Contract Series',
        volume: 'Volume 01',
        at: new Date(NOW).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        ocr: 'Contract Series/Volume 01.mokuro',
        layers: []
      },
      {
        series: '日本語シリーズ',
        volume: '第1巻',
        at: expect.any(String),
        ocr: '日本語シリーズ/第1巻.mokuro',
        layers: [{ id: 'hayai', path: '日本語シリーズ/第1巻.hayai.mokuro' }]
      }
    ]);
    expect(file.volumes).toHaveLength(1);
  });

  it('a truncated cloud copy says so', () => {
    const file = parseQueueFile(fx('queue-file-cloud-truncated').body)!;
    expect(file.truncated).toBe(true);
    expect(file.volumes).toEqual([]);
    expect(file.done).toHaveLength(2);
  });
});

describeContract('the lease marker as Bunko writes it', () => {
  const record = (body: unknown): MarkerNodeRecord => {
    const m = parseBunkoMarker(body)!;
    return {
      id: 'node-1',
      version: 'v1',
      instance_id: m.instance_id,
      instance_name: m.instance_name,
      heartbeat_at: m.heartbeat_at,
      ttl_s: m.ttl_s,
      state: m.state,
      epoch: m.epoch,
      claimed_at: m.claimed_at,
      compiles: m.compiles,
      changedAt: null
    };
  };

  it('an active marker: Bunko compiles the metadata files and runs the queue', () => {
    const m = parseBunkoMarker(fx('marker-active').body)!;
    expect(m).not.toBeNull();
    expect(m.state).toBe('active');
    expect(m.compiles).toEqual(['series.json', 'catalog.json']);
    expect(m.ocr).toBe(true);
    expect(m.queue).toBe('.mokuro-queue.json');
    expect(m.ttl_s).toBeGreaterThan(0);
  });

  it('is fresh at its heartbeat and stale three TTLs later', () => {
    const rec = record(fx('marker-active', NOW).body);
    expect(isMarkerFresh(rec, NOW)).toBe(true);
    expect(isMarkerFresh(rec, NOW, 'series.json')).toBe(true);
    expect(isMarkerFresh(rec, NOW + 3 * rec.ttl_s * 1000)).toBe(false);
  });

  it('a released marker is never fresh', () => {
    const rec = record(fx('marker-released', NOW).body);
    expect(rec.state).toBe('released');
    expect(isMarkerFresh(rec, NOW)).toBe(false);
  });
});

/**
 * `series.json` volume fields the reader drops on purpose. `matched_page_count`:
 * Bunko's own bookkeeping (how many of the `.mokuro`'s pages it found in the
 * archive, for its manifest and OCR queue); the reader neither reads nor writes it.
 */
const SERIES_VOLUME_IGNORED: readonly string[] = ['matched_page_count'];

describeContract('the compiled metadata files as Bunko writes them', () => {
  for (const [name, title, count] of [
    ['series-json', 'Contract Series', 2],
    ['series-json-japanese', '日本語シリーズ', 1]
  ] as const) {
    it(`${name}: every field of every volume survives the parse, in Bunko's order`, () => {
      const raw = fx(name).body;
      const { file, entryCollapse } = parseSeriesFileWithReport(raw);
      expect(file).toBeDefined();
      expect(entryCollapse).toBe(false);
      expect(file!.series_title).toBe(title);
      expect(raw.volumes).toHaveLength(count);
      expect(file!.volumes).toHaveLength(count);
      expect(lostKeys(raw, file!)).toEqual([]);
      raw.volumes.forEach((v: Record<string, unknown>, i: number) => {
        expect(lostKeys(v, file!.volumes[i], SERIES_VOLUME_IGNORED)).toEqual([]);
        // The reader writes series.json byte for byte as Bunko does (series-file.ts).
        expect(Object.keys(file!.volumes[i])).toEqual(
          Object.keys(v).filter((k) => !SERIES_VOLUME_IGNORED.includes(k))
        );
      });
      expect(Object.keys(file!)).toEqual(Object.keys(raw));
    });
  }

  it('series.json: the stamps the reader compares come through as Bunko wrote them', () => {
    const raw = fx('series-json').body;
    const file = parseSeriesFileWithReport(raw).file!;
    const [v1, v2] = file.volumes;
    expect(v1).toMatchObject({
      volume_uuid: '22222222-2222-4222-8222-222222222222',
      archive_size: raw.volumes[0].archive_size,
      mokuro_size: raw.volumes[0].mokuro_size,
      mokuro_modified: Math.floor(NOW / 1000),
      mokuro_sha256: raw.volumes[0].mokuro_sha256,
      cover_size: raw.volumes[0].cover_size
    });
    // A volume without OCR: Bunko's deterministic uuid, as the reader derives it too.
    expect(v2.volume_uuid).toBe(raw.volumes[1].volume_uuid);
    expect(v2.archive_size).toBe(raw.volumes[1].archive_size);
  });

  it('catalog.json lists both series, every field kept', () => {
    const raw = fx('catalog-json').body;
    const file = parseCatalogFile(raw)!;
    expect(file).toBeDefined();
    expect(file.series.map((s) => s.series_title)).toEqual(['Contract Series', '日本語シリーズ']);
    expect(lostKeys(raw, file)).toEqual([]);
    raw.series.forEach((entry: Record<string, unknown>, i: number) => {
      expect(lostKeys(entry, file.series[i])).toEqual([]);
    });
  });
});

/** An XHR that answers each PUT with the next fixture. */
let xhrAnswers: Fixture[] = [];
class FixtureXhr {
  status = 0;
  statusText = '';
  responseText = '';
  timeout = 0;
  upload = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  private answer: Fixture | null = null;
  open() {}
  setRequestHeader() {}
  getResponseHeader(name: string): string | null {
    return this.answer ? fixtureHeader(this.answer)(name) : null;
  }
  send() {
    this.answer = xhrAnswers.shift()!;
    queueMicrotask(() => {
      this.status = this.answer!.status ?? 200;
      this.responseText =
        this.answer!.body !== undefined
          ? JSON.stringify(this.answer!.body)
          : (this.answer!.body_text ?? '');
      this.onload?.();
    });
  }
}

const client = {
  getFileUploadLink: (path: string) => `${SERVER}${encodeURI(path)}`,
  getHeaders: () => ({})
} as unknown as WebDAVClient;

/** A blob of the size Bunko said it stored (the reader checks `X-Mokuro-Size`). */
const blobFor = (f: Fixture) => new Blob([new Uint8Array(Number(f.headers?.['x-mokuro-size']))]);

describeContract('PUT answers as Bunko gives them', () => {
  beforeEach(() => {
    xhrAnswers = [];
    vi.stubGlobal('XMLHttpRequest', FixtureXhr);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a new volume: verified, staged PUTs, queued for OCR with its manifest', async () => {
    const f = fx('put-volume');
    expect(readServerOcrHeaders(fixtureHeader(f), `${SERVER}${f.request.path}`)).toEqual({
      manifestUrl: `${SERVER}/catalog/api/manifest?series=Contract%20Series&volume=Volume%2003`,
      recheckAfter: Number(f.headers!['x-mokuro-recheck-after'])
    });
    xhrAnswers = [f];
    const result = await uploadFileWithClient(
      client,
      '/mokuro-reader/Contract Series/Volume 03.cbz',
      blobFor(f)
    );
    expect(result.putVerified).toBe(true);
    expect(result.serverOcr?.manifestUrl).toContain('volume=Volume%2003');
  });

  it('a sidecar: stored is enough for a file that is not an archive', async () => {
    const f = fx('put-sidecar');
    xhrAnswers = [f];
    const result = await uploadFileWithClient(
      client,
      '/mokuro-reader/Contract Series/Volume 02.mokuro',
      blobFor(f)
    );
    expect(result.path).toBe('/mokuro-reader/Contract Series/Volume 02.mokuro');
  });

  const failure = async (name: string, path = '/mokuro-reader/Contract Series/Volume 03.cbz') => {
    xhrAnswers = [fx(name)];
    const err = await uploadFileWithClient(client, path, new Blob(['x'])).catch((e) => e);
    expect(err).toBeInstanceOf(WebdavUploadError);
    return err as WebdavUploadError;
  };

  it('a refused account: a final permission error, in the server’s words', async () => {
    const err = await failure('put-refused-viewer');
    expect(err).toMatchObject({ status: 403, reason: 'forbidden', retryable: false });
    expect(err.detail).toBe(fx('put-refused-viewer').body.detail);
    expect(classifyWriteError(err.message)).toBe('permission');
  });

  it('a stale If-Match: final, not retried', async () => {
    const err = await failure('put-precondition-failed');
    expect(err).toMatchObject({ status: 412, retryable: false });
  });
});

describeContract('WebDAV errors as Bunko gives them', () => {
  beforeEach(() => {
    xhrAnswers = [];
    vi.stubGlobal('XMLHttpRequest', FixtureXhr);
  });
  afterEach(() => vi.unstubAllGlobals());

  const failure = async (name: string) => {
    const f = fx(name);
    xhrAnswers = [f];
    const err = await uploadFileWithClient(
      client,
      decodeURIComponent(f.request.path!),
      new Blob(['x'])
    ).catch((e) => e);
    expect(err).toBeInstanceOf(WebdavUploadError);
    return err as WebdavUploadError;
  };

  it('an upload without credentials is an auth error, with a Basic challenge', async () => {
    const err = await failure('dav-401-basic-missing');
    expect(classifyWriteError(err.message)).toBe('auth');
    expect(fx('dav-401-basic-missing').headers!['www-authenticate']).toMatch(/^Basic /);
  });

  it('the lease claim is a 503 the reader retries; Bunko says how long', async () => {
    const err = await failure('dav-503-lease-claiming');
    expect(err).toMatchObject({ status: 503, retryable: true });
    expect(err.detail).toContain('storage-lease-claiming');
    expect(Number(fx('dav-503-lease-claiming').headers!['retry-after'])).toBeGreaterThan(0);
  });

  it('a full store is final; a lock held elsewhere and a missing parent are not auth errors', async () => {
    expect(await failure('dav-507')).toMatchObject({
      status: 507,
      reason: 'disk-full',
      retryable: false
    });
    const locked = await failure('dav-423');
    expect(locked).toMatchObject({ status: 423, retryable: true });
    const conflict = await failure('dav-409');
    expect(conflict).toMatchObject({ status: 409, retryable: false });
    expect(classifyWriteError(conflict.message)).toBe('other');
  });

  it('a dead bearer token is challenged as one; refusals carry no Retry-After', () => {
    expect(fx('dav-401-bearer-invalid').headers!['www-authenticate']).toContain(
      'error="invalid_token"'
    );
    expect(fx('dav-429').headers!['retry-after']).toBeUndefined();
    expect(fx('dav-401-basic-latin1').status).toBe(401);
  });
});

describeContract('PROPFIND answers as Bunko gives them', () => {
  let provider: any;
  let calls: ReturnType<typeof fixtureFetch>['calls'];

  beforeAll(async () => {
    localStorage.clear();
    const answers = fixtureFetch([
      fx('propfind-server-root-depth1'),
      fx('propfind-library-depth0'),
      fx('login-me-basic'),
      fx('login-token-issue'),
      fx('options-library'),
      fx('propfind-root-depth0-privileges'),
      fx('propfind-root-depth1'),
      fx('propfind-root-depth-infinity'),
      fx('propfind-series-depth1')
    ]);
    calls = answers.calls;
    fetchHandler.impl = answers.fetch;
    const { WebDAVProvider } = await import('$lib/util/sync/providers/webdav/webdav-provider');
    provider = new WebDAVProvider();
    await provider.whenReady();
    await provider.login({ serverUrl: SERVER, username: 'reader', password: password('reader') });
  });

  beforeEach(() => {
    if (!fetchHandler.impl) {
      fetchHandler.impl = fixtureFetch([
        fx('propfind-library-depth0'),
        fx('propfind-root-depth0-privileges'),
        fx('propfind-root-depth1'),
        fx('propfind-root-depth-infinity'),
        fx('propfind-series-depth1')
      ]).fetch;
    }
  });

  it('signs in from the identity Bunko gives, and learns that PUTs are verified', () => {
    expect(provider.isAuthenticated()).toBe(true);
    expect(provider.isReadOnly).toBe(false);
    expect(calls.some((c) => c.url === `${SERVER}/login/api/me`)).toBe(true);
    // The OPTIONS probe read `X-Mokuro-Put: verified` (uploads then carry a digest).
    expect(calls.some((c) => c.method === 'OPTIONS')).toBe(true);
    expect(localStorage.getItem('webdav_put_verified')).toBe(SERVER);
  });

  it('the privilege probe finds no ACL, and the OPTIONS fallback reads Bunko’s Allow', async () => {
    const answers = fixtureFetch([fx('propfind-root-depth0-privileges'), fx('options-library')]);
    fetchHandler.impl = answers.fetch;
    const allow = fx('options-library').headers!.allow;
    expect(allow).toBeTruthy();
    // Bunko's Allow on the library folder names no PUT or MKCOL (a collection takes
    // neither), so this generic-WebDAV fallback calls it read-only. It runs only when
    // the identity endpoint did not answer for the account.
    expect(await provider.checkWritePermissions(SERVER)).toBe(
      ['PUT', 'DELETE', 'MKCOL'].every((m) =>
        allow
          .split(',')
          .map((x: string) => x.trim())
          .includes(m)
      )
    );
    expect(answers.calls.map((c) => c.method)).toEqual(['PROPFIND', 'OPTIONS']);
    expect(answers.calls[1].url).toBe(`${SERVER}/mokuro-reader/`);
  });

  it('the Depth: infinity listing yields every volume, sidecar and metadata file', async () => {
    const files = await provider.listCloudVolumes();
    const paths = files.map((f: { path: string }) => f.path).sort();
    expect(paths).toEqual(
      [
        'Contract Series/Volume 01.cbz',
        'Contract Series/Volume 01.mokuro',
        'Contract Series/Volume 01.hayai-nova.mokuro',
        'Contract Series/Volume 01.webp',
        'Contract Series/Volume 02.cbz',
        'Contract Series/series.json',
        'catalog.json',
        '日本語シリーズ/series.json',
        '日本語シリーズ/第1巻.cbz',
        '日本語シリーズ/第1巻.mokuro'
      ].sort()
    );
    const vol = files.find((f: { path: string }) => f.path === 'Contract Series/Volume 01.cbz');
    expect(vol.size).toBeGreaterThan(0);
    expect(vol.fileId).toBe('/mokuro-reader/Contract Series/Volume 01.cbz');
  });
});
