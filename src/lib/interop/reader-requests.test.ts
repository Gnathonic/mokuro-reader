/**
 * The requests the reader sends to Bunko, recorded from the reader's own code
 * into mokuro-bunko's `interop/contract/reader/` (compare, or `READER_BLESS=1`
 * to rewrite). Each record names the response fields and headers the code
 * reads; Bunko's `contract_replay` sends the request to a seeded server and
 * checks them. A request the reader changes shows up here as a record diff,
 * and a field it starts to need fails Bunko's replay.
 *
 * The answers the captured code gets back are Bunko's own (its contract
 * fixtures), so each code path runs as it does against a real server.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WebDAVClient } from 'webdav';

// The `webdav` library binds `fetch` when it loads (see bunko-contract.test.ts).
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

import {
  describeContract,
  fixtureFetch,
  fixtureHeader,
  loadBunkoFixture,
  loadSeed,
  recordRequest,
  type CapturedRequest,
  type Fixture,
  type ReaderExpect
} from './contract';
import { fetchServerIdentity } from '$lib/util/sync/providers/webdav/identity';
import {
  requestBunkoToken,
  revokeBunkoToken,
  tokenLabel
} from '$lib/util/sync/providers/webdav/bunko-token';
import { loadVolumeManifest } from '$lib/import/deep-link-manifest';
import { httpQueueSource, parseQueueFile } from '$lib/catalog/server-ocr-queue';
import {
  contentDigestOf,
  uploadFileWithClient
} from '$lib/util/sync/providers/webdav/webdav-upload';
import { webdavAuthorization } from '$lib/util/sync/core/providers/webdav-authorization';

const SERVER = 'https://bunko.example';
/** The bearer token the tests hold for `reader` (recorded as `bearer:reader`). */
const TOKENS = { reader: 'reader-token' };

const fx = (name: string) => loadBunkoFixture(name);
const password = (user: string) => loadSeed().users.find((u) => u.username === user)!.password;
const basic = (user: string) => webdavAuthorization({ username: user, password: password(user) })!;

function record(
  name: string,
  request: CapturedRequest,
  expectations: ReaderExpect,
  after?: string
) {
  const problem = recordRequest(
    name,
    { request, expect: expectations, ...(after ? { after } : {}) },
    { tokens: TOKENS }
  );
  expect(problem).toBeNull();
}

/** The fetch call `calls[i]` as a captured request. */
function captured(
  call: { method: string; url: string; init?: RequestInit },
  body?: CapturedRequest['body']
): CapturedRequest {
  const raw = call.init?.body;
  return {
    method: call.method,
    url: call.url,
    headers: call.init?.headers as Record<string, string> | undefined,
    body: body ?? (typeof raw === 'string' ? raw : undefined)
  };
}

afterEach(() => {
  fetchHandler.impl = null;
});

/** The identity endpoint's fields `fetchServerIdentity` reads (`identity.ts`). */
const IDENTITY_FIELDS = [
  'authenticated',
  'username',
  'role',
  'permissions.canWriteProgress',
  'permissions.canAddFiles',
  'permissions.canModifyDelete',
  'permissions.metadata.scope',
  'permissions.metadata.ownedSeries'
];

describeContract('identity and tokens', () => {
  it('me-basic: the password as UTF-8 Basic', async () => {
    const { fetch, calls } = fixtureFetch([fx('login-me-basic')]);
    await fetchServerIdentity(SERVER, 'reader', password('reader'), fetch);
    record('me-basic', captured(calls[0]), { status: [200], body_fields: IDENTITY_FIELDS });
  });

  it('me-bearer: a held token instead of the password', async () => {
    const { fetch, calls } = fixtureFetch([fx('login-me-bearer')]);
    await fetchServerIdentity(SERVER, 'reader', password('reader'), fetch, TOKENS.reader);
    record('me-bearer', captured(calls[0]), { status: [200], body_fields: IDENTITY_FIELDS });
  });

  it('token-issue: the password traded for a reader token', async () => {
    const { fetch, calls } = fixtureFetch([fx('login-token-issue')]);
    await requestBunkoToken(
      `${SERVER}/login/api/token`,
      'reader',
      password('reader'),
      tokenLabel(''),
      fetch
    );
    record('token-issue', captured(calls[0]), {
      status: [200],
      body_fields: ['token', 'token_type', 'expires_at']
    });
  });

  it('token-revoke: signing the token out', async () => {
    const { fetch, calls } = fixtureFetch([fx('login-token-revoke')]);
    await revokeBunkoToken(`${SERVER}/login/api/token`, TOKENS.reader, fetch);
    record('token-revoke', captured(calls[0]), { status: [200] });
  });
});

