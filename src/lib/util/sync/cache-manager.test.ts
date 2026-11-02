import { writable } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheManager } from './cache-manager';
import type { CloudCache } from './cloud-cache-interface';
import type { CloudFileMetadata, ProviderType } from './provider-interface';
import { clearRootFileMemo, noteRootFileUpload, rootFileMemoSize } from './root-file-memo';
import type { SyncProvider } from './provider-interface';

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
