import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Page, VolumeOcrLayer } from '$lib/types';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_layer_sync_test') };
});
vi.mock('$lib/util/sync/sidecar-backfill', () => ({ noteOcrEdited: vi.fn() }));

const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { getActiveProvider: () => getActiveProvider() }
}));
const cacheAdd = vi.fn();
const cacheRemove = vi.fn();
let cachedFiles: CloudFileMetadata[] = [];
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: {
    getCache: () => ({
      add: cacheAdd,
      removeById: cacheRemove,
      getAllFiles: () => cachedFiles
    })
  }
}));

import { db } from '$lib/catalog/db';
import {
  collectLayerFiles,
  deleteLayerFileInCloud,
  layerNeedsPull,
  layerNeedsPush,
  pullLayersForVolume,
  syncLayersFromListing
} from './layer-sync';

function pg(text: string, img_path = 'p.png'): Page {
  return {
    version: '0.2.1',
    img_width: 100,
    img_height: 100,
    img_path,
    blocks: [{ box: [0, 0, 10, 10], vertical: true, font_size: 10, lines: [text] }]
  };
}

function cloudFile(path: string, overrides: Partial<CloudFileMetadata> = {}): CloudFileMetadata {
  return {
    provider: 'webdav',
    fileId: path,
    path,
    modifiedTime: '2026-09-16T10:00:00.000Z',
    size: 100,
    ...overrides
  };
}

function listing(...files: CloudFileMetadata[]): Map<string, CloudFileMetadata[]> {
  const map = new Map<string, CloudFileMetadata[]>();
  for (const file of files) {
    const folder = file.path.split('/')[0];
    const group = map.get(folder);
    if (group) group.push(file);
    else map.set(folder, [file]);
  }
  return map;
}

function mokuroJson(text: string): string {
  return JSON.stringify({
    version: '0.2.1',
    title: 'Series',
    title_uuid: 's1',
    volume: 'Vol 1',
    volume_uuid: 'v1',
    pages: [{ ...pg(text), cumulativeChars: 2 }],
    chars: 2
  });
}

const downloadFile = vi.fn();
const uploadFile = vi.fn();
const deleteFile = vi.fn();
let readOnly = false;

function provider(type = 'webdav') {
  return {
    type,
    getStatus: () => ({ isReadOnly: readOnly }),
    downloadFile,
    uploadFile,
    deleteFile
  };
}

async function seedRow(volume_title = 'Vol 1', volume_uuid = 'v1') {
  await db.volumes.put({
    volume_uuid,
    series_uuid: 's1',
    series_title: 'Series',
    volume_title,
    mokuro_version: '0.2.1',
    page_count: 1,
    character_count: 2,
    page_char_counts: [2]
  });
  await db.volume_ocr.put({ volume_uuid, pages: [pg('あい')] });
}

beforeEach(async () => {
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_ocr_layers.clear()]);
  downloadFile.mockReset();
  uploadFile.mockReset();
  deleteFile.mockReset();
  cacheAdd.mockReset();
  cacheRemove.mockReset();
  cachedFiles = [];
  readOnly = false;
  getActiveProvider.mockReturnValue(provider());
  uploadFile.mockResolvedValue({
    fileId: 'up',
    modifiedTime: '2026-09-16T12:00:00.000Z',
    size: 77
  });
});

