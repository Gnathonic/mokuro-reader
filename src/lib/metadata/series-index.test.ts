import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('series-index-store-test');
  db.version(1).stores({ series_index: 'series_key' });
  return { db };
});

import { db } from '$lib/catalog/db';
import {
  getSeriesIndex,
  putSeriesIndex,
  deleteSeriesIndex,
  moveSeriesIndexKey,
  indexNeedsRefresh,
  sourceStampChanged,
  seriesIndexMap,
  type SeriesIndexRecord
} from './series-index';
import type { SeriesFile } from './series-file';

/** A minimal series.json — the store never inspects its contents. */
function seriesFile(overrides: Partial<SeriesFile> = {}): SeriesFile {
  return {
    version: 2,
    series_title: 'One Piece',
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at: '2026-08-17T00:00:00.000Z',
    volumes: [],
    ...overrides
  };
}

function record(overrides: Partial<SeriesIndexRecord> = {}): SeriesIndexRecord {
  return {
    series_key: 'one piece',
    series_title: 'One Piece',
    file: seriesFile(),
    source: {
      provider: 'google-drive',
      path: 'One Piece/series.json',
      size: 1234,
      modifiedTime: '2026-08-17T00:00:00.000Z'
    },
    fetched_at: '2026-08-17T00:00:01.000Z',
    ...overrides
  };
}

