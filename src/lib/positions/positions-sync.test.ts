import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, readable } from 'svelte/store';
import { ProviderError } from '$lib/util/sync/provider-interface';
import type {
  CloudFileMetadata,
  ProviderStatus,
  SyncProvider
} from '$lib/util/sync/provider-interface';

vi.mock('$app/environment', () => ({ browser: true }));

const getCache = vi.fn();
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: { getCache: (...args: unknown[]) => getCache(...args) }
}));
const blindUploadFile = vi.fn(async (_path: string, _blob: Blob) => 'uploaded-id');
const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    blindUploadFile: (path: string, blob: Blob) => blindUploadFile(path, blob),
    getActiveProvider: () => getActiveProvider()
  }
}));
const syncReady = vi.fn(() => true);
vi.mock('$lib/util/sync/foreground-sync', () => ({ syncReady: () => syncReady() }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/reading-history/history-db', () => ({ historyDb: () => ({}) }));
vi.mock('$lib/reading-history/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/reading-history/record')>()),
  getOrCreateDeviceId: async () => 'me'
}));
vi.mock('$lib/reading-history/device-stats', () => ({
  devices: readable(
    new Map([
      [
        'phone',
        {
          canonical: 'phone',
          label: 'Pixel',
          named: true,
          class: 'phone',
          isThisDevice: false
        }
      ]
    ])
  )
}));
const pageCounts = vi.hoisted(() => new Map<string, number>());
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: vi.fn(async (uuid: string) =>
        pageCounts.has(uuid) ? { page_count: pageCounts.get(uuid) } : undefined
      ),
      bulkGet: vi.fn(async () => [])
    }
  }
}));

import { showSnackbar } from '$lib/util/snackbar';
import { clearVolumes, updateProgress, volumesWithTrash } from '$lib/settings/volume-data';
import { _resetPositionTracking, changedVolumes, initPositionTracking } from './positions-local';
import { noteReaderClosed, noteReaderOpened } from './reader-open';
import {
  _resetPositionsSyncForTests,
  flushPositionPush,
  initPositionPush,
  syncPositions
} from './positions-sync';

const now = Date.parse('2026-10-16T12:00:00.000Z');

function listed(fileId: string): CloudFileMetadata {
  return {
    provider: 'webdav',
    fileId,
    path: 'positions.json',
    modifiedTime: '2026-10-16T00:00:00Z'
  } as CloudFileMetadata;
}

const fileBlob = (positions: Record<string, unknown[]>) =>
  ({ text: async () => JSON.stringify({ version: 1, positions }) }) as unknown as Blob;

function stubCache(files: CloudFileMetadata[]) {
  const cache = { getAll: vi.fn(() => files), add: vi.fn() };
  getCache.mockReturnValue(cache);
  return cache;
}

function makeProvider(
  download: (file: CloudFileMetadata) => Promise<Blob>,
  status: Partial<ProviderStatus> = {}
): SyncProvider {
  const provider = {
    type: 'webdav',
    name: 'WebDAV',
    downloadFile: vi.fn(download),
    getStatus: () => ({
      isAuthenticated: true,
      hasStoredCredentials: true,
      needsAttention: false,
      statusMessage: '',
      ...status
    })
  } as unknown as SyncProvider;
  getActiveProvider.mockReturnValue(provider);
  return provider;
}

async function uploadedFile(): Promise<{ positions: Record<string, unknown[]> }> {
  const blob = blindUploadFile.mock.calls.at(-1)![1];
  return JSON.parse(await blob.text());
}

let stops: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  localStorage.clear();
  clearVolumes();
  pageCounts.clear();
  _resetPositionTracking();
  _resetPositionsSyncForTests();
  syncReady.mockReturnValue(true);
  stops.push(initPositionTracking());
});
afterEach(() => {
  stops.forEach((stop) => stop());
  stops = [];
  noteReaderClosed('v');
  vi.useRealTimers();
});

