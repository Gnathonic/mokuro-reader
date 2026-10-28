/**
 * The MEGA provider against cloudsim (`CLOUDSIM_URL`): the real provider and
 * megajs, with megajs's `gateway` pointed at the simulator, whose MEGA does the
 * node crypto for real. Skipped without a simulator. The suites share one
 * simulator and reset it: run them with `--no-file-parallelism`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cloudsimForSuite,
  fetchWithoutForeignSignals,
  refuseNonLocalRequests,
  sha256Hex,
  sim,
  type SimLogEntry
} from '../cloudsim';
import { setCloudTestBases } from '$lib/util/sync/cloud-test-hooks';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));

const ACCOUNT = 'reader-mega';
const EMAIL = 'reader@cloudsim.test';
const PASSWORD = 'cloudsim-password';
const VOLUME = new Uint8Array(200_003).map((_, i) => (i * 13) % 251);

describe.skipIf(!cloudsimForSuite())('MEGA provider against cloudsim', () => {
  type Provider = import('$lib/util/sync/providers/mega/mega-provider').MegaProvider;
  let MegaProviderClass: new () => Provider;
  let provider: Provider;
  const opened: Provider[] = [];
  let restoreFetch = () => {};
  let restoreLocal = () => {};

  async function find(p: Provider, path: string): Promise<CloudFileMetadata> {
    const hit = (await p.listCloudVolumes()).find((f) => f.path === path);
    if (!hit) throw new Error(`${path} not listed`);
    return hit;
  }

  function megaLog(log: SimLogEntry[]): SimLogEntry[] {
    return log.filter((e) => e.provider === 'mega');
  }

  beforeAll(async () => {
    await sim.reset();
    restoreLocal = refuseNonLocalRequests();
    restoreFetch = fetchWithoutForeignSignals();
    setCloudTestBases(sim.bases());
    localStorage.removeItem('mega_session');
    ({ MegaProvider: MegaProviderClass } = await import(
      '$lib/util/sync/providers/mega/mega-provider'
    ));
    await sim.megaAccount(ACCOUNT, EMAIL, PASSWORD);
    await sim.seed(
      'mega',
      [
        { path: 'mokuro-reader/Series A/Vol 1.cbz', data: VOLUME },
        { path: 'mokuro-reader/Series A/Vol 1.mokuro', data: '{"pages":[]}' }
      ],
      ACCOUNT
    );
    provider = new MegaProviderClass();
    opened.push(provider);
    await provider.whenReady();
    await provider.login({ email: EMAIL, password: PASSWORD });
  });

  afterEach(async () => {
    expect(await sim.takeViolations()).toEqual([]);
  });

  afterAll(async () => {
    // Stop megajs's server-change long-poll so the run can end.
    for (const p of opened) (p as any).storage?.api?.close?.();
    localStorage.removeItem('mega_session');
    setCloudTestBases(null);
    restoreFetch();
    restoreLocal();
    await sim.reset();
  });

  it('logs in by password through the simulator and lists the seeded volume', async () => {
    expect(provider.isAuthenticated()).toBe(true);
    const paths = (await provider.listCloudVolumes()).map((f) => f.path).sort();
    expect(paths).toEqual(['Series A/Vol 1.cbz', 'Series A/Vol 1.mokuro']);
    const log = megaLog(await sim.log());
    expect(log.some((e) => e.class === 'auth' && e.account === ACCOUNT)).toBe(true);
    // The persisted session carries the simulator's gateway, not a password.
    const blob = JSON.parse(localStorage.getItem('mega_session') ?? '{}');
    expect(blob.options?.password).toBeUndefined();
    expect(blob.options?.gateway).toBe(sim.bases().megaGateway);
  });

  it('downloads and decrypts the volume byte for byte', async () => {
    const blob = await provider.downloadFile(await find(provider, 'Series A/Vol 1.cbz'));
    const got = new Uint8Array(await blob.arrayBuffer());
    expect(got.length).toBe(VOLUME.length);
    expect(await sha256Hex(got)).toBe(await sha256Hex(VOLUME));
  });

  it('uploads a new file (encrypted, readable by the simulator), then deletes it', async () => {
    const body = new Uint8Array(70_000).map((_, i) => (i * 3) % 256);
    await provider.uploadFile('Series A/Vol 2.cbz', new Blob([body]));
    let files = await sim.files('mega', ACCOUNT);
    const hit = files.find((f) => f.path === 'mokuro-reader/Series A/Vol 2.cbz');
    expect(hit?.sha256).toBe(await sha256Hex(body));

    await provider.deleteFile(await find(provider, 'Series A/Vol 2.cbz'));
    files = await sim.files('mega', ACCOUNT);
    expect(files.some((f) => f.path.endsWith('Vol 2.cbz'))).toBe(false);
  });

  it('restores from a saved session without a gateway: the hook supplies it', async () => {
    // A session saved by a build without the hooks carries no gateway; the restore
    // path must still reach the simulator, never the real MEGA.
    const blob = JSON.parse(localStorage.getItem('mega_session') ?? '{}');
    delete blob.options.gateway;
    localStorage.setItem('mega_session', JSON.stringify(blob));
    await sim.clearLog();
    const restored = new MegaProviderClass();
    opened.push(restored);
    await restored.whenReady();
    expect(restored.isAuthenticated()).toBe(true);
    expect((restored as any).storage.api.gateway).toBe(sim.bases().megaGateway);
    const paths = (await restored.listCloudVolumes()).map((f) => f.path).sort();
    expect(paths).toEqual(['Series A/Vol 1.cbz', 'Series A/Vol 1.mokuro']);
    const log = megaLog(await sim.log());
    expect(log.filter((e) => e.class === 'auth')).toEqual([]);
    expect(log.some((e) => e.class === 'list' && e.account === ACCOUNT)).toBe(true);
    provider = restored;
  });

  it('worker transfers reach the simulator with the gateway from their credentials', async () => {
    const { megaCore } = await import('$lib/util/sync/core/providers/mega-core');
    const vol = await find(provider, 'Series A/Vol 1.cbz');
    const down = await provider.getWorkerDownloadCredentials(vol.fileId);
    // The saved session has no gateway (previous test): only the credentials do.
    const up = {
      ...(await provider.getWorkerUploadCredentials()),
      ...(await provider.prepareUploadTarget('Series A'))
    };
    expect(JSON.parse(up.megaSession).options.gateway).toBeUndefined();
    await sim.clearLog();
    // A worker has its own copy of the hooks module: no bases there.
    setCloudTestBases(null);
    try {
      const data = await megaCore.downloadFile({
        fileId: vol.fileId,
        credentials: down,
        onProgress: () => {}
      });
      expect(await sha256Hex(new Uint8Array(data))).toBe(await sha256Hex(VOLUME));
      await megaCore.uploadFile({
        seriesTitle: 'Series A',
        filename: 'Vol 7.mokuro',
        blob: new Blob(['{"v":7}']),
        credentials: up
      });
    } finally {
      setCloudTestBases(sim.bases());
    }
    const log = megaLog(await sim.log());
    expect(log.some((e) => e.class === 'download')).toBe(true);
    expect(log.some((e) => e.class === 'upload')).toBe(true);
    const files = await sim.files('mega', ACCOUNT);
    expect(files.some((f) => f.path === 'mokuro-reader/Series A/Vol 7.mokuro')).toBe(true);
  });
});