describe('series index store', () => {
  beforeEach(async () => {
    await (db as any).table('series_index').clear();
  });

  it('put/get round-trips a record by series_key', async () => {
    const rec = record();
    await putSeriesIndex(rec);
    expect(await getSeriesIndex('one piece')).toEqual(rec);
    expect(await getSeriesIndex('nonexistent')).toBeUndefined();
  });

  it('putSeriesIndex overwrites an existing record for the same key', async () => {
    await putSeriesIndex(record());
    const updated = record({
      file: seriesFile({ updated_at: '2026-08-18T00:00:00.000Z' }),
      fetched_at: '2026-08-18T00:00:01.000Z'
    });
    await putSeriesIndex(updated);
    expect(await getSeriesIndex('one piece')).toEqual(updated);
  });

  it('deleteSeriesIndex removes the record', async () => {
    await putSeriesIndex(record());
    await deleteSeriesIndex('one piece');
    expect(await getSeriesIndex('one piece')).toBeUndefined();
  });

  it('deleteSeriesIndex on a missing key is a no-op', async () => {
    await expect(deleteSeriesIndex('missing')).resolves.toBeUndefined();
  });

  describe('moveSeriesIndexKey', () => {
    it('moves the record to the new key', async () => {
      await putSeriesIndex(record());
      await moveSeriesIndexKey('One Piece', 'One Piece Digital');
      expect(await getSeriesIndex('one piece')).toBeUndefined();
      const moved = await getSeriesIndex('one piece digital');
      expect(moved?.series_key).toBe('one piece digital');
      expect(moved?.series_title).toBe('One Piece Digital');
      expect(moved?.file).toEqual(record().file);
    });

    it('is a no-op when there is no record at the old key', async () => {
      await expect(moveSeriesIndexKey('Nothing Here', 'Something')).resolves.toBeUndefined();
      expect(await getSeriesIndex('something')).toBeUndefined();
    });

    it('keeps the record when only case/whitespace changed', async () => {
      await putSeriesIndex(record());
      await moveSeriesIndexKey('one piece', 'One  Piece');
      const moved = await getSeriesIndex('one piece');
      expect(moved?.series_title).toBe('One  Piece');
    });

    it('on collision, the newer fetched_at wins and the loser is dropped', async () => {
      await putSeriesIndex(
        record({
          series_key: 'old name',
          series_title: 'Old Name',
          fetched_at: '2026-08-17T00:00:00.000Z'
        })
      );
      await putSeriesIndex(
        record({
          series_key: 'new name',
          series_title: 'New Name',
          fetched_at: '2026-08-18T00:00:00.000Z',
          file: seriesFile({ series_title: 'New Name' })
        })
      );

      await moveSeriesIndexKey('Old Name', 'New Name');

      expect(await getSeriesIndex('old name')).toBeUndefined();
      const winner = await getSeriesIndex('new name');
      expect(winner?.fetched_at).toBe('2026-08-18T00:00:00.000Z');
      expect(winner?.series_title).toBe('New Name');
    });

    it('on collision, an older destination record is replaced by the moved record', async () => {
      await putSeriesIndex(
        record({
          series_key: 'old name',
          series_title: 'Old Name',
          fetched_at: '2026-08-18T00:00:00.000Z'
        })
      );
      await putSeriesIndex(
        record({
          series_key: 'new name',
          series_title: 'New Name',
          fetched_at: '2026-08-17T00:00:00.000Z'
        })
      );

      await moveSeriesIndexKey('Old Name', 'New Name');

      expect(await getSeriesIndex('old name')).toBeUndefined();
      const winner = await getSeriesIndex('new name');
      expect(winner?.fetched_at).toBe('2026-08-18T00:00:00.000Z');
      expect(winner?.series_title).toBe('New Name');
    });
  });

  describe('seriesIndexMap', () => {
    it('starts empty and reflects table writes reactively', async () => {
      const emissions: Map<string, SeriesIndexRecord>[] = [];
      const unsubscribe = seriesIndexMap.subscribe((m) => emissions.push(m));
      try {
        // The store's initial value (before any liveQuery emission) is an empty Map.
        expect(emissions[0]).toEqual(new Map());

        await putSeriesIndex(record());
        // Wait for the liveQuery subscription to pick up the write.
        await vi.waitFor(() => {
          expect(emissions.at(-1)?.get('one piece')).toBeDefined();
        });
        expect(emissions.at(-1)?.get('one piece')).toEqual(record());
      } finally {
        unsubscribe();
      }
    });
  });

  describe('indexNeedsRefresh', () => {
    it('is true when there is no cached record', () => {
      expect(
        indexNeedsRefresh(undefined, { size: 100, modifiedTime: '2026-08-17T00:00:00Z' })
      ).toBe(true);
    });

    it('is true when the record was cached from another source than this provider', () => {
      const rec = record({
        source: {
          provider: 'import',
          path: 'series.json',
          size: 100,
          modifiedTime: '2026-08-17T00:00:00.000Z'
        }
      });
      const stamp = { size: 100, modifiedTime: '2026-08-17T00:00:00.000Z' };

      // An import-sourced (or other-provider) record never saw this cloud file.
      expect(indexNeedsRefresh(rec, stamp, 'mega')).toBe(true);
      expect(indexNeedsRefresh(rec, stamp, 'import')).toBe(false);
      // No provider given: the stamp alone decides, as before.
      expect(indexNeedsRefresh(rec, stamp)).toBe(false);
    });

    it('is false when size and modifiedTime (normalized) match', () => {
      const rec = record({
        source: { provider: 'mega', path: 'x', size: 100, modifiedTime: '2026-08-17T00:00:00.000Z' }
      });
      expect(indexNeedsRefresh(rec, { size: 100, modifiedTime: '2026-08-17T00:00:00.000Z' })).toBe(
        false
      );
    });

    it('is true when size differs', () => {
      const rec = record({
        source: { provider: 'mega', path: 'x', size: 100, modifiedTime: '2026-08-17T00:00:00.000Z' }
      });
      expect(indexNeedsRefresh(rec, { size: 200, modifiedTime: '2026-08-17T00:00:00.000Z' })).toBe(
        true
      );
    });

    it('is true when modifiedTime differs', () => {
      const rec = record({
        source: { provider: 'mega', path: 'x', size: 100, modifiedTime: '2026-08-17T00:00:00.000Z' }
      });
      expect(indexNeedsRefresh(rec, { size: 100, modifiedTime: '2026-08-17T00:05:00.000Z' })).toBe(
        true
      );
    });

    it('treats equal instants in different ISO formats as unchanged (normalized comparison)', () => {
      const rec = record({
        source: {
          provider: 'webdav',
          path: 'x',
          size: 100,
          modifiedTime: '2026-08-17T00:00:00.000Z'
        }
      });
      // Same instant, no milliseconds + explicit UTC offset instead of "Z".
      expect(indexNeedsRefresh(rec, { size: 100, modifiedTime: '2026-08-17T00:00:00+00:00' })).toBe(
        false
      );
    });

    it('is true when cloud modifiedTime is unparseable (fail open to refetch)', () => {
      const rec = record({
        source: { provider: 'mega', path: 'x', size: 100, modifiedTime: '2026-08-17T00:00:00.000Z' }
      });
      expect(indexNeedsRefresh(rec, { size: 100, modifiedTime: 'not-a-date' })).toBe(true);
    });
  });
});

describe('sourceStampChanged', () => {
  const cloud = { size: 10, modifiedTime: '2026-08-17T00:00:00.000Z' };

  it('is true with no cached source at all', () => {
    expect(sourceStampChanged(undefined, cloud, 'webdav')).toBe(true);
  });

  it('is false when provider, size and instant all match', () => {
    expect(
      sourceStampChanged(
        { provider: 'webdav', size: 10, modifiedTime: '2026-08-17T00:00:00.000Z' },
        cloud,
        'webdav'
      )
    ).toBe(false);
  });

  it('is true when the cloud modifiedTime does not parse', () => {
    expect(
      sourceStampChanged(
        { provider: 'webdav', size: 10, modifiedTime: '2026-08-17T00:00:00.000Z' },
        { size: 10, modifiedTime: 'whenever' },
        'webdav'
      )
    ).toBe(true);
  });
});
