import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

let status = {
  hasAnyAuthenticated: true,
  currentProviderType: 'webdav' as string | null,
  providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } } as Record<
    string,
    { isReadOnly?: boolean; serverCompilesMetadata?: boolean } | null
  >
};
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: {
    get status() {
      return readable(status);
    }
  }
}));

const writeCatalogFile = vi.fn(async () => 'written' as const);
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { writeCatalogFile: () => writeCatalogFile() }
}));

const ensureFreshCloudListing = vi.fn(async () => true);
vi.mock('$lib/metadata/series-file-sync', () => ({
  ensureFreshCloudListing: () => ensureFreshCloudListing()
}));

const listeners: Array<(title: string) => void> = [];
vi.mock('$lib/metadata/store', () => ({
  registerFactsChangeListener: (fn: (title: string) => void) => {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }
}));

import {
  CATALOG_FILE_WRITE_DEBOUNCE_MS,
  flushCatalogFileWrites,
  initCatalogFileSync,
  scheduleCatalogFileWrite
} from './catalog-file-sync';

beforeEach(() => {
  writeCatalogFile.mockClear();
  ensureFreshCloudListing.mockClear();
  listeners.length = 0;
  status = {
    hasAnyAuthenticated: true,
    currentProviderType: 'webdav',
    providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } }
  };
});

describe('scheduleCatalogFileWrite', () => {
  it('coalesces a burst of edits into ONE write', async () => {
    vi.useFakeTimers();
    scheduleCatalogFileWrite();
    scheduleCatalogFileWrite();
    scheduleCatalogFileWrite();
    await vi.advanceTimersByTimeAsync(CATALOG_FILE_WRITE_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(writeCatalogFile).toHaveBeenCalledTimes(1);
  });

  it('skips when the provider is read-only', async () => {
    status.providers.webdav = { isReadOnly: true };
    scheduleCatalogFileWrite();
    await flushCatalogFileWrites();
    expect(writeCatalogFile).not.toHaveBeenCalled();
  });

  it('skips when the server compiles the file itself', async () => {
    status.providers.webdav = { isReadOnly: false, serverCompilesMetadata: true };
    scheduleCatalogFileWrite();
    await flushCatalogFileWrites();
    expect(writeCatalogFile).not.toHaveBeenCalled();
  });

  it('skips when no provider is connected', async () => {
    status = { hasAnyAuthenticated: false, currentProviderType: null, providers: {} };
    scheduleCatalogFileWrite();
    await flushCatalogFileWrites();
    expect(writeCatalogFile).not.toHaveBeenCalled();
  });

  it('skips when the cloud listing could not be refreshed', async () => {
    ensureFreshCloudListing.mockResolvedValueOnce(false);
    scheduleCatalogFileWrite();
    await flushCatalogFileWrites();
    expect(writeCatalogFile).not.toHaveBeenCalled();
  });

  it('never overlaps two writes — a flush waits for the one in flight', async () => {
    // The write is read-merge-upload against the cloud copy. A second one
    // starting mid-flight merges the copy the first is about to replace, so the
    // later upload silently drops whatever the earlier one added.
    let active = 0;
    let maxActive = 0;
    writeCatalogFile.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return 'written' as const;
    });

    await Promise.all([flushCatalogFileWrites(), flushCatalogFileWrites()]);

    expect(maxActive).toBe(1);
    expect(writeCatalogFile).toHaveBeenCalledTimes(2);
    writeCatalogFile.mockReset();
    writeCatalogFile.mockResolvedValue('written');
  });

  it('never rejects when the write throws', async () => {
    writeCatalogFile.mockRejectedValueOnce(new Error('403 Forbidden'));
    scheduleCatalogFileWrite();
    await expect(flushCatalogFileWrites()).resolves.toBeUndefined();
  });
});

describe('initCatalogFileSync', () => {
  it('schedules a write on a local fact edit and is idempotent', async () => {
    const dispose = initCatalogFileSync();
    expect(initCatalogFileSync()).toBe(dispose);
    expect(listeners).toHaveLength(1);

    listeners[0]('Dr Stone');
    await flushCatalogFileWrites();
    expect(writeCatalogFile).toHaveBeenCalledTimes(1);

    dispose();
    expect(listeners).toHaveLength(0);
  });
});