describe('collectLayerFiles', () => {
  it('classifies per folder by archive presence; plain beats gz; nested paths ignored', () => {
    const files = collectLayerFiles(
      listing(
        cloudFile('Series/Vol 1.cbz'),
        cloudFile('Series/Vol 1.mokuro'),
        cloudFile('Series/Vol 1.paddle-manga.mokuro'),
        cloudFile('Series/Vol 1.paddle-manga.mokuro.gz'),
        cloudFile('Series/Vol 1.tr-en.mokuro.gz'),
        cloudFile('Series/Vol 1.5.cbz'),
        cloudFile('Series/Vol 1.5.mokuro'),
        cloudFile('Series/Vol 2.gcv.mokuro'),
        cloudFile('Series/deeper/Vol 1.gcv.mokuro'),
        cloudFile('Series/series.json')
      )
    );
    expect(files.map((f) => [f.stem, f.layerId, f.gz, f.file.path])).toEqual([
      ['Vol 1', 'paddle-manga', false, 'Series/Vol 1.paddle-manga.mokuro'],
      ['Vol 1', 'tr-en', true, 'Series/Vol 1.tr-en.mokuro.gz']
    ]);
  });
});

describe('layerNeedsPull / layerNeedsPush', () => {
  const file = cloudFile('Series/Vol 1.fix.mokuro', {
    size: 100,
    modifiedTime: '2026-09-16T10:00:00.000Z'
  });
  const synced: VolumeOcrLayer = {
    volume_uuid: 'v1',
    layer_id: 'fix',
    name: 'Fix',
    kind: 'edit',
    created_at: '2026-09-16T09:00:00.000Z',
    updated_at: '2026-09-16T09:00:00.000Z',
    pages: [],
    cloud: {
      provider: 'webdav',
      size: 100,
      modified: 1789552800,
      synced_at: '2026-09-16T09:00:00.000Z'
    }
  };

  it('no row → pull; same stamp → neither; cloud moved + row untouched → pull', () => {
    expect(layerNeedsPull(undefined, file, 'webdav')).toBe(true);
    expect(layerNeedsPull(synced, file, 'webdav')).toBe(false);
    expect(layerNeedsPush(synced, file, 'webdav')).toBe(false);
    const moved = cloudFile(file.path, { size: 101, modifiedTime: '2026-09-16T11:00:00.000Z' });
    expect(layerNeedsPull(synced, moved, 'webdav')).toBe(true);
  });

  it('row edited since sync → push, unless the cloud copy is newer than the edit', () => {
    const edited = { ...synced, updated_at: '2026-09-16T10:30:00.000Z' };
    expect(layerNeedsPush(edited, file, 'webdav')).toBe(true);
    expect(layerNeedsPull(edited, file, 'webdav')).toBe(false);
    const newer = cloudFile(file.path, { size: 101, modifiedTime: '2026-09-16T11:00:00.000Z' });
    expect(layerNeedsPull(edited, newer, 'webdav')).toBe(true);
    expect(layerNeedsPush(edited, newer, 'webdav')).toBe(false);
  });

  it('a never-synced row is pushed even with no cloud file; a provisional mtime compares size only', () => {
    const fresh = { ...synced, cloud: undefined };
    expect(layerNeedsPush(fresh, undefined, 'webdav')).toBe(true);
    const provisional = cloudFile(file.path, {
      size: 100,
      modifiedTime: '2026-09-16T23:00:00.000Z',
      modifiedTimeProvisional: true
    });
    expect(layerNeedsPull(synced, provisional, 'webdav')).toBe(false);
  });

  // A row attached from inside a downloaded archive is a snapshot of the cloud,
  // not an edit: stamped `now` with no `cloud`, it used to out-rank the real
  // sidecar and then get pushed over it.
  const passive: VolumeOcrLayer = {
    ...synced,
    cloud: undefined,
    updated_at: '2026-09-16T12:00:00.000Z',
    passive_at: '2026-09-16T12:00:00.000Z'
  };

  it('passively attached row vs an older-mtime real cloud file → pull, never push', () => {
    expect(layerNeedsPull(passive, file, 'webdav')).toBe(true);
    expect(layerNeedsPush(passive, file, 'webdav')).toBe(false);
    const provisional = cloudFile(file.path, { modifiedTimeProvisional: true });
    expect(layerNeedsPull(passive, provisional, 'webdav')).toBe(true);
    expect(layerNeedsPush(passive, provisional, 'webdav')).toBe(false);
  });

  it('passively attached row with no cloud file → push', () => {
    expect(layerNeedsPush(passive, undefined, 'webdav')).toBe(true);
  });

  it('a passively attached row edited afterwards is an ordinary edit again', () => {
    const edited = { ...passive, updated_at: '2026-09-16T12:30:00.000Z' };
    expect(layerNeedsPull(edited, file, 'webdav')).toBe(false);
    expect(layerNeedsPush(edited, file, 'webdav')).toBe(true);
  });
});

