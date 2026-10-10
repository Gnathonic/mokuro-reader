import { describe, expect, it, vi } from 'vitest';
import { get, type Writable } from 'svelte/store';

vi.mock('$lib/util/sync/cache-manager', async () => {
  const { writable } = await import('svelte/store');
  return {
    cacheManager: {
      allFiles: writable(new Map()),
      isFetchingState: { subscribe: vi.fn() },
      getCache: vi.fn(),
      getAllFiles: vi.fn(() => [])
    }
  };
});
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { getActiveProvider: vi.fn(() => ({ type: 'webdav' })) }
}));
vi.mock('$lib/util/sync/unified-sync-service', () => ({
  unifiedSyncService: { isSyncing: { subscribe: vi.fn() }, syncProvider: vi.fn() }
}));

import { unifiedCloudManager } from './unified-cloud-manager';
import { cacheManager } from '$lib/util/sync/cache-manager';

const allFiles = cacheManager.allFiles as unknown as Writable<
  Map<string, Array<Record<string, unknown>>>
>;

const file = (path: string, size = 1) => ({
  provider: 'webdav',
  fileId: path,
  path,
  modifiedTime: '2026-10-04T00:00:00.000Z',
  size
});

describe('cloudFiles (the catalog input)', () => {
  it('never carries reading history, and keeps its identity when only history changed', () => {
    const store = unifiedCloudManager.cloudFiles;
    const series = [file('S/Vol 1.cbz')];
    allFiles.set(
      new Map([
        ['S', series],
        ['history', [file('history/d/2026-10.events')]]
      ])
    );
    let latest: Map<string, unknown[]> = new Map();
    const stop = store.subscribe((v) => (latest = v));
    const first = latest;
    expect([...first.keys()]).toEqual(['S']);

    allFiles.set(
      new Map([
        ['S', series],
        ['history', [file('history/d/2026-10.events', 2), file('history/d/2026-11.events')]]
      ])
    );
    expect(latest).toBe(first);

    allFiles.set(new Map([['S', [...series, file('S/Vol 2.cbz')]]]));
    expect(latest).not.toBe(first);
    expect(get(store).get('S')).toHaveLength(2);
    stop();
  });

  it('notices an in-place change to a series list (same array, new file)', () => {
    const series = [file('S/Vol 1.cbz')];
    allFiles.set(new Map([['S', series]]));
    let latest: Map<string, unknown[]> = new Map();
    const stop = unifiedCloudManager.cloudFiles.subscribe((v) => (latest = v));
    const first = latest;
    series.push(file('S/Vol 2.cbz'));
    allFiles.set(new Map([['S', series]]));
    expect(latest).not.toBe(first);
    expect(latest.get('S')).toHaveLength(2);
    stop();
  });
});
