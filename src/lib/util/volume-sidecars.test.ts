import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db: any = new Dexie('volume-sidecars-test');
  db.version(1).stores({
    volumes: 'volume_uuid, series_uuid, series_title',
    volume_ocr: 'volume_uuid',
    volume_files: 'volume_uuid',
    series_metadata: 'series_key',
    series_index: 'series_key'
  });
  return { db };
});

import { db } from '$lib/catalog/db';
import { buildSeriesFileForExport, loadVolumeSidecars } from './volume-sidecars';
import { parseSeriesFile } from '$lib/metadata/series-file';
import { createEmptySeriesMetadata } from '$lib/metadata/types';
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
  await db.series_metadata.put({
    ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
    external_ids: { anilist: 30013 },
    facts_updated_at: '2026-08-16T00:00:00.000Z'
  });
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
  it('offers series.json next to the .mokuro when asked for it', async () => {
    const sidecars = await loadVolumeSidecars('volume-uuid', { seriesFile: true });

    expect(sidecars.mokuroFile?.name).toBe('Vol 1.mokuro');
    expect(sidecars.seriesFile?.name).toBe('series.json');
    expect(sidecars.seriesFile?.type).toBe('application/json');

    const parsed = parseSeriesFile(JSON.parse(await sidecars.seriesFile!.text()));
    expect(parsed?.external_ids).toEqual({ anilist: 30013 });
    expect(parsed?.volumes).toHaveLength(2);
  });

  it('builds no series file unless the caller asks (the per-volume export loop)', async () => {
    const sidecars = await loadVolumeSidecars('volume-uuid');
    expect(sidecars.mokuroFile?.name).toBe('Vol 1.mokuro');
    expect(sidecars.seriesFile).toBeNull();
  });

  it('offers no series.json when the series has no facts and no volumes', async () => {
    await db.volumes.clear();
    await db.series_metadata.clear();
    await db.volumes.put({ ...volume, isPlaceholder: true });

    const sidecars = await loadVolumeSidecars('volume-uuid', { seriesFile: true });
    expect(sidecars.seriesFile).toBeNull();
  });
});
