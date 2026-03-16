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

    await executeRenameSeries('Old Series', 'New Series', 'series-1');

    expect(unifiedCloudManager.renameSeries).toHaveBeenCalledWith('Old Series', 'New Series');
    expect(db.volumes.update).toHaveBeenCalledWith('vol-1', { series_title: 'New Series' });
    expect(updateVolumeSeriesTitle).toHaveBeenCalledWith('vol-1', 'New Series');
  });
});
