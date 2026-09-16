import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_layer_import_test') };
});
vi.mock('$lib/util/sync/sidecar-backfill', () => ({ noteOcrEdited: vi.fn() }));

import { db } from '$lib/catalog/db';
import {
  applyStashedLayersFor,
  attachLayerFile,
  clearStashedLayerEntries,
  extractLayerEntries,
  stashLayerEntries
} from './layer-import';

function entry(path: string) {
  return { path, file: new File(['{}'], path.split('/').pop()!) };
}

function mokuro(
  text: string,
  ids: Partial<{ volume_uuid: string; title: string; volume: string }>
) {
  return JSON.stringify({
    version: '0.2.1',
    title: 'Series',
    title_uuid: 's1',
    volume: 'Vol 1',
    volume_uuid: 'v1',
    ...ids,
    pages: [
      {
        version: '0.2.1',
        img_width: 10,
        img_height: 10,
        img_path: 'p.png',
        cumulativeChars: 1,
        blocks: [{ box: [0, 0, 1, 1], vertical: true, font_size: 5, lines: [text] }]
      }
    ],
    chars: 1
  });
}

async function seed(volume_uuid = 'v1', volume_title = 'Vol 1', series_title = 'Series') {
  await db.volumes.put({
    volume_uuid,
    series_uuid: 's1',
    series_title,
    volume_title,
    mokuro_version: '0.2.1',
    page_count: 1,
    character_count: 1,
    page_char_counts: [1]
  });
}

beforeEach(async () => {
  await Promise.all([db.volumes.clear(), db.volume_ocr_layers.clear()]);
  clearStashedLayerEntries();
});

describe('extractLayerEntries', () => {
  it('a layer file beside its volume rides as a layer; alone it is standalone; a dotted volume stays primary', () => {
    const { entries, layers, standalone } = extractLayerEntries([
      entry('S/Vol 1.mokuro'),
      entry('S/Vol 1.cbz'),
      entry('S/Vol 1.gcv.mokuro'),
      entry('S/Vol 1.tr-en.mokuro.gz'),
      entry('S/Vol 1.5.cbz'),
      entry('S/Vol 1.5.mokuro'),
      entry('S/Vol 7.fix.mokuro'),
      entry('S/Vol 2/001.png'),
      entry('S/Vol 2.hayai.mokuro')
    ]);
    expect(entries.map((e) => e.path)).toEqual([
      'S/Vol 1.mokuro',
      'S/Vol 1.cbz',
      'S/Vol 1.5.cbz',
      'S/Vol 1.5.mokuro',
      'S/Vol 2/001.png'
    ]);
    expect(layers.map((l) => [l.stem, l.layerId, l.gz])).toEqual([
      ['Vol 1', 'gcv', false],
      ['Vol 1', 'tr-en', true],
      ['Vol 2', 'hayai', false]
    ]);
    expect(standalone.map((l) => [l.stem, l.layerId])).toEqual([['Vol 7', 'fix']]);
  });
});

describe('attachLayerFile', () => {
  it('attaches by the uuid inside the file, inferring kind/engine/name from the id', async () => {
    await seed();
    const file = new File([mokuro('うえ', {})], 'Whatever.gcv.mokuro');
    const result = await attachLayerFile(file);
    expect(result).toMatchObject({ status: 'attached', volumeUuid: 'v1', layerId: 'gcv' });
    const row = await db.volume_ocr_layers.get(['v1', 'gcv']);
    expect(row).toMatchObject({ kind: 'ocr', engine: 'gcv', name: 'Gcv' });
    expect(row!.pages[0].blocks[0].lines).toEqual(['うえ']);
    expect('cumulativeChars' in row!.pages[0]).toBe(false);
    expect(row!.cloud).toBeUndefined();
  });

  it('falls back to the title when the uuid is unknown: the file\u2019s own series, else the hint', async () => {
    await seed('local-1', 'Vol 1', 'Series');
    await seed('local-2', 'Vol 1', 'Other Series');
    const file = new File([mokuro('x', { volume_uuid: 'gone' })], 'Vol 1.fix.mokuro');
    expect(await attachLayerFile(file)).toMatchObject({
      status: 'attached',
      volumeUuid: 'local-1'
    });
    expect(await attachLayerFile(file, { seriesTitle: 'other series' })).toMatchObject({
      status: 'attached',
      volumeUuid: 'local-2'
    });
    // Two candidates and nothing to choose by → refuse rather than guess.
    const bare = new File(
      [mokuro('x', { volume_uuid: 'gone', title: undefined as never })],
      'Vol 1.fix.mokuro'
    );
    expect(await attachLayerFile(bare)).toMatchObject({ status: 'no-match' });
  });

  it('reports invalid input and never creates a volume', async () => {
    expect(await attachLayerFile(new File(['nope'], 'Vol 1.fix.mokuro'))).toEqual({
      status: 'invalid'
    });
    expect(await attachLayerFile(new File(['{}'], 'Vol 1.mokuro'))).toEqual({ status: 'invalid' });
    expect(await db.volumes.count()).toBe(0);
  });
});

describe('stashed layers', () => {
  it('apply to the volume saved under the matching stem, and only once', async () => {
    await seed('v9', 'Vol 3');
    stashLayerEntries(
      extractLayerEntries([
        entry('S/Vol 3.cbz'),
        {
          path: 'S/Vol 3.tr-en.mokuro',
          file: new File([mokuro('en', { volume_uuid: 'none' })], 'Vol 3.tr-en.mokuro')
        }
      ]).layers
    );
    expect(await applyStashedLayersFor('v9', 'vol 3')).toBe(1);
    expect((await db.volume_ocr_layers.get(['v9', 'tr-en']))!.kind).toBe('translation');
    expect(await applyStashedLayersFor('v9', 'Vol 3')).toBe(0);
  });
});