describe('syncPositions', () => {
  it('old bunko: no GET and no PUT of positions.json', async () => {
    stubCache([listed('a')]);
    updateProgress('v', 41, 4100, false);
    const provider = makeProvider(async () => fileBlob({}), { serverCompilesMetadata: true });
    expect(await syncPositions(provider)).toMatchObject({
      skipped: 'not-allowed',
      uploaded: false
    });
    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(blindUploadFile).not.toHaveBeenCalled();
  });

  it('bunko listing positions.json: reads and writes', async () => {
    stubCache([]);
    updateProgress('v', 41, 4100, false);
    const provider = makeProvider(async () => fileBlob({}), {
      serverCompilesMetadata: true,
      positionsSync: true
    });
    expect((await syncPositions(provider)).uploaded).toBe(true);
  });

  it('read-only plain provider: adopts, never uploads', async () => {
    stubCache([listed('a')]);
    updateProgress('w', 3, 30, false);
    const provider = makeProvider(async () => fileBlob({ v: [now - 1000, 120, 12000, 'phone'] }), {
      isReadOnly: true
    });
    const outcome = await syncPositions(provider);
    expect(outcome.adopted).toEqual(['v']);
    expect(outcome.uploaded).toBe(false);
    expect(blindUploadFile).not.toHaveBeenCalled();
  });

  it('merges two listed copies; a not-found copy does not hide the other', async () => {
    stubCache([listed('ghost'), listed('a'), listed('b')]);
    const provider = makeProvider(async (file) => {
      if (file.fileId === 'ghost') throw new ProviderError('File not found', 'webdav', 'NOT_FOUND');
      return file.fileId === 'a'
        ? fileBlob({ x: [now - 5000, 10, 100, 'phone'] })
        : fileBlob({ y: [now - 4000, 20, 200, 'phone'] });
    });
    const outcome = await syncPositions(provider);
    expect(outcome.adopted.sort()).toEqual(['x', 'y']);
    // The surviving content differs from the merge, so the copies converge.
    expect(outcome.uploaded).toBe(true);
    expect(Object.keys((await uploadedFile()).positions)).toEqual(['x', 'y']);
  });

  it('adopts a newer remote position with its stamp; toasts only for the open volume', async () => {
    stubCache([listed('a')]);
    pageCounts.set('v', 200);
    updateProgress('v', 40, 4000, false);
    updateProgress('w', 5, 50, false);
    vi.advanceTimersByTime(10_000);
    noteReaderOpened('v', Date.now());
    const remoteAt = Date.now() - 1000;
    const provider = makeProvider(async () =>
      fileBlob({ v: [remoteAt, 120, 12000, 'phone'], w: [remoteAt, 9, 90, 'phone'] })
    );
    const outcome = await syncPositions(provider);
    expect(outcome.adopted.sort()).toEqual(['v', 'w']);
    expect(get(volumesWithTrash).v).toMatchObject({
      progress: 120,
      chars: 12000,
      completed: false,
      lastProgressUpdate: new Date(remoteAt).toISOString()
    });
    expect(showSnackbar).toHaveBeenCalledTimes(1);
    expect(showSnackbar).toHaveBeenCalledWith('Continued from Pixel, p.120');
  });

  it('an unnamed device toasts "another device"', async () => {
    stubCache([listed('a')]);
    noteReaderOpened('v', Date.now());
    const provider = makeProvider(async () => fileBlob({ v: [now - 1000, 7, 70, 'tablet'] }));
    await syncPositions(provider);
    expect(showSnackbar).toHaveBeenCalledWith('Continued from another device, p.7');
  });

  it('a turn on the open volume since opening defers instead of moving', async () => {
    stubCache([listed('a')]);
    noteReaderOpened('v', Date.now() - 5000);
    updateProgress('v', 41, 4100, false);
    const provider = makeProvider(async () => fileBlob({ v: [now + 1000, 120, 12000, 'phone'] }));
    const outcome = await syncPositions(provider);
    expect(outcome.deferred).toEqual(['v']);
    expect(get(volumesWithTrash).v.progress).toBe(41);
  });

  it('a completed remote position marks the volume complete when the page count is known', async () => {
    stubCache([listed('a')]);
    pageCounts.set('v', 120);
    const provider = makeProvider(async () => fileBlob({ v: [now - 1000, 120, 12000, 'phone'] }));
    await syncPositions(provider);
    expect(get(volumesWithTrash).v.completed).toBe(true);
  });

  it('uploads its own turn once, then a second run with nothing new uploads nothing', async () => {
    const cache = stubCache([]);
    updateProgress('v', 41, 4100, false);
    const provider = makeProvider(async () => fileBlob({}));
    expect((await syncPositions(provider)).uploaded).toBe(true);
    expect(blindUploadFile).toHaveBeenCalledTimes(1);
    expect(blindUploadFile.mock.calls[0][0]).toBe('positions.json');
    expect((await uploadedFile()).positions.v).toEqual([
      Date.parse(get(volumesWithTrash).v.lastProgressUpdate),
      41,
      4100,
      'me'
    ]);
    expect(cache.add).toHaveBeenCalledWith(
      'positions.json',
      expect.objectContaining({ fileId: 'uploaded-id', path: 'positions.json' })
    );
    expect(changedVolumes()).toEqual([]);

    // The cloud now holds what went up.
    const sent = await (blindUploadFile.mock.calls[0][1] as Blob).text();
    stubCache([listed('uploaded-id')]);
    const again = makeProvider(async () => ({ text: async () => sent }) as unknown as Blob);
    expect((await syncPositions(again)).uploaded).toBe(false);
    expect(blindUploadFile).toHaveBeenCalledTimes(1);
  });

  it('no file and nothing of its own: no request beyond the listing, no upload', async () => {
    stubCache([]);
    const provider = makeProvider(async () => fileBlob({}));
    expect((await syncPositions(provider)).uploaded).toBe(false);
    expect(blindUploadFile).not.toHaveBeenCalled();
  });

  it('a transient download failure adopts what it could read and does not overwrite', async () => {
    stubCache([listed('a'), listed('b')]);
    updateProgress('w', 3, 30, false);
    const provider = makeProvider(async (file) => {
      if (file.fileId === 'a') throw new Error('network down');
      return fileBlob({ v: [now - 1000, 9, 90, 'phone'] });
    });
    const outcome = await syncPositions(provider);
    expect(outcome.adopted).toEqual(['v']);
    expect(outcome.uploaded).toBe(false);
    expect(changedVolumes()).toEqual(['w']);
  });

  it('a failing download or upload resolves an outcome, never throws', async () => {
    stubCache([listed('a')]);
    updateProgress('v', 41, 4100, false);
    const provider = makeProvider(async () => {
      throw new Error('boom');
    });
    await expect(syncPositions(provider)).resolves.toMatchObject({ uploaded: false });

    stubCache([]);
    blindUploadFile.mockRejectedValueOnce(new Error('PUT failed'));
    const ok = makeProvider(async () => fileBlob({}));
    await expect(syncPositions(ok)).resolves.toMatchObject({ uploaded: false });
    expect(changedVolumes()).toEqual(['v']);
  });

  it('a call mid-run is folded into ONE follow-up run', async () => {
    stubCache([listed('a')]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider = makeProvider(async () => {
      await gate;
      return fileBlob({});
    });
    const first = syncPositions(provider);
    const second = syncPositions(provider);
    const third = syncPositions(provider);
    release();
    await Promise.all([first, second, third]);
    expect(provider.downloadFile).toHaveBeenCalledTimes(2);
  });
});

describe('the position push', () => {
  it('three turns within 3 s → one syncPositions; hidden flushes at once', async () => {
    stubCache([]);
    const provider = makeProvider(async () => fileBlob({}));
    stops.push(initPositionPush());
    updateProgress('v', 41, 4100, false);
    vi.advanceTimersByTime(1000);
    updateProgress('v', 42, 4200, false);
    vi.advanceTimersByTime(1000);
    updateProgress('v', 43, 4300, false);
    vi.advanceTimersByTime(2999);
    expect(blindUploadFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(blindUploadFile).toHaveBeenCalledTimes(1));
    expect(provider.downloadFile).not.toHaveBeenCalled(); // nothing listed

    updateProgress('v', 44, 4400, false);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(blindUploadFile).toHaveBeenCalledTimes(2));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('not ready: the push does nothing and keeps the turn marked', async () => {
    stubCache([]);
    makeProvider(async () => fileBlob({}));
    syncReady.mockReturnValue(false);
    updateProgress('v', 41, 4100, false);
    await flushPositionPush();
    expect(blindUploadFile).not.toHaveBeenCalled();
    expect(changedVolumes()).toEqual(['v']);
  });
});
