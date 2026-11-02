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
const scheduleLayerPush = vi.hoisted(() => vi.fn());
vi.mock('$lib/metadata/layer-sync', () => ({ scheduleLayerPush }));

import { db } from '$lib/catalog/db';
import { clearAllLayers, getLayerWithPages, putLayerWithPages } from '$lib/catalog/layer-store';
import {
  buildLayerExportFile,
  copyIntoEditLayer,
  createLayer,
  forkIntoEditLayer,
  deleteLayer,
  listLayers,
  loadLayerPages,
  persistLayerPageEdit,
  promoteLayer,
  renameLayer,
  slugifyLayerId,
  upsertLayerPages,
  layerKindForId,
  servedEngineOf,
  layerNameForId
} from './layers';
import { isReservedLayerId } from './layer-names';

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
  scheduleLayerPush.mockClear();
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
    expect(slugifyLayerId('Original', [])).toBe('layer-original');
    expect(slugifyLayerId('Fixes', ['fixes', 'fixes-2'])).toBe('fixes-3');
    expect(slugifyLayerId('', [])).toBe('layer');
    expect(slugifyLayerId('a'.repeat(40), [])).toHaveLength(24);
  });

  it('a new id always carries a letter (rule v1 #8), so it never reads as a bare number', () => {
    expect(slugifyLayerId('2024', [])).toBe('layer-2024');
    expect(slugifyLayerId('2024', ['layer-2024'])).toBe('layer-2024-2');
    expect(slugifyLayerId('1.5', [])).toBe('layer-1-5');
    expect(slugifyLayerId('9'.repeat(40), [])).toHaveLength(24);
    expect(slugifyLayerId('9'.repeat(40), [])).toMatch(/^layer-9+$/);
    expect(slugifyLayerId('New layer', [])).toBe('new-layer');
    expect(slugifyLayerId('Vol 2', [])).toBe('vol-2');
  });

  it('steps out of every reserved id and family with a layer- prefix', () => {
    expect(slugifyLayerId('Edit', [])).toBe('layer-edit');
    expect(slugifyLayerId('Curated', [])).toBe('layer-curated');
    expect(slugifyLayerId('Updated OCR', [])).toBe('layer-updated-ocr');
    expect(slugifyLayerId('gcv', [])).toBe('layer-gcv');
    expect(slugifyLayerId('Edit 2', [])).toBe('layer-edit-2');
    expect(slugifyLayerId('curated 7', [])).toBe('layer-curated-7');
    expect(slugifyLayerId('TR en', [])).toBe('layer-tr-en');
    // Then de-duplicated like any other id.
    expect(slugifyLayerId('Edit', ['layer-edit'])).toBe('layer-edit-2');
    // `tr` is free, but its first de-duplicated form `tr-2` is a translation id.
    expect(slugifyLayerId('tr', ['tr'])).toBe('layer-tr');
    expect(slugifyLayerId('tr', ['tr', 'layer-tr'])).toBe('layer-tr-2');
    // Not reserved: kept as they are.
    expect(slugifyLayerId('Editorial', [])).toBe('editorial');
    expect(slugifyLayerId('Edit X', [])).toBe('edit-x');
    // Ordinary hand-made ids now: bunko no longer writes or reserves them.
    expect(slugifyLayerId('Pre upgrade', [])).toBe('pre-upgrade');
    expect(slugifyLayerId('Previous OCR', [])).toBe('previous-ocr');
  });

  it('never returns a reserved id, whatever the name', () => {
    const names = ['Edit', 'edit-2', 'Curated', 'curated 2', 'original', 'GCV', 'updated ocr'];
    names.push('pre-upgrade 9', 'previous ocr 2', 'tr', 'tr ja', '2024', '', '---', 'Ｅｄｉｔ');
    for (const name of names) {
      const taken: string[] = [];
      for (let i = 0; i < 4; i++) {
        const id = slugifyLayerId(name, taken);
        expect(isReservedLayerId(id), `${name} -> ${id}`).toBe(false);
        expect(taken).not.toContain(id);
        taken.push(id);
      }
    }
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
    // A local view choice (D4): nothing is scheduled for upload, and the
    // promoted layer is no edit layer either.
    await new Promise((r) => setTimeout(r, 0));
    expect(scheduleLayerPush).not.toHaveBeenCalled();
    expect(await getLayerWithPages(db, 'v1', 'edit')).toBeUndefined();
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
    // everywhere a kind is inferred (cloud pull, import). `createLayer` no
    // longer mints a `tr-` id (reserved), so an older row is seeded directly.
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'tr-en',
      name: 'tr en',
      kind: 'edit',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
      pages: [pg('Hi'), pg('Yo', 'q.png')]
    });
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
    expect(scheduleLayerPush).not.toHaveBeenCalled();
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

