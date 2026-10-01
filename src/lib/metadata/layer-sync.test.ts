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
import { countIdbOps } from '$lib/catalog/__tests__/idb-op-counter';
import {
  clearAllLayers,
  deleteLayerRows,
  getLayerWithPages,
  putLayerWithPages
} from '$lib/catalog/layer-store';
import {
  clearPendingLayerDelete,
  collectLayerFiles,
  deleteCloudLayerFile,
  deleteLayerFileInCloud,
  importFetchedLayers,
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
let canAddFiles: boolean | undefined = undefined;
let serverCompilesMetadata = false;

function provider(type = 'webdav') {
  return {
    type,
    getStatus: () => ({ isReadOnly: readOnly, canAddFiles, serverCompilesMetadata }),
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
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), clearAllLayers(db)]);
  downloadFile.mockReset();
  uploadFile.mockReset();
  deleteFile.mockReset();
  cacheAdd.mockReset();
  cacheRemove.mockReset();
  cachedFiles = [];
  readOnly = false;
  canAddFiles = undefined;
  serverCompilesMetadata = false;
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
    // The winner is for reading; a delete needs every copy (raw listing).
    expect(files.map((f) => f.copies.map((c) => c.file.path).sort())).toEqual([
      ['Series/Vol 1.paddle-manga.mokuro', 'Series/Vol 1.paddle-manga.mokuro.gz'],
      ['Series/Vol 1.tr-en.mokuro.gz']
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
  // The OCR upgrade's `updated-ocr` row for an edited volume IS the cloud's
  // primary sidecar: pushing it would publish that file a second time.
  const mirror: VolumeOcrLayer = {
    ...synced,
    layer_id: 'updated-ocr',
    kind: 'ocr',
    cloud: undefined,
    updated_at: '2026-09-16T12:00:00.000Z',
    source_sha256: 'a'.repeat(64),
    source_at: '2026-09-16T12:00:00.000Z'
  };

  it('an untouched updated-ocr row is never pushed, with or without a listed file', () => {
    expect(layerNeedsPush(mirror, undefined, 'webdav')).toBe(false);
    expect(layerNeedsPush(mirror, file, 'webdav')).toBe(false);
  });

  it('an untouched previous-ocr keepsake (the local primary an upgrade replaced) is never pushed', () => {
    const keepsake = {
      ...mirror,
      layer_id: 'previous-ocr',
      source_sha256: undefined, // a legacy primary had no hash
      source_at: mirror.updated_at
    };
    expect(layerNeedsPush(keepsake, undefined, 'webdav')).toBe(false);
    expect(
      layerNeedsPush({ ...keepsake, updated_at: '2026-09-16T12:30:00.000Z' }, undefined, 'webdav')
    ).toBe(true);
  });

  it('an updated-ocr row the user edited is their layer: pushed like any edit', () => {
    const edited = { ...mirror, updated_at: '2026-09-16T12:30:00.000Z' };
    expect(layerNeedsPush(edited, undefined, 'webdav')).toBe(true);
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
    const row = await getLayerWithPages(db, 'v1', 'paddle-manga');
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

  it('a pulled tr-<lang> file is filed as a translation — which can never become the primary', async () => {
    await seedRow();
    downloadFile.mockResolvedValue(new Blob([mokuroJson('Hello')]));
    await syncLayersFromListing(
      listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.tr-en.mokuro')),
      'webdav'
    );
    expect((await getLayerWithPages(db, 'v1', 'tr-en'))?.kind).toBe('translation');
    const { promoteLayer } = await import('$lib/reader/edit/layers');
    await expect(promoteLayer('v1', 'tr-en')).rejects.toThrow(/translation/i);
    expect((await db.volumes.get('v1'))?.character_count).toBe(2);
  });

  it('an unchanged stamp downloads nothing; a placeholder (no row) gets nothing', async () => {
    await seedRow();
    await putLayerWithPages(db, {
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

  it("never pushes the editor's original snapshot to a server that compiles its metadata", async () => {
    await seedRow();
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: '2026-09-16T09:00:00.000Z',
      updated_at: '2026-09-16T09:00:00.000Z',
      pages: [pg('あい')]
    });
    const files = listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.mokuro'));
    serverCompilesMetadata = true;
    await syncLayersFromListing(files, 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();

    // Plain storage: it is this user's Revert base, and it syncs.
    serverCompilesMetadata = false;
    await syncLayersFromListing(files, 'webdav');
    expect(uploadFile.mock.calls.map((c) => c[0])).toEqual(['Series/Vol 1.original.mokuro']);
  });

  it('an account that cannot add files (progress-only) never pushes a layer', async () => {
    await seedRow();
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'fix',
      name: 'Fix',
      kind: 'edit',
      created_at: '2026-09-16T09:00:00.000Z',
      updated_at: '2026-09-16T09:00:00.000Z',
      pages: [pg('なお')]
    });
    const files = listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.mokuro'));
    canAddFiles = false;
    await syncLayersFromListing(files, 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('pushes a locally edited layer as <title>.<id>.mokuro and stamps it; read-only skips', async () => {
    await seedRow();
    await putLayerWithPages(db, {
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
    const row = await getLayerWithPages(db, 'v1', 'fix');
    expect(row!.cloud).toMatchObject({ provider: 'webdav', size: 77, modified: 1789560000 });
    expect(row!.updated_at <= row!.cloud!.synced_at).toBe(true);

    // Stamped now: a second pass with the same listing does nothing.
    await syncLayersFromListing(files, 'webdav');
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  // A push always writes the PLAIN name. A layer that arrived as an engine's
  // `.mokuro.gz` and was then edited used to leave that `.gz` beside the new
  // plain file forever — shadowed by it, swept by nothing.
  describe('the .mokuro.gz a pushed layer was pulled from', () => {
    const gzPath = 'Series/Vol 1.gcv.mokuro.gz';
    const plainPath = 'Series/Vol 1.gcv.mokuro';
    const gz = () => cloudFile(gzPath, { size: 21 });

    /** Pulled from the `.gz` at 09:00, edited at 10:30. */
    async function seedEditedPulledLayer() {
      await seedRow();
      await putLayerWithPages(db, {
        volume_uuid: 'v1',
        layer_id: 'gcv',
        name: 'Gcv',
        kind: 'ocr',
        engine: 'gcv',
        created_at: '2026-09-16T09:00:00.000Z',
        updated_at: '2026-09-16T10:30:00.000Z',
        pages: [pg('なお')],
        cloud: {
          provider: 'webdav',
          size: 21,
          modified: 1789552800,
          synced_at: '2026-09-16T09:00:00.000Z'
        }
      });
    }

    it('is deleted once the plain file is up', async () => {
      await seedEditedPulledLayer();
      await syncLayersFromListing(listing(cloudFile('Series/Vol 1.cbz'), gz()), 'webdav');
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(uploadFile.mock.calls[0][0]).toBe(plainPath);
      expect(deleteFile).toHaveBeenCalledTimes(1);
      expect(deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: gzPath }));
      expect(cacheRemove).toHaveBeenCalledWith(gzPath);
      expect(deleteFile.mock.invocationCallOrder[0]).toBeGreaterThan(
        uploadFile.mock.invocationCallOrder[0]
      );
    });

    it('is left alone when the upload fails', async () => {
      await seedEditedPulledLayer();
      uploadFile.mockRejectedValueOnce(new Error('507'));
      await syncLayersFromListing(listing(cloudFile('Series/Vol 1.cbz'), gz()), 'webdav');
      expect(deleteFile).not.toHaveBeenCalled();
    });

    it('a failed sibling delete does not fail the push, and the next listing retries it', async () => {
      await seedEditedPulledLayer();
      deleteFile.mockRejectedValueOnce(new Error('503'));
      await syncLayersFromListing(listing(cloudFile('Series/Vol 1.cbz'), gz()), 'webdav');
      const row = (await getLayerWithPages(db, 'v1', 'gcv'))!;
      expect(row.cloud).toMatchObject({ provider: 'webdav', size: 77 });

      // Both are listed now; the row is in sync with the plain one.
      const plain = cloudFile(plainPath, { size: 77, modifiedTime: '2026-09-16T12:00:00.000Z' });
      await syncLayersFromListing(listing(cloudFile('Series/Vol 1.cbz'), plain, gz()), 'webdav');
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(downloadFile).not.toHaveBeenCalled();
      expect(deleteFile).toHaveBeenCalledTimes(2);
      expect(deleteFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: gzPath }));
      expect(deleteFile).not.toHaveBeenCalledWith(expect.objectContaining({ path: plainPath }));
    });

    it('is never tidied on a read-only provider, nor for a layer this device never synced', async () => {
      await seedEditedPulledLayer();
      // In sync with the plain file (its own push), the `.gz` still beside it.
      await db.volume_ocr_layers.update(['v1', 'gcv'], {
        cloud: {
          provider: 'webdav',
          size: 77,
          modified: 1789560000,
          synced_at: '2026-09-16T12:00:00.000Z'
        }
      });
      const plain = cloudFile(plainPath, { size: 77, modifiedTime: '2026-09-16T12:00:00.000Z' });
      const files = () => listing(cloudFile('Series/Vol 1.cbz'), plain, gz());
      readOnly = true;
      await syncLayersFromListing(files(), 'webdav');
      expect(downloadFile).not.toHaveBeenCalled();
      expect(deleteFile).not.toHaveBeenCalled();

      // No row at all: the plain file is pulled, nothing is deleted on a guess.
      readOnly = false;
      await clearAllLayers(db);
      downloadFile.mockResolvedValue(new Blob([mokuroJson('えん')]));
      await syncLayersFromListing(files(), 'webdav');
      expect(downloadFile).toHaveBeenCalledTimes(1);
      expect(deleteFile).not.toHaveBeenCalled();
    });
  });

  it('a passively attached row is replaced by the older-mtime cloud sidecar, never pushed over it', async () => {
    await seedRow();
    await putLayerWithPages(db, {
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
    const row = await getLayerWithPages(db, 'v1', 'gcv');
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
    await putLayerWithPages(db, {
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

describe('a pulled file must plausibly be a layer OF THAT VOLUME (page count)', () => {
  /** Another volume's primary sidecar: its own uuid/title, and three pages. */
  function otherVolumesSidecar(): Blob {
    return new Blob([
      JSON.stringify({
        version: '0.2.1',
        title: 'Series',
        title_uuid: 's1',
        volume: 'Vol 1.5',
        volume_uuid: 'v15',
        pages: [pg('a'), pg('b'), pg('c')],
        chars: 3
      })
    ]);
  }
  // No `Vol 1.5.cbz` listed, so by filename shape this is layer "5" of Vol 1.
  const lookAlike = (overrides: Partial<CloudFileMetadata> = {}) =>
    listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.5.mokuro', overrides));

  it('a look-alike with another page count makes no row, and is not downloaded again until it changes', async () => {
    await seedRow(); // page_count 1
    downloadFile.mockImplementation(async () => otherVolumesSidecar());

    await syncLayersFromListing(lookAlike(), 'webdav');
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(await db.volume_ocr_layers.count()).toBe(0);

    // Same listing again: the verdict is remembered, nothing is fetched.
    await syncLayersFromListing(lookAlike(), 'webdav');
    expect(downloadFile).toHaveBeenCalledTimes(1);

    // The file changed in the cloud → worth one more look.
    await syncLayersFromListing(lookAlike({ size: 321 }), 'webdav');
    expect(downloadFile).toHaveBeenCalledTimes(2);
    expect(await db.volume_ocr_layers.count()).toBe(0);
  });

  it('the verdict is about THIS page count: a row whose count changed is looked at again', async () => {
    await seedRow();
    downloadFile.mockImplementation(async () => otherVolumesSidecar());
    await syncLayersFromListing(lookAlike(), 'webdav');
    expect(await db.volume_ocr_layers.count()).toBe(0);

    await db.volumes.update('v1', { page_count: 3 });
    await syncLayersFromListing(lookAlike(), 'webdav');
    expect(downloadFile).toHaveBeenCalledTimes(2);
    expect((await getLayerWithPages(db, 'v1', '5'))!.pages).toHaveLength(3);
  });

  it('a differing volume_uuid alone is tolerated (engine sidecars)', async () => {
    await seedRow();
    downloadFile.mockResolvedValue(
      new Blob([JSON.stringify({ volume_uuid: 'someone-else', pages: [pg('えん')] })])
    );
    await syncLayersFromListing(
      listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.gcv.mokuro')),
      'webdav'
    );
    expect(await getLayerWithPages(db, 'v1', 'gcv')).toBeDefined();
  });

  it('a row with no known page count receives nothing, and nothing is downloaded for it', async () => {
    await seedRow();
    await db.volumes.update('v1', { page_count: 0 });
    downloadFile.mockResolvedValue(new Blob([mokuroJson('えん')]));
    await syncLayersFromListing(
      listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.gcv.mokuro')),
      'webdav'
    );
    expect(downloadFile).not.toHaveBeenCalled();
    expect(await db.volume_ocr_layers.count()).toBe(0);
  });

  it('pullLayersForVolume applies the same check', async () => {
    await seedRow();
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.5.mokuro')];
    downloadFile.mockImplementation(async () => otherVolumesSidecar());
    expect(await pullLayersForVolume('v1', 'webdav')).toBe(0);
    expect(await db.volume_ocr_layers.count()).toBe(0);
    expect(await pullLayersForVolume('v1', 'webdav')).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });
});

describe('an engine file that OMITS the pages it failed on', () => {
  // bunko's runner keeps going past a page its engine crashed on and writes
  // the volume without it: 2 pages of a 3-page volume, each naming its image.
  const engineFile = (...paths: string[]) =>
    new Blob([
      JSON.stringify({ volume_uuid: 'engine-run', pages: paths.map((p) => pg('えん', p)) })
    ]);
  const sparseListing = (overrides: Partial<CloudFileMetadata> = {}) =>
    listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.ppocr-manga.mokuro', overrides));

  async function seedThreePages(installed = true) {
    await seedRow();
    await db.volumes.update('v1', {
      page_count: 3,
      ...(installed ? {} : { metadata_only: true as const })
    });
    if (installed) {
      await db.volume_ocr.put({
        volume_uuid: 'v1',
        pages: [pg('あ', 'v/001.jpg'), pg('い', 'v/002.jpg'), pg('う', 'v/003.jpg')]
      });
    } else {
      await db.volume_ocr.delete('v1');
    }
  }

  it('is aligned to the volume by image path: a blank page where one was dropped', async () => {
    await seedThreePages();
    downloadFile.mockImplementation(async () => engineFile('v/001.jpg', 'v/003.jpg'));

    await syncLayersFromListing(sparseListing(), 'webdav');

    const row = (await getLayerWithPages(db, 'v1', 'ppocr-manga'))!;
    expect(row).toMatchObject({ kind: 'ocr', engine: 'ppocr-manga' });
    expect(row.pages.map((p) => p.img_path)).toEqual(['v/001.jpg', 'v/002.jpg', 'v/003.jpg']);
    expect(row.pages.map((p) => p.blocks.length)).toEqual([1, 0, 1]);
    expect(localStorage.getItem('layer-sync:rejected-files')).toBeNull();
  });

  it('pages of some OTHER volume are still rejected, and remembered', async () => {
    await seedThreePages();
    downloadFile.mockImplementation(async () => engineFile('w/001.jpg', 'w/777.jpg'));

    await syncLayersFromListing(sparseListing(), 'webdav');
    await syncLayersFromListing(sparseListing(), 'webdav');

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(await db.volume_ocr_layers.count()).toBe(0);
  });

  it('a row without its pages cannot align: refused without re-downloading, then looked at again once installed', async () => {
    await seedThreePages(false);
    downloadFile.mockImplementation(async () => engineFile('v/001.jpg', 'v/003.jpg'));

    await syncLayersFromListing(sparseListing(), 'webdav');
    await syncLayersFromListing(sparseListing(), 'webdav');
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(await db.volume_ocr_layers.count()).toBe(0);

    // The volume is downloaded: same file, same page count — but now there are
    // pages to align against, which the earlier verdict never had.
    await seedThreePages(true);
    await db.volumes.update('v1', { metadata_only: undefined });
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.ppocr-manga.mokuro')];
    expect(await pullLayersForVolume('v1', 'webdav')).toBe(1);
    expect((await getLayerWithPages(db, 'v1', 'ppocr-manga'))!.pages).toHaveLength(3);
  });

  it('a verdict reached under the old count-only rule is re-examined once', async () => {
    await seedThreePages();
    // Exactly what a build before the alignment left behind for this file.
    localStorage.setItem(
      'layer-sync:rejected-files',
      JSON.stringify([
        {
          volume_uuid: 'v1',
          layer_id: 'ppocr-manga',
          provider: 'webdav',
          page_count: 3,
          size: 100,
          modified: Date.parse('2026-09-16T10:00:00.000Z') / 1000
        }
      ])
    );
    downloadFile.mockImplementation(async () => engineFile('v/001.jpg', 'v/003.jpg'));

    await syncLayersFromListing(sparseListing(), 'webdav');

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect((await getLayerWithPages(db, 'v1', 'ppocr-manga'))!.pages).toHaveLength(3);
    expect(localStorage.getItem('layer-sync:rejected-files')).toBeNull();
  });
});

describe('a row filed before its engine id was known here', () => {
  const STAMP = '2026-09-16T10:00:00.000Z';
  async function seedFiledAsEdit(overrides: Partial<VolumeOcrLayer> = {}) {
    await seedRow();
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'ppocr-manga',
      name: 'Ppocr Manga',
      kind: 'edit',
      created_at: STAMP,
      updated_at: STAMP,
      cloud: {
        provider: 'webdav',
        size: 100,
        modified: Date.parse(STAMP) / 1000,
        synced_at: STAMP
      },
      pages: [pg('えん')],
      ...overrides
    });
  }
  const inSync = () =>
    listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.ppocr-manga.mokuro'));

  it('is re-filed as that engine’s OCR — no transfer, and never an "edit" to push', async () => {
    await seedFiledAsEdit();
    await syncLayersFromListing(inSync(), 'webdav');

    expect(await getLayerWithPages(db, 'v1', 'ppocr-manga')).toMatchObject({
      kind: 'ocr',
      engine: 'ppocr-manga',
      name: 'PP-OCR Manga',
      updated_at: STAMP
    });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('keeps a name the user gave it; leaves a layer that never came from a cloud alone', async () => {
    await seedFiledAsEdit({ name: 'My pick' });
    await syncLayersFromListing(inSync(), 'webdav');
    expect(await getLayerWithPages(db, 'v1', 'ppocr-manga')).toMatchObject({
      kind: 'ocr',
      name: 'My pick'
    });

    readOnly = true; // (so the never-synced row below is not pushed either)
    await seedFiledAsEdit({ cloud: undefined });
    await syncLayersFromListing(listing(cloudFile('Series/Vol 1.cbz')), 'webdav');
    expect((await getLayerWithPages(db, 'v1', 'ppocr-manga'))!.kind).toBe('edit');
  });
});

describe('a generation the server named itself', () => {
  /** What bunko writes: the pages plus a stamp naming the engine that read them. */
  function servedJson(text: string, engineId: string): string {
    return JSON.stringify({
      ...JSON.parse(mokuroJson(text)),
      ocr_engine: { id: engineId, detector: 'ctd', generator: 'mokuro-bunko 0.4.0' }
    });
  }

  it('is filed as OCR of the engine the FILE names, whatever the layer is called', async () => {
    await seedRow();
    downloadFile.mockResolvedValue(new Blob([servedJson('かな', 'hayai-nova')]));
    await syncLayersFromListing(
      listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.my-best-ocr.mokuro')),
      'webdav'
    );
    expect(await getLayerWithPages(db, 'v1', 'my-best-ocr')).toMatchObject({
      kind: 'ocr',
      engine: 'hayai-nova',
      name: 'My Best Ocr'
    });
  });

  it('leaves an unknown id with no stamp a person’s edit, as before', async () => {
    await seedRow();
    downloadFile.mockResolvedValue(new Blob([mokuroJson('かな')]));
    await syncLayersFromListing(
      listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.my-fixes.mokuro')),
      'webdav'
    );
    const layer = (await getLayerWithPages(db, 'v1', 'my-fixes'))!;
    expect(layer.kind).toBe('edit');
    expect(layer.engine).toBeUndefined();
  });

  it('ignores a stamp that is not an engine id', async () => {
    await seedRow();
    const junk = JSON.stringify({
      ...JSON.parse(mokuroJson('かな')),
      ocr_engine: { id: 'Not An Id' }
    });
    downloadFile.mockResolvedValue(new Blob([junk]));
    await syncLayersFromListing(
      listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.odd.mokuro')),
      'webdav'
    );
    expect((await getLayerWithPages(db, 'v1', 'odd'))!.kind).toBe('edit');
  });

  it('re-files a cloud row that was filed as an edit once its file says a server made it', async () => {
    const STAMP = '2026-09-16T10:00:00.000Z';
    await seedRow();
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'paddle-ctd',
      name: 'Paddle Ctd',
      kind: 'edit',
      created_at: STAMP,
      updated_at: STAMP,
      cloud: {
        provider: 'webdav',
        size: 100,
        modified: Date.parse(STAMP) / 1000,
        synced_at: STAMP
      },
      pages: [pg('えん')]
    });
    downloadFile.mockResolvedValue(new Blob([servedJson('かな', 'paddle-manga')]));
    // A newer cloud copy than the one the row was synced from: it is pulled.
    await syncLayersFromListing(
      listing(
        cloudFile('Series/Vol 1.cbz'),
        cloudFile('Series/Vol 1.paddle-ctd.mokuro', {
          size: 222,
          modifiedTime: '2026-09-17T10:00:00.000Z'
        })
      ),
      'webdav'
    );
    expect(await getLayerWithPages(db, 'v1', 'paddle-ctd')).toMatchObject({
      kind: 'ocr',
      engine: 'paddle-manga'
    });
    expect(uploadFile).not.toHaveBeenCalled();
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
    expect((await getLayerWithPages(db, 'v1', 'gcv'))!.kind).toBe('ocr');
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
    await putLayerWithPages(db, {
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
    await deleteLayerRows(db, 'v1', layerId);
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
    expect(await getLayerWithPages(db, 'v1', 'fix')).toBeUndefined();

    // The following listing gets the delete through.
    await syncLayersFromListing(files(), 'webdav');
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleteFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: layerPath }));
    expect(cacheRemove).toHaveBeenCalledWith(layerPath);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(await getLayerWithPages(db, 'v1', 'fix')).toBeUndefined();

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
    expect(await getLayerWithPages(db, 'v1', 'fix')).toBeUndefined();
  });

  it('a confirmed delete, and a layer that never reached a cloud, leave no tombstone', async () => {
    await seedSyncedLayer();
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile(layerPath, { size: 55 })];
    expect(await userDeletes()).toBe('gone');
    expect(deleteFile).toHaveBeenCalledTimes(1);

    await putLayerWithPages(db, {
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
      putLayerWithPages(db, {
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
    await deleteLayerRows(db, 'v1', 'fix');
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

  // The listing VIEW keeps one file per layer ("plain beats gz"). A delete that
  // worked from that view removed the plain copy, called the layer gone, and
  // the next listing — now showing only the `.gz` — pulled it straight back.
  describe('a layer listed as BOTH .mokuro and .mokuro.gz', () => {
    const gzPath = `${layerPath}.gz`;
    const both = () => [
      cloudFile('Series/Vol 1.cbz'),
      cloudFile(layerPath, { size: 55 }),
      cloudFile(gzPath, { size: 21 })
    ];

    it('the delete removes every copy, and nothing comes back', async () => {
      await seedSyncedLayer();
      cachedFiles = both();
      downloadFile.mockResolvedValue(new Blob([mokuroJson('もど')]));

      expect(await userDeletes()).toBe('gone');
      expect(deleteFile.mock.calls.map(([f]) => f.path).sort()).toEqual([layerPath, gzPath]);
      expect(cacheRemove).toHaveBeenCalledWith(layerPath);
      expect(cacheRemove).toHaveBeenCalledWith(gzPath);
      expect(localStorage.length).toBe(0);
    });

    it('one copy surviving keeps the tombstone: not pulled back, removed by the next listing', async () => {
      await seedSyncedLayer();
      cachedFiles = both();
      downloadFile.mockResolvedValue(new Blob([mokuroJson('もど')]));
      deleteFile.mockImplementation(async (f: CloudFileMetadata) => {
        if (f.path === gzPath) throw new Error('503');
      });

      expect(await userDeletes()).toBe('unconfirmed');
      // The failure of one copy never spares the other.
      expect(deleteFile).toHaveBeenCalledTimes(2);

      // The plain copy is gone; the listing now shows the survivor alone.
      deleteFile.mockReset();
      deleteFile.mockResolvedValue(undefined);
      const survivor = () =>
        listing(cloudFile('Series/Vol 1.cbz'), cloudFile(gzPath, { size: 21 }));
      await syncLayersFromListing(survivor(), 'webdav');
      expect(downloadFile).not.toHaveBeenCalled();
      expect(await getLayerWithPages(db, 'v1', 'fix')).toBeUndefined();
      expect(deleteFile).toHaveBeenCalledTimes(1);
      expect(deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: gzPath }));
      expect(localStorage.length).toBe(0);
    });

    it('a pending delete’s retry removes every copy too', async () => {
      await seedSyncedLayer();
      cachedFiles = both();
      getActiveProvider.mockReturnValue(null);
      expect(await userDeletes()).toBe('unconfirmed');
      getActiveProvider.mockReturnValue(provider());

      await syncLayersFromListing(listing(...both()), 'webdav');
      expect(deleteFile.mock.calls.map(([f]) => f.path).sort()).toEqual([layerPath, gzPath]);
      expect(downloadFile).not.toHaveBeenCalled();
      expect(localStorage.length).toBe(0);
    });
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
    await putLayerWithPages(db, {
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
    const row = (await getLayerWithPages(db, 'v1', 'fix'))!;
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
    await putLayerWithPages(db, {
      ...(await getLayerWithPages(db, 'v1', 'fix'))!,
      updated_at: T1,
      pages: [pg('あとのへんしゅう')]
    });
    // …and the upload completes.
    await stampLayersSynced('v1', 'webdav', snapshot);

    const row = (await getLayerWithPages(db, 'v1', 'fix'))!;
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
    expect((await getLayerWithPages(db, 'v1', 'fix'))!.pages[0].blocks[0].lines).toEqual([
      'あとのへんしゅう'
    ]);
  });

  it('a layer created after the serialize was never uploaded, so it is not stamped', async () => {
    await seedLayer();
    await stampLayersSynced('v1', 'webdav', []);
    expect((await getLayerWithPages(db, 'v1', 'fix'))!.cloud).toBeUndefined();
  });
});

/**
 * PERFORMANCE CONTRACT. A listing is planned on stamps alone: a layer's pages
 * are a whole volume of OCR, IndexedDB only reads whole rows, and a server that
 * writes an engine sidecar per volume lists a layer for every volume of the
 * library. So planning may read `volume_ocr_layers` (metadata) and must never
 * open `volume_ocr_layer_pages` — only an actual push reads pages, one layer at
 * a time.
 */
describe('planning a listing never reads layer pages', () => {
  const opsOn = (counts: Record<string, number>, store: string) =>
    Object.keys(counts).filter((key) => key.startsWith(`${store}.`));

  async function seedSynced(volume_uuid: string, volume_title: string) {
    await seedRow(volume_title, volume_uuid);
    await putLayerWithPages(db, {
      volume_uuid,
      layer_id: 'gcv',
      name: 'Gcv',
      kind: 'ocr',
      engine: 'gcv',
      created_at: '2026-09-16T09:00:00.000Z',
      updated_at: '2026-09-16T09:00:00.000Z',
      pages: [pg('あい')],
      cloud: {
        provider: 'webdav',
        size: 100,
        modified: 1789552800,
        synced_at: '2026-09-16T09:00:00.000Z'
      }
    });
  }

  it('in-sync layers: metadata is read in ONE query per folder, pages never', async () => {
    await seedSynced('v1', 'Vol 1');
    await seedSynced('v2', 'Vol 2');
    await seedSynced('v3', 'Vol 3');
    const files = listing(
      ...['Vol 1', 'Vol 2', 'Vol 3'].flatMap((title) => [
        cloudFile(`Series/${title}.cbz`),
        cloudFile(`Series/${title}.gcv.mokuro`)
      ])
    );

    const counts = await countIdbOps(() => syncLayersFromListing(files, 'webdav'));

    expect(downloadFile).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(opsOn(counts, 'volume_ocr_layer_pages')).toEqual([]);
    // Anchor: the plan DID consult the metadata table (so the empty list above
    // is not a counter that saw nothing) — once for "who has layers at all"
    // (keys only) and once for the whole folder, not once per volume.
    expect(counts['volume_ocr_layers.idx.openKeyCursor']).toBe(1);
    const valueReads = opsOn(counts, 'volume_ocr_layers').filter(
      (key) => !key.endsWith('openKeyCursor') && !key.endsWith('.bytes')
    );
    expect(valueReads.reduce((sum, key) => sum + counts[key], 0)).toBe(1);
  });

  it('a push reads the pages of the layer it uploads, and only that one', async () => {
    await seedSynced('v1', 'Vol 1');
    await seedSynced('v2', 'Vol 2');
    // v2's layer was edited after its sync; v1's was not.
    await putLayerWithPages(db, {
      ...(await getLayerWithPages(db, 'v2', 'gcv'))!,
      updated_at: '2026-09-16T11:00:00.000Z',
      pages: [pg('へんしゅう')]
    });
    const files = listing(
      cloudFile('Series/Vol 1.cbz'),
      cloudFile('Series/Vol 1.gcv.mokuro'),
      cloudFile('Series/Vol 2.cbz'),
      cloudFile('Series/Vol 2.gcv.mokuro')
    );

    const counts = await countIdbOps(() => syncLayersFromListing(files, 'webdav'));

    expect(uploadFile).toHaveBeenCalledTimes(1);
    const [path, blob] = uploadFile.mock.calls[0] as [string, Blob];
    expect(path).toBe('Series/Vol 2.gcv.mokuro');
    expect(JSON.parse(await blob.text()).pages[0].blocks[0].lines).toEqual(['へんしゅう']);
    expect(counts['volume_ocr_layer_pages.get']).toBe(1);
    expect(opsOn(counts, 'volume_ocr_layer_pages')).toEqual(['volume_ocr_layer_pages.get']);
  });

  it('no layer files listed and no layers on this device: not even the volumes are read', async () => {
    await seedRow('Vol 1', 'v1');
    const files = listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.mokuro'));

    const counts = await countIdbOps(() => syncLayersFromListing(files, 'webdav'));

    expect(opsOn(counts, 'volume_ocr_layer_pages')).toEqual([]);
    expect(opsOn(counts, 'volumes')).toEqual([]);
    expect(opsOn(counts, 'volume_ocr_layers')).toEqual(['volume_ocr_layers.idx.openKeyCursor']);
  });

  it('a folder with nothing listed and nothing local is skipped while another folder syncs', async () => {
    await seedSynced('v1', 'Vol 1');
    await db.volumes.put({
      volume_uuid: 'o1',
      series_uuid: 's2',
      series_title: 'Other',
      volume_title: 'Vol 1',
      mokuro_version: '0.2.1',
      page_count: 1,
      character_count: 2,
      page_char_counts: [2]
    });
    const files = listing(
      cloudFile('Series/Vol 1.cbz'),
      cloudFile('Series/Vol 1.gcv.mokuro'),
      cloudFile('Other/Vol 1.cbz')
    );

    const counts = await countIdbOps(() => syncLayersFromListing(files, 'webdav'));

    expect(opsOn(counts, 'volume_ocr_layer_pages')).toEqual([]);
    // Still one metadata value-read in total: 'Other' issued none of its own.
    const valueReads = opsOn(counts, 'volume_ocr_layers').filter(
      (key) => !key.endsWith('openKeyCursor') && !key.endsWith('.bytes')
    );
    expect(valueReads.reduce((sum, key) => sum + counts[key], 0)).toBe(1);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('a spent tombstone is still retired in a folder that has nothing else to do', async () => {
    await seedRow('Vol 1', 'v1');
    getActiveProvider.mockReturnValue(null);
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'fix',
      name: 'Fix',
      kind: 'edit',
      created_at: '2026-09-16T09:00:00.000Z',
      updated_at: '2026-09-16T09:00:00.000Z',
      pages: [pg('あい')],
      cloud: { provider: 'webdav', size: 100, synced_at: '2026-09-16T09:00:00.000Z' }
    });
    expect(await deleteCloudLayerFile('v1', 'fix')).toBe('unconfirmed');
    await deleteLayerRows(db, 'v1', 'fix');
    expect(localStorage.length).toBe(1);

    // The file is gone from the cloud by the next listing (another device).
    getActiveProvider.mockReturnValue(provider());
    await syncLayersFromListing(listing(cloudFile('Series/Vol 1.cbz')), 'webdav');
    expect(localStorage.length).toBe(0);
  });
});

describe("importFetchedLayers (a deep link's manifest)", () => {
  const URL_BASE = 'https://bunko.example/mokuro-reader/Series/';
  const MODIFIED = '2026-09-27T01:02:05.000Z';

  function servedJson(text: string, engineId: string): string {
    return JSON.stringify({
      ...JSON.parse(mokuroJson(text)),
      ocr_engine: { id: engineId, detector: 'ctd', generator: 'mokuro-bunko 0.5.0' }
    });
  }

  function fetched(layerId: string, body: string | Blob, extra: Record<string, unknown> = {}) {
    return {
      layerId,
      gz: false,
      blob: typeof body === 'string' ? new Blob([body]) : body,
      label: `${URL_BASE}Vol%201.${layerId}.mokuro`,
      size: 67,
      modifiedTime: MODIFIED,
      ...extra
    };
  }

  async function gzip(text: string): Promise<Blob> {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).blob();
  }

  it('files a stamped layer by the engine the file names, stamped with its source', async () => {
    await seedRow();
    const n = await importFetchedLayers('v1', 'html-download', [
      fetched('hayai-nova-ppocr', servedJson('かな', 'hayai-nova'))
    ]);
    expect(n).toBe(1);
    const layer = (await getLayerWithPages(db, 'v1', 'hayai-nova-ppocr'))!;
    expect(layer).toMatchObject({ kind: 'ocr', engine: 'hayai-nova' });
    expect(layer.pages[0].blocks[0].lines).toEqual(['かな']);
    expect('cumulativeChars' in layer.pages[0]).toBe(false);
    expect(layer.cloud).toMatchObject({
      provider: 'html-download',
      size: 67,
      modified: Date.parse(MODIFIED) / 1000
    });
  });

  it("leaves an unstamped unknown id a person's edit, exactly as a cloud pull does", async () => {
    await seedRow();
    await importFetchedLayers('v1', 'html-download', [fetched('my-fixes', mokuroJson('かな'))]);
    const layer = (await getLayerWithPages(db, 'v1', 'my-fixes'))!;
    expect(layer.kind).toBe('edit');
    expect(layer.engine).toBeUndefined();
  });

  it('decodes a .gz layer', async () => {
    await seedRow();
    const n = await importFetchedLayers('v1', 'html-download', [
      fetched('paddle', await gzip(servedJson('ろ', 'paddle')), { gz: true })
    ]);
    expect(n).toBe(1);
    expect((await getLayerWithPages(db, 'v1', 'paddle'))!.pages[0].blocks[0].lines).toEqual(['ろ']);
  });

  it('skips a file that is not a layer, warning with its name, and imports the rest', async () => {
    await seedRow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = fetched('broken', '{ not json');
    const n = await importFetchedLayers('v1', 'html-download', [
      bad,
      fetched('paddle', servedJson('ろ', 'paddle'))
    ]);
    expect(n).toBe(1);
    expect(await getLayerWithPages(db, 'v1', 'broken')).toBeUndefined();
    expect(warn.mock.calls.some((c) => c.join(' ').includes(bad.label))).toBe(true);
    warn.mockRestore();
  });

  it('refuses a layer of another page count, warning with its name', async () => {
    await seedRow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const twoPages = JSON.stringify({
      ...JSON.parse(mokuroJson('か')),
      pages: [pg('か', 'a.png'), pg('き', 'b.png')]
    });
    const file = fetched('paddle', twoPages);
    expect(await importFetchedLayers('v1', 'html-download', [file])).toBe(0);
    expect(await getLayerWithPages(db, 'v1', 'paddle')).toBeUndefined();
    expect(warn.mock.calls.some((c) => c.join(' ').includes(file.label))).toBe(true);
    warn.mockRestore();
  });

  it('never overwrites a layer edited here since its last sync', async () => {
    await seedRow();
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'paddle',
      name: 'Paddle',
      kind: 'ocr',
      engine: 'paddle',
      created_at: '2026-09-27T00:00:00.000Z',
      updated_at: '2026-09-27T03:00:00.000Z',
      pages: [pg('mine')],
      cloud: {
        provider: 'html-download',
        size: 67,
        modified: Date.parse(MODIFIED) / 1000,
        synced_at: '2026-09-27T02:00:00.000Z'
      }
    });
    expect(
      await importFetchedLayers('v1', 'html-download', [
        fetched('paddle', servedJson('ろ', 'paddle'))
      ])
    ).toBe(0);
    expect((await getLayerWithPages(db, 'v1', 'paddle'))!.pages[0].blocks[0].lines).toEqual([
      'mine'
    ]);
  });

  it('replaces a passive snapshot that came out of the archive', async () => {
    await seedRow();
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'paddle',
      name: 'Paddle',
      kind: 'ocr',
      engine: 'paddle',
      created_at: '2026-09-27T00:00:00.000Z',
      updated_at: '2026-09-27T00:00:00.000Z',
      passive_at: '2026-09-27T00:00:00.000Z',
      pages: [pg('old')]
    });
    expect(
      await importFetchedLayers('v1', 'html-download', [
        fetched('paddle', servedJson('ろ', 'paddle'))
      ])
    ).toBe(1);
    expect((await getLayerWithPages(db, 'v1', 'paddle'))!.pages[0].blocks[0].lines).toEqual(['ろ']);
  });

  it('stamps size only when the source gave no modification time', async () => {
    await seedRow();
    await importFetchedLayers('v1', 'html-download', [
      fetched('paddle', servedJson('ろ', 'paddle'), { modifiedTime: undefined, size: undefined })
    ]);
    const layer = (await getLayerWithPages(db, 'v1', 'paddle'))!;
    expect(layer.cloud!.modified).toBeUndefined();
    expect(layer.cloud!.size).toBeGreaterThan(0);
  });

  it('does nothing for a volume that is gone or a placeholder', async () => {
    expect(
      await importFetchedLayers('nope', 'html-download', [
        fetched('paddle', servedJson('ろ', 'paddle'))
      ])
    ).toBe(0);
  });

  it('a later WebDAV listing of the same file takes the row over from the deep link', async () => {
    await seedRow();
    await importFetchedLayers('v1', 'html-download', [
      fetched('paddle', servedJson('ろ', 'paddle'))
    ]);
    const row = (await getLayerWithPages(db, 'v1', 'paddle'))!;
    const listed = cloudFile('Series/Vol 1.paddle.mokuro', { size: 67, modifiedTime: MODIFIED });
    expect(layerNeedsPull(row, listed, 'webdav')).toBe(true);
    expect(layerNeedsPush(row, listed, 'webdav')).toBe(false);
  });
});
