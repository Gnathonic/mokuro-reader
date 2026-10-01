/**
 * The Worker export path (`compress-from-db`): a self-contained archive carries
 * `series.json`, a cloud upload does not.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { BlobReader, TextWriter, ZipReader, configure } from '@zip.js/zip.js';

// jsdom has no usable Worker for zip.js to farm compression out to.
configure({ useWebWorkers: false });

import {
  compressVolume,
  compressVolumeFromDb,
  generateVolumeSidecarsFromDb
} from './compress-volume';
import { parseSeriesFile } from '$lib/metadata/series-file';
import { createEmptySeriesMetadata } from '$lib/metadata/types';
import { MOKURO_DB_NAME, declareMokuroSchema } from '$lib/catalog/db-schema';
import { clearAllLayers, putLayerWithPages } from '$lib/catalog/layer-store';

// zip.js writes the archive through a Blob stream; jsdom's Blob has none.
if (typeof Blob !== 'undefined' && !Blob.prototype.stream) {
  Blob.prototype.stream = function (this: Blob) {
    const bytes = this.arrayBuffer();
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(await bytes));
        controller.close();
      }
    });
  } as Blob['stream'];
}

let db: any;

// jsdom's Blob/File do not survive fake-indexeddb's structured clone (they come
// back as plain objects); node's Blob does, and `arrayBuffer()` is all the
// compressor asks of a stored page. Loaded through a non-literal specifier so
// the app's tsconfig (no node types) does not have to resolve it.
const NODE_BUFFER: string = 'node:buffer';
let NodeBlob: typeof Blob;

const volume = {
  mokuro_version: '0.2.1',
  series_title: 'One Piece',
  series_uuid: 'series-uuid',
  volume_title: 'Vol 1',
  volume_uuid: 'volume-uuid',
  page_count: 1,
  character_count: 5,
  page_char_counts: [5]
};

beforeAll(async () => {
  ({ Blob: NodeBlob } = (await import(/* @vite-ignore */ NODE_BUFFER)) as { Blob: typeof Blob });

  // Same name and schema `compress-volume`'s own worker-side handle opens —
  // taken from the one shared declaration rather than restated, so this fixture
  // cannot drift out from under the code it is testing.
  db = new Dexie(MOKURO_DB_NAME);
  declareMokuroSchema(db);
  await db.open();
});

beforeEach(async () => {
  await Promise.all([
    db.table('volumes').clear(),
    db.table('volume_ocr').clear(),
    db.table('volume_files').clear(),
    db.table('series_metadata').clear(),
    db.table('series_index').clear(),
    clearAllLayers(db)
  ]);
  await db
    .table('volumes')
    .bulkPut([volume, { ...volume, volume_uuid: 'v2', volume_title: 'Vol 2' }]);
  await db
    .table('volume_ocr')
    .put({ volume_uuid: 'volume-uuid', pages: [{ img_path: '001.jpg', blocks: [] }] });
  await db.table('volume_files').put({
    volume_uuid: 'volume-uuid',
    files: { '001.jpg': new NodeBlob([new Uint8Array([1, 2, 3])]) }
  });
  await db.table('series_metadata').put({
    ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
    external_ids: { anilist: 30013 },
    facts_updated_at: '2026-08-16T00:00:00.000Z'
  });
});

async function entryNames(blob: Blob): Promise<string[]> {
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();
  const names = entries.map((entry) => entry.filename);
  await reader.close();
  return names;
}

async function entryText(blob: Blob, name: string): Promise<string> {
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();
  const entry = entries.find((candidate) => candidate.filename === name);
  const text = await (entry as any).getData(new TextWriter());
  await reader.close();
  return text;
}

describe('compressVolume', () => {
  const pages = [{ filename: '001.jpg', data: new Uint8Array([1, 2, 3]) }];

  it('writes the extra files at the archive root, beside the .mokuro', async () => {
    const layer = new File(['{"pages":[]}'], 'Vol 1.gcv.mokuro', { type: 'application/json' });
    const blob = await compressVolume('Vol 1', null, pages, undefined, { extraFiles: [layer] });

    expect(await entryNames(blob)).toEqual(['Vol 1/', 'Vol 1/001.jpg', 'Vol 1.gcv.mokuro']);
    expect(await entryText(blob, 'Vol 1.gcv.mokuro')).toBe('{"pages":[]}');
  });

  it('adds nothing when no extra files are given (the cloud backup shape)', async () => {
    const blob = await compressVolume('Vol 1', null, pages);

    expect(await entryNames(blob)).toEqual(['Vol 1/', 'Vol 1/001.jpg']);
  });
});