describe('the editor’s edit layer (D4)', () => {
  it('an edit-kind layer file carries the edited block (base = the main sidecar hash), no ocr_engine', async () => {
    const sha = 'ab'.repeat(32);
    await db.volumes.update('v1', { mokuro_sha256: sha });
    const layer = await createLayer('v1', { name: 'Fixes', pages: [pg('直'), pg('す', 'q.png')] });
    const json = JSON.parse(await (await buildLayerExportFile('v1', layer.layer_id)).text());
    // The export path names no base seal (bunko reads base_sha256 then).
    expect(json.edited).toEqual({
      by: 'mokuro-reader',
      at: layer.updated_at,
      base_sha256: sha,
      base_seal: null
    });
    expect(json.ocr_engine).toBeUndefined();
  });

  it('base_sha256 is null when this device does not know the main sidecar’s hash', async () => {
    const layer = await createLayer('v1', { name: 'Fixes', pages: PAGES });
    const json = JSON.parse(await (await buildLayerExportFile('v1', layer.layer_id)).text());
    expect(json.edited.base_sha256).toBeNull();
  });

  it('a new layer never takes the reserved edit id', () => {
    expect(slugifyLayerId('Edit', [])).toBe('layer-edit');
    expect(slugifyLayerId('original', [])).toBe('layer-original');
  });

  it('names the edit layer; a pre-upgrade layer is named like any other id', () => {
    expect(layerNameForId('edit')).toBe('Your corrections');
    expect(layerNameForId('pre-upgrade')).toBe('Pre Upgrade');
    expect(layerNameForId('pre-upgrade-2')).toBe('Pre Upgrade 2');
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

  it('files the shared, personal and keepsake layers as corrections, stamp or not', () => {
    // A stamp on these never makes them a server's OCR: curated is published
    // corrections, edit-<n> a person's, curated-<n> a case merge's copy of a
    // second curated. Their role is read from the id.
    for (const id of ['curated', 'edit', 'edit-2', 'curated-2']) {
      expect(layerKindForId(id)).toBe('edit');
      expect(layerKindForId(id, 'hayai-nova')).toBe('edit');
    }
  });

  it('files pre-upgrade / previous-ocr like any other hand-made id: by the stamp it carries', () => {
    for (const id of ['pre-upgrade', 'pre-upgrade-2', 'previous-ocr', 'previous-ocr-2']) {
      expect(layerKindForId(id)).toBe('edit');
      expect(layerKindForId(id, 'hayai-nova')).toBe('ocr');
    }
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

describe('shared layers are read-only: an edit forks into `edit`', () => {
  async function seedCurated(pages = [pg('共有'), pg('ページ', 'q.png')]) {
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'curated',
      name: 'Shared corrections',
      kind: 'edit',
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
      cloud: { provider: 'webdav', size: 10, synced_at: '2026-10-01T00:00:00.000Z' },
      pages
    });
  }

  it('persistLayerPageEdit and upsertLayerPages refuse the curated layer and change nothing', async () => {
    await seedCurated();
    await expect(persistLayerPageEdit('v1', 'curated', 0, pg('x'))).rejects.toThrow(/read-only/);
    await expect(
      upsertLayerPages('v1', 'curated', {
        name: 'x',
        kind: 'ocr',
        engine: 'x',
        sourcePages: PAGES,
        pages: new Map([[0, pg('x')]])
      })
    ).rejects.toThrow(/read-only/);
    expect((await getLayerWithPages(db, 'v1', 'curated'))?.pages[0].blocks[0].lines).toEqual([
      '共有'
    ]);
    // The display name is local: renaming stays allowed.
    await renameLayer('v1', 'curated', 'Team fixes');
    expect((await getLayerWithPages(db, 'v1', 'curated'))?.name).toBe('Team fixes');
  });

  it('forkIntoEditLayer creates `edit` from the source pages once, never stamped as synced', async () => {
    await seedCurated();
    expect(await forkIntoEditLayer('v1', 'curated')).toEqual({ created: true });
    const edit = await getLayerWithPages(db, 'v1', 'edit');
    expect(edit).toMatchObject({ kind: 'edit', name: 'Your corrections' });
    expect(edit?.cloud).toBeUndefined();
    expect(edit?.pages.map((p) => p.blocks[0].lines[0])).toEqual(['共有', 'ページ']);

    // An existing edit layer is never overwritten by a fork.
    await persistLayerPageEdit('v1', 'edit', 0, pg('私の'));
    expect(await forkIntoEditLayer('v1', 'curated')).toEqual({ created: false });
    expect((await getLayerWithPages(db, 'v1', 'edit'))?.pages[0].blocks[0].lines).toEqual(['私の']);
    // The source is untouched either way.
    expect((await getLayerWithPages(db, 'v1', 'curated'))?.pages[0].blocks[0].lines).toEqual([
      '共有'
    ]);
  });

  it('forkIntoEditLayer refuses a missing source and writes nothing', async () => {
    await expect(forkIntoEditLayer('v1', 'curated')).rejects.toThrow(/not found/);
    expect(await getLayerWithPages(db, 'v1', 'edit')).toBeUndefined();
  });

  it('copyIntoEditLayer replaces the pages of an existing edit layer and keeps its identity', async () => {
    await seedCurated();
    await forkIntoEditLayer('v1', 'curated');
    await persistLayerPageEdit('v1', 'edit', 0, pg('私の'));
    await renameLayer('v1', 'edit', 'Mine');
    const before = await getLayerWithPages(db, 'v1', 'edit');

    await copyIntoEditLayer('v1', 'curated');
    const after = await getLayerWithPages(db, 'v1', 'edit');
    expect(after?.pages[0].blocks[0].lines).toEqual(['共有']);
    expect(after?.name).toBe('Mine');
    expect(after?.created_at).toBe(before?.created_at);
    expect(after!.updated_at >= before!.updated_at).toBe(true);
  });

  it('copyIntoEditLayer makes the edit layer when there is none', async () => {
    await seedCurated();
    await copyIntoEditLayer('v1', 'curated');
    expect((await getLayerWithPages(db, 'v1', 'edit'))?.pages[1].blocks[0].lines).toEqual([
      'ページ'
    ]);
  });
});
