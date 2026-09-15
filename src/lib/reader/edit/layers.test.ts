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
  return { db: new CatalogDexieV3('mokuro_v3_layers_test') };
});
const noteOcrEdited = vi.hoisted(() => vi.fn());
vi.mock('$lib/util/sync/sidecar-backfill', () => ({ noteOcrEdited }));

import { db } from '$lib/catalog/db';
import {
  buildLayerExportFile,
  createLayer,
  deleteLayer,
  listLayers,
  loadLayerPages,
  persistLayerPageEdit,
  promoteLayer,
  renameLayer,
  slugifyLayerId
} from './layers';

function pg(text: string, img_path = 'p.png'): Page {
  return {
    version: '0.2.1',
    img_width: 100,
    img_height: 100,
    img_path,
    blocks: [{ box: [0, 0, 10, 10], vertical: true, font_size: 10, lines: [text] }]
  };
}
const PAGES = [pg('あい'), pg('うえ', 'q.png')];

beforeEach(async () => {
  noteOcrEdited.mockClear();
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_ocr_layers.clear()]);
  await db.volumes.put({
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'S',
    volume_title: 'Vol 1',
    mokuro_version: '0.2.1',
    page_count: 2,
    character_count: 4,
    page_char_counts: [2, 4]
  });
  await db.volume_ocr.put({ volume_uuid: 'v1', pages: PAGES });
});

describe('slugifyLayerId', () => {
  it('slugs, truncates, and de-duplicates; never yields "original"', () => {
    expect(slugifyLayerId('My Translation!', [])).toBe('my-translation');
    expect(slugifyLayerId('Original', [])).toBe('original-2');
    expect(slugifyLayerId('gcv', ['gcv', 'gcv-2'])).toBe('gcv-3');
    expect(slugifyLayerId('', [])).toBe('layer');
    expect(slugifyLayerId('a'.repeat(40), [])).toHaveLength(24);
  });
});

describe('layers store', () => {
  it('creates a copy layer and an empty layer, lists original first, loads pages', async () => {
    await db.volume_ocr_layers.add({
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      pages: PAGES
    });
    const copy = await createLayer('v1', { name: 'Fix ups', pages: PAGES });
    const empty = await createLayer('v1', {
      name: 'English',
      kind: 'translation',
      pages: 'empty',
      sourcePages: PAGES
    });
    expect(copy.layer_id).toBe('fix-ups');
    expect(empty.pages[0].blocks).toEqual([]);
    expect(empty.pages[1].img_path).toBe('q.png');
    const ids = (await listLayers('v1')).map((l) => l.layer_id);
    expect(ids).toEqual(['original', 'fix-ups', 'english']);
    expect((await loadLayerPages('v1', 'fix-ups'))?.[0].blocks[0].lines).toEqual(['あい']);
    expect(await loadLayerPages('v1', 'nope')).toBeNull();
  });

  it('renames and deletes, but never the original', async () => {
    await createLayer('v1', { name: 'A', pages: PAGES });
    await db.volume_ocr_layers.add({
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: 'x',
      updated_at: 'x',
      pages: PAGES
    });
    await renameLayer('v1', 'a', 'B');
    expect((await db.volume_ocr_layers.get(['v1', 'a']))?.name).toBe('B');
    await expect(renameLayer('v1', 'original', 'X')).rejects.toThrow();
    await expect(deleteLayer('v1', 'original')).rejects.toThrow();
    await deleteLayer('v1', 'a');
    expect(await db.volume_ocr_layers.get(['v1', 'a'])).toBeUndefined();
  });

  it('persistLayerPageEdit replaces one page and bumps updated_at; original is read-only', async () => {
    const l = await createLayer('v1', { name: 'A', pages: PAGES });
    await new Promise((r) => setTimeout(r, 2));
    await persistLayerPageEdit('v1', 'a', 1, pg('かきく', 'q.png'));
    const row = await db.volume_ocr_layers.get(['v1', 'a']);
    expect(row?.pages[1].blocks[0].lines).toEqual(['かきく']);
    expect(row?.pages[0].blocks[0].lines).toEqual(['あい']);
    expect(row!.updated_at > l.updated_at).toBe(true);
    expect((await db.volume_ocr.get('v1'))?.pages[1].blocks[0].lines).toEqual(['うえ']);
    await expect(persistLayerPageEdit('v1', 'original', 0, pg('x'))).rejects.toThrow();
    await expect(persistLayerPageEdit('v1', 'missing', 0, pg('x'))).rejects.toThrow();
  });
});

describe('promoteLayer', () => {
  it('copies the layer into primary, recounts, stamps, snapshots the previous primary, nominates', async () => {
    await createLayer('v1', { name: 'A', pages: [pg('かきくけこ'), pg('さ', 'q.png')] });
    const { replacedLayerId } = await promoteLayer('v1', 'a');
    expect((await db.volume_ocr.get('v1'))?.pages[0].blocks[0].lines).toEqual(['かきくけこ']);
    const row = await db.volumes.get('v1');
    expect(row?.page_char_counts).toEqual([5, 6]);
    expect(row?.character_count).toBe(6);
    expect(typeof row?.ocr_edited_at).toBe('string');
    // No original existed: the pre-promote primary became it, and no
    // replaced-… duplicate was made.
    expect((await db.volume_ocr_layers.get(['v1', 'original']))?.pages[0].blocks[0].lines).toEqual([
      'あい'
    ]);
    expect(replacedLayerId).toBeNull();
    expect(noteOcrEdited).toHaveBeenCalledWith('v1');
  });

  it('keeps a replaced-… snapshot when the previous primary differs from the original', async () => {
    await db.volume_ocr_layers.add({
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: 'x',
      updated_at: 'x',
      pages: [pg('ORIG'), pg('ORIG2', 'q.png')]
    });
    await createLayer('v1', { name: 'A', pages: [pg('new'), pg('new2', 'q.png')] });
    const { replacedLayerId } = await promoteLayer('v1', 'a');
    expect(replacedLayerId).toMatch(/^replaced-\d{8}-\d{4}$/);
    expect(
      (await db.volume_ocr_layers.get(['v1', replacedLayerId!]))?.pages[0].blocks[0].lines
    ).toEqual(['あい']);
    expect((await db.volume_ocr_layers.get(['v1', 'original']))?.pages[0].blocks[0].lines).toEqual([
      'ORIG'
    ]);
  });

  it('refuses a missing layer and leaves primary untouched', async () => {
    await expect(promoteLayer('v1', 'nope')).rejects.toThrow();
    expect((await db.volume_ocr.get('v1'))?.pages[0].blocks[0].lines).toEqual(['あい']);
  });
});

describe('buildLayerExportFile', () => {
  it('names the file <title>.layer.<id>.mokuro and writes upstream mokuro JSON with the layer chars', async () => {
    await createLayer('v1', {
      name: 'English',
      kind: 'translation',
      pages: [pg('abc'), pg('あ', 'q.png')]
    });
    const file = await buildLayerExportFile('v1', 'english');
    expect(file.name).toBe('Vol 1.layer.english.mokuro');
    const json = JSON.parse(await file.text());
    expect(json.volume_uuid).toBe('v1');
    expect(json.title).toBe('S');
    expect(json.pages[0].blocks[0].lines).toEqual(['abc']);
    expect(json.chars).toBe(1);
    expect(Object.keys(json).sort()).toEqual([
      'chars',
      'pages',
      'title',
      'title_uuid',
      'version',
      'volume',
      'volume_uuid'
    ]);
  });
});
