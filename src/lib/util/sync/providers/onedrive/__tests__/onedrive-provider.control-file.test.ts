import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false }));
vi.mock('../../../core/cloud-provider-core-registry', () => ({
  getCloudProviderCore: vi.fn(() => ({}))
}));
vi.mock('../token-manager', () => ({
  onedriveTokenManager: {
    initialize: vi.fn().mockResolvedValue(undefined),
    isAuthenticated: vi.fn().mockReturnValue(true),
    getAccessToken: vi.fn().mockResolvedValue('TOKEN'),
    hasStoredCredentials: vi.fn().mockReturnValue(true),
    getActiveAccountName: vi.fn().mockReturnValue('me'),
    getActiveAccountId: vi.fn().mockReturnValue('acct'),
    needsAttention: { subscribe: (cb: (v: boolean) => void) => (cb(false), () => {}) },
    logout: vi.fn().mockResolvedValue(undefined)
  }
}));
vi.mock('../graph-client', () => ({
  getItemByPath: vi.fn(),
  downloadItemContent: vi.fn(),
  listChildren: vi.fn(),
  createFolder: vi.fn(),
  deleteItem: vi.fn(),
  getDriveQuota: vi.fn(),
  patchItem: vi.fn()
}));

import { OneDriveProvider } from '../onedrive-provider';
import { getItemByPath, downloadItemContent, createFolder } from '../graph-client';
import { onedriveTokenManager } from '../token-manager';
import { ProviderError } from '../../../provider-interface';
import type { ControlFileRead } from '../../../provider-interface';
import { BUNKO_MARKER_NAME } from '../../../syncable-file';
import { ingestMarkerRead, resetCloudBunkoMarkersForTest } from '$lib/catalog/cloud-bunko-marker';

const MARKER = JSON.stringify({
  version: 1,
  kind: 'mokuro-bunko',
  instance_id: 'aaa',
  instance_name: 'nas',
  epoch: 1,
  claimed_at: '2026-10-12T09:00:00Z',
  heartbeat_at: new Date().toISOString(),
  ttl_s: 900,
  state: 'active',
  compiles: ['series.json', 'catalog.json'],
  ocr: true,
  queue: '.mokuro-queue.json'
});

const item = (cTag: string | undefined, extra: Record<string, unknown> = {}) => ({
  id: 'item-1',
  name: BUNKO_MARKER_NAME,
  file: {},
  cTag,
  eTag: 'etag-1',
  lastModifiedDateTime: '2026-10-12T09:00:00Z',
  ...extra
});

