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
  clearPendingLayerDelete,
  collectLayerFiles,
  deleteCloudLayerFile,
  deleteLayerFileInCloud,
  layerNeedsPull,
  layerNeedsPush,
  pullLayersForVolume,
  stampLayersSynced,
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
  localStorage.clear();
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

// Deleting a layer used to drop the local row whether or not the cloud copy
// went with it; whenever it did not (offline, read-only, a failed request) the
// next listing found "no row" and pulled the file straight back.
describe('pending layer deletes (no resurrection)', () => {
  const layerPath = 'Series/Vol 1.fix.mokuro';
  const files = () => listing(cloudFile('Series/Vol 1.cbz'), cloudFile(layerPath, { size: 55 }));

  async function seedSyncedLayer(layer_id = 'fix') {
    await seedRow();
    await db.volume_ocr_layers.put({
      volume_uuid: 'v1',
      layer_id,
      name: 'Fix',
      kind: 'edit',
      created_at: '2026-09-16T09:00:00.000Z',
      updated_at: '2026-09-16T09:00:00.000Z',
      pages: [pg('なお')],
      cloud: {
        provider: 'webdav',
        size: 55,
        modified: 1789552800,
        synced_at: '2026-09-16T09:00:00.000Z'
      }
    });
  }

  /** What `runLayerAction` does: cloud first, then the row — whatever the outcome. */
  async function userDeletes(layerId = 'fix') {
    const outcome = await deleteCloudLayerFile('v1', layerId);
    await db.volume_ocr_layers.delete(['v1', layerId]);
    return outcome;
  }

  it('offline delete → not pulled back → cloud file removed on the next writable listing', async () => {
    await seedSyncedLayer();
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile(layerPath, { size: 55 })];
    downloadFile.mockResolvedValue(new Blob([mokuroJson('もど')]));

    getActiveProvider.mockReturnValue(null);
    expect(await userDeletes()).toBe('unconfirmed');
    expect(deleteFile).not.toHaveBeenCalled();

    // Back online, but the delete request fails: still no resurrection.
    getActiveProvider.mockReturnValue(provider());
    deleteFile.mockRejectedValueOnce(new Error('503'));
    await syncLayersFromListing(files(), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(await db.volume_ocr_layers.get(['v1', 'fix'])).toBeUndefined();

    // The following listing gets the delete through.
    await syncLayersFromListing(files(), 'webdav');
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleteFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: layerPath }));
    expect(cacheRemove).toHaveBeenCalledWith(layerPath);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(await db.volume_ocr_layers.get(['v1', 'fix'])).toBeUndefined();

    // Tombstone spent: once the file is gone nothing more is attempted, and a
    // layer another device publishes under that id later is an arrival again.
    await syncLayersFromListing(listing(cloudFile('Series/Vol 1.cbz')), 'webdav');
    expect(deleteFile).toHaveBeenCalledTimes(2);
    await syncLayersFromListing(files(), 'webdav');
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it('read-only provider: the row goes locally and is never pulled back', async () => {
    await seedSyncedLayer();
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile(layerPath, { size: 55 })];
    downloadFile.mockResolvedValue(new Blob([mokuroJson('もど')]));
    readOnly = true;

    expect(await userDeletes()).toBe('unconfirmed');
    await syncLayersFromListing(files(), 'webdav');
    await syncLayersFromListing(files(), 'webdav');
    expect(await pullLayersForVolume('v1', 'webdav')).toBe(0);
    expect(deleteFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(await db.volume_ocr_layers.get(['v1', 'fix'])).toBeUndefined();
  });

  it('a confirmed delete, and a layer that never reached a cloud, leave no tombstone', async () => {
    await seedSyncedLayer();
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile(layerPath, { size: 55 })];
    expect(await userDeletes()).toBe('gone');
    expect(deleteFile).toHaveBeenCalledTimes(1);

    await db.volume_ocr_layers.put({
      volume_uuid: 'v1',
      layer_id: 'local',
      name: 'Local',
      kind: 'edit',
      created_at: '2026-09-16T09:00:00.000Z',
      updated_at: '2026-09-16T09:00:00.000Z',
      pages: [pg('x')]
    });
    getActiveProvider.mockReturnValue(null);
    expect(await userDeletes('local')).toBe('gone');
    expect(localStorage.length).toBe(0);
  });

  it('synced, writable, but the cached listing cannot vouch for the file → unconfirmed until a listing says so', async () => {
    await seedSyncedLayer();
    cachedFiles = []; // cache not loaded yet: "not listed" proves nothing
    expect(await userDeletes()).toBe('unconfirmed');
    downloadFile.mockResolvedValue(new Blob([mokuroJson('もど')]));
    await syncLayersFromListing(files(), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledTimes(1);

    // …whereas a cache that covers the volume and shows no such file is proof.
    await seedSyncedLayer('gone-already');
    cachedFiles = [cloudFile('Series/Vol 1.cbz')];
    expect(await userDeletes('gone-already')).toBe('gone');
  });

  it('re-creating a layer under the same id clears the tombstone: it is pushed, never deleted', async () => {
    await seedSyncedLayer();
    getActiveProvider.mockReturnValue(null);
    expect(await userDeletes()).toBe('unconfirmed');
    getActiveProvider.mockReturnValue(provider());

    const recreate = () =>
      db.volume_ocr_layers.put({
        volume_uuid: 'v1',
        layer_id: 'fix',
        name: 'Fix',
        kind: 'edit',
        created_at: '2026-09-16T11:00:00.000Z',
        updated_at: '2026-09-16T11:00:00.000Z',
        pages: [pg('あたらしい')]
      });

    // Explicitly (what the "new layer" action does)…
    await recreate();
    clearPendingLayerDelete('v1', 'fix');
    expect(localStorage.length).toBe(0);

    // …and self-healing for every other way a row can come back (import, promote).
    await db.volume_ocr_layers.delete(['v1', 'fix']);
    await seedSyncedLayer();
    getActiveProvider.mockReturnValue(null);
    await userDeletes();
    getActiveProvider.mockReturnValue(provider());
    await recreate();
    await syncLayersFromListing(files(), 'webdav');
    expect(deleteFile).not.toHaveBeenCalled();
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
  });

  it('a tombstone for another provider neither hides nor deletes this provider’s file', async () => {
    await seedSyncedLayer();
    await db.volume_ocr_layers.update(['v1', 'fix'], {
      cloud: { provider: 'mega', size: 55, synced_at: '2026-09-16T09:00:00.000Z' }
    });
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile(layerPath, { size: 55 })];
    expect(await userDeletes()).toBe('unconfirmed');
    // Never this provider's copy: the row was not synced with it.
    expect(deleteFile).not.toHaveBeenCalled();
    downloadFile.mockResolvedValue(new Blob([mokuroJson('べつ')]));
    await syncLayersFromListing(files(), 'webdav');
    expect(deleteFile).not.toHaveBeenCalled();
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it('tombstones of a volume that no longer exists are dropped', async () => {
    await seedSyncedLayer();
    getActiveProvider.mockReturnValue(null);
    await userDeletes();
    getActiveProvider.mockReturnValue(provider());
    await db.volumes.delete('v1');
    await syncLayersFromListing(files(), 'webdav');
    expect(localStorage.length).toBe(0);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

// A backup serializes a layer, then spends seconds to minutes uploading. The
// stamp used to re-read the row afterwards and call whatever it found synced —
// so an edit made during the upload read as "in the cloud", and the next
// listing (cloud file newer than the edit, size now different) pulled the
// stale upload over it.
describe('stampLayersSynced', () => {
  const T0 = '2026-09-16T09:00:00.000Z';
  const T1 = '2026-09-16T09:00:30.000Z';

  async function seedLayer() {
    await seedRow();
    await db.volume_ocr_layers.put({
      volume_uuid: 'v1',
      layer_id: 'fix',
      name: 'Fix',
      kind: 'edit',
      created_at: T0,
      updated_at: T0,
      pages: [pg('まえ')]
    });
  }

  it('an untouched layer is stamped synced with the uploaded size; an unknown id is ignored', async () => {
    await seedLayer();
    await stampLayersSynced('v1', 'webdav', [
      { layerId: 'fix', updatedAt: T0, size: 321 },
      { layerId: 'deleted-meanwhile', updatedAt: T0, size: 1 }
    ]);
    const row = (await db.volume_ocr_layers.get(['v1', 'fix']))!;
    expect(row.cloud).toMatchObject({ provider: 'webdav', size: 321 });
    expect(row.cloud!.modified).toBeUndefined();
    expect(row.updated_at > row.cloud!.synced_at).toBe(false);
    expect(await db.volume_ocr_layers.count()).toBe(1);
    const files = listing(
      cloudFile('Series/Vol 1.cbz'),
      cloudFile('Series/Vol 1.fix.mokuro', { size: 321, modifiedTime: '2026-09-16T09:01:00.000Z' })
    );
    await syncLayersFromListing(files, 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('edited between serialize and stamp → stays "edited since sync" and is pushed, never overwritten', async () => {
    await seedLayer();
    // The worker read the row at T0 and is uploading those 321 bytes…
    const snapshot = [{ layerId: 'fix', updatedAt: T0, size: 321 }];
    // …the user edits the layer while it does…
    await db.volume_ocr_layers.update(['v1', 'fix'], {
      updated_at: T1,
      pages: [pg('あとのへんしゅう')]
    });
    // …and the upload completes.
    await stampLayersSynced('v1', 'webdav', snapshot);

    const row = (await db.volume_ocr_layers.get(['v1', 'fix']))!;
    expect(row.updated_at > row.cloud!.synced_at).toBe(true);
    // Stamped with what IS in the cloud, so the listed file does not read as
    // somebody else's newer copy.
    expect(row.cloud).toMatchObject({ provider: 'webdav', size: 321 });

    // The cloud file carries the upload's mtime — LATER than the edit.
    downloadFile.mockResolvedValue(new Blob([mokuroJson('ふるい')]));
    const files = listing(
      cloudFile('Series/Vol 1.cbz'),
      cloudFile('Series/Vol 1.fix.mokuro', { size: 321, modifiedTime: '2026-09-16T09:01:00.000Z' })
    );
    await syncLayersFromListing(files, 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const pushed = JSON.parse(await (uploadFile.mock.calls[0][1] as Blob).text());
    expect(pushed.pages[0].blocks[0].lines).toEqual(['あとのへんしゅう']);
    expect((await db.volume_ocr_layers.get(['v1', 'fix']))!.pages[0].blocks[0].lines).toEqual([
      'あとのへんしゅう'
    ]);
  });

  it('a layer created after the serialize was never uploaded, so it is not stamped', async () => {
    await seedLayer();
    await stampLayersSynced('v1', 'webdav', []);
    expect((await db.volume_ocr_layers.get(['v1', 'fix']))!.cloud).toBeUndefined();
  });
});
