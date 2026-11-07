import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Page } from '$lib/types';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_edit_persist_test') };
});
const scheduleLayerPush = vi.hoisted(() => vi.fn());
vi.mock('$lib/metadata/layer-sync', () => ({ scheduleLayerPush }));

import { countIdbOps } from '$lib/catalog/__tests__/idb-op-counter';
import { db } from '$lib/catalog/db';
import { clearAllLayers, getLayerWithPages } from '$lib/catalog/layer-store';
import {
  EDIT_LAYER_ID,
  ORIGINAL_LAYER_ID,
  hasOriginalLayer,
  mainSidecarPagesForCloud,
  loadOriginalPage,
  persistPageEdit
} from './edit-persist';

function pg(text: string, img_path = 'p.png'): Page {
  return {
    version: '0.2.1',
    img_width: 100,
    img_height: 100,
    img_path,
    blocks: [{ box: [0, 0, 10, 10], vertical: true, font_size: 10, lines: [text] }]
  };
}

beforeEach(async () => {
  scheduleLayerPush.mockClear();
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), clearAllLayers(db)]);
  await db.volumes.put({
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'S',
    volume_title: 'V',
    mokuro_version: '0.2.1',
    page_count: 2,
    character_count: 4,
    page_char_counts: [2, 4]
  });
  await db.volume_ocr.put({ volume_uuid: 'v1', pages: [pg('あい'), pg('うえ', 'q.png')] });
});

describe('persistPageEdit', () => {
  it('writes the page, recounts chars, stamps ocr_edited_at, and nominates the volume', async () => {
    await persistPageEdit('v1', 1, pg('かきくけこ', 'q.png'));
    const ocr = await db.volume_ocr.get('v1');
    expect(ocr?.pages[1].blocks[0].lines).toEqual(['かきくけこ']);
    expect(ocr?.pages[0].blocks[0].lines).toEqual(['あい']);
    const row = await db.volumes.get('v1');
    expect(row?.page_char_counts).toEqual([2, 7]);
    expect(row?.character_count).toBe(7);
    expect(typeof row?.ocr_edited_at).toBe('string');
    await vi.waitFor(() => expect(scheduleLayerPush).toHaveBeenCalled());
  });

  it('saves the correction into the edit layer, created from the pre-edit primary', async () => {
    await persistPageEdit('v1', 1, pg('かきくけこ', 'q.png'));
    const edit = await getLayerWithPages(db, 'v1', EDIT_LAYER_ID);
    expect(edit).toMatchObject({ layer_id: 'edit', kind: 'edit', name: 'Your corrections' });
    expect(edit?.pages.map((p) => p.blocks[0].lines[0])).toEqual(['あい', 'かきくけこ']);
    expect(edit?.cloud).toBeUndefined();
  });

  it('later saves change only their page of the edit layer (a page edited in the layer stays)', async () => {
    await persistPageEdit('v1', 0, pg('X'));
    // The user edits page 2 in the layer itself.
    const edit = await getLayerWithPages(db, 'v1', EDIT_LAYER_ID);
    await db.volume_ocr_layer_pages.put({
      volume_uuid: 'v1',
      layer_id: EDIT_LAYER_ID,
      pages: [edit!.pages[0], pg('layer-only', 'q.png')]
    });
    await db.volume_ocr_layers.update(['v1', EDIT_LAYER_ID], {
      cloud: { provider: 'webdav', size: 1, synced_at: '2026-01-01T00:00:00.000Z' }
    });
    await persistPageEdit('v1', 0, pg('Y'));
    const after = await getLayerWithPages(db, 'v1', EDIT_LAYER_ID);
    expect(after?.pages.map((p) => p.blocks[0].lines[0])).toEqual(['Y', 'layer-only']);
    // Its sync record is kept, so layer-sync sees an edit since that sync.
    expect(after?.cloud?.provider).toBe('webdav');
    expect(after!.updated_at > after!.cloud!.synced_at).toBe(true);
  });

  it('the main sidecar a cloud upload builds is the original, never the edited primary', async () => {
    const primary = (await db.volume_ocr.get('v1'))!.pages;
    expect(await mainSidecarPagesForCloud({ volume_uuid: 'v1' }, primary)).toBe(primary);
    await persistPageEdit('v1', 0, pg('X'));
    const row = await db.volumes.get('v1');
    const edited = (await db.volume_ocr.get('v1'))!.pages;
    const main = await mainSidecarPagesForCloud(row!, edited);
    expect(main?.[0].blocks[0].lines).toEqual(['あい']);
    // Edited with no snapshot to build from: no main sidecar at all.
    await clearAllLayers(db);
    expect(await mainSidecarPagesForCloud(row!, edited)).toBeNull();
  });

  it('snapshots the PRE-edit pages into the original layer exactly once', async () => {
    expect(await hasOriginalLayer('v1')).toBe(false);
    await persistPageEdit('v1', 0, pg('X'));
    await persistPageEdit('v1', 0, pg('Y'));
    const original = await getLayerWithPages(db, 'v1', ORIGINAL_LAYER_ID);
    expect(original?.kind).toBe('original');
    expect(original?.pages[0].blocks[0].lines).toEqual(['あい']);
    expect(await hasOriginalLayer('v1')).toBe(true);
    expect(await loadOriginalPage('v1', 0)).toEqual(pg('あい'));
    expect(await loadOriginalPage('v1', 5)).toBeNull();
  });

  // Every autosave asks "is there an original yet?". That snapshot is a whole
  // volume of OCR, so the question must be answered from its metadata row.
  it('a save after the first never reads or rewrites the original’s pages', async () => {
    await persistPageEdit('v1', 0, pg('X'));
    const counts = await countIdbOps(async () => {
      await persistPageEdit('v1', 0, pg('Y'));
      expect(await hasOriginalLayer('v1')).toBe(true);
    });
    // Only the edit layer's pages row is read and rewritten (one get, one put).
    expect(counts['volume_ocr_layer_pages.get']).toBe(1);
    expect(counts['volume_ocr_layer_pages.put']).toBe(1);
    expect(counts['volume_ocr_layers.get']).toBe(3);
    const original = await getLayerWithPages(db, 'v1', ORIGINAL_LAYER_ID);
    expect(original?.pages[0].blocks[0].lines).toEqual(['あい']);
  });

  it('rejects when the volume has no OCR row, writing nothing', async () => {
    await db.volume_ocr.delete('v1');
    await expect(persistPageEdit('v1', 0, pg('X'))).rejects.toThrow(/no OCR row/);
    expect(await db.volume_ocr_layers.count()).toBe(0);
    expect(await db.volume_ocr_layer_pages.count()).toBe(0);
    expect((await db.volumes.get('v1'))?.ocr_edited_at).toBeUndefined();
    expect(scheduleLayerPush).not.toHaveBeenCalled();
  });
});