describe('compressVolumeFromDb', () => {
  it('embeds series.json when the archive is a self-contained export', async () => {
    const blob = await compressVolumeFromDb('volume-uuid', undefined, {
      embedMokuroInArchive: true,
      embedSeriesFile: true
    });

    expect(await entryNames(blob)).toContain('series.json');

    const parsed = parseSeriesFile(JSON.parse(await entryText(blob, 'series.json')));
    expect(parsed?.series_title).toBe('One Piece');
    expect(parsed?.external_ids).toEqual({ anilist: 30013 });
    // Every local volume of the series, not just the one being exported.
    expect(parsed?.volumes.map((v) => v.volume_uuid)).toEqual(['volume-uuid', 'v2']);
  });

  it('leaves series.json out of a cloud upload', async () => {
    const blob = await compressVolumeFromDb('volume-uuid', undefined, {
      embedMokuroInArchive: false,
      embedSeriesFile: false
    });

    expect(await entryNames(blob)).not.toContain('series.json');
  });

  const gcvLayer = {
    volume_uuid: 'volume-uuid',
    layer_id: 'gcv',
    name: 'Cloud Vision',
    kind: 'ocr' as const,
    engine: 'gcv',
    created_at: '2026-09-16T00:00:00.000Z',
    updated_at: '2026-09-16T00:00:00.000Z',
    pages: [
      {
        version: '0.2.1',
        img_width: 10,
        img_height: 10,
        img_path: '001.jpg',
        blocks: [{ box: [0, 0, 1, 1], vertical: true, font_size: 1, lines: ['あいう'] }]
      }
    ]
  };

  // The "Individual volumes" export with sidecars embedded: the queue downloads
  // nothing beside the archive then, so a layer that is not IN the archive is
  // simply lost from the export.
  it('embeds the layer files at the archive root, beside the .mokuro, when asked', async () => {
    await putLayerWithPages(db, gcvLayer);

    const blob = await compressVolumeFromDb('volume-uuid', undefined, {
      embedMokuroInArchive: true,
      embedLayerFiles: true
    });

    // Same root location and `<Volume Title>.<layer-id>.mokuro` name the ZIP
    // exports in `zip.ts` use, so the importer pairs it with the volume.
    const names = await entryNames(blob);
    expect(names).toContain('Vol 1.mokuro');
    expect(names).toContain('Vol 1.gcv.mokuro');

    // Byte-identical to the sidecar the cloud path would upload for this layer.
    const sidecars = await generateVolumeSidecarsFromDb('volume-uuid');
    const embedded = await entryText(blob, 'Vol 1.gcv.mokuro');
    expect(embedded).toBe(await sidecars.layers![0].blob.text());
    const json = JSON.parse(embedded);
    expect(json.chars).toBe(3);
    expect(json.pages[0].blocks[0].lines).toEqual(['あいう']);
  });

  it('never embeds layer files unless asked (a cloud backup keeps them as separate files)', async () => {
    await putLayerWithPages(db, gcvLayer);

    const blob = await compressVolumeFromDb('volume-uuid', undefined, {
      embedThumbnailSidecar: true,
      embedMokuroInArchive: false,
      embedSeriesFile: false
    });

    expect(await entryNames(blob)).toEqual(['Vol 1/', 'Vol 1/001.jpg']);
  });
});

describe('generateVolumeSidecarsFromDb — layers', () => {
  it('emits one <title>.<id>.mokuro per layer row, upstream format, with the layer chars', async () => {
    await putLayerWithPages(db, {
      volume_uuid: 'volume-uuid',
      layer_id: 'gcv',
      name: 'Cloud Vision',
      kind: 'ocr',
      engine: 'gcv',
      created_at: '2026-09-16T00:00:00.000Z',
      updated_at: '2026-09-16T00:00:00.000Z',
      pages: [
        {
          version: '0.2.1',
          img_width: 10,
          img_height: 10,
          img_path: '001.jpg',
          blocks: [{ box: [0, 0, 1, 1], vertical: true, font_size: 1, lines: ['あいう'] }]
        }
      ]
    });
    const sidecars = await generateVolumeSidecarsFromDb('volume-uuid');
    expect(sidecars.mokuro?.filename).toBe('Vol 1.mokuro');
    expect(sidecars.layers?.map((l) => [l.layerId, l.filename])).toEqual([
      ['gcv', 'Vol 1.gcv.mokuro']
    ]);
    // The row's `updated_at` as read WITH these pages: what a backup compares
    // against after the upload to tell whether the layer was edited meanwhile.
    expect(sidecars.layers![0].updatedAt).toBe('2026-09-16T00:00:00.000Z');
    const json = JSON.parse(await sidecars.layers![0].blob.text());
    expect(json.chars).toBe(3);
    expect(json.volume_uuid).toBe('volume-uuid');
    expect(json.pages[0].blocks[0].lines).toEqual(['あいう']);
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

  it('a renamed volume names its layer files after the new title', async () => {
    await putLayerWithPages(db, {
      volume_uuid: 'volume-uuid',
      layer_id: 'fix',
      name: 'Fix',
      kind: 'edit',
      created_at: '2026-09-16T00:00:00.000Z',
      updated_at: '2026-09-16T00:00:00.000Z',
      pages: []
    });
    const sidecars = await generateVolumeSidecarsFromDb('volume-uuid', { volumeTitle: 'Vol 01' });
    expect(sidecars.layers?.[0].filename).toBe('Vol 01.fix.mokuro');
    expect(JSON.parse(await sidecars.layers![0].blob.text()).volume).toBe('Vol 01');
  });
  // The OCR upgrade's mirror of the cloud's own primary sidecar (an edited
  // volume's `updated-ocr` layer) must never be written out as a layer file.
  it('leaves out an untouched updated-ocr layer, and keeps it once the user edited it', async () => {
    const mirror = {
      volume_uuid: 'volume-uuid',
      layer_id: 'updated-ocr',
      name: 'Updated OCR',
      kind: 'ocr' as const,
      created_at: '2026-09-16T00:00:00.000Z',
      updated_at: '2026-09-16T00:00:00.000Z',
      source_sha256: 'a'.repeat(64),
      source_at: '2026-09-16T00:00:00.000Z',
      pages: []
    };
    await putLayerWithPages(db, mirror);
    expect((await generateVolumeSidecarsFromDb('volume-uuid')).layers).toBeUndefined();

    await putLayerWithPages(db, { ...mirror, updated_at: '2026-09-17T00:00:00.000Z' });
    expect(
      (await generateVolumeSidecarsFromDb('volume-uuid')).layers?.map((l) => l.layerId)
    ).toEqual(['updated-ocr']);
  });
});