describeContract('the manifest and the queue file', () => {
  it('manifest: a volume’s manifest, with the account header', async () => {
    const f = fx('manifest-with-ocr');
    const { fetch, calls } = fixtureFetch([f]);
    await loadVolumeManifest(
      `${SERVER}${f.request.path}`,
      { Authorization: basic('reader') },
      fetch
    );
    record('manifest', captured(calls[0]), {
      status: [200],
      body_fields: [
        'version',
        'series',
        'volume',
        'archive.url',
        'archive.size',
        'archive.modified',
        'ocr.url',
        'series_file.url',
        'layers',
        'pending'
      ]
    });
  });

  const QUEUE_URL = `${SERVER}/mokuro-reader/.mokuro-queue.json`;
  const init = async () => ({
    cache: 'no-store' as const,
    headers: { Authorization: basic('reader') }
  });

  it('queue-get and queue-get-if-none-match: the poller’s read, then its conditional one', async () => {
    const first = fixtureFetch([fx('queue-file-http')]);
    const read = await httpQueueSource(QUEUE_URL, init, first.fetch).read({
      etag: null,
      file: null
    });
    expect(read).not.toBe('not-modified');
    record('queue-get', captured(first.calls[0]), {
      status: [200],
      body_fields: [
        'version',
        'generated_at',
        'held.reason',
        'next_check_after',
        'pending_volumes',
        'volumes.0.series',
        'volumes.0.volume',
        'volumes.0.path',
        'volumes.0.manifest',
        'volumes.0.jobs.0.kind',
        'volumes.0.jobs.0.id',
        'volumes.0.jobs.0.state'
      ],
      headers: ['etag']
    });

    const second = fixtureFetch([fx('queue-file-http-not-modified')]);
    const file = parseQueueFile(fx('queue-file-http').body);
    const again = await httpQueueSource(QUEUE_URL, init, second.fetch).read({
      etag: '"from-the-first-answer"',
      file
    });
    expect(again).toBe('not-modified');
    record(
      'queue-get-if-none-match',
      captured(second.calls[0]),
      { status: [304], headers: ['etag'] },
      'queue-get'
    );
  });
});

