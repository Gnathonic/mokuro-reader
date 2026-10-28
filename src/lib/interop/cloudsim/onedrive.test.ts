/**
 * The OneDrive provider against cloudsim (`CLOUDSIM_URL`): the real provider,
 * Graph client and upload core, with Graph pointed at the simulator and a token
 * handed to the token manager instead of MSAL. Skipped without a simulator.
 * The suites share one simulator and reset it: run them with
 * `--no-file-parallelism`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  blobText,
  cloudsimUrl,
  fetchWithoutForeignSignals,
  sendBlobsAsBytes,
  sha256Hex,
  sim
} from '../cloudsim';
import { setCloudTestBases, setCloudTestToken } from '$lib/util/sync/cloud-test-hooks';
import { ProviderError, type CloudFileMetadata } from '$lib/util/sync/provider-interface';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));

const VOLUME = new Uint8Array(90_000).map((_, i) => (i * 7) % 253);
const SIDECAR = JSON.stringify({ version: '0.2.5', volume: 'Vol 1', pages: [] });
const CATALOG = JSON.stringify({ version: 1, series: [] });

describe.skipIf(!cloudsimUrl())('OneDrive provider against cloudsim', () => {
  type Provider = import('$lib/util/sync/providers/onedrive/onedrive-provider').OneDriveProvider;
  let provider: Provider;
  let tokenManager: typeof import('$lib/util/sync/providers/onedrive/token-manager').onedriveTokenManager;
  let accessToken = '';
  let restoreXhr = () => {};
  let restoreFetch = () => {};

  async function signIn(): Promise<void> {
    const t = await sim.token('microsoft');
    accessToken = t.access_token;
    setCloudTestToken('onedrive', t.access_token);
  }

  async function find(path: string): Promise<CloudFileMetadata> {
    const hit = (await provider.listCloudVolumes()).find((f) => f.path === path);
    if (!hit) throw new Error(`${path} not listed`);
    return hit;
  }

  beforeAll(async () => {
    await sim.reset();
    restoreXhr = sendBlobsAsBytes();
    restoreFetch = fetchWithoutForeignSignals();
    setCloudTestBases(sim.bases());
    const { OneDriveProvider } = await import(
      '$lib/util/sync/providers/onedrive/onedrive-provider'
    );
    ({ onedriveTokenManager: tokenManager } = await import(
      '$lib/util/sync/providers/onedrive/token-manager'
    ));
    provider = new OneDriveProvider();
    await sim.seed('microsoft', [
      { path: 'mokuro-reader/Series A/Vol 1.cbz', data: VOLUME },
      { path: 'mokuro-reader/Series A/Vol 1.mokuro', data: SIDECAR },
      { path: 'mokuro-reader/catalog.json', data: CATALOG }
    ]);
    await signIn();
  });

  afterEach(async () => {
    expect(await sim.takeViolations()).toEqual([]);
  });

  afterAll(async () => {
    setCloudTestToken('onedrive', null);
    setCloudTestBases(null);
    restoreXhr();
    restoreFetch();
    await sim.reset();
  });

  it('lists the seeded volume and its sidecar', async () => {
    expect(provider.isAuthenticated()).toBe(true);
    const paths = (await provider.listCloudVolumes()).map((f) => f.path).sort();
    expect(paths).toEqual(['Series A/Vol 1.cbz', 'Series A/Vol 1.mokuro', 'catalog.json']);
  });

  it('downloads through the redirect, and the pre-authenticated URL never sees the token', async () => {
    await sim.clearLog();
    const blob = await provider.downloadFile(await find('Series A/Vol 1.cbz'));
    const got = new Uint8Array(await blob.arrayBuffer());
    expect(await sha256Hex(got)).toBe(await sha256Hex(VOLUME));
    const log = await sim.log();
    const content = log.find((e) => e.path.endsWith('/content'));
    expect(content?.status).toBe(302);
    const preauth = log.find((e) => e.path.includes('/graph/preauth/'));
    // A token on the pre-authenticated URL is refused (401) by the simulator.
    expect(preauth?.status).toBe(200);
    expect(preauth?.bytes_out).toBe(VOLUME.length);
  });

  it('uploads through an upload session, replaces in place, then deletes', async () => {
    const body = new Uint8Array(1500).map((_, i) => i % 256);
    await provider.uploadFile('Series A/Vol 2.cbz', new Blob([body]));
    let files = await sim.files('microsoft');
    const hit = files.find((f) => f.path === 'mokuro-reader/Series A/Vol 2.cbz');
    expect(hit?.sha256).toBe(await sha256Hex(body));
    const sessions = (await sim.log()).filter((e) => e.path.endsWith(':/createUploadSession'));
    expect(sessions.length).toBeGreaterThan(0);

    await provider.uploadFile('Series A/Vol 2.cbz', new Blob(['replaced']));
    files = await sim.files('microsoft');
    const same = files.filter((f) => f.path === 'mokuro-reader/Series A/Vol 2.cbz');
    expect(same).toHaveLength(1);
    expect(same[0].size).toBe(8);

    await provider.deleteFile(await find('Series A/Vol 2.cbz'));
    files = await sim.files('microsoft');
    expect(files.some((f) => f.path.endsWith('Vol 2.cbz'))).toBe(false);
  });

  it('creates a missing series folder on upload', async () => {
    await provider.uploadFile('Series B/Vol 1.mokuro', new Blob(['{}']));
    const files = await sim.files('microsoft');
    expect(files.some((f) => f.path === 'mokuro-reader/Series B/Vol 1.mokuro')).toBe(true);
  });

  it('reads a control file once, then answers not-modified without a download', async () => {
    await sim.clearLog();
    const first = await provider.readControlFile('catalog.json');
    if (!first || first === 'not-modified') throw new Error(`read: ${first}`);
    expect(await blobText(first.nodes[0].blob)).toBe(CATALOG);
    const second = await provider.readControlFile('catalog.json', { ifNoneMatch: first.etag });
    expect(second).toBe('not-modified');
    const downloads = (await sim.log()).filter((e) => e.class === 'download');
    // The /content redirect and the pre-authenticated GET it leads to: one download.
    expect(downloads.filter((e) => e.path.includes('/graph/preauth/'))).toHaveLength(1);
  });

  it('a 429 on an upload chunk is retried after Retry-After and the upload lands', async () => {
    await sim.clearLog();
    await sim.fault({
      provider: 'microsoft',
      method: 'PUT',
      path_has: '/upload/',
      status: 429,
      reason: 'activityLimitReached',
      retry_after: 1
    });
    await provider.uploadFile('Series A/Vol 3.mokuro', new Blob(['{"v":3}']));
    const puts = (await sim.log()).filter((e) => e.method === 'PUT' && e.class === 'upload');
    expect(puts.map((e) => e.status)).toEqual([429, 201]);
    const files = await sim.files('microsoft');
    expect(files.some((f) => f.path === 'mokuro-reader/Series A/Vol 3.mokuro')).toBe(true);
  });

  // The upload core treats every 5xx as transient, 507 included: it tries the
  // session five times before giving up (Retry-After: 0 keeps this quick).
  it('a 507 insufficientStorage fails the upload after the session retries', async () => {
    await sim.clearLog();
    await sim.fault({
      provider: 'microsoft',
      method: 'POST',
      path_has: 'createUploadSession',
      status: 507,
      reason: 'insufficientStorage',
      retry_after: 0,
      times: 10
    });
    const err = await provider
      .uploadFile('Series A/Vol 4.mokuro', new Blob(['{}']))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('UPLOAD_FAILED');
    expect((err as ProviderError).message).toContain('507');
    const sessions = (await sim.log()).filter((e) => e.path.endsWith(':/createUploadSession'));
    expect(sessions.map((e) => e.status)).toEqual([507, 507, 507, 507, 507]);
    await sim.reset();
    await sim.seed('microsoft', [{ path: 'mokuro-reader/catalog.json', data: CATALOG }]);
    await signIn();
  });

  it('an expired token surfaces as an auth error and flags the session for reconnect', async () => {
    await sim.expire(accessToken);
    const err = await provider.listCloudVolumes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('GRAPH_401');
    expect((err as ProviderError).isAuthError).toBe(true);
    let needsAttention = false;
    tokenManager.needsAttention.subscribe((v) => (needsAttention = v))();
    expect(needsAttention).toBe(true);
    await signIn();
  });
});
