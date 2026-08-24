import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeRenameSeries, generateRenameSeriesPreview } from './series-rename';

vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      where: vi.fn(),
      update: vi.fn()
    },
    transaction: vi.fn(async (_mode: string, _tables: unknown[], callback: () => Promise<void>) => {
      await callback();
    })
  }
}));

vi.mock('$lib/settings/volume-data', () => ({
  volumes: {
    subscribe: vi.fn()
  },
  updateVolumeSeriesTitle: vi.fn()
}));

vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    renameSeries: vi.fn()
  }
}));

vi.mock('svelte/store', () => ({
  get: vi.fn()
}));

const moveSeriesMetadataKey = vi.fn();
vi.mock('$lib/metadata/store', () => ({
  moveSeriesMetadataKey: (...args: unknown[]) => moveSeriesMetadataKey(...args)
}));

const moveSeriesReadingStateKey = vi.fn();
vi.mock('$lib/settings/series-data', () => ({
  moveSeriesReadingStateKey: (...args: unknown[]) => moveSeriesReadingStateKey(...args)
}));

describe('Series rename cloud propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes matching local storage rows in the preview', async () => {
    const { db } = await import('$lib/catalog/db');
    const { get } = await import('svelte/store');

    vi.mocked(db.volumes.where).mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          volume_uuid: 'vol-1',
          series_uuid: 'series-1',
          series_title: 'Old Series'
        }
      ])
    } as any);
    vi.mocked(get).mockReturnValue({
      'vol-1': {
        series_uuid: 'series-1',
        series_title: 'Old Series'
      },
      'vol-2': {
        series_uuid: 'series-2',
        series_title: 'Other Series'
      }
    });

    const preview = await generateRenameSeriesPreview('Old Series', 'New Series', 'series-1');

    expect(preview.indexedDbChanges).toHaveLength(1);
    expect(preview.localStorageChanges).toEqual([
      {
        volumeUuid: 'vol-1',
        field: 'series_title',
        oldValue: 'Old Series',
        newValue: 'New Series'
      }
    ]);
  });

  it('renames the cloud series before updating local metadata', async () => {
    const { db } = await import('$lib/catalog/db');
    const { get } = await import('svelte/store');
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const { updateVolumeSeriesTitle } = await import('$lib/settings/volume-data');

    vi.mocked(db.volumes.where).mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          volume_uuid: 'vol-1',
          volume_title: 'Volume 1',
          series_uuid: 'series-1',
          series_title: 'Old Series'
        }
      ])
    } as any);
    vi.mocked(get).mockReturnValue({
      'vol-1': {
        series_uuid: 'series-1',
        series_title: 'Old Series'
      }
    });
    vi.mocked(unifiedCloudManager.renameSeries).mockResolvedValue({
      changed: 3,
      renamedVolumeUuids: ['vol-1'],
      failures: []
    });

    const result = await executeRenameSeries('Old Series', 'New Series', 'series-1');

    // Passes the volume list so each .mokuro's series title can be regenerated.
    expect(unifiedCloudManager.renameSeries).toHaveBeenCalledWith('Old Series', 'New Series', [
      { volumeUuid: 'vol-1', volumeTitle: 'Volume 1' }
    ]);
    expect(db.volumes.update).toHaveBeenCalledWith('vol-1', { series_title: 'New Series' });
    expect(updateVolumeSeriesTitle).toHaveBeenCalledWith('vol-1', 'New Series');
    expect(result).toEqual({ finalTitle: 'New Series', renamedCount: 1, failures: [] });
  });

  it('commits ONLY the volumes whose cloud rename succeeded, and reports the rest', async () => {
    const { db } = await import('$lib/catalog/db');
    const { get } = await import('svelte/store');
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    const { updateVolumeSeriesTitle } = await import('$lib/settings/volume-data');

    vi.mocked(db.volumes.where).mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          volume_uuid: 'vol-1',
          volume_title: 'Volume 1',
          series_uuid: 'series-1',
          series_title: 'Old Series'
        },
        {
          volume_uuid: 'vol-2',
          volume_title: 'Volume 2',
          series_uuid: 'series-1',
          series_title: 'Old Series'
        }
      ])
    } as any);
    vi.mocked(get).mockReturnValue({
      'vol-1': { series_uuid: 'series-1', series_title: 'Old Series' },
      'vol-2': { series_uuid: 'series-1', series_title: 'Old Series' }
    });
    vi.mocked(unifiedCloudManager.renameSeries).mockResolvedValue({
      changed: 3,
      renamedVolumeUuids: ['vol-2'],
      failures: [{ volumeUuid: 'vol-1', volumeTitle: 'Volume 1', error: new Error('network') }]
    });

    const result = await executeRenameSeries('Old Series', 'New Series', 'series-1');

    // vol-1's cloud rename failed → it keeps the old title locally too.
    expect(db.volumes.update).toHaveBeenCalledTimes(1);
    expect(db.volumes.update).toHaveBeenCalledWith('vol-2', { series_title: 'New Series' });
    expect(updateVolumeSeriesTitle).toHaveBeenCalledTimes(1);
    expect(updateVolumeSeriesTitle).toHaveBeenCalledWith('vol-2', 'New Series');
    expect(result.renamedCount).toBe(1);
    // The reason travels with the failure: some of them ("not on this device")
    // cannot be fixed by the retry the UI otherwise suggests.
    expect(result.failures).toEqual([
      { volumeUuid: 'vol-1', volumeTitle: 'Volume 1', reason: 'network' }
    ]);
  });

  it('sanitizes the new series title before cloud rename and DB write', async () => {
    const { db } = await import('$lib/catalog/db');
    const { get } = await import('svelte/store');
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');

    vi.mocked(db.volumes.where).mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          volume_uuid: 'vol-1',
          volume_title: 'Volume 1',
          series_uuid: 'series-1',
          series_title: 'Old Series'
        }
      ])
    } as any);
    vi.mocked(get).mockReturnValue({
      'vol-1': { series_uuid: 'series-1', series_title: 'Old Series' }
    });
    vi.mocked(unifiedCloudManager.renameSeries).mockResolvedValue({
      changed: 3,
      renamedVolumeUuids: ['vol-1'],
      failures: []
    });

    const result = await executeRenameSeries('Old Series', 'New/Series', 'series-1');

    expect(unifiedCloudManager.renameSeries).toHaveBeenCalledWith('Old Series', 'New／Series', [
      { volumeUuid: 'vol-1', volumeTitle: 'Volume 1' }
    ]);
    expect(db.volumes.update).toHaveBeenCalledWith('vol-1', { series_title: 'New／Series' });
    expect(result.finalTitle).toBe('New／Series');
  });

  it('throws when the new title sanitizes to empty', async () => {
    const { db } = await import('$lib/catalog/db');
    vi.mocked(db.volumes.where).mockReturnValue({
      toArray: vi.fn().mockResolvedValue([])
    } as any);

    await expect(executeRenameSeries('Old Series', '', 'series-1')).rejects.toThrow();
  });

  it('moves the series metadata record to the new title after a successful rename', async () => {
    const { db } = await import('$lib/catalog/db');
    const { get } = await import('svelte/store');
    const { unifiedCloudManager } = await import('$lib/util/sync/unified-cloud-manager');
    vi.mocked(db.volumes.where).mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          volume_uuid: 'vol-1',
          series_uuid: 'series-1',
          series_title: 'Old Series',
          volume_title: 'V1'
        }
      ])
    } as any);
    vi.mocked(get).mockReturnValue({});
    vi.mocked(unifiedCloudManager.renameSeries).mockResolvedValue({
      renamedVolumeUuids: ['vol-1'],
      failures: []
    } as any);

    await executeRenameSeries('Old Series', 'New Series');
    expect(moveSeriesMetadataKey).toHaveBeenCalledWith('Old Series', 'New Series');
    // The reading state is keyed the same way and has to follow the same rename,
    // or "Read N times" and the AniList bookkeeping stay behind on the old key.
    expect(moveSeriesReadingStateKey).toHaveBeenCalledWith('Old Series', 'New Series');
  });
});
