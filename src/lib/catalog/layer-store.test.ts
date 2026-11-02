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
  deleteRetiredPreviousOcrLayers,
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

  describe('deleteRetiredPreviousOcrLayers (v1.10.0 leftovers)', () => {
    /** A layer the OCR upgrade wrote and nobody touched: `source_at === updated_at`,
     * under the name v1.10.0 gave it. */
    const untouched = {
      kind: 'ocr' as const,
      source_at: 'u',
      updated_at: 'u',
      name: 'Previous OCR'
    };
    /** No volume displays any layer. */
    const noneDisplayed = () => false;

    async function seed(): Promise<void> {
      await putLayerWithPages(db, layer('v1', 'previous-ocr', 'old', untouched));
      await putLayerWithPages(
        db,
        layer('v1', 'previous-ocr-2', 'old2', { ...untouched, name: 'Previous OCR (2)' })
      );
      // Edited after the upgrade wrote it: the user's own layer now.
      await putLayerWithPages(
        db,
        layer('v1', 'previous-ocr-3', 'mine', {
          ...untouched,
          name: 'Previous OCR (3)',
          updated_at: 'u2'
        })
      );
      await putLayerWithPages(db, layer('v2', 'previous-ocr', 'old', untouched));
      // Never a keepsake, whatever its stamps.
      await putLayerWithPages(db, layer('v1', 'updated-ocr', 'cloud', untouched));
      await putLayerWithPages(db, layer('v1', 'previous-ocr-x', 'other', untouched));
      await putLayerWithPages(db, layer('v1', 'my-previous-ocr', 'other', untouched));
      await putLayerWithPages(db, layer('v1', 'original', 'orig', { kind: 'original' }));
      await putLayerWithPages(db, layer('v2', 'fix', 'edit'));
    }

    async function allKeys(table: 'volume_ocr_layers' | 'volume_ocr_layer_pages') {
      return (await db.table(table).toCollection().primaryKeys())
        .map((key) => (key as [string, string]).join('/'))
        .sort();
    }

    const SURVIVORS = [
      'v1/my-previous-ocr',
      'v1/original',
      'v1/previous-ocr-3',
      'v1/previous-ocr-x',
      'v1/updated-ocr',
      'v2/fix'
    ];

    it('deletes untouched previous-ocr and previous-ocr-<n>, both rows; keeps edited ones and every other layer', async () => {
      await seed();
      expect(await deleteRetiredPreviousOcrLayers(db, noneDisplayed)).toBe(3);
      expect(await allKeys('volume_ocr_layers')).toEqual(SURVIVORS);
      expect(await allKeys('volume_ocr_layer_pages')).toEqual(SURVIVORS);
      expect((await getLayerPages(db, 'v1', 'previous-ocr-3'))![0].blocks[0].lines).toEqual([
        'mine'
      ]);
      expect((await getLayerMeta(db, 'v1', 'updated-ocr'))?.updated_at).toBe('u');
    });

    it('chooses from metadata only: the pages table is only ever deleted from', async () => {
      await seed();
      const counts = await countIdbOps(async () => {
        expect(await deleteRetiredPreviousOcrLayers(db, noneDisplayed)).toBe(3);
      });
      expect(opsOn(counts, 'volume_ocr_layer_pages')).toEqual(['volume_ocr_layer_pages.delete']);
      expect(counts['volume_ocr_layer_pages.delete']).toBe(3);
      expect(opsOn(counts, 'volume_ocr_layers').length).toBeGreaterThan(0);
    });

    it('is safe to run twice: the second run deletes nothing and reads keys only', async () => {
      await seed();
      expect(await deleteRetiredPreviousOcrLayers(db, noneDisplayed)).toBe(3);
      const counts = await countIdbOps(async () => {
        expect(await deleteRetiredPreviousOcrLayers(db, noneDisplayed)).toBe(0);
      });
      expect(await allKeys('volume_ocr_layers')).toEqual(SURVIVORS);
      expect(await allKeys('volume_ocr_layer_pages')).toEqual(SURVIVORS);
      expect(opsOn(counts, 'volume_ocr_layer_pages')).toEqual([]);
      // Only the kept, edited `previous-ocr-3` is a candidate by id: its one
      // metadata row is re-checked, nothing else is read, nothing is written.
      expect(counts['volume_ocr_layers.get']).toBe(1);
      expect(counts['volume_ocr_layers.delete'] ?? 0).toBe(0);
    });

    it('does nothing on an empty table', async () => {
      expect(await deleteRetiredPreviousOcrLayers(db, noneDisplayed)).toBe(0);
    });

    it('keeps the keepsake a volume displays and a renamed one: picking or renaming moves no stamp', async () => {
      await putLayerWithPages(db, layer('v1', 'previous-ocr', 'shown', untouched));
      await putLayerWithPages(
        db,
        layer('v2', 'previous-ocr', 'renamed', { ...untouched, name: 'Good OCR' })
      );
      await putLayerWithPages(
        db,
        layer('v3', 'previous-ocr-2', 'old', { ...untouched, name: 'Previous OCR (2)' })
      );
      const isDisplayed = vi.fn(
        (volumeUuid: string, layerId: string) => volumeUuid === 'v1' && layerId === 'previous-ocr'
      );
      expect(await deleteRetiredPreviousOcrLayers(db, isDisplayed)).toBe(1);
      expect(await allKeys('volume_ocr_layers')).toEqual(['v1/previous-ocr', 'v2/previous-ocr']);
      expect(await allKeys('volume_ocr_layer_pages')).toEqual([
        'v1/previous-ocr',
        'v2/previous-ocr'
      ]);
      expect(isDisplayed).toHaveBeenCalledWith('v1', 'previous-ocr');
    });

    it('asks again inside the delete: a layer picked meanwhile is kept', async () => {
      await putLayerWithPages(db, layer('v1', 'previous-ocr', 'old', untouched));
      let asked = 0;
      // Not displayed when the candidates are chosen; picked before the delete.
      const isDisplayed = () => ++asked > 1;
      expect(await deleteRetiredPreviousOcrLayers(db, isDisplayed)).toBe(0);
      expect(asked).toBe(2);
      expect(await allKeys('volume_ocr_layers')).toEqual(['v1/previous-ocr']);
    });
  });
});
