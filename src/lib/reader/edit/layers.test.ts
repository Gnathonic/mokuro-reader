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
import { clearAllLayers, getLayerWithPages, putLayerWithPages } from '$lib/catalog/layer-store';
import {
  buildLayerExportFile,
  createLayer,
  deleteLayer,
  listLayers,
  loadLayerPages,
  persistLayerPageEdit,
  promoteLayer,
  renameLayer,
  slugifyLayerId,
  layerKindForId,
  servedEngineOf,
  layerNameForId
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
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), clearAllLayers(db)]);
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
    await putLayerWithPages(db, {
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
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: 'x',
      updated_at: 'x',
      pages: PAGES
    });
    await renameLayer('v1', 'a', 'B');
    expect((await getLayerWithPages(db, 'v1', 'a'))?.name).toBe('B');
    await expect(renameLayer('v1', 'original', 'X')).rejects.toThrow();
    await expect(deleteLayer('v1', 'original')).rejects.toThrow();
    await deleteLayer('v1', 'a');
    expect(await db.volume_ocr_layers.get(['v1', 'a'])).toBeUndefined();
    expect(await db.volume_ocr_layer_pages.get(['v1', 'a'])).toBeUndefined();
  });

  it('persistLayerPageEdit replaces one page and bumps updated_at; original is read-only', async () => {
    const l = await createLayer('v1', { name: 'A', pages: PAGES });
    await new Promise((r) => setTimeout(r, 2));
    await persistLayerPageEdit('v1', 'a', 1, pg('かきく', 'q.png'));
    const row = await getLayerWithPages(db, 'v1', 'a');
    expect(row?.pages[1].blocks[0].lines).toEqual(['かきく']);
    expect(row?.pages[0].blocks[0].lines).toEqual(['あい']);
    expect(row!.updated_at > l.updated_at).toBe(true);
    expect((await db.volume_ocr.get('v1'))?.pages[1].blocks[0].lines).toEqual(['うえ']);
    await expect(persistLayerPageEdit('v1', 'original', 0, pg('x'))).rejects.toThrow();
    await expect(persistLayerPageEdit('v1', 'missing', 0, pg('x'))).rejects.toThrow();
  });
});

describe('promoteLayer', () => {
  // `mokuro_sha256` is the primary's BASE revision (the OCR upgrade).
  it("promoting the upgrade's updated-ocr layer adopts the cloud file it mirrors as the base", async () => {
    await db.volumes.update('v1', {
      mokuro_sha256: 'f'.repeat(64),
      mokuro_sha256_cloud: { provider: 'webdav', size: 9 }
    });
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'updated-ocr',
      name: 'Updated OCR',
      kind: 'ocr',
      created_at: 't',
      updated_at: 't',
      source_sha256: 'a'.repeat(64),
      source_at: 't',
      pages: [pg('しん'), pg('き', 'q.png')]
    });
    await promoteLayer('v1', 'updated-ocr');
    const row = (await db.volumes.get('v1'))!;
    expect(row.mokuro_sha256).toBe('a'.repeat(64));
    // Where the cloud stores that file is not known here: nothing vouches for it.
    expect(row.mokuro_sha256_cloud).toBeUndefined();
  });

  it('promoting any other layer is a local change on top of the same base: the hash stays', async () => {
    await db.volumes.update('v1', { mokuro_sha256: 'f'.repeat(64) });
    await createLayer('v1', { name: 'A', pages: [pg('かき'), pg('さ', 'q.png')] });
    await promoteLayer('v1', 'a');
    expect((await db.volumes.get('v1'))!.mokuro_sha256).toBe('f'.repeat(64));
  });

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
    expect((await getLayerWithPages(db, 'v1', 'original'))?.pages[0].blocks[0].lines).toEqual([
      'あい'
    ]);
    expect(replacedLayerId).toBeNull();
    expect(noteOcrEdited).toHaveBeenCalledWith('v1');
  });

  it('keeps a replaced-… snapshot when the previous primary differs from the original', async () => {
    await putLayerWithPages(db, {
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
    expect((await getLayerWithPages(db, 'v1', replacedLayerId!))?.pages[0].blocks[0].lines).toEqual(
      ['あい']
    );
    expect((await getLayerWithPages(db, 'v1', 'original'))?.pages[0].blocks[0].lines).toEqual([
      'ORIG'
    ]);
  });

  // The primary row is what every stat is counted from, and the count only
  // knows Japanese (`countCharsInLines`): an English layer recounts to ~0,
  // which would flow into the catalog, reading speed, the `.mokuro` sidecar
  // and `series.json`.
  it('refuses a translation layer — by kind, or by its tr-<lang> id alone — and changes nothing', async () => {
    await createLayer('v1', {
      name: 'English',
      kind: 'translation',
      pages: [pg('Hello there'), pg('General', 'q.png')]
    });
    // A row whose kind says "edit" but whose id files it as a translation
    // everywhere a kind is inferred (cloud pull, import).
    await createLayer('v1', { name: 'tr en', pages: [pg('Hi'), pg('Yo', 'q.png')] });
    expect((await getLayerWithPages(db, 'v1', 'tr-en'))?.kind).toBe('edit');

    for (const id of ['english', 'tr-en']) {
      await expect(promoteLayer('v1', id)).rejects.toThrow(/translation/i);
    }
    expect((await db.volume_ocr.get('v1'))?.pages[0].blocks[0].lines).toEqual(['あい']);
    const row = await db.volumes.get('v1');
    expect(row?.character_count).toBe(4);
    expect(row?.page_char_counts).toEqual([2, 4]);
    expect(row?.ocr_edited_at).toBeUndefined();
    expect(await getLayerWithPages(db, 'v1', 'original')).toBeUndefined();
    expect(noteOcrEdited).not.toHaveBeenCalled();
  });

  it('refuses a missing layer and leaves primary untouched', async () => {
    await expect(promoteLayer('v1', 'nope')).rejects.toThrow();
    expect((await db.volume_ocr.get('v1'))?.pages[0].blocks[0].lines).toEqual(['あい']);
  });
});