describe('OneDriveProvider.readControlFile()', () => {
  let provider: OneDriveProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(onedriveTokenManager.isAuthenticated).mockReturnValue(true);
    vi.mocked(onedriveTokenManager.getAccessToken).mockResolvedValue('TOKEN');
    vi.mocked(downloadItemContent).mockImplementation(async () => new Blob([MARKER]));
    resetCloudBunkoMarkersForTest();
    localStorage.clear();
    provider = new OneDriveProvider();
  });

  it('reads the one node by path: id, cTag version, modified time, body', async () => {
    vi.mocked(getItemByPath).mockResolvedValue(item('ctag-1'));

    const result = (await provider.readControlFile(BUNKO_MARKER_NAME)) as ControlFileRead;

    expect(getItemByPath).toHaveBeenCalledTimes(1);
    expect(getItemByPath).toHaveBeenCalledWith('TOKEN', `mokuro-reader/${BUNKO_MARKER_NAME}`);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: 'item-1',
      etag: 'ctag-1',
      modified: '2026-10-12T09:00:00Z'
    });
    expect(await result.nodes[0].blob.text()).toBe(MARKER);
    expect(downloadItemContent).toHaveBeenCalledWith('TOKEN', 'item-1');
  });

  it('falls back to eTag when the item has no cTag', async () => {
    vi.mocked(getItemByPath).mockResolvedValue(item(undefined));

    const result = (await provider.readControlFile(BUNKO_MARKER_NAME)) as ControlFileRead;

    expect(result.nodes[0].etag).toBe('etag-1');
  });

  it('answers not-modified with no content download when the cTag is unchanged', async () => {
    vi.mocked(getItemByPath).mockResolvedValue(item('ctag-1'));
    const first = (await provider.readControlFile(BUNKO_MARKER_NAME)) as ControlFileRead;
    vi.mocked(downloadItemContent).mockClear();

    const second = await provider.readControlFile(BUNKO_MARKER_NAME, { ifNoneMatch: first.etag });

    expect(second).toBe('not-modified');
    expect(downloadItemContent).not.toHaveBeenCalled();
  });

  it('re-downloads when the cTag changed, and reuses the body when only the caller lost its etag', async () => {
    vi.mocked(getItemByPath).mockResolvedValue(item('ctag-1'));
    const first = (await provider.readControlFile(BUNKO_MARKER_NAME)) as ControlFileRead;
    vi.mocked(downloadItemContent).mockClear();

    // Caller has no etag: same version, served from the cache.
    await provider.readControlFile(BUNKO_MARKER_NAME);
    expect(downloadItemContent).not.toHaveBeenCalled();

    vi.mocked(getItemByPath).mockResolvedValue(item('ctag-2'));
    const second = (await provider.readControlFile(BUNKO_MARKER_NAME, {
      ifNoneMatch: first.etag
    })) as ControlFileRead;

    expect(second.etag).not.toBe(first.etag);
    expect(downloadItemContent).toHaveBeenCalledTimes(1);
  });

  it('returns null when the file (or the folder) does not exist, and creates nothing', async () => {
    vi.mocked(getItemByPath).mockResolvedValue(null);

    await expect(provider.readControlFile(BUNKO_MARKER_NAME)).resolves.toBeNull();

    expect(downloadItemContent).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('rejects with an auth ProviderError when not authenticated', async () => {
    vi.mocked(onedriveTokenManager.isAuthenticated).mockReturnValue(false);

    const error = await provider.readControlFile(BUNKO_MARKER_NAME).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.isAuthError).toBe(true);
  });

  it('propagates a Graph 401 as an auth ProviderError', async () => {
    vi.mocked(getItemByPath).mockRejectedValue(
      new ProviderError('Graph 401 Unauthorized', 'onedrive', 'GRAPH_401', true)
    );

    const error = await provider.readControlFile(BUNKO_MARKER_NAME).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.isAuthError).toBe(true);
  });

  it('maps an MSAL interaction-required token failure to an auth ProviderError', async () => {
    const msalError = Object.assign(new Error('interaction_required'), {
      name: 'InteractionRequiredAuthError'
    });
    vi.mocked(onedriveTokenManager.getAccessToken).mockRejectedValue(msalError);

    const error = await provider.readControlFile(BUNKO_MARKER_NAME).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.isAuthError).toBe(true);
  });

  it('wraps other failures as non-auth ProviderErrors', async () => {
    vi.mocked(getItemByPath).mockRejectedValue(new Error('boom'));

    const error = await provider.readControlFile(BUNKO_MARKER_NAME).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.isAuthError).toBe(false);
  });

  it('turns serverCompilesMetadata true after a fresh marker read', async () => {
    expect(provider.getStatus().serverCompilesMetadata).toBeFalsy();
    vi.mocked(getItemByPath).mockResolvedValue(item('ctag-1'));

    await ingestMarkerRead('onedrive', await provider.readControlFile(BUNKO_MARKER_NAME));

    const status = provider.getStatus();
    expect(status.serverCompilesMetadata).toBe(true);
    expect(status.cloudBunko?.fresh).toBe(true);
    expect(status.cloudBunko?.holder?.instanceId).toBe('aaa');
  });
});
