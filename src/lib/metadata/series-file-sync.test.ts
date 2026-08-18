import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

const providerStatus = vi.hoisted(() => {
  let value = {
    providers: {} as Record<string, { isReadOnly?: boolean } | null>,
    hasAnyAuthenticated: true,
    needsAttention: false,
    currentProviderType: 'webdav' as string | null
  };
  const subs = new Set<(v: typeof value) => void>();
  return {
    subscribe(fn: (v: typeof value) => void) {
      subs.add(fn);
      fn(value);
      return () => subs.delete(fn);
    },
    set(v: typeof value) {
      value = v;
      subs.forEach((fn) => fn(value));
    }
  };
});

vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { status: providerStatus }
}));

const writeSeriesFile = vi.hoisted(() => vi.fn(async () => 'written' as const));
const getManagedCloudFilesForVolume = vi.hoisted(() =>
  vi.fn((_series: string, volumeTitle: string) => [{ path: `One Piece/${volumeTitle}.cbz` }])
);
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { writeSeriesFile, getManagedCloudFilesForVolume }
}));

// An in-memory stand-in for the two tables involved: the gate reads the
// installed volumes, and `store.ts` writes the series_metadata rows whose fact
// changes drive the listener. Deliberately NOT fake-indexeddb: it schedules its
// transactions on setImmediate, which vitest's fake timers freeze.
const { volumeRows, metaRows } = vi.hoisted(() => ({
  volumeRows: [] as Record<string, unknown>[],
  metaRows: new Map<string, Record<string, unknown>>()
}));

vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { toArray: async () => [...volumeRows] },
    series_metadata: {
      get: async (key: string) => metaRows.get(key),
      put: async (rec: { series_key: string }) => {
        metaRows.set(rec.series_key, rec);
      }
    },
    transaction: async (_mode: string, _table: unknown, body: () => Promise<unknown>) => body()
  }
}));

import {
  flushSeriesFileWrites,
  initSeriesFileSync,
  scheduleSeriesFileWrite
} from './series-file-sync';
import { updateSeriesMetadata, unlinkSeries, upsertFromSeriesFile } from './store';

function addVolume(seriesTitle: string, volumeTitle: string, extra: object = {}) {
  volumeRows.push({
    volume_uuid: `${seriesTitle}/${volumeTitle}`,
    series_uuid: 's',
    series_title: seriesTitle,
    volume_title: volumeTitle,
    mokuro_version: '0.4.11',
    page_count: 1,
    character_count: 1,
    page_char_counts: [1],
    ...extra
  });
}

let dispose: (() => void) | undefined;

describe('series-file-sync', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    writeSeriesFile.mockResolvedValue('written');
    getManagedCloudFilesForVolume.mockImplementation((_s: string, volumeTitle: string) => [
      { path: `One Piece/${volumeTitle}.cbz` }
    ]);
    providerStatus.set({
      providers: {},
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'webdav'
    });
    volumeRows.length = 0;
    metaRows.clear();
    addVolume('One Piece', 'Volume 1');
    dispose = initSeriesFileSync();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
  });

  it('coalesces a burst of edits into one write per series', async () => {
    scheduleSeriesFileWrite('One Piece');
    scheduleSeriesFileWrite('One Piece');
    scheduleSeriesFileWrite('One Piece');
    expect(writeSeriesFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('debounces per series — two series each get their own write', async () => {
    addVolume('Berserk', 'Volume 1');
    getManagedCloudFilesForVolume.mockImplementation((series: string, volumeTitle: string) => [
      { path: `${series}/${volumeTitle}.cbz` }
    ]);

    scheduleSeriesFileWrite('One Piece');
    scheduleSeriesFileWrite('Berserk');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile.mock.calls.map((args: unknown[]) => args[0]).sort()).toEqual([
      'Berserk',
      'One Piece'
    ]);
  });

  it('does not write when no cloud provider is connected', async () => {
    providerStatus.set({
      providers: {},
      hasAnyAuthenticated: false,
      needsAttention: false,
      currentProviderType: null
    });

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('does not write to a read-only provider', async () => {
    providerStatus.set({
      providers: { webdav: { isReadOnly: true } },
      hasAnyAuthenticated: true,
      needsAttention: false,
      currentProviderType: 'webdav'
    });

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('does not write for a series with nothing backed up', async () => {
    getManagedCloudFilesForVolume.mockReturnValue([]);

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('ignores a series whose only cloud files are sidecars (no archive)', async () => {
    getManagedCloudFilesForVolume.mockReturnValue([{ path: 'One Piece/Volume 1.mokuro' }]);

    scheduleSeriesFileWrite('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('swallows a write failure — a background index write never breaks an edit', async () => {
    writeSeriesFile.mockRejectedValue(new Error('offline'));

    scheduleSeriesFileWrite('One Piece');
    // No unhandled rejection, no throw out of the timer callback.
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
  });

  it('flush writes everything pending immediately', async () => {
    scheduleSeriesFileWrite('One Piece');
    await flushSeriesFileWrites();

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    // The timer is cancelled, not merely fired early.
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
  });

  it('fires after a fact edit through the store', async () => {
    await updateSeriesMetadata('One Piece', { tag: 'color' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('fires after an unlink (the cleared facts have to be published)', async () => {
    await updateSeriesMetadata('One Piece', { external_ids: { anilist: 13 } });
    await vi.advanceTimersByTimeAsync(2000);
    writeSeriesFile.mockClear();

    await unlinkSeries('One Piece');
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  });

  it('does NOT fire for a per-user edit (spine offsets, rereads, tracking)', async () => {
    await updateSeriesMetadata('One Piece', { read_count: 2 });
    await updateSeriesMetadata('One Piece', { tracking: { enabled: true, unit: 'volumes' } });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('does NOT fire when a fact write changes nothing', async () => {
    await updateSeriesMetadata('One Piece', { tag: 'color' });
    await vi.advanceTimersByTimeAsync(2000);
    writeSeriesFile.mockClear();

    await updateSeriesMetadata('One Piece', { tag: 'color' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('does NOT fire when a sidecar read-back applies facts (no write loop)', async () => {
    await upsertFromSeriesFile('One Piece', {
      version: 2,
      series_title: 'One Piece',
      external_ids: { anilist: 13 },
      titles: {},
      synonyms: [],
      updated_at: '2026-08-17T00:00:00.000Z',
      volumes: []
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('stops scheduling once disposed and re-registers idempotently', async () => {
    // A second init while one is live must not double-register the listener.
    const second = initSeriesFileSync();
    await updateSeriesMetadata('One Piece', { tag: 'blue' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);

    second();
    dispose = undefined;
    await updateSeriesMetadata('One Piece', { tag: 'green' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
  });
});
