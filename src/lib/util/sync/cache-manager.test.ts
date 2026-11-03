import { writable } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheManager } from './cache-manager';
import type { CloudCache } from './cloud-cache-interface';
import type { CloudFileMetadata, ProviderType } from './provider-interface';
import { clearRootFileMemo, noteRootFileUpload, rootFileMemoSize } from './root-file-memo';
import type { SyncProvider } from './provider-interface';
import {
  clearVolumeDataDeferred,
  noteVolumeDataDeferred,
  volumeDataDeferred
} from './reading-session';
import { cloudPositionStamp, noteCloudPositions } from '$lib/positions/positions-cloud';

function fakeCache(): CloudCache<CloudFileMetadata> {
  return {
    store: writable(new Map()),
    has: () => false,
    get: () => null,
    getAll: () => [],
    getBySeries: () => [],
    getAllFiles: () => [],
    fetch: vi.fn(async () => {}),
    clear: vi.fn(),
    isFetching: () => false,
    isLoaded: () => true
  } as unknown as CloudCache<CloudFileMetadata>;
}

function fakeProvider(type: ProviderType, scope: string): SyncProvider {
  return {
    type,
    getStatus: () => ({
      isAuthenticated: true,
      hasStoredCredentials: true,
      needsAttention: false,
      statusMessage: '',
      accountScope: scope
    })
  } as unknown as SyncProvider;
}

/** Memoize one root file of `provider`, the way this device's own upload does. */
async function seed(provider: SyncProvider): Promise<void> {
  const body = '{"mine":1}';
  await noteRootFileUpload(provider, 'volume-data.json', new Blob([body]), {
    fileId: `${provider.type}-volume-data`,
    size: new Blob([body]).size,
    revision: 'r1'
  });
}

describe('cacheManager and the root-file memo', () => {
  beforeEach(() => {
    clearRootFileMemo();
    cacheManager.clearAll();
    cacheManager.registerCache('webdav', fakeCache());
    cacheManager.registerCache('google-drive', fakeCache());
  });

  it('clearAll (logout, cache clear) forgets every memoized root file', async () => {
    cacheManager.setActiveProvider('webdav');
    await seed(fakeProvider('webdav', 'webdav:a|alice'));
    expect(rootFileMemoSize()).toBe(1);

    cacheManager.clearAll();
    expect(rootFileMemoSize()).toBe(0);
  });

  it("switching providers forgets the previous account's memoized files", async () => {
    cacheManager.setActiveProvider('webdav');
    await seed(fakeProvider('webdav', 'webdav:a|alice'));
    expect(rootFileMemoSize()).toBe(1);

    cacheManager.setActiveProvider('google-drive');
    expect(rootFileMemoSize()).toBe(0);
  });

  it('re-activating the same provider keeps the memo', async () => {
    cacheManager.setActiveProvider('webdav');
    await seed(fakeProvider('webdav', 'webdav:a|alice'));

    cacheManager.setActiveProvider('webdav');
    expect(rootFileMemoSize()).toBe(1);
  });
});

describe('cacheManager and the per-session sync state', () => {
  const folder = fakeProvider('filesystem', 'manga');

  beforeEach(() => {
    cacheManager.clearAll();
    clearVolumeDataDeferred();
    cacheManager.registerCache('webdav', fakeCache());
    cacheManager.registerCache('google-drive', fakeCache());
    cacheManager.registerCache('filesystem', fakeCache());
  });

  /** The cloud positions.json was seen holding volume `v` at stamp 5. */
  const seePositions = () =>
    noteCloudPositions(folder, { v: { t: 5, page: 3, chars: 10, device: 'd' } });

  it('clearAll (logout, cache clear) forgets the cloud positions memo and the deferral', () => {
    cacheManager.setActiveProvider('filesystem');
    seePositions();
    noteVolumeDataDeferred();
    expect(cloudPositionStamp(folder, 'v')).toBe(5);

    cacheManager.clearAll();
    expect(cloudPositionStamp(folder, 'v')).toBeUndefined();
    expect(volumeDataDeferred()).toBe(false);
  });

  it('switching providers forgets the cloud positions memo and the deferral', () => {
    cacheManager.setActiveProvider('webdav');
    seePositions();
    noteVolumeDataDeferred();

    cacheManager.setActiveProvider('google-drive');
    expect(cloudPositionStamp(folder, 'v')).toBeUndefined();
    expect(volumeDataDeferred()).toBe(false);
  });

  it('a connect forgets the cloud positions memo: another folder of the same name is another file', () => {
    // Local Folder's account scope is the folder's basename: two folders both
    // named "manga" share it, so a stamp seen in one must not vouch for the other.
    cacheManager.setActiveProvider('filesystem');
    seePositions();

    cacheManager.setActiveProvider('filesystem');
    expect(cloudPositionStamp(folder, 'v')).toBeUndefined();
  });
});