describe('syncLayersFromListing', () => {
  it('pulls an engine file into a row with inferred kind/engine/name and the listing stamp', async () => {
    await seedRow();
    downloadFile.mockResolvedValue(new Blob([mokuroJson('えん')]));
    await syncLayersFromListing(
      listing(
        cloudFile('Series/Vol 1.cbz'),
        cloudFile('Series/Vol 1.mokuro'),
        cloudFile('Series/Vol 1.paddle-manga.mokuro', { size: 55 })
      ),
      'webdav'
    );
    const row = await db.volume_ocr_layers.get(['v1', 'paddle-manga']);
    expect(row).toMatchObject({
      name: 'Paddle Manga',
      kind: 'ocr',
      engine: 'paddle-manga',
      cloud: { provider: 'webdav', size: 55, modified: 1789552800 }
    });
    expect(row!.pages[0].blocks[0].lines).toEqual(['えん']);
    expect('cumulativeChars' in row!.pages[0]).toBe(false);
    // The primary row is untouched.
    expect((await db.volume_ocr.get('v1'))!.pages[0].blocks[0].lines).toEqual(['あい']);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it('an unchanged stamp downloads nothing; a placeholder (no row) gets nothing', async () => {
    await seedRow();
    await db.volume_ocr_layers.put({
      volume_uuid: 'v1',
      layer_id: 'paddle-manga',
      name: 'Paddle Manga',
      kind: 'ocr',
      engine: 'paddle-manga',
      created_at: '2026-09-16T09:00:00.000Z',
      updated_at: '2026-09-16T09:00:00.000Z',
      pages: [pg('old')],
      cloud: {
        provider: 'webdav',
        size: 100,
        modified: 1789552800,
        synced_at: '2026-09-16T09:00:00.000Z'
      }
    });
    await syncLayersFromListing(
      listing(
        cloudFile('Series/Vol 1.cbz'),
        cloudFile('Series/Vol 1.paddle-manga.mokuro'),
        cloudFile('Series/Vol 9.cbz'),
        cloudFile('Series/Vol 9.paddle-manga.mokuro')
      ),
      'webdav'
    );
    expect(downloadFile).not.toHaveBeenCalled();
    expect((await db.volume_ocr_layers.toArray()).map((l) => l.volume_uuid)).toEqual(['v1']);
  });

  it('pushes a locally edited layer as <title>.<id>.mokuro and stamps it; read-only skips', async () => {
    await seedRow();
    await db.volume_ocr_layers.put({
      volume_uuid: 'v1',
      layer_id: 'fix',
      name: 'Fix',
      kind: 'edit',
      created_at: '2026-09-16T09:00:00.000Z',
      updated_at: '2026-09-16T09:00:00.000Z',
      pages: [pg('なお')]
    });
    const files = listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.mokuro'));
    readOnly = true;
    await syncLayersFromListing(files, 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();

    readOnly = false;
    await syncLayersFromListing(files, 'webdav');
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const [path, blob] = uploadFile.mock.calls[0];
    expect(path).toBe('Series/Vol 1.fix.mokuro');
    const json = JSON.parse(await (blob as Blob).text());
    expect(json.pages[0].blocks[0].lines).toEqual(['なお']);
    expect(Object.keys(json).sort()).toEqual([
      'chars',
      'pages',
      'title',
      'title_uuid',
      'version',
      'volume',
      'volume_uuid'
    ]);
    expect(cacheAdd).toHaveBeenCalledWith('Series/Vol 1.fix.mokuro', expect.anything());
    const row = await db.volume_ocr_layers.get(['v1', 'fix']);
    expect(row!.cloud).toMatchObject({ provider: 'webdav', size: 77, modified: 1789560000 });
    expect(row!.updated_at <= row!.cloud!.synced_at).toBe(true);

    // Stamped now: a second pass with the same listing does nothing.
    await syncLayersFromListing(files, 'webdav');
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it('a passively attached row is replaced by the older-mtime cloud sidecar, never pushed over it', async () => {
    await seedRow();
    await db.volume_ocr_layers.put({
      volume_uuid: 'v1',
      layer_id: 'gcv',
      name: 'Gcv',
      kind: 'ocr',
      engine: 'gcv',
      created_at: '2026-09-16T12:00:00.000Z',
      updated_at: '2026-09-16T12:00:00.000Z',
      passive_at: '2026-09-16T12:00:00.000Z',
      pages: [pg('ふる')]
    });
    downloadFile.mockResolvedValue(new Blob([mokuroJson('しん')]));
    const files = listing(
      cloudFile('Series/Vol 1.cbz'),
      cloudFile('Series/Vol 1.gcv.mokuro', { modifiedTime: '2026-09-16T10:00:00.000Z' })
    );
    await syncLayersFromListing(files, 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();
    const row = await db.volume_ocr_layers.get(['v1', 'gcv']);
    expect(row!.pages[0].blocks[0].lines).toEqual(['しん']);
    expect(row!.cloud).toMatchObject({ provider: 'webdav' });
    expect(row!.passive_at).toBeUndefined();

    // Pulled and stamped: the same listing is now a no-op in both directions.
    await syncLayersFromListing(files, 'webdav');
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('never pushes a layer of a volume whose archive is not in the cloud', async () => {
    await seedRow();
    await db.volume_ocr_layers.put({
      volume_uuid: 'v1',
      layer_id: 'fix',
      name: 'Fix',
      kind: 'edit',
      created_at: '2026-09-16T09:00:00.000Z',
      updated_at: '2026-09-16T09:00:00.000Z',
      pages: [pg('x')]
    });
    await syncLayersFromListing(listing(cloudFile('Series/Other.cbz')), 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('a listing from a different provider than the active one is ignored', async () => {
    await seedRow();
    await syncLayersFromListing(
      listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.gcv.mokuro')),
      'mega'
    );
    expect(downloadFile).not.toHaveBeenCalled();
  });
});

describe('pullLayersForVolume / deleteLayerFileInCloud', () => {
  it('pulls one volume’s layers from the cached listing', async () => {
    await seedRow();
    cachedFiles = [
      cloudFile('Series/Vol 1.cbz'),
      cloudFile('Series/Vol 1.gcv.mokuro'),
      cloudFile('Series/Vol 2.cbz'),
      cloudFile('Series/Vol 2.gcv.mokuro')
    ];
    downloadFile.mockResolvedValue(new Blob([mokuroJson('ok')]));
    expect(await pullLayersForVolume('v1', 'webdav')).toBe(1);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect((await db.volume_ocr_layers.get(['v1', 'gcv']))!.kind).toBe('ocr');
  });

  it('deletes the cloud file of a layer that was synced with this provider', async () => {
    await seedRow();
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.fix.mokuro')];
    const row = (await db.volumes.get('v1'))!;
    await deleteLayerFileInCloud(row, {
      layer_id: 'fix',
      cloud: { provider: 'webdav', synced_at: '2026-09-16T09:00:00.000Z' }
    });
    expect(deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Series/Vol 1.fix.mokuro' })
    );
    expect(cacheRemove).toHaveBeenCalledWith('Series/Vol 1.fix.mokuro');
    deleteFile.mockClear();
    await deleteLayerFileInCloud(row, { layer_id: 'fix' });
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
