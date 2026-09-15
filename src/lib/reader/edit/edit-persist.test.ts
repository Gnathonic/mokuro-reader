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
const noteOcrEdited = vi.hoisted(() => vi.fn());
vi.mock('$lib/util/sync/sidecar-backfill', () => ({ noteOcrEdited }));

import { db } from '$lib/catalog/db';
import {
  ORIGINAL_LAYER_ID,
  hasOriginalLayer,
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
  noteOcrEdited.mockClear();
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_ocr_layers.clear()]);
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
    expect(noteOcrEdited).toHaveBeenCalledWith('v1');
  });

  it('snapshots the PRE-edit pages into the original layer exactly once', async () => {
    expect(await hasOriginalLayer('v1')).toBe(false);
    await persistPageEdit('v1', 0, pg('X'));
    await persistPageEdit('v1', 0, pg('Y'));
    const original = await db.volume_ocr_layers.get(['v1', ORIGINAL_LAYER_ID]);
    expect(original?.kind).toBe('original');
    expect(original?.pages[0].blocks[0].lines).toEqual(['あい']);
    expect(await hasOriginalLayer('v1')).toBe(true);
    expect(await loadOriginalPage('v1', 0)).toEqual(pg('あい'));
    expect(await loadOriginalPage('v1', 5)).toBeNull();
  });

  it('rejects when the volume has no OCR row, writing nothing', async () => {
    await db.volume_ocr.delete('v1');
    await expect(persistPageEdit('v1', 0, pg('X'))).rejects.toThrow(/no OCR row/);
    expect(await db.volume_ocr_layers.count()).toBe(0);
    expect((await db.volumes.get('v1'))?.ocr_edited_at).toBeUndefined();
    expect(noteOcrEdited).not.toHaveBeenCalled();
  });
});
