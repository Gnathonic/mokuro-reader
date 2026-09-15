import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_layers_schema_test') };
});

import { db } from '$lib/catalog/db';
import { deleteVolumeCompletely, removeVolumeFiles } from '$lib/import/database';
import { MOKURO_DB_SCHEMA } from '$lib/catalog/db-schema';

afterEach(async () => {
  await Promise.all([
    db.volumes.clear(),
    db.volume_ocr.clear(),
    db.volume_files.clear(),
    db.volume_ocr_layers.clear()
  ]);
});

function row() {
  return {
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'Series',
    volume_title: 'Vol 1',
    mokuro_version: '0.2.1',
    page_count: 1,
    character_count: 3,
    page_char_counts: [3]
  };
}

describe('volume_ocr_layers schema', () => {
  it('declares version 3 with the layers table and the ocr_edited_at index', () => {
    const v3 = MOKURO_DB_SCHEMA.find((v) => v.version === 3);
    expect(v3?.stores.volume_ocr_layers).toBe('[volume_uuid+layer_id], volume_uuid');
    expect(v3?.stores.volumes).toBe('volume_uuid, series_uuid, series_title, ocr_edited_at');
  });

  it('round-trips a layer row keyed by volume + layer id', async () => {
    await db.volume_ocr_layers.put({
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: '2026-09-15T00:00:00.000Z',
      updated_at: '2026-09-15T00:00:00.000Z',
      pages: [{ version: '0.2.1', img_width: 10, img_height: 10, img_path: 'p.png', blocks: [] }]
    });
    const back = await db.volume_ocr_layers.get(['v1', 'original']);
    expect(back?.pages[0].img_path).toBe('p.png');
    expect(await db.volume_ocr_layers.where('volume_uuid').equals('v1').count()).toBe(1);
  });

  it('indexes only rows that carry ocr_edited_at', async () => {
    await db.volumes.put(row());
    await db.volumes.put({ ...row(), volume_uuid: 'v2', ocr_edited_at: '2026-09-15T00:00:00Z' });
    const keys = await db.volumes.where('ocr_edited_at').above('').primaryKeys();
    expect(keys).toEqual(['v2']);
  });

  it('deleteVolumeCompletely removes layer rows; removeVolumeFiles keeps them', async () => {
    const layer = {
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original' as const,
      created_at: 'x',
      updated_at: 'x',
      pages: []
    };
    await db.volumes.put(row());
    await db.volume_ocr.put({ volume_uuid: 'v1', pages: [] });
    await db.volume_files.put({ volume_uuid: 'v1', files: {} });
    await db.volume_ocr_layers.put(layer);

    await removeVolumeFiles('v1');
    expect(await db.volume_ocr_layers.get(['v1', 'original'])).toBeDefined();
    expect((await db.volumes.get('v1'))?.metadata_only).toBe(true);

    await deleteVolumeCompletely('v1');
    expect(await db.volume_ocr_layers.get(['v1', 'original'])).toBeUndefined();
    expect(await db.volumes.get('v1')).toBeUndefined();
  });
});
