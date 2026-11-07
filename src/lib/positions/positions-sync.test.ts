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
const blindUploadFile = vi.fn(async (_path: string, _blob: Blob) => ({ fileId: 'uploaded-id' }));
const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    blindUploadFile: (path: string, blob: Blob) => blindUploadFile(path, blob),
    getActiveProvider: () => getActiveProvider()
  }
}));
const syncReady = vi.fn(() => true);
const providerTokenValid = vi.fn(() => true);
vi.mock('$lib/util/sync/foreground-sync', () => ({
  syncReady: () => syncReady(),
  providerTokenValid: () => providerTokenValid()
}));
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
const rehomeVisit = vi.hoisted(() => vi.fn());
vi.mock('./visit', () => ({ rehomeVisit: (volume: string) => rehomeVisit(volume) }));
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
import { _resetEscapesForTests, newestUploaded, watchEscapes } from './escapes';
import { _resetPositionTracking, changedVolumes, initPositionTracking } from './positions-local';
import { noteReaderClosed, noteReaderOpened } from './reader-open';
import { _resetCloudPositionsForTests, cloudPositionStamp } from './positions-cloud';
import {
  _resetPositionsSyncForTests,
  checkPositionsOnOpen,
  flushPositionPush,
  requestPositionCheck,
  initPositionPush,
  probePositions,
  syncPositions
} from './positions-sync';
import { _resetRemoteReadsForTests, remoteReads } from '$lib/reading-history/remote-reads';

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

