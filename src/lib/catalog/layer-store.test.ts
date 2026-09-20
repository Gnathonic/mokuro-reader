import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

import { countIdbOps } from './__tests__/idb-op-counter';
import { CatalogDexieV3 } from './db-v3';
import {
  clearAllLayers,
  deleteLayerRows,
  deleteLayersOfVolume,
  getLayerMeta,
  getLayerPages,
  getLayerWithPages,
  layerTables,
  listLayerIds,
  listLayerMetas,
  listLayerMetasForVolumes,
  listLayersWithPages,
  listVolumeUuidsWithLayers,
  putLayerWithPages,
  updateLayerMeta
} from './layer-store';
import type { Page, VolumeOcrLayerWithPages } from '$lib/types';

const db = new CatalogDexieV3('mokuro_v3_layer_store_test');

function pg(text: string): Page {
  return {
    version: '0.2.1',
    img_width: 10,
    img_height: 10,
    img_path: 'p.png',
    blocks: [{ box: [0, 0, 1, 1], vertical: true, font_size: 5, lines: [text] }]
  };
}

function layer(
  volume_uuid: string,
  layer_id: string,
  text = 'あい',
  extra: Partial<VolumeOcrLayerWithPages> = {}
): VolumeOcrLayerWithPages {
  return {
    volume_uuid,
    layer_id,
    name: layer_id,
    kind: 'edit',
    created_at: 'c',
    updated_at: 'u',
    pages: [pg(text)],
    ...extra
  };
}

const opsOn = (counts: Record<string, number>, store: string) =>
  Object.keys(counts).filter((key) => key.startsWith(`${store}.`));

afterEach(() => clearAllLayers(db));

