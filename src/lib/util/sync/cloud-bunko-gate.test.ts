/**
 * A cloud-direct Bunko's marker drives `serverCompilesMetadata` end to end:
 * marker store → provider `getStatus()` (`withCloudBunkoStatus`) → the
 * provider manager's status store (recomputed on marker change AND at expiry)
 * → the gates that decide whether this client produces `catalog.json`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
const writeCatalogFile = vi.fn(async () => 'written' as const);
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { writeCatalogFile: () => writeCatalogFile() }
}));
vi.mock('$lib/metadata/series-file-sync', () => ({ ensureFreshCloudListing: async () => true }));
vi.mock('$lib/metadata/store', () => ({ registerFactsChangeListener: () => () => {} }));

import {
  ingestMarkerRead,
  resetCloudBunkoMarkersForTest,
  withCloudBunkoStatus
} from '$lib/catalog/cloud-bunko-marker';
import {
  CATALOG_FILE_WRITE_DEBOUNCE_MS,
  scheduleCatalogFileWrite
} from '$lib/metadata/catalog-file-sync';
import { hasWritableNonServerProvider } from '$lib/metadata/series-backfill';
import { onCloudBunkoMarkerChange } from '$lib/catalog/cloud-bunko-marker';
import type { ProviderStatus, SyncProvider } from './provider-interface';
import { providerManager } from './provider-manager';

const T0 = Date.parse('2026-10-12T10:00:00Z');
const TTL = 900;

function markerRead(etag: string, over: Record<string, unknown> = {}) {
  const body = {
    version: 1,
    kind: 'mokuro-bunko',
    instance_id: 'aaa',
    instance_name: 'nas',
    epoch: 1,
    claimed_at: '2026-10-12T09:00:00Z',
    heartbeat_at: new Date(Date.now()).toISOString(),
    ttl_s: TTL,
    state: 'active',
    compiles: ['series.json', 'catalog.json'],
    ocr: true,
    queue: '.mokuro-queue.json',
    ...over
  };
  return { etag, nodes: [{ id: 'm1', etag, blob: new Blob([JSON.stringify(body)]) }] };
}

const fakeDrive = {
  type: 'google-drive',
  name: 'Fake Drive',
  supportsWorkerDownload: true,
  supportsWorkerUpload: true,
  uploadConcurrencyLimit: 1,
  downloadConcurrencyLimit: 1,
  isAuthenticated: () => true,
  getStatus: (): ProviderStatus =>
    withCloudBunkoStatus('google-drive', {
      isAuthenticated: true,
      hasStoredCredentials: true,
      needsAttention: false,
      statusMessage: 'Connected',
      isReadOnly: false
    }),
  logout: async () => {}
} as unknown as SyncProvider;

function storeSaysCompiled(): boolean {
  return get(providerManager.status).providers['google-drive']?.serverCompilesMetadata === true;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  localStorage.clear();
  resetCloudBunkoMarkersForTest();
  // The reset drops listeners; re-attach the manager's (its constructor did it once).
  onCloudBunkoMarkerChange(() => providerManager.updateStatus());
  writeCatalogFile.mockClear();
  providerManager.registerProvider(fakeDrive);
  await providerManager.setCurrentProvider(fakeDrive);
});

afterEach(() => {
  resetCloudBunkoMarkersForTest();
  vi.useRealTimers();
});

describe('serverCompilesMetadata from a cloud-direct Bunko marker', () => {
  it('turns true on a fresh marker and back to false when it expires, with no other call', async () => {
    expect(storeSaysCompiled()).toBe(false);
    expect(hasWritableNonServerProvider()).toBe(true);

    await ingestMarkerRead('google-drive', markerRead('v1'));
    await ingestMarkerRead('google-drive', markerRead('v2')); // a heartbeat: history begins
    expect(storeSaysCompiled()).toBe(true);
    expect(hasWritableNonServerProvider()).toBe(false);
    expect(get(providerManager.status).providers['google-drive']?.cloudBunko?.holder).toMatchObject(
      {
        instanceName: 'nas'
      }
    );

    // No further reads: the marker store's own timer re-announces at 2 × ttl.
    vi.advanceTimersByTime(2 * TTL * 1000 + 10);
    expect(storeSaysCompiled()).toBe(false);
    expect(hasWritableNonServerProvider()).toBe(true);
  });

  it('released flips it back at once', async () => {
    await ingestMarkerRead('google-drive', markerRead('v1'));
    expect(storeSaysCompiled()).toBe(true);
    await ingestMarkerRead('google-drive', markerRead('v2', { state: 'released' }));
    expect(storeSaysCompiled()).toBe(false);
  });

  it('a gate flip cancels a debounced catalog.json write', async () => {
    scheduleCatalogFileWrite();
    // Bunko shows up while the write waits on its debounce.
    await ingestMarkerRead('google-drive', markerRead('v1'));
    await vi.advanceTimersByTimeAsync(CATALOG_FILE_WRITE_DEBOUNCE_MS + 10);
    expect(writeCatalogFile).not.toHaveBeenCalled();

    // Gone again (released): the client is the producer once more.
    await ingestMarkerRead('google-drive', markerRead('v2', { state: 'released' }));
    scheduleCatalogFileWrite();
    await vi.advanceTimersByTimeAsync(CATALOG_FILE_WRITE_DEBOUNCE_MS + 10);
    expect(writeCatalogFile).toHaveBeenCalledTimes(1);
  });

  it('logout forgets the marker', async () => {
    await ingestMarkerRead('google-drive', markerRead('v1'));
    expect(storeSaysCompiled()).toBe(true);
    await providerManager.logout();
    expect(fakeDrive.getStatus().cloudBunko).toBeUndefined();
  });
});