describeContract('WebDAV reads through the provider', () => {
  async function signedIn() {
    const answers = fixtureFetch([
      fx('propfind-server-root-depth1'),
      fx('propfind-library-depth0'),
      // No token endpoint answers here: the session stays on Basic, so every
      // record below carries the seed account's header.
      fx('login-me-basic')
    ]);
    fetchHandler.impl = answers.fetch;
    const { WebDAVProvider } = await import('$lib/util/sync/providers/webdav/webdav-provider');
    localStorage.clear();
    const provider = new WebDAVProvider() as any;
    await provider.whenReady();
    await provider.login({ serverUrl: SERVER, username: 'reader', password: password('reader') });
    expect(provider.isAuthenticated()).toBe(true);
    return provider;
  }

  it('control-file-get: the queue file read twice, the second time conditionally', async () => {
    const provider = await signedIn();
    const reads = fixtureFetch([fx('queue-file-http')]);
    fetchHandler.impl = reads.fetch;
    const first = await provider.readControlFile('.mokuro-queue.json');
    const conditional = fixtureFetch([fx('get-control-file-not-modified')]);
    fetchHandler.impl = conditional.fetch;
    expect(await provider.readControlFile('.mokuro-queue.json', { ifNoneMatch: first.etag })).toBe(
      'not-modified'
    );
    record(
      'control-file-get',
      captured(conditional.calls[0]),
      { status: [304], headers: ['etag'] },
      'queue-get'
    );
  });

  it('propfind-privileges: the write-permission probe', async () => {
    const provider = await signedIn();
    const probe = fixtureFetch([fx('propfind-root-depth0-privileges')]);
    fetchHandler.impl = probe.fetch;
    await provider.checkWritePermissions(SERVER);
    record('propfind-privileges', captured(probe.calls[0]), { status: [207] });
  });

  it('propfind-listing: the library listing (Depth: infinity)', async () => {
    const provider = await signedIn();
    const listing = fixtureFetch([
      fx('propfind-library-depth0'),
      fx('propfind-root-depth-infinity')
    ]);
    fetchHandler.impl = listing.fetch;
    const files = await provider.listCloudVolumes();
    expect(files.length).toBeGreaterThan(0);
    const call = listing.calls.find((c) => c.method === 'PROPFIND' && c.url.endsWith('/'))!;
    record('propfind-listing', captured(call), { status: [207], headers: ['content-type'] });
  });
});

/** An XHR that records the PUT and answers with the next fixture. */
let xhrAnswers: Fixture[] = [];
let xhrSent: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
class RecordingXhr {
  status = 0;
  statusText = '';
  responseText = '';
  timeout = 0;
  upload = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  private method = '';
  private url = '';
  private headers: Record<string, string> = {};
  private answer: Fixture | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  getResponseHeader(name: string): string | null {
    return this.answer ? fixtureHeader(this.answer)(name) : null;
  }
  send() {
    xhrSent.push({ method: this.method, url: this.url, headers: this.headers });
    this.answer = xhrAnswers.shift()!;
    queueMicrotask(() => {
      this.status = this.answer!.status ?? 200;
      this.onload?.();
    });
  }
}

describeContract('uploads', () => {
  beforeEach(() => {
    xhrAnswers = [];
    xhrSent = [];
    vi.stubGlobal('XMLHttpRequest', RecordingXhr);
  });
  afterEach(() => vi.unstubAllGlobals());

  const client = {
    getFileUploadLink: (path: string) => `${SERVER}${encodeURI(path)}`,
    getHeaders: () => ({ Authorization: basic('reader') })
  } as unknown as WebDAVClient;

  /** The verdict headers `uploadFileWithClient` reads from every answer. */
  const VERDICT = ['x-mokuro-upload', 'x-mokuro-size'];

  it('put-volume: a new archive, with its digest', async () => {
    const f = fx('put-volume');
    xhrAnswers = [f];
    const blob = new Blob([new Uint8Array(Number(f.headers!['x-mokuro-size']))]);
    await uploadFileWithClient(
      client,
      '/mokuro-reader/Contract Series/Volume 03.cbz',
      blob,
      undefined,
      {
        contentDigest: (await contentDigestOf(blob))!
      }
    );
    const sent = xhrSent[0];
    record(
      'put-volume',
      { ...sent, body: { cbz: { pages: 2 } } },
      {
        status: [201, 204],
        headers: [...VERDICT, 'x-mokuro-put', 'x-mokuro-manifest', 'x-mokuro-recheck-after']
      }
    );
  });

  it('put-sidecar: an OCR sidecar for a volume that has none', async () => {
    const f = fx('put-sidecar');
    xhrAnswers = [f];
    const text = JSON.stringify(f.request.body);
    const blob = new Blob([text]);
    await uploadFileWithClient(
      client,
      '/mokuro-reader/Contract Series/Volume 02.mokuro',
      blob,
      undefined,
      { contentDigest: (await contentDigestOf(blob))! }
    ).catch(() => undefined);
    record('put-sidecar', { ...xhrSent[0], body: text }, { status: [201, 204], headers: VERDICT });
  });
});