describe('buildLayerExportFile', () => {
  it('names the file <title>.<id>.mokuro and writes upstream mokuro JSON with the layer chars', async () => {
    await createLayer('v1', {
      name: 'English',
      kind: 'translation',
      pages: [pg('abc'), pg('あ', 'q.png')]
    });
    const file = await buildLayerExportFile('v1', 'english');
    expect(file.name).toBe('Vol 1.english.mokuro');
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

describe('upsertLayerPages', () => {
  const opts = (pages: Map<number, Page>) => ({
    name: 'Cloud Vision',
    kind: 'ocr' as const,
    engine: 'gcv',
    sourcePages: PAGES,
    pages
  });

  it('creates the layer with empty pages on first use, then overwrites only the pages given', async () => {
    const { upsertLayerPages } = await import('./layers');
    const ran = pg('OCR結果');
    const layer = (await upsertLayerPages('v1', 'gcv', opts(new Map([[1, ran]]))))!;
    expect(layer.layer_id).toBe('gcv');
    expect(layer.pages[0].blocks).toEqual([]);
    expect(layer.pages[0].img_path).toBe('p.png');
    expect(layer.pages[1].blocks[0].lines).toEqual(['OCR結果']);

    const again = (await upsertLayerPages('v1', 'gcv', opts(new Map([[0, pg('二回目')]]))))!;
    expect(again.pages[0].blocks[0].lines).toEqual(['二回目']);
    expect(again.pages[1].blocks[0].lines).toEqual(['OCR結果']);
    expect(again.updated_at >= layer.updated_at).toBe(true);
  });

  it('refuses the original layer', async () => {
    const { upsertLayerPages } = await import('./layers');
    await expect(upsertLayerPages('v1', 'original', opts(new Map()))).rejects.toThrow(/read-only/);
  });

  it('writes nothing for a volume that was deleted — a late flush must not resurrect its layer', async () => {
    const { upsertLayerPages } = await import('./layers');
    const { deleteVolumeCompletely } = await import('$lib/import/database');
    // The run created the layer, then the user deleted the volume mid-run.
    await upsertLayerPages('v1', 'gcv', opts(new Map([[0, pg('一')]])));
    await deleteVolumeCompletely('v1');
    expect(await db.volume_ocr_layers.where('volume_uuid').equals('v1').count()).toBe(0);
    expect(await db.volume_ocr_layer_pages.where('volume_uuid').equals('v1').count()).toBe(0);

    expect(await upsertLayerPages('v1', 'gcv', opts(new Map([[1, pg('二')]])))).toBeNull();
    expect(await db.volume_ocr_layers.where('volume_uuid').equals('v1').count()).toBe(0);
    expect(await db.volume_ocr_layer_pages.where('volume_uuid').equals('v1').count()).toBe(0);
  });

  it('writes nothing once the volume was removed from this device, and leaves the kept layer alone', async () => {
    const { upsertLayerPages } = await import('./layers');
    const { removeVolumeFiles } = await import('$lib/import/database');
    const before = (await upsertLayerPages('v1', 'gcv', opts(new Map([[0, pg('一')]]))))!;
    await removeVolumeFiles('v1');

    expect(await upsertLayerPages('v1', 'gcv', opts(new Map([[1, pg('二')]])))).toBeNull();
    expect(await getLayerWithPages(db, 'v1', 'gcv')).toEqual(before);
  });
  describe('with the run-start `baseline` (a hand edit made mid-run is never overwritten)', () => {
    it('keeps a page that was edited after the run started; still writes the others', async () => {
      const { upsertLayerPages } = await import('./layers');
      // An earlier run's output is what the new run starts from.
      await upsertLayerPages(
        'v1',
        'gcv',
        opts(
          new Map([
            [0, pg('旧0')],
            [1, pg('旧1', 'q.png')]
          ])
        )
      );
      const baseline = await loadLayerPages('v1', 'gcv');
      await persistLayerPageEdit('v1', 'gcv', 1, pg('手直し', 'q.png'));

      const layer = (await upsertLayerPages('v1', 'gcv', {
        ...opts(
          new Map([
            [0, pg('新0')],
            [1, pg('新1', 'q.png')]
          ])
        ),
        baseline
      }))!;
      expect(layer.pages[0].blocks[0].lines).toEqual(['新0']);
      expect(layer.pages[1].blocks[0].lines).toEqual(['手直し']);
      const stored = await loadLayerPages('v1', 'gcv');
      expect(stored![1].blocks[0].lines).toEqual(['手直し']);
    });

    it('re-runs over a page nobody touched since the run started', async () => {
      const { upsertLayerPages } = await import('./layers');
      await upsertLayerPages('v1', 'gcv', opts(new Map([[0, pg('旧0')]])));
      const baseline = await loadLayerPages('v1', 'gcv');
      const layer = (await upsertLayerPages('v1', 'gcv', {
        ...opts(new Map([[0, pg('新0')]])),
        baseline
      }))!;
      expect(layer.pages[0].blocks[0].lines).toEqual(['新0']);
    });

    it('a layer the run itself created: a page typed into before the run reached it is kept', async () => {
      const { upsertLayerPages } = await import('./layers');
      // No layer at run start → baseline null; the first flush creates it.
      await upsertLayerPages('v1', 'gcv', { ...opts(new Map([[0, pg('新0')]])), baseline: null });
      await persistLayerPageEdit('v1', 'gcv', 1, pg('手書き', 'q.png'));
      const layer = (await upsertLayerPages('v1', 'gcv', {
        ...opts(new Map([[1, pg('新1', 'q.png')]])),
        baseline: null
      }))!;
      expect(layer.pages[0].blocks[0].lines).toEqual(['新0']);
      expect(layer.pages[1].blocks[0].lines).toEqual(['手書き']);
    });
  });
});

describe('layerKindForId / layerNameForId', () => {
  it('files a pulled layer by its id alone', () => {
    expect(layerKindForId('original')).toBe('original');
    expect(layerKindForId('tr-en')).toBe('translation');
    expect(layerKindForId('paddle-manga')).toBe('ocr');
    expect(layerKindForId('gcv')).toBe('ocr');
    expect(layerKindForId('fix')).toBe('edit');
    expect(layerNameForId('paddle-manga')).toBe('Paddle Manga');
    expect(layerNameForId('gcv')).toBe('Gcv');
  });

  it('files a layer a server stamped as OCR, whatever its admin named it', () => {
    // No closed list can know `my-best-ocr`; the file's own stamp does.
    expect(layerKindForId('my-best-ocr')).toBe('edit');
    expect(layerKindForId('my-best-ocr', 'hayai-nova')).toBe('ocr');
    expect(layerKindForId('hayai-nova')).toBe('ocr');
    // The reserved ids keep their meaning even if a file claims an engine.
    expect(layerKindForId('original', 'hayai-nova')).toBe('original');
    expect(layerKindForId('tr-en', 'hayai-nova')).toBe('translation');
  });

  it('reads the engine stamp bunko writes, and nothing that merely looks like one', () => {
    expect(servedEngineOf({ pages: [], ocr_engine: { id: 'paddle-manga', detector: 'ctd' } })).toBe(
      'paddle-manga'
    );
    for (const junk of [
      null,
      'text',
      {},
      { ocr_engine: null },
      { ocr_engine: 'hayai-nova' },
      { ocr_engine: {} },
      { ocr_engine: { id: 7 } },
      { ocr_engine: { id: '' } },
      { ocr_engine: { id: 'Has Spaces' } },
      { ocr_engine: { id: '../etc' } }
    ]) {
      expect(servedEngineOf(junk)).toBeUndefined();
    }
  });

  it('knows bunko’s PP-OCR manga engine: OCR output, named as the engine spells itself', () => {
    expect(layerKindForId('ppocr-manga')).toBe('ocr');
    // Title-casing the slug would read "Ppocr Manga".
    expect(layerNameForId('ppocr-manga')).toBe('PP-OCR Manga');
  });
});