function stubCache(
  files: CloudFileMetadata[],
  state: { loaded?: boolean; fetching?: boolean } = {}
) {
  const cache = {
    getAll: vi.fn(() => files),
    add: vi.fn(),
    removeById: vi.fn(),
    isLoaded: () => state.loaded ?? true,
    isFetching: () => state.fetching ?? false
  };
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
    deleteFile: vi.fn(async (_file: CloudFileMetadata) => {}),
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
  _resetEscapesForTests();
  _resetCloudPositionsForTests();
  syncReady.mockReturnValue(true);
  providerTokenValid.mockReturnValue(true);
  _resetRemoteReadsForTests();
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

  it('listing not loaded or still fetching: not-ready, no GET and no PUT', async () => {
    // The full sync's step has callers the readiness gate does not cover; an
    // unloaded cache looks like "no copy" and the upload would replace the
    // cloud file with this device's entries alone.
    updateProgress('v', 41, 4100, false);
    for (const state of [{ loaded: false }, { fetching: true }]) {
      stubCache([], state);
      const provider = makeProvider(async () => fileBlob({}));
      expect(await syncPositions(provider)).toMatchObject({
        skipped: 'not-ready',
        uploaded: false
      });
      expect(provider.downloadFile).not.toHaveBeenCalled();
    }
    expect(blindUploadFile).not.toHaveBeenCalled();
    expect(changedVolumes()).toEqual(['v']);
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

  it('two listed copies (Drive): the upload lands on one, the other is deleted', async () => {
    // Drive's upload replaces whichever same-name file its query lists first;
    // left alone, the write could land on the copy nobody compares against and
    // every run would upload again. A delete of a copy already gone is fine.
    const cache = stubCache([listed('a'), listed('b'), listed('ghost')]);
    const provider = makeProvider(async (file) => {
      if (file.fileId === 'ghost') throw new ProviderError('File not found', 'webdav', 'NOT_FOUND');
      return file.fileId === 'a'
        ? fileBlob({ x: [now - 5000, 10, 100, 'phone'] })
        : fileBlob({ y: [now - 4000, 20, 200, 'phone'] });
    });
    blindUploadFile.mockResolvedValueOnce({ fileId: 'b' });
    vi.mocked(provider.deleteFile).mockImplementation(async (file) => {
      if (file.fileId === 'ghost') throw new ProviderError('File not found', 'webdav', 'NOT_FOUND');
    });
    expect((await syncPositions(provider)).uploaded).toBe(true);
    const deleted = vi.mocked(provider.deleteFile).mock.calls.map((c) => c[0].fileId);
    expect(deleted.sort()).toEqual(['a', 'ghost']);
    expect(cache.removeById.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'ghost']);

    // The survivor holds the merge: the next run has nothing to upload.
    const sent = await (blindUploadFile.mock.calls[0][1] as Blob).text();
    stubCache([listed('b')]);
    const again = makeProvider(async () => ({ text: async () => sent }) as unknown as Blob);
    expect((await syncPositions(again)).uploaded).toBe(false);
    expect(again.deleteFile).not.toHaveBeenCalled();
  });

  it('one listed copy: nothing is deleted after the upload', async () => {
    stubCache([listed('a')]);
    updateProgress('v', 41, 4100, false);
    const provider = makeProvider(async () => fileBlob({}));
    expect((await syncPositions(provider)).uploaded).toBe(true);
    expect(provider.deleteFile).not.toHaveBeenCalled();
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
    // The open volume's visit starts again where the reader now is.
    expect(rehomeVisit.mock.calls).toEqual([['v']]);
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

  it('a completed remote position marks the open volume complete when the page count is known', async () => {
    stubCache([listed('a')]);
    pageCounts.set('v', 120);
    noteReaderOpened('v', Date.now());
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
    // The manager's blind upload records the receipt in the cache itself; a
    // second, client-clock entry here would overwrite the server's stamp.
    expect(cache.add).not.toHaveBeenCalled();
    expect(changedVolumes()).toEqual([]);

    // The cloud now holds what went up.
    const sent = await (blindUploadFile.mock.calls[0][1] as Blob).text();
    stubCache([listed('uploaded-id')]);
    const again = makeProvider(async () => ({ text: async () => sent }) as unknown as Blob);
    expect((await syncPositions(again)).uploaded).toBe(false);
    expect(blindUploadFile).toHaveBeenCalledTimes(1);
  });

  it('remembers what the cloud file holds: after a read, and after its own write', async () => {
    stubCache([listed('a')]);
    const scope = { accountScope: 'https://dav.example/' };
    const read = makeProvider(async () => fileBlob({ w: [now - 1000, 3, 30, 'phone'] }), scope);
    await syncPositions(read);
    // The volume-data sync's deferral asks this (`volume-data-deferral.ts`).
    expect(cloudPositionStamp(read, 'w')).toBe(now - 1000);
    expect(cloudPositionStamp(read, 'v')).toBeUndefined();

    updateProgress('v', 41, 4100, false);
    const written = makeProvider(async () => fileBlob({ w: [now - 1000, 3, 30, 'phone'] }), scope);
    expect((await syncPositions(written)).uploaded).toBe(true);
    expect(cloudPositionStamp(written, 'v')).toBe(
      Date.parse(get(volumesWithTrash).v.lastProgressUpdate)
    );
    expect(cloudPositionStamp(written, 'w')).toBe(now - 1000);
  });

  it('a provider other than the active one: its own upload receipt goes into the cache', async () => {
    const cache = stubCache([]);
    updateProgress('v', 41, 4100, false);
    const provider = makeProvider(async () => fileBlob({}));
    getActiveProvider.mockReturnValue(null);
    const uploadFile = vi.fn(async (_path: string, blob: Blob) => ({
      fileId: 'other-id',
      modifiedTime: '2026-11-02T10:00:00.000Z',
      size: blob.size,
      revision: 'r1'
    }));
    (provider as unknown as { uploadFile: typeof uploadFile }).uploadFile = uploadFile;
    expect((await syncPositions(provider)).uploaded).toBe(true);
    expect(blindUploadFile).not.toHaveBeenCalled();
    expect(cache.add).toHaveBeenCalledTimes(1);
    expect(cache.add).toHaveBeenCalledWith(
      'positions.json',
      expect.objectContaining({
        fileId: 'other-id',
        modifiedTime: '2026-11-02T10:00:00.000Z',
        modifiedTimeProvisional: false,
        revision: 'r1'
      })
    );
  });

  it('an upload reports each own stamp as escaped, for the volumes a visit watches', async () => {
    stubCache([]);
    watchEscapes('v');
    updateProgress('v', 41, 4100, false);
    updateProgress('w', 9, 90, false);
    const provider = makeProvider(async () => fileBlob({}));
    expect((await syncPositions(provider)).uploaded).toBe(true);
    expect(newestUploaded('v')).toBe(Date.parse(get(volumesWithTrash).v.lastProgressUpdate));
    expect(newestUploaded('w')).toBe(0);
  });

  it('a stamp counts as escaped from the moment its upload starts', async () => {
    // The user may turn home while the PUT is in flight: the restore must
    // already beat the stamp the PUT is carrying.
    stubCache([]);
    watchEscapes('v');
    updateProgress('v', 41, 4100, false);
    let duringUpload = -1;
    blindUploadFile.mockImplementationOnce(async () => {
      duringUpload = newestUploaded('v');
      return { fileId: 'uploaded-id' };
    });
    const provider = makeProvider(async () => fileBlob({}));
    await syncPositions(provider);
    expect(duringUpload).toBe(Date.parse(get(volumesWithTrash).v.lastProgressUpdate));
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

describe('adoption cost', () => {
  it('reads a catalog row only for the open volume, never one per adopted entry', async () => {
    const { db } = await import('$lib/catalog/db');
    stubCache([listed('a')]);
    pageCounts.set('v', 200);
    noteReaderOpened('v', Date.now());
    const provider = makeProvider(async () =>
      fileBlob({
        v: [now - 1000, 120, 12000, 'phone'],
        x: [now - 1000, 5, 50, 'phone'],
        y: [now - 1000, 6, 60, 'phone']
      })
    );
    const outcome = await syncPositions(provider);
    expect(outcome.adopted.sort()).toEqual(['v', 'x', 'y']);
    expect(vi.mocked(db.volumes.get).mock.calls.map((c) => c[0])).toEqual(['v']);
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

  // The page-turn push runs outside the progress sync: it must ask the server
  // again (throttled) before it writes, or a bunko rolled back to 0.7.3 under
  // an open tab gets positions.json into its SHARED library.
  it('after a bunko rollback, the page-turn push asks the identity again and does not PUT', async () => {
    stubCache([]);
    const status: Partial<ProviderStatus> = { serverCompilesMetadata: true, positionsSync: true };
    const provider = makeProvider(async () => fileBlob({}), status);
    const refreshIdentity = vi.fn(async () => {
      status.positionsSync = false; // the server answers as 0.7.3 now
    });
    Object.assign(provider, {
      getStatus: () => ({
        isAuthenticated: true,
        hasStoredCredentials: true,
        needsAttention: false,
        statusMessage: '',
        ...status
      }),
      refreshIdentity
    });
    stops.push(initPositionPush());
    updateProgress('v', 41, 4100, false);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(refreshIdentity).toHaveBeenCalled());
    expect(refreshIdentity).toHaveBeenCalledWith({ maxAgeMs: 5 * 60_000 });
    await flushPositionPush();
    expect(blindUploadFile).not.toHaveBeenCalled();
    expect(provider.downloadFile).not.toHaveBeenCalled();
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

describe('the reader-open check', () => {
  it('resolves when the answer arrives', async () => {
    stubCache([listed('a')]);
    makeProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return fileBlob({ v: [now - 1000, 120, 12000, 'phone'] });
    });
    let done = false;
    const check = checkPositionsOnOpen('v').then(() => (done = true));
    await vi.advanceTimersByTimeAsync(199);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await check;
    expect(done).toBe(true);
    expect(get(volumesWithTrash).v.progress).toBe(120);
    expect(showSnackbar).toHaveBeenCalledWith('Continued from Pixel, p.120');
  });

  it('resolves at 1000 ms when the provider is slow; the late answer still adopts', async () => {
    stubCache([listed('a')]);
    makeProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return fileBlob({ v: [now - 1000, 120, 12000, 'phone'] });
    });
    let done = false;
    void checkPositionsOnOpen('v').then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(get(volumesWithTrash).v?.progress ?? 0).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(get(volumesWithTrash).v.progress).toBe(120));
    expect(showSnackbar).toHaveBeenCalledWith('Continued from Pixel, p.120');
  });

  it('not ready (no provider / listing not loaded) → resolves at once, no request', async () => {
    stubCache([listed('a')]);
    const provider = makeProvider(async () => fileBlob({}));
    syncReady.mockReturnValue(false);
    await checkPositionsOnOpen('v');
    expect(provider.downloadFile).not.toHaveBeenCalled();

    syncReady.mockReturnValue(true);
    getActiveProvider.mockReturnValue(null);
    await checkPositionsOnOpen('v');
    expect(provider.downloadFile).not.toHaveBeenCalled();
  });

  it('notes the open volume, so an answer for it toasts', async () => {
    stubCache([listed('a')]);
    makeProvider(async () => fileBlob({ v: [now - 1000, 9, 90, 'phone'] }));
    await checkPositionsOnOpen('v');
    expect(showSnackbar).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when the readiness check does', async () => {
    syncReady.mockImplementation(() => {
      throw new Error('cache gone');
    });
    await expect(Promise.resolve().then(() => checkPositionsOnOpen('v'))).resolves.toBeUndefined();
  });

  it('focus check is throttled to one per 10 s', async () => {
    stubCache([listed('a')]);
    const provider = makeProvider(async () => fileBlob({}));
    requestPositionCheck(100_000);
    requestPositionCheck(105_000);
    await vi.waitFor(() => expect(provider.downloadFile).toHaveBeenCalledTimes(1));
    requestPositionCheck(110_000);
    await vi.waitFor(() => expect(provider.downloadFile).toHaveBeenCalledTimes(2));
  });

  it('a visible tab asks for a check', async () => {
    stubCache([listed('a')]);
    const provider = makeProvider(async () => fileBlob({}));
    stops.push(initPositionPush());
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(provider.downloadFile).toHaveBeenCalledTimes(1));
  });
});

/** A provider that can read `positions.json` by path (no listing). */
function makeProbingProvider(
  copies: () => Promise<Blob[]>,
  status: Partial<ProviderStatus> = {}
): SyncProvider & { readRootFileCopies: ReturnType<typeof vi.fn> } {
  const provider = makeProvider(async () => {
    throw new Error('the probe never downloads through the listing');
  }, status) as SyncProvider & { readRootFileCopies: ReturnType<typeof vi.fn> };
  provider.readRootFileCopies = vi.fn(copies);
  (provider as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => true;
  return provider;
}

describe('the cold probe (before the listing has loaded)', () => {
  it('probePositions adopts by path and writes nothing, keeping own turns marked', async () => {
    stubCache([], { loaded: false });
    updateProgress('w', 3, 30, false);
    const provider = makeProbingProvider(async () => [
      fileBlob({ v: [now - 1000, 120, 12000, 'phone'] })
    ]);
    const outcome = await probePositions(provider);
    expect(outcome).toMatchObject({ adopted: ['v'], uploaded: false, probe: true });
    expect(provider.readRootFileCopies).toHaveBeenCalledWith('positions.json');
    expect(provider.downloadFile).not.toHaveBeenCalled();
    expect(get(volumesWithTrash).v.progress).toBe(120);
    expect(blindUploadFile).not.toHaveBeenCalled();
    // The full sync pushes them once the listing shows every copy.
    expect(changedVolumes()).toEqual(['w']);
  });

  it('merges every copy the provider found', async () => {
    stubCache([], { loaded: false });
    const provider = makeProbingProvider(async () => [
      fileBlob({ v: [now - 1000, 120, 12000, 'phone'] }),
      fileBlob({ v: [now - 500, 130, 13000, 'tablet'], w: [now - 9000, 4, 40, 'phone'] })
    ]);
    expect((await probePositions(provider)).adopted.sort()).toEqual(['v', 'w']);
    expect(get(volumesWithTrash).v.progress).toBe(130);
  });

  it('no file: adopts nothing, no error', async () => {
    stubCache([], { loaded: false });
    const provider = makeProbingProvider(async () => []);
    expect(await probePositions(provider)).toMatchObject({ adopted: [], uploaded: false });
  });

  it('old bunko: not even the probe reads the shared path', async () => {
    stubCache([], { loaded: false });
    const provider = makeProbingProvider(async () => [fileBlob({})], {
      serverCompilesMetadata: true
    });
    expect((await probePositions(provider)).skipped).toBe('not-allowed');
    expect(provider.readRootFileCopies).not.toHaveBeenCalled();
  });

  it('an expired Drive token: no probe', async () => {
    stubCache([], { loaded: false });
    providerTokenValid.mockReturnValue(false);
    const provider = makeProbingProvider(async () => [fileBlob({})]);
    expect((await probePositions(provider)).skipped).toBe('not-ready');
    expect(provider.readRootFileCopies).not.toHaveBeenCalled();
  });

  it('the reader-open check probes while the first listing runs, and toasts', async () => {
    stubCache([], { loaded: false, fetching: true });
    syncReady.mockReturnValue(false);
    const provider = makeProbingProvider(async () => [
      fileBlob({ v: [now - 1000, 120, 12000, 'phone'] })
    ]);
    await checkPositionsOnOpen('v');
    expect(provider.readRootFileCopies).toHaveBeenCalledTimes(1);
    expect(get(volumesWithTrash).v.progress).toBe(120);
    expect(showSnackbar).toHaveBeenCalledWith('Continued from Pixel, p.120');
  });

  it('no listing under way (e.g. login not finished): the open check does not probe', async () => {
    stubCache([], { loaded: false, fetching: false });
    syncReady.mockReturnValue(false);
    const provider = makeProbingProvider(async () => [fileBlob({})]);
    await checkPositionsOnOpen('v');
    expect(provider.readRootFileCopies).not.toHaveBeenCalled();
  });

  it('a probe in flight answers the open check: no second wait', async () => {
    stubCache([], { loaded: false, fetching: true });
    syncReady.mockReturnValue(false);
    const provider = makeProbingProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return [fileBlob({ v: [now - 1000, 120, 12000, 'phone'] })];
    });
    void probePositions(provider);
    await vi.advanceTimersByTimeAsync(100);
    let done = false;
    const check = checkPositionsOnOpen('v').then(() => (done = true));
    await vi.advanceTimersByTimeAsync(200);
    await check;
    expect(done).toBe(true);
    expect(get(volumesWithTrash).v.progress).toBe(120);
    // The open was noted before the first probe's download landed: it toasts.
    expect(showSnackbar).toHaveBeenCalledWith('Continued from Pixel, p.120');
  });

  it('the focus check probes while the first listing runs', async () => {
    stubCache([], { loaded: false, fetching: true });
    syncReady.mockReturnValue(false);
    const provider = makeProbingProvider(async () => [fileBlob({})]);
    requestPositionCheck(now);
    await vi.waitFor(() => expect(provider.readRootFileCopies).toHaveBeenCalledTimes(1));
  });

  it('once the listing is in, the ordinary path runs (listed copies, push)', async () => {
    stubCache([listed('a')]);
    updateProgress('w', 3, 30, false);
    const provider = makeProbingProvider(async () => [fileBlob({})]);
    (provider.downloadFile as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      fileBlob({})
    );
    const outcome = await syncPositions(provider);
    expect(outcome.uploaded).toBe(true);
    expect(outcome.probe).toBeUndefined();
    expect(provider.readRootFileCopies).not.toHaveBeenCalled();
  });
});

describe('adopted positions are reads for smart sort', () => {
  it('an adoption notes the reading device and its stamp', async () => {
    stubCache([listed('a')]);
    const remoteAt = now - 1000;
    const provider = makeProvider(async () => fileBlob({ v: [remoteAt, 120, 12000, 'phone'] }));
    await syncPositions(provider);
    expect(get(remoteReads).get('v')).toEqual({ at: remoteAt, device: 'phone' });
  });

  it('an entry not adopted (older than local) notes nothing', async () => {
    stubCache([listed('a')]);
    updateProgress('v', 41, 4100, false);
    const provider = makeProvider(async () => fileBlob({ v: [now - 60_000, 120, 12000, 'phone'] }));
    await syncPositions(provider);
    expect(get(remoteReads).has('v')).toBe(false);
  });
});
