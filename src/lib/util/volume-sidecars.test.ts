import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

// The app's real schema under a private database name. Declared from the shared
// definition rather than a hand-written subset: a fixture that quietly holds a
// different table set from production is a test that stops testing production.
vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const { declareMokuroSchema } = await import('$lib/catalog/db-schema');
  const db: any = new Dexie('volume-sidecars-test');
  declareMokuroSchema(db);
  return { db };
});

import { db } from '$lib/catalog/db';
import { buildSeriesFileForExport, loadVolumeSidecars } from './volume-sidecars';
import { createEmptySeriesMetadata, toStoredSeriesMetadata } from '$lib/metadata/types';
import type { VolumeMetadata } from '$lib/types';

const volume: VolumeMetadata = {
  mokuro_version: '0.2.1',
  series_title: 'One Piece',
  series_uuid: 'series-uuid',
  volume_title: 'Vol 1',
  volume_uuid: 'volume-uuid',
  page_count: 1,
  character_count: 5,
  page_char_counts: [5],
  spine_width: 17
};

const otherVolume: VolumeMetadata = {
  ...volume,
  volume_title: 'Vol 2',
  volume_uuid: 'volume-uuid-2'
};

beforeEach(async () => {
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.series_metadata.clear()]);
  await db.volumes.bulkPut([volume, otherVolume]);
  await db.volume_ocr.put({
    volume_uuid: 'volume-uuid',
    pages: [{ version: '0.2.1', img_path: '1.jpg', img_width: 100, img_height: 140, blocks: [] }]
  });
  await db.series_metadata.put(
    toStoredSeriesMetadata({
      ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
      external_ids: { anilist: 30013 },
      facts_updated_at: '2026-08-16T00:00:00.000Z'
    })
  );
});

describe('buildSeriesFileForExport', () => {
  it('carries the series facts and every local volume of the series', async () => {
    const file = await buildSeriesFileForExport('One Piece');

    expect(file?.series_title).toBe('One Piece');
    expect(file?.external_ids).toEqual({ anilist: 30013 });
    expect(file?.volumes.map((v) => v.volume_uuid)).toEqual(['volume-uuid', 'volume-uuid-2']);
  });

  it('is undefined for a series with nothing to say', async () => {
    expect(await buildSeriesFileForExport('Nothing Here')).toBeUndefined();
  });
});

describe('loadVolumeSidecars', () => {
  it('carries the volume sidecars only — never the series file', async () => {
    // Building the series file reads the whole volumes table, so the per-volume
    // export loop must not trigger it once per volume.
    const sidecars = await loadVolumeSidecars('volume-uuid');

    expect(sidecars.mokuroFile?.name).toBe('Vol 1.mokuro');
    expect(Object.keys(sidecars).sort()).toEqual(['mokuroFile', 'thumbnailFile']);
  });
});