describe('layer-store', () => {
  it('writes a layer as two rows under one key, and never leaves pages on the metadata row', async () => {
    await putLayerWithPages(db, layer('v1', 'fix'));
    expect(await db.volume_ocr_layers.get(['v1', 'fix'])).toEqual({
      volume_uuid: 'v1',
      layer_id: 'fix',
      name: 'fix',
      kind: 'edit',
      created_at: 'c',
      updated_at: 'u'
    });
    expect(await db.volume_ocr_layer_pages.get(['v1', 'fix'])).toEqual({
      volume_uuid: 'v1',
      layer_id: 'fix',
      pages: [pg('あい')]
    });
  });

  it('a rewrite replaces both rows, dropping metadata fields the new layer does not carry', async () => {
    await putLayerWithPages(db, layer('v1', 'fix', 'あい', { passive_at: 'u' }));
    await putLayerWithPages(db, layer('v1', 'fix', 'かき', { updated_at: 'u2' }));
    const back = await getLayerWithPages(db, 'v1', 'fix');
    expect(back?.updated_at).toBe('u2');
    expect('passive_at' in back!).toBe(false);
    expect(back?.pages[0].blocks[0].lines).toEqual(['かき']);
  });

  it('joins the two rows on read; a layer missing either row is not a layer', async () => {
    await putLayerWithPages(db, layer('v1', 'a', 'A'));
    await putLayerWithPages(db, layer('v1', 'b', 'B'));
    await putLayerWithPages(db, layer('v2', 'a', 'other'));
    const joined = await listLayersWithPages(db, 'v1');
    expect(joined.map((l) => [l.layer_id, l.name, l.pages[0].blocks[0].lines[0]]).sort()).toEqual([
      ['a', 'a', 'A'],
      ['b', 'b', 'B']
    ]);
    expect(await getLayerPages(db, 'v1', 'nope')).toBeNull();
    expect(await getLayerWithPages(db, 'v1', 'nope')).toBeUndefined();

    await db.volume_ocr_layer_pages.delete(['v1', 'b']);
    expect(await getLayerWithPages(db, 'v1', 'b')).toBeUndefined();
    expect((await listLayersWithPages(db, 'v1')).map((l) => l.layer_id)).toEqual(['a']);
  });

  it('updateLayerMeta patches the metadata row only', async () => {
    await putLayerWithPages(db, layer('v1', 'fix'));
    expect(await updateLayerMeta(db, 'v1', 'fix', { name: 'Fixed' })).toBe(1);
    expect(await updateLayerMeta(db, 'v1', 'nope', { name: 'x' })).toBe(0);
    expect((await getLayerMeta(db, 'v1', 'fix'))?.name).toBe('Fixed');
    expect(await getLayerPages(db, 'v1', 'fix')).toEqual([pg('あい')]);
  });

  it('deletes always take both rows, and only the ones asked for', async () => {
    await putLayerWithPages(db, layer('v1', 'a'));
    await putLayerWithPages(db, layer('v1', 'b'));
    await putLayerWithPages(db, layer('v2', 'a'));

    await deleteLayerRows(db, 'v1', 'a');
    expect(await db.volume_ocr_layers.get(['v1', 'a'])).toBeUndefined();
    expect(await db.volume_ocr_layer_pages.get(['v1', 'a'])).toBeUndefined();
    expect(await listLayerIds(db, 'v1')).toEqual(['b']);

    await deleteLayersOfVolume(db, 'v1');
    expect(await db.volume_ocr_layers.where('volume_uuid').equals('v1').count()).toBe(0);
    expect(await db.volume_ocr_layer_pages.where('volume_uuid').equals('v1').count()).toBe(0);
    expect(await getLayerPages(db, 'v2', 'a')).toHaveLength(1);

    await clearAllLayers(db);
    expect(await db.volume_ocr_layers.count()).toBe(0);
    expect(await db.volume_ocr_layer_pages.count()).toBe(0);
  });

  it('joins a caller’s transaction, which must list both tables', async () => {
    await db.transaction('rw', [db.volumes, ...layerTables(db)], async () => {
      await putLayerWithPages(db, layer('v1', 'fix'));
      expect((await getLayerWithPages(db, 'v1', 'fix'))?.pages).toHaveLength(1);
    });
    // Metadata table alone: the write is refused rather than half-applied.
    await expect(
      db.transaction('rw', db.volume_ocr_layers, () => putLayerWithPages(db, layer('v1', 'b')))
    ).rejects.toThrow();
    expect(await getLayerMeta(db, 'v1', 'b')).toBeUndefined();
  });

  // The reason the tables are split at all — see the module header.
  it('PERF CONTRACT: no metadata operation ever opens the pages table', async () => {
    await putLayerWithPages(db, layer('v1', 'a'));
    await putLayerWithPages(db, layer('v1', 'b'));
    await putLayerWithPages(db, layer('v2', 'a'));

    const counts = await countIdbOps(async () => {
      expect((await getLayerMeta(db, 'v1', 'a'))?.name).toBe('a');
      expect(await listLayerMetas(db, 'v1')).toHaveLength(2);
      expect(await listLayerMetasForVolumes(db, ['v1', 'v2', 'v3'])).toHaveLength(3);
      expect(await listLayerMetasForVolumes(db, [])).toEqual([]);
      expect(await listLayerIds(db, 'v1')).toEqual(['a', 'b']);
      expect([...(await listVolumeUuidsWithLayers(db))].sort()).toEqual(['v1', 'v2']);
      await updateLayerMeta(db, 'v1', 'a', {
        cloud: { provider: 'webdav', size: 1, synced_at: 's' }
      });
    });

    expect(opsOn(counts, 'volume_ocr_layer_pages')).toEqual([]);
    // Anchor: the counter was watching, and the metadata table was used.
    expect(opsOn(counts, 'volume_ocr_layers').length).toBeGreaterThan(0);
    const withPages = await countIdbOps(async () => {
      await getLayerPages(db, 'v1', 'a');
    });
    expect(opsOn(withPages, 'volume_ocr_layer_pages')).toEqual(['volume_ocr_layer_pages.get']);
  });
});
