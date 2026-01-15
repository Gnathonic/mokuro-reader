import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectSeriesConflicts, generateMergeSeriesPreview } from '$lib/util/series-merge';

// Mock the database
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      toArray: vi.fn(),
      where: vi.fn().mockReturnValue({
        toArray: vi.fn()
      }),
      update: vi.fn()
    },
    transaction: vi.fn()
  }
}));

// Mock the volume data store
vi.mock('$lib/settings/volume-data', () => ({
  volumes: {
    subscribe: vi.fn()
  }
}));

// Mock svelte/store
vi.mock('svelte/store', () => ({
  get: vi.fn().mockReturnValue({})
}));

describe('Series Merge Functionality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectSeriesConflicts', () => {
    it('should return empty array when no volumes exist', async () => {
      const { db } = await import('$lib/catalog/db');
      vi.mocked(db.volumes.toArray).mockResolvedValue([]);

      const conflicts = await detectSeriesConflicts();
      expect(conflicts).toEqual([]);
    });

    it('should detect series with multiple UUIDs', async () => {
      const { db } = await import('$lib/catalog/db');
      const mockVolumes = [
        {
          series_title: 'Test Series',
          series_uuid: 'uuid-1',
          volume_uuid: 'vol-1',
          volume_title: 'Volume 1'
        },
        {
          series_title: 'Test Series',
          series_uuid: 'uuid-2',
          volume_uuid: 'vol-2',
          volume_title: 'Volume 2'
        },
        {
          series_title: 'Another Series',
          series_uuid: 'uuid-3',
          volume_uuid: 'vol-3',
          volume_title: 'Volume 1'
        }
      ];

      vi.mocked(db.volumes.toArray).mockResolvedValue(mockVolumes);

      const conflicts = await detectSeriesConflicts();

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].seriesTitle).toBe('Test Series');
      expect(conflicts[0].conflictingUuids).toHaveLength(2);
      expect(conflicts[0].conflictingUuids[0].seriesUuid).toBe('uuid-1');
      expect(conflicts[0].conflictingUuids[1].seriesUuid).toBe('uuid-2');
    });

    it('should not return series with single UUID', async () => {
      const { db } = await import('$lib/catalog/db');
      const mockVolumes = [
        {
          series_title: 'Consistent Series',
          series_uuid: 'uuid-1',
          volume_uuid: 'vol-1',
          volume_title: 'Volume 1'
        },
        {
          series_title: 'Consistent Series',
          series_uuid: 'uuid-1',
          volume_uuid: 'vol-2',
          volume_title: 'Volume 2'
        }
      ];

      vi.mocked(db.volumes.toArray).mockResolvedValue(mockVolumes);

      const conflicts = await detectSeriesConflicts();
      expect(conflicts).toEqual([]);
    });

    it('should detect series with different casing as conflicts (case-insensitive)', async () => {
      const { db } = await import('$lib/catalog/db');
      const mockVolumes = [
        {
          series_title: 'Test Series',
          series_uuid: 'uuid-1',
          volume_uuid: 'vol-1',
          volume_title: 'Volume 1'
        },
        {
          series_title: 'test series', // Same title, different case
          series_uuid: 'uuid-2',
          volume_uuid: 'vol-2',
          volume_title: 'Volume 2'
        },
        {
          series_title: 'TEST SERIES', // Same title, all caps
          series_uuid: 'uuid-3',
          volume_uuid: 'vol-3',
          volume_title: 'Volume 3'
        }
      ];

      vi.mocked(db.volumes.toArray).mockResolvedValue(mockVolumes);

      const conflicts = await detectSeriesConflicts();

      expect(conflicts).toHaveLength(1);
      // Uses the first encountered title as display title
      expect(conflicts[0].seriesTitle).toBe('Test Series');
      expect(conflicts[0].conflictingUuids).toHaveLength(3);
    });
  });

  describe('generateMergeSeriesPreview', () => {
    it('should generate preview of database and localStorage changes', async () => {
      const { db } = await import('$lib/catalog/db');
      const mockVolumes = [
        {
          volume_uuid: 'vol-1',
          series_uuid: 'old-uuid',
          series_title: 'Test Series'
        }
      ];

      vi.mocked(db.volumes.where).mockReturnValue({
        toArray: vi.fn().mockResolvedValue(mockVolumes)
      } as any);

      const preview = await generateMergeSeriesPreview('Test Series', 'old-uuid', 'new-uuid');

      expect(preview.indexedDbChanges).toHaveLength(1);
      expect(preview.indexedDbChanges[0]).toEqual({
        table: 'volumes',
        volumeUuid: 'vol-1',
        field: 'series_uuid',
        oldValue: 'old-uuid',
        newValue: 'new-uuid'
      });
    });
  });
});
