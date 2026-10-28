/**
 * The Google Drive provider against cloudsim (`CLOUDSIM_URL`): the real provider,
 * api-client and token manager, with `gapi.client.drive` replaced by a REST shim
 * and every Drive address pointed at the simulator. Skipped without a simulator.
 * The suites share one simulator and reset it: run them with
 * `--no-file-parallelism`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { blobText, cloudsimUrl, sendBlobsAsBytes, sha256Hex, sim } from '../cloudsim';
import { installGapiRestShim, removeGapiRestShim } from '../gapi-rest-shim';
import { setCloudTestBases } from '$lib/util/sync/cloud-test-hooks';
import { ProviderError, type CloudFileMetadata } from '$lib/util/sync/provider-interface';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));

const VOLUME = new Uint8Array(70_000).map((_, i) => (i * 31) % 251);
const SIDECAR = JSON.stringify({ version: '0.2.5', volume: 'Vol 1', pages: [] });
const CATALOG = JSON.stringify({ version: 1, series: [] });

describe.skipIf(!cloudsimUrl())('Google Drive provider against cloudsim', () => {
  let provider: typeof import('$lib/util/sync/providers/google-drive/google-drive-provider').googleDriveProvider;
  let tokenManager: typeof import('$lib/util/sync/providers/google-drive/token-manager').tokenManager;
  let accessToken = '';
  let restoreXhr = () => {};

  async function signIn(): Promise<void> {
    const t = await sim.token('google');
    accessToken = t.access_token;
    (globalThis as any).gapi.client.setToken({ access_token: t.access_token });
    tokenManager.setToken(t.access_token, t.expires_in);
  }

  async function listed(): Promise<CloudFileMetadata[]> {
    return provider.listCloudVolumes();
  }

  async function find(path: string): Promise<CloudFileMetadata> {
    const hit = (await listed()).find((f) => f.path === path);
    if (!hit) throw new Error(`${path} not listed`);
    return hit;
  }

  beforeAll(async () => {
    await sim.reset();
    restoreXhr = sendBlobsAsBytes();
    installGapiRestShim(sim.bases().driveApi);
    setCloudTestBases(sim.bases());
    ({ googleDriveProvider: provider } = await import(
      '$lib/util/sync/providers/google-drive/google-drive-provider'
    ));
    ({ tokenManager } = await import('$lib/util/sync/providers/google-drive/token-manager'));
    await sim.seed('google', [
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
    setCloudTestBases(null);
    removeGapiRestShim();
    restoreXhr();
    await sim.reset();
  });

  it('lists the seeded volume and its sidecar', async () => {
    const paths = (await listed()).map((f) => f.path).sort();
    expect(paths).toEqual(['Series A/Vol 1.cbz', 'Series A/Vol 1.mokuro', 'catalog.json']);
    const vol = await find('Series A/Vol 1.cbz');
    expect(vol.size).toBe(VOLUME.length);
  });

  it('downloads the volume byte for byte', async () => {
    const blob = await provider.downloadFile(await find('Series A/Vol 1.cbz'));
    const got = new Uint8Array(await blob.arrayBuffer());
    expect(got.length).toBe(VOLUME.length);
    expect(await sha256Hex(got)).toBe(await sha256Hex(VOLUME));
  });

  it('uploads a new file into the series folder, then deletes it', async () => {
    const body = JSON.stringify({ version: '0.2.5', volume: 'Vol 2', pages: [] });
    const up = await provider.uploadFile('Series A/Vol 2.mokuro', new Blob([body]));
    expect(up.fileId).toBeTruthy();
    const files = await sim.files('google');
    const hit = files.find((f) => f.path === 'mokuro-reader/Series A/Vol 2.mokuro');
    expect(hit?.sha256).toBe(await sha256Hex(new TextEncoder().encode(body)));
    // Uploading again replaces the file (one copy).
    await provider.uploadFile('Series A/Vol 2.mokuro', new Blob(['{"v":2}']));
    const again = (await sim.files('google')).filter(
      (f) => f.path === 'mokuro-reader/Series A/Vol 2.mokuro'
    );
    expect(again).toHaveLength(1);
    expect(again[0].size).toBe(7);

    await provider.deleteFile(await find('Series A/Vol 2.mokuro'));
    const after = await sim.files('google');
    expect(after.some((f) => f.path.endsWith('Vol 2.mokuro'))).toBe(false);
  });

  it('reads a control file once, then answers not-modified without a download', async () => {
    await sim.clearLog();
    const first = await provider.readControlFile('catalog.json');
    expect(first).not.toBeNull();
    expect(first).not.toBe('not-modified');
    if (!first || first === 'not-modified') return;
    expect(await blobText(first.nodes[0].blob)).toBe(CATALOG);
    const second = await provider.readControlFile('catalog.json', { ifNoneMatch: first.etag });
    expect(second).toBe('not-modified');
    const downloads = (await sim.log()).filter((e) => e.class === 'download');
    expect(downloads).toHaveLength(1);
  });

  it('a 403 storageQuotaExceeded on upload fails the upload', async () => {
    await sim.fault({
      provider: 'google',
      method: 'POST',
      path_has: '/upload/drive/v3/files',
      status: 403,
      reason: 'storageQuotaExceeded'
    });
    const err = await provider
      .uploadFile('Series A/Vol 3.mokuro', new Blob(['{}']))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('UPLOAD_FAILED');
    expect((err as ProviderError).message).toContain('403');
    expect((await sim.files('google')).some((f) => f.path.endsWith('Vol 3.mokuro'))).toBe(false);
  });

  it('a 429 with Retry-After fails that call (no Drive-level retry); the next call succeeds', async () => {
    await sim.clearLog();
    await sim.fault({
      provider: 'google',
      method: 'GET',
      path_has: '/drive/v3/files',
      status: 429,
      reason: 'rateLimitExceeded',
      retry_after: 1
    });
    const err = await listed().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('LIST_FAILED');
    const attempts = (await sim.log()).filter((e) => e.class === 'list');
    expect(attempts.map((e) => e.status)).toEqual([429]);
    expect((await listed()).length).toBeGreaterThan(0);
  });

  it('a query the simulator does not model is a 400 naming it, never a wrong listing', async () => {
    const q = "fullText contains 'Vol'";
    const err = await (globalThis as any).gapi.client.drive.files
      .list({ q, fields: 'files(id)' })
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(400);
    const violations = await sim.takeViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(q);
  });

  it('an expired token takes the re-auth path instead of failing silently', async () => {
    const reauth = vi.spyOn(tokenManager, 'reAuthenticate').mockImplementation(() => {});
    try {
      await sim.expire(accessToken);
      const err = await provider.readControlFile('catalog.json').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe('AUTH_EXPIRED');
      expect((err as ProviderError).isAuthError).toBe(true);
      expect(reauth).toHaveBeenCalled();
    } finally {
      reauth.mockRestore();
      await signIn();
    }
  });
});
