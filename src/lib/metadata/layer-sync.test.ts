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
import { forksOnEdit } from '$lib/reader/edit/layer-kind';
import { contentDigest, provenanceFromParsed } from '$lib/catalog/ocr-provenance';
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
  listedCuratedLayerFile,
  publishCuratedLayer,
  pullLayersForVolume,
  pullOwnEditLayerBeforeEdit,
  unpublishCuratedLayer,
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
let editLayerSync: 'push' | 'local' | undefined = undefined;
let accountScope: string | undefined = undefined;
let curatedPublish: 'all' | 'owned' | 'none' | undefined = undefined;
let curatedVolumes: { series: string; volume: string }[] | undefined = undefined;
let refreshIdentity: ((options?: { maxAgeMs?: number }) => Promise<void>) | undefined = undefined;

function provider(type = 'webdav') {
  return {
    type,
    refreshIdentity: (options?: { maxAgeMs?: number }) => refreshIdentity?.(options),
    getStatus: () => ({
      isReadOnly: readOnly,
      canAddFiles,
      serverCompilesMetadata,
      editLayerSync,
      accountScope,
      curatedPublish,
      curatedVolumes
    }),
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
  editLayerSync = undefined;
  accountScope = undefined;
  curatedPublish = undefined;
  curatedVolumes = undefined;
  refreshIdentity = undefined;
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

describe('collectLayerFiles under sidecar names rule v1', () => {
  it('folds stems NFC + lowercase, keeps ids as written, and files a layer under the exactly-spelled archive first', () => {
    const NFC = 'V\u00f3l 1';
    const NFD = 'Vo\u0301l 1';
    const files = collectLayerFiles(
      listing(
        cloudFile(`Series/${NFC}.cbz`),
        cloudFile(`Series/${NFD}.gcv.mokuro`),
        cloudFile('Series/Vol 2.cbz'),
        cloudFile('Series/Vol 2.GCV.mokuro'),
        cloudFile('Series/Vol 2.2024.mokuro'),
        cloudFile('Series/Vol 3.cbz'),
        cloudFile('Series/vol 3.cbz'),
        cloudFile('Series/Vol 3.hayai.mokuro'),
        cloudFile('Series/vol 3.hayai.mokuro')
      )
    );
    expect(files.map((f) => [f.stem, f.layerId, f.file.path])).toEqual([
      [NFC, 'gcv', `Series/${NFD}.gcv.mokuro`],
      ['Vol 2', '2024', 'Series/Vol 2.2024.mokuro'],
      ['Vol 3', 'hayai', 'Series/Vol 3.hayai.mokuro'],
      ['vol 3', 'hayai', 'Series/vol 3.hayai.mokuro']
    ]);
  });

  it('a layer spelled like NEITHER of two folded-alike archives has ONE owner, whatever the listing order', () => {
    const files = [
      cloudFile('Series/Vol 3.cbz'),
      cloudFile('Series/VOL 3.cbz'),
      cloudFile('Series/vol 3.hayai.mokuro')
    ];
    const owners = (fs: CloudFileMetadata[]) =>
      collectLayerFiles(listing(...fs)).map((f) => [f.stem, f.layerId]);
    // naturalSort-first of the archives that fold alike ('O' < 'o'), not the one listed last.
    expect(owners(files)).toEqual([['VOL 3', 'hayai']]);
    expect(owners([...files].reverse())).toEqual([['VOL 3', 'hayai']]);
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

  it('a v1.10.0 previous-ocr leftover, untouched, is never pushed before the startup cleanup deletes it', () => {
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

  it('a pulled pre-upgrade layer is an ordinary hand-made layer: named from its id', async () => {
    await seedRow();
    downloadFile.mockResolvedValue(new Blob([mokuroJson('旧')]));
    await syncLayersFromListing(
      listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.pre-upgrade.mokuro')),
      'webdav'
    );
    expect(await getLayerWithPages(db, 'v1', 'pre-upgrade')).toMatchObject({
      kind: 'edit',
      name: 'Pre Upgrade'
    });
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

  it('a push the server refuses (403) is not asked again until the layer changes', async () => {
    const { ProviderError } = await import('$lib/util/sync/provider-interface');
    const { resetRefusedLayerPushesForTest } = await import('./layer-sync');
    resetRefusedLayerPushesForTest();
    await seedRow();
    const layer = {
      volume_uuid: 'v1',
      layer_id: 'hayai-nova',
      name: 'hayai-nova',
      kind: 'ocr' as const,
      created_at: '2026-09-16T09:00:00.000Z',
      updated_at: '2026-09-16T09:00:00.000Z',
      pages: [pg('なお')]
    };
    await putLayerWithPages(db, layer);
    const files = listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.mokuro'));
    uploadFile.mockRejectedValue(
      new ProviderError('no', 'webdav', 'PERMISSION_DENIED', false, false, 'permission')
    );
    await syncLayersFromListing(files, 'webdav');
    await syncLayersFromListing(files, 'webdav');
    expect(uploadFile).toHaveBeenCalledTimes(1);

    // A new edit is a new request.
    await putLayerWithPages(db, { ...layer, updated_at: '2026-09-16T10:00:00.000Z' });
    await syncLayersFromListing(files, 'webdav');
    expect(uploadFile).toHaveBeenCalledTimes(2);
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
    // Upstream format plus, for a layer of a person's corrections, the D4
    // `edited` block — and never an `ocr_engine` stamp.
    expect(Object.keys(json).sort()).toEqual([
      'chars',
      'edited',
      'pages',
      'title',
      'title_uuid',
      'version',
      'volume',
      'volume_uuid'
    ]);
    expect(json.edited).toEqual({
      by: 'mokuro-reader',
      at: '2026-09-16T09:00:00.000Z',
      base_sha256: null,
      base_seal: null
    });
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

  it('files a stamped curated, personal or curated-<n> file as corrections, never as OCR', async () => {
    await seedRow();
    downloadFile.mockResolvedValue(new Blob([servedJson('かな', 'hayai-nova')]));
    await syncLayersFromListing(
      listing(
        cloudFile('Series/Vol 1.cbz'),
        cloudFile('Series/Vol 1.curated.mokuro'),
        cloudFile('Series/Vol 1.edit-2.mokuro'),
        cloudFile('Series/Vol 1.curated-2.mokuro'),
        cloudFile('Series/Vol 1.pre-upgrade.mokuro')
      ),
      'webdav'
    );
    expect(await getLayerWithPages(db, 'v1', 'curated')).toMatchObject({
      kind: 'edit',
      name: 'Shared corrections'
    });
    expect((await getLayerWithPages(db, 'v1', 'curated'))!.engine).toBeUndefined();
    expect(await getLayerWithPages(db, 'v1', 'edit-2')).toMatchObject({
      kind: 'edit',
      name: 'Your corrections 2'
    });
    expect((await getLayerWithPages(db, 'v1', 'curated-2'))!.kind).toBe('edit');
    // Not a corrections id any more: a stamped `pre-upgrade` is a server's OCR,
    // like any other hand-made id with a stamp.
    expect(await getLayerWithPages(db, 'v1', 'pre-upgrade')).toMatchObject({
      kind: 'ocr',
      engine: 'hayai-nova'
    });
  });

  it('never re-files a cloud curated row as OCR when a newer stamped copy arrives', async () => {
    const STAMP = '2026-09-16T10:00:00.000Z';
    await seedRow();
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'curated',
      name: 'Shared corrections',
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
    await syncLayersFromListing(
      listing(
        cloudFile('Series/Vol 1.cbz'),
        cloudFile('Series/Vol 1.curated.mokuro', {
          size: 222,
          modifiedTime: '2026-09-17T10:00:00.000Z'
        })
      ),
      'webdav'
    );
    const row = (await getLayerWithPages(db, 'v1', 'curated'))!;
    expect(row.kind).toBe('edit');
    expect(row.engine).toBeUndefined();
    expect(row.pages[0].blocks[0].lines).toEqual(['かな']);
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

    it('a copy that fails stops the delete and keeps the tombstone: not pulled back, removed by the next listing', async () => {
      await seedSyncedLayer();
      cachedFiles = both();
      downloadFile.mockResolvedValue(new Blob([mokuroJson('もど')]));
      deleteFile.mockImplementation(async (f: CloudFileMetadata) => {
        if (f.path === gzPath) throw new Error('503');
      });

      expect(await userDeletes()).toBe('unconfirmed');
      // The `.gz` goes first, and its failure stops the delete: removing the
      // plain copy anyway would leave the `.gz` read in its place.
      expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual([gzPath]);

      // Both copies are still listed; the tombstone's retry takes them both.
      deleteFile.mockReset();
      deleteFile.mockResolvedValue(undefined);
      await syncLayersFromListing(listing(...both()), 'webdav');
      expect(downloadFile).not.toHaveBeenCalled();
      expect(await getLayerWithPages(db, 'v1', 'fix')).toBeUndefined();
      expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual([gzPath, layerPath]);
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

  // Case-sensitive storage can hold `Vol 1.cbz` AND `vol 1.cbz` — two volumes
  // that fold onto ONE local row. The row owns only the layers of the archive
  // spelled like its own title; the other volume's layer files are never its.
  describe('two archives that fold alike in one folder (case-sensitive storage)', () => {
    const otherPath = 'Series/vol 1.fix.mokuro';
    const both = () => [
      cloudFile('Series/Vol 1.cbz'),
      cloudFile('Series/vol 1.cbz'),
      cloudFile(layerPath, { size: 55 }),
      cloudFile(otherPath, { size: 66 })
    ];

    it('a row takes only the layers of the archive spelled like its title; the other volume’s are never pulled', async () => {
      await seedRow();
      downloadFile.mockResolvedValue(new Blob([mokuroJson('もど')]));
      await syncLayersFromListing(listing(...both()), 'webdav');
      expect(downloadFile).toHaveBeenCalledTimes(1);
      expect(downloadFile).toHaveBeenCalledWith(expect.objectContaining({ path: layerPath }));
      expect((await getLayerWithPages(db, 'v1', 'fix'))?.cloud?.size).toBe(55);
    });

    it('an offline delete removes only the row’s own copy, and the other spelling never comes back as the layer', async () => {
      await seedSyncedLayer();
      cachedFiles = both();
      getActiveProvider.mockReturnValue(null);
      expect(await userDeletes()).toBe('unconfirmed');
      getActiveProvider.mockReturnValue(provider());
      downloadFile.mockResolvedValue(new Blob([mokuroJson('もど')]));

      await syncLayersFromListing(listing(...both()), 'webdav');
      expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual([layerPath]);
      expect(downloadFile).not.toHaveBeenCalled();
      expect(localStorage.length).toBe(0);

      // The next listing shows the other volume's file alone: not ours, not pulled.
      await syncLayersFromListing(
        listing(
          cloudFile('Series/Vol 1.cbz'),
          cloudFile('Series/vol 1.cbz'),
          cloudFile(otherPath, { size: 66 })
        ),
        'webdav'
      );
      expect(downloadFile).not.toHaveBeenCalled();
      expect(deleteFile).toHaveBeenCalledTimes(1);
      expect(await getLayerWithPages(db, 'v1', 'fix')).toBeUndefined();
    });

    it('an online delete removes only the row’s own copy, whatever the listing order', async () => {
      await seedSyncedLayer();
      cachedFiles = both().reverse();
      expect(await userDeletes()).toBe('gone');
      expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual([layerPath]);
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

  it('a layer on this device does not make every other folder read its volumes', async () => {
    await seedSynced('v1', 'Vol 1');
    for (const series of ['Other A', 'Other B', 'Other C']) {
      await db.volumes.put({
        volume_uuid: `${series}-1`,
        series_uuid: series,
        series_title: series,
        volume_title: 'Vol 1',
        mokuro_version: '0.2.1',
        page_count: 1,
        character_count: 2,
        page_char_counts: [2]
      });
    }
    const files = listing(
      cloudFile('Series/Vol 1.cbz'),
      cloudFile('Other A/Vol 1.cbz'),
      cloudFile('Other B/Vol 1.cbz'),
      cloudFile('Other C/Vol 1.cbz')
    );

    const counts = await countIdbOps(() => syncLayersFromListing(files, 'webdav'));

    // One keys-only pass folds every series title; only 'Series' (the one with
    // a layer) reads its rows. The three others issue nothing of their own.
    const volumeReads = opsOn(counts, 'volumes').filter((key) => !key.endsWith('openKeyCursor'));
    expect(volumeReads.reduce((sum, key) => sum + counts[key], 0)).toBe(1);
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

describe('personal and shared correction layers (bunko 0.8)', () => {
  const T0 = '2026-09-16T09:00:00.000Z';
  const T1 = '2026-09-16T09:30:00.000Z';
  const ACCOUNT_A = 'webdav:https://host|alice';
  const ACCOUNT_B = 'webdav:https://host|bob';

  /** A local layer edited after its last sync (or never synced). */
  async function seedLayer(layer_id: string, over: Partial<VolumeOcrLayer> = {}) {
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id,
      name: layer_id,
      kind: 'edit',
      created_at: T0,
      updated_at: T1,
      pages: [pg('なお')],
      ...over
    });
  }
  const files = () => listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.mokuro'));
  const uploaded = () => uploadFile.mock.calls.map((c) => c[0]).sort();

  it('a registered account on a per-account server pushes its edit layer and nothing else', async () => {
    await seedRow();
    await seedLayer('edit');
    await seedLayer('edit-2');
    await seedLayer('fix');
    await seedLayer('curated');
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    canAddFiles = false; // registered: WriteProgress only
    await syncLayersFromListing(files(), 'webdav');
    expect(uploaded()).toEqual(['Series/Vol 1.edit-2.mokuro', 'Series/Vol 1.edit.mokuro']);
  });

  it('a 0.7.x bunko (edit layers shared there) never gets a PUT of an edit layer', async () => {
    await seedRow();
    await seedLayer('edit');
    await seedLayer('edit-3');
    await seedLayer('fix');
    serverCompilesMetadata = true;
    editLayerSync = 'local';
    canAddFiles = true;
    await syncLayersFromListing(files(), 'webdav');
    expect(uploaded()).toEqual(['Series/Vol 1.fix.mokuro']);
  });

  it('a curated row edited locally is never pushed, anywhere', async () => {
    await seedRow();
    await seedLayer('curated');
    for (const [compiles, gate] of [
      [false, undefined],
      [true, 'push'],
      [true, 'local']
    ] as const) {
      serverCompilesMetadata = compiles;
      editLayerSync = gate;
      await syncLayersFromListing(files(), 'webdav');
    }
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('pre-upgrade / previous-ocr layers are hand-made layers on bunko: pushed like any other', async () => {
    // bunko no longer writes or reserves either family (sidecar names rule v1:
    // `other`), so they go up under AddFiles like `fix` does.
    await seedRow();
    await seedLayer('pre-upgrade');
    await seedLayer('pre-upgrade-2');
    await seedLayer('previous-ocr');
    await seedLayer('fix');
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    canAddFiles = true;
    await syncLayersFromListing(files(), 'webdav');
    expect(uploaded()).toEqual([
      'Series/Vol 1.fix.mokuro',
      'Series/Vol 1.pre-upgrade-2.mokuro',
      'Series/Vol 1.pre-upgrade.mokuro',
      'Series/Vol 1.previous-ocr.mokuro'
    ]);
  });

  it('…and, like any library file, not by a progress-only account', async () => {
    await seedRow();
    await seedLayer('pre-upgrade');
    await seedLayer('previous-ocr');
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    canAddFiles = false; // registered: WriteProgress only
    await syncLayersFromListing(files(), 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("bunko's curated-<n> (a case merge's keepsake) is corrections it alone writes: never pushed, never deleted from here", async () => {
    // bunko classes `curated-<n>` Reserved: a client PUT is a 403, and a DELETE by
    // a ModifyDelete account would remove the keepsake for every account.
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    canAddFiles = true;
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.curated-2.mokuro')];
    // A stamp naming an engine, as a curated file carries: still filed as corrections.
    const stamped = JSON.stringify({
      ...JSON.parse(mokuroJson('かな')),
      ocr_engine: { id: 'hayai-nova', detector: 'ctd', generator: 'mokuro-bunko 0.8.0' }
    });
    downloadFile.mockResolvedValue(new Blob([stamped]));
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    const pulled = await getLayerWithPages(db, 'v1', 'curated-2');
    expect(pulled).toMatchObject({ kind: 'edit' });
    expect(pulled!.engine).toBeUndefined();
    expect(forksOnEdit(pulled!, { serverCompilesMetadata: true })).toBe(true);

    // Even a row edited here (an older reader edited it in place) stays local.
    await putLayerWithPages(db, { ...pulled!, updated_at: '2099-01-01T00:00:00.000Z' });
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();

    expect(await deleteCloudLayerFile('v1', 'curated-2')).toBe('kept-shared');
    await deleteLayerRows(db, 'v1', 'curated-2');
    downloadFile.mockClear();
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    expect(deleteFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("bunko's own OCR, edited here in place before its status was known, never goes up over the model output", async () => {
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    canAddFiles = true;
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.hayai.mokuro')];
    const stamped = JSON.stringify({
      ...JSON.parse(mokuroJson('かな')),
      ocr_engine: { id: 'hayai', detector: 'ctd', generator: 'mokuro-bunko 0.8.0' }
    });
    downloadFile.mockResolvedValue(new Blob([stamped]));
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    const pulled = await getLayerWithPages(db, 'v1', 'hayai');
    expect(pulled).toMatchObject({ kind: 'ocr', engine: 'hayai' });
    expect(forksOnEdit(pulled!, { serverCompilesMetadata: true })).toBe(true);
    // The editor opened while the provider still said plain storage (signing
    // in, or a cloud-direct marker not read yet): the row is edited in place.
    expect(forksOnEdit(pulled!, { serverCompilesMetadata: false })).toBe(false);
    await putLayerWithPages(db, { ...pulled!, updated_at: '2099-01-01T00:00:00.000Z' });
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();

    // The status reads plain storage again (stale marker, failed probe): the
    // row was pulled from a bunko (`cloud.server_compiled`), so still not.
    serverCompilesMetadata = false;
    editLayerSync = undefined;
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('a server OCR row pulled from plain storage and edited is the user’s own file: it goes up', async () => {
    await seedRow();
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.hayai.mokuro')];
    const stamped = JSON.stringify({
      ...JSON.parse(mokuroJson('かな')),
      ocr_engine: { id: 'hayai', detector: 'ctd', generator: 'mokuro-bunko 0.8.0' }
    });
    downloadFile.mockResolvedValue(new Blob([stamped]));
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    const pulled = await getLayerWithPages(db, 'v1', 'hayai');
    await putLayerWithPages(db, { ...pulled!, updated_at: '2099-01-01T00:00:00.000Z' });
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it('…and a rewrite of that layer by bunko never replaces the corrections made in it', async () => {
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    canAddFiles = true;
    const served = (text: string) =>
      new Blob([
        JSON.stringify({
          ...JSON.parse(mokuroJson(text)),
          ocr_engine: { id: 'hayai', detector: 'ctd', generator: 'mokuro-bunko 0.8.0' }
        })
      ]);
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.hayai.mokuro')];
    downloadFile.mockResolvedValue(served('かな'));
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    const pulled = (await getLayerWithPages(db, 'v1', 'hayai'))!;
    // Edited in place in the fork window (the provider said plain storage).
    const syncedAt = Date.parse(pulled.cloud!.synced_at);
    await putLayerWithPages(db, {
      ...pulled,
      updated_at: new Date(syncedAt + 60_000).toISOString(),
      pages: [pg('なおし')]
    });

    // bunko re-runs the engine at a newer revision and rewrites the file in place.
    downloadFile.mockClear();
    downloadFile.mockResolvedValue(served('あたらしい'));
    const rewritten = cloudFile('Series/Vol 1.hayai.mokuro', {
      size: 333,
      modifiedTime: new Date(syncedAt + 3_600_000).toISOString()
    });
    await syncLayersFromListing(listing(cloudFile('Series/Vol 1.cbz'), rewritten), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect((await getLayerWithPages(db, 'v1', 'hayai'))!.pages[0].blocks[0].lines).toEqual([
      'なおし'
    ]);

    // The status reads plain storage again (a stale cloud-direct marker, /me
    // 'unsupported'): the row remembers it came from a server that compiles
    // its metadata, and the corrections still stay.
    serverCompilesMetadata = false;
    editLayerSync = undefined;
    await syncLayersFromListing(listing(cloudFile('Series/Vol 1.cbz'), rewritten), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect((await getLayerWithPages(db, 'v1', 'hayai'))!.pages[0].blocks[0].lines).toEqual([
      'なおし'
    ]);
    // Nor do the corrections go up over the server's file for every account,
    // the cloud copy unchanged since the pull and all.
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('…while a server OCR row pulled from plain storage is an ordinary layer file: newest wins', async () => {
    await seedRow();
    const served = (text: string) =>
      new Blob([
        JSON.stringify({
          ...JSON.parse(mokuroJson(text)),
          ocr_engine: { id: 'hayai', detector: 'ctd', generator: 'mokuro-bunko 0.8.0' }
        })
      ]);
    downloadFile.mockResolvedValue(served('かな'));
    await syncLayersFromListing(
      listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.hayai.mokuro')),
      'webdav'
    );
    const pulled = (await getLayerWithPages(db, 'v1', 'hayai'))!;
    expect(pulled.cloud).not.toHaveProperty('server_compiled');
    const syncedAt = Date.parse(pulled.cloud!.synced_at);
    await putLayerWithPages(db, {
      ...pulled,
      updated_at: new Date(syncedAt + 60_000).toISOString(),
      pages: [pg('なおし')]
    });
    downloadFile.mockClear();
    downloadFile.mockResolvedValue(served('あたらしい'));
    const rewritten = cloudFile('Series/Vol 1.hayai.mokuro', {
      size: 333,
      modifiedTime: new Date(syncedAt + 3_600_000).toISOString()
    });
    await syncLayersFromListing(listing(cloudFile('Series/Vol 1.cbz'), rewritten), 'webdav');
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it('an edited previous-ocr layer syncs on bunko and plain storage alike', async () => {
    for (const compiles of [true, false]) {
      await seedRow();
      await seedLayer('previous-ocr', { kind: 'ocr' });
      serverCompilesMetadata = compiles;
      editLayerSync = compiles ? 'push' : undefined;
      canAddFiles = true;
      uploadFile.mockClear();
      await syncLayersFromListing(files(), 'webdav');
      expect(uploaded(), `serverCompilesMetadata ${compiles}`).toEqual([
        'Series/Vol 1.previous-ocr.mokuro'
      ]);
      await deleteLayerRows(db, 'v1', 'previous-ocr');
    }
  });

  it('a read-only account pushes nothing, edit layer included', async () => {
    await seedRow();
    await seedLayer('edit');
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    readOnly = true;
    await syncLayersFromListing(files(), 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('a registered account deletes its own edit layer file, but never a shared one', async () => {
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    canAddFiles = false;
    const synced = { provider: 'webdav', size: 100, modified: 1789552800, synced_at: T1 };
    await seedLayer('edit', { cloud: synced });
    await seedLayer('fix', { cloud: synced });
    cachedFiles = [
      cloudFile('Series/Vol 1.cbz'),
      cloudFile('Series/Vol 1.edit.mokuro'),
      cloudFile('Series/Vol 1.fix.mokuro')
    ];
    expect(await deleteCloudLayerFile('v1', 'edit')).toBe('gone');
    // A library file a progress-only account may not delete: maybe later, by another.
    expect(await deleteCloudLayerFile('v1', 'fix')).toBe('unconfirmed');
    expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual(['Series/Vol 1.edit.mokuro']);
  });

  it('deleting a curated row here never deletes the shared file, and it is not pulled back', async () => {
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    canAddFiles = true;
    await seedLayer('curated', {
      updated_at: T0,
      cloud: { provider: 'webdav', size: 100, modified: 1789552800, synced_at: T0 }
    });
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.curated.mokuro')];
    expect(await deleteCloudLayerFile('v1', 'curated')).toBe('kept-shared');
    await deleteLayerRows(db, 'v1', 'curated');
    downloadFile.mockResolvedValue(new Blob([mokuroJson('もど')]));
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    expect(deleteFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("a shared edit layer (0.7.x) is 'kept-shared', and stays hidden", async () => {
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'local';
    canAddFiles = true;
    const synced = { provider: 'webdav', size: 100, modified: 1789552800, synced_at: T0 };
    await seedLayer('edit', { updated_at: T0, cloud: synced });
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.edit.mokuro')];
    expect(await deleteCloudLayerFile('v1', 'edit')).toBe('kept-shared');
    await deleteLayerRows(db, 'v1', 'edit');
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    expect(deleteFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('a pre-upgrade / previous-ocr layer on bunko is deleted from the cloud like any other', async () => {
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    canAddFiles = true;
    const synced = { provider: 'webdav', size: 100, modified: 1789552800, synced_at: T0 };
    await seedLayer('pre-upgrade', { updated_at: T0, cloud: synced });
    await seedLayer('previous-ocr-2', { updated_at: T0, cloud: synced });
    cachedFiles = [
      cloudFile('Series/Vol 1.cbz'),
      cloudFile('Series/Vol 1.pre-upgrade.mokuro'),
      cloudFile('Series/Vol 1.previous-ocr-2.mokuro')
    ];
    expect(await deleteCloudLayerFile('v1', 'pre-upgrade')).toBe('gone');
    expect(await deleteCloudLayerFile('v1', 'previous-ocr-2')).toBe('gone');
    expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual([
      'Series/Vol 1.pre-upgrade.mokuro',
      'Series/Vol 1.previous-ocr-2.mokuro'
    ]);
  });

  describe('two accounts on one device and one server', () => {
    beforeEach(() => {
      serverCompilesMetadata = true;
      editLayerSync = 'push';
    });

    it('a push stamps the account on a personal layer only', async () => {
      await seedRow();
      await seedLayer('edit');
      await seedLayer('fix');
      accountScope = ACCOUNT_A;
      await syncLayersFromListing(files(), 'webdav');
      expect((await getLayerWithPages(db, 'v1', 'edit'))!.cloud?.account).toBe(ACCOUNT_A);
      expect((await getLayerWithPages(db, 'v1', 'fix'))!.cloud).not.toHaveProperty('account');
    });

    it('an edit row stamped for A is never pushed while B is active', async () => {
      await seedRow();
      await seedLayer('edit', {
        cloud: { provider: 'webdav', account: ACCOUNT_A, size: 100, synced_at: T0 }
      });
      accountScope = ACCOUNT_B;
      await syncLayersFromListing(files(), 'webdav');
      expect(uploadFile).not.toHaveBeenCalled();
      // A's unsynced edit stays as it is, even under B's listed overlay.
      await syncLayersFromListing(
        listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.edit.mokuro', { size: 55 })),
        'webdav'
      );
      expect(downloadFile).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
    });

    it("B's listed overlay replaces A's row once A's row is in sync", async () => {
      await seedRow();
      await seedLayer('edit', {
        updated_at: T0,
        cloud: {
          provider: 'webdav',
          account: ACCOUNT_A,
          size: 100,
          modified: 1789552800,
          synced_at: T0
        }
      });
      accountScope = ACCOUNT_B;
      downloadFile.mockResolvedValue(new Blob([mokuroJson('びー')]));
      // Same stamps as A's own file: still B's file, so it is pulled.
      await syncLayersFromListing(
        listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.edit.mokuro')),
        'webdav'
      );
      const row = (await getLayerWithPages(db, 'v1', 'edit'))!;
      expect(row.pages[0].blocks[0].lines).toEqual(['びー']);
      expect(row.cloud?.account).toBe(ACCOUNT_B);
      expect(uploadFile).not.toHaveBeenCalled();
    });

    it('a row stamped before accounts were recorded is treated as this account’s', async () => {
      await seedRow();
      await seedLayer('edit', { cloud: { provider: 'webdav', size: 100, synced_at: T0 } });
      accountScope = ACCOUNT_B;
      await syncLayersFromListing(files(), 'webdav');
      expect(uploaded()).toEqual(['Series/Vol 1.edit.mokuro']);
    });

    it('stampLayersSynced records the account for a personal layer only', async () => {
      await seedRow();
      await seedLayer('edit', { updated_at: T0 });
      await seedLayer('fix', { updated_at: T0 });
      await stampLayersSynced(
        'v1',
        'webdav',
        [
          { layerId: 'edit', updatedAt: T0, size: 9 },
          { layerId: 'fix', updatedAt: T0, size: 9 }
        ],
        ACCOUNT_A
      );
      expect((await getLayerWithPages(db, 'v1', 'edit'))!.cloud?.account).toBe(ACCOUNT_A);
      expect((await getLayerWithPages(db, 'v1', 'fix'))!.cloud).not.toHaveProperty('account');
    });

    it("deleting A's edit row while B is active never deletes B's overlay; A's next listing does", async () => {
      await seedRow();
      await seedLayer('edit', {
        updated_at: T0,
        cloud: {
          provider: 'webdav',
          account: ACCOUNT_A,
          size: 100,
          modified: 1789552800,
          synced_at: T0
        }
      });
      accountScope = ACCOUNT_B;
      cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.edit.mokuro')];
      expect(await deleteCloudLayerFile('v1', 'edit')).toBe('unconfirmed');
      expect(deleteFile).not.toHaveBeenCalled();
      await deleteLayerRows(db, 'v1', 'edit');

      // B's listing: A's tombstone is not about B's file — neither deleted nor hidden.
      downloadFile.mockResolvedValue(new Blob([mokuroJson('びー')]));
      await syncLayersFromListing(listing(...cachedFiles), 'webdav');
      expect(deleteFile).not.toHaveBeenCalled();
      expect((await getLayerWithPages(db, 'v1', 'edit'))!.cloud?.account).toBe(ACCOUNT_B);
    });

    it("A's edit-layer tombstone is retried by A's listing only", async () => {
      await seedRow();
      localStorage.setItem(
        'layer-sync:pending-deletes',
        JSON.stringify([
          { volume_uuid: 'v1', layer_id: 'edit', provider: 'webdav', account: ACCOUNT_A }
        ])
      );
      const files = listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.edit.mokuro'));
      accountScope = ACCOUNT_B;
      downloadFile.mockRejectedValue(new Error('not now'));
      await syncLayersFromListing(files, 'webdav');
      expect(deleteFile).not.toHaveBeenCalled();
      accountScope = ACCOUNT_A;
      await syncLayersFromListing(files, 'webdav');
      expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual(['Series/Vol 1.edit.mokuro']);
    });
  });

  // The listing- and edit-triggered layer sync runs outside the progress
  // sync: it asks the server again (throttled) before it pushes, or a bunko
  // rolled back to 0.7.3 under an open tab gets the account's edit layer into
  // its SHARED library.
  it('after a bunko rollback, a layer push asks the identity again and sends no edit layer', async () => {
    await seedRow();
    await seedLayer('edit');
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    accountScope = ACCOUNT_A;
    const refresh = vi.fn(async () => {
      editLayerSync = 'local';
    });
    refreshIdentity = refresh;
    await syncLayersFromListing(files(), 'webdav');
    expect(refresh).toHaveBeenCalledWith({ maxAgeMs: 5 * 60_000 });
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('after a bunko rollback, deleting the edit layer leaves the now-shared file alone', async () => {
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    accountScope = ACCOUNT_A;
    canAddFiles = true;
    await seedLayer('edit', {
      updated_at: T0,
      cloud: {
        provider: 'webdav',
        account: ACCOUNT_A,
        size: 100,
        modified: 1789552800,
        synced_at: T0
      }
    });
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.edit.mokuro')];
    refreshIdentity = async () => {
      editLayerSync = 'local';
    };
    expect(await deleteCloudLayerFile('v1', 'edit')).toBe('kept-shared');
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("an overlay pulled while the identity fell back ('local') is stamped, so another account never pushes or deletes over it", async () => {
    // A 0.8 bunko whose /me failed at A's sign-in: status reads 'local'.
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'local';
    accountScope = ACCOUNT_A;
    const overlay = () =>
      listing(cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.edit.mokuro'));
    downloadFile.mockResolvedValue(new Blob([mokuroJson('えー')]));
    await syncLayersFromListing(overlay(), 'webdav');
    const pulled = (await getLayerWithPages(db, 'v1', 'edit'))!;
    expect(pulled.cloud?.account).toBe(ACCOUNT_A);

    // A corrects it (stays local under 'local'); then B signs in, identity OK.
    await putLayerWithPages(db, {
      ...pulled,
      updated_at: new Date(Date.parse(pulled.cloud!.synced_at) + 60_000).toISOString(),
      pages: [pg('なおし')]
    });
    editLayerSync = 'push';
    accountScope = ACCOUNT_B;
    downloadFile.mockClear();
    await syncLayersFromListing(files(), 'webdav');
    expect(uploadFile).not.toHaveBeenCalled();
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.edit.mokuro')];
    expect(await deleteCloudLayerFile('v1', 'edit')).toBe('unconfirmed');
    expect(deleteFile).not.toHaveBeenCalled();
  });

  // Google Drive's accountScope is `default` until the reader folder resolves,
  // then that folder's id: two values within ONE account. Only a server that
  // keeps personal layers per account has two accounts behind one path.
  describe('a provider whose accountScope moves within one account (Google Drive)', () => {
    const DEFAULT = 'google-drive:default';
    const FOLDER = 'google-drive:reader-folder-id';
    const driveFile = (path: string, over: Partial<CloudFileMetadata> = {}) =>
      cloudFile(path, { provider: 'google-drive', ...over });
    const driveListing = () =>
      listing(driveFile('Series/Vol 1.cbz'), driveFile('Series/Vol 1.edit.mokuro'));

    beforeEach(() => {
      getActiveProvider.mockReturnValue(provider('google-drive'));
    });

    it('a pull under a fresh cloud-direct bunko marker is not stamped either', async () => {
      await seedRow();
      serverCompilesMetadata = true; // withCloudBunkoStatus; no editLayerSync on Drive
      accountScope = DEFAULT;
      downloadFile.mockResolvedValue(new Blob([mokuroJson('よそ')]));
      await syncLayersFromListing(driveListing(), 'google-drive');
      expect((await getLayerWithPages(db, 'v1', 'edit'))!.cloud).not.toHaveProperty('account');
    });

    it('an edit pulled before the reader folder resolved still goes up after it did', async () => {
      await seedRow();
      accountScope = DEFAULT;
      downloadFile.mockResolvedValue(new Blob([mokuroJson('よそ')]));
      await syncLayersFromListing(driveListing(), 'google-drive');
      const pulled = (await getLayerWithPages(db, 'v1', 'edit'))!;
      expect(pulled.cloud).not.toHaveProperty('account');

      // This device corrects it; an upload meanwhile resolved the folder.
      await putLayerWithPages(db, {
        ...pulled,
        updated_at: new Date(Date.parse(pulled.cloud!.synced_at) + 60_000).toISOString(),
        pages: [pg('なおし')]
      });
      accountScope = FOLDER;
      downloadFile.mockClear();
      await syncLayersFromListing(driveListing(), 'google-drive');
      expect(uploaded()).toEqual(['Series/Vol 1.edit.mokuro']);
      expect(downloadFile).not.toHaveBeenCalled();
    });

    it('a row an older build stamped with the earlier scope is still this account’s', async () => {
      await seedRow();
      await seedLayer('edit', {
        cloud: { provider: 'google-drive', account: DEFAULT, size: 100, synced_at: T0 }
      });
      accountScope = FOLDER;
      await syncLayersFromListing(
        listing(driveFile('Series/Vol 1.cbz'), driveFile('Series/Vol 1.mokuro')),
        'google-drive'
      );
      expect(uploaded()).toEqual(['Series/Vol 1.edit.mokuro']);
    });

    it('deleting such a row removes its file, so no listing pulls it back', async () => {
      await seedRow();
      await seedLayer('edit', {
        updated_at: T0,
        cloud: {
          provider: 'google-drive',
          account: DEFAULT,
          size: 100,
          modified: 1789552800,
          synced_at: T0
        }
      });
      accountScope = FOLDER;
      cachedFiles = [driveFile('Series/Vol 1.cbz'), driveFile('Series/Vol 1.edit.mokuro')];
      deleteFile.mockResolvedValue(undefined);
      expect(await deleteCloudLayerFile('v1', 'edit')).toBe('gone');
      expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual(['Series/Vol 1.edit.mokuro']);
    });

    it('a tombstone left under the earlier scope is retried under the later one', async () => {
      await seedRow();
      localStorage.setItem(
        'layer-sync:pending-deletes',
        JSON.stringify([
          { volume_uuid: 'v1', layer_id: 'edit', provider: 'google-drive', account: DEFAULT }
        ])
      );
      accountScope = FOLDER;
      await syncLayersFromListing(driveListing(), 'google-drive');
      expect(downloadFile).not.toHaveBeenCalled();
      expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual(['Series/Vol 1.edit.mokuro']);
    });
  });

  it("a fork pulls the account's listed overlay first instead of minting a copy over it", async () => {
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    await seedLayer('curated', {
      updated_at: T0,
      cloud: { provider: 'webdav', size: 100, modified: 1789552800, synced_at: T0 }
    });
    cachedFiles = [
      cloudFile('Series/Vol 1.cbz'),
      cloudFile('Series/Vol 1.curated.mokuro'),
      cloudFile('Series/Vol 1.edit.mokuro', { size: 55 })
    ];
    downloadFile.mockResolvedValue(new Blob([mokuroJson('わたし')]));
    expect(await pullOwnEditLayerBeforeEdit('v1')).toBe('pulled');
    // Only the overlay: the curated row is in sync and not this helper's business.
    expect(downloadFile).toHaveBeenCalledTimes(1);
    const edit = (await getLayerWithPages(db, 'v1', 'edit'))!;
    expect(edit.pages[0].blocks[0].lines).toEqual(['わたし']);
    expect(edit.cloud).toMatchObject({ provider: 'webdav', size: 55 });

    // A local edit row is the account's already: nothing is fetched.
    downloadFile.mockClear();
    expect(await pullOwnEditLayerBeforeEdit('v1')).toBe('none');
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('a fork pulls nothing where the edit file is the shared one (0.7.x) or none is listed', async () => {
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'local';
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.edit.mokuro')];
    expect(await pullOwnEditLayerBeforeEdit('v1')).toBe('none');
    editLayerSync = 'push';
    cachedFiles = [cloudFile('Series/Vol 1.cbz')];
    expect(await pullOwnEditLayerBeforeEdit('v1')).toBe('none');
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("'failed' when the account's listed overlay could not be fetched — nothing minted", async () => {
    await seedRow();
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.edit.mokuro')];
    downloadFile.mockRejectedValue(new Error('offline'));
    expect(await pullOwnEditLayerBeforeEdit('v1')).toBe('failed');
    expect(await getLayerWithPages(db, 'v1', 'edit')).toBeUndefined();
    // Bytes that are no layer at all are no transient failure: that file can
    // never be the account's corrections, and a fresh row may replace it.
    downloadFile.mockResolvedValue(new Blob(['not json']));
    expect(await pullOwnEditLayerBeforeEdit('v1')).toBe('none');
  });

  it('never tidies the .gz beside a layer this device may not delete', async () => {
    await seedRow();
    canAddFiles = true;
    const inSync = {
      provider: 'webdav',
      size: 100,
      modified: 1789552800,
      synced_at: T0
    };
    await seedLayer('curated', { updated_at: T0, cloud: inSync });
    await seedLayer('edit', { updated_at: T0, cloud: inSync });
    for (const gate of ['push', 'local'] as const) {
      serverCompilesMetadata = true;
      editLayerSync = gate;
      await syncLayersFromListing(
        listing(
          cloudFile('Series/Vol 1.cbz'),
          cloudFile('Series/Vol 1.curated.mokuro'),
          cloudFile('Series/Vol 1.curated.mokuro.gz'),
          cloudFile('Series/Vol 1.edit.mokuro'),
          cloudFile('Series/Vol 1.edit.mokuro.gz')
        ),
        'webdav'
      );
      const deleted = deleteFile.mock.calls.map(([f]) => f.path);
      expect(deleted).not.toContain('Series/Vol 1.curated.mokuro.gz');
      // The account's own per-account overlay is its to tidy; a shared one is not.
      if (gate === 'local') expect(deleted).not.toContain('Series/Vol 1.edit.mokuro.gz');
      else expect(deleted).toContain('Series/Vol 1.edit.mokuro.gz');
      deleteFile.mockClear();
    }
  });
});

describe('Publish and Unpublish the shared curated layer', () => {
  const T0 = '2026-09-16T09:00:00.000Z';
  const T1 = '2026-09-16T09:30:00.000Z';

  async function seedEdit(text = 'なお') {
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'edit',
      name: 'Your corrections',
      kind: 'edit',
      created_at: T0,
      updated_at: T1,
      pages: [pg(text)]
    });
  }

  beforeEach(() => {
    serverCompilesMetadata = true;
    editLayerSync = 'push';
    curatedPublish = 'all';
    // The archive as the listing spells it, not as the local row does.
    cachedFiles = [cloudFile('Series/VOL 1.cbz'), cloudFile('Series/VOL 1.mokuro')];
  });

  it("uploads exactly the edit layer's serialization to <stem>.curated.mokuro and stamps a curated row", async () => {
    await seedRow();
    await seedEdit();
    expect(await publishCuratedLayer('v1')).toBe('published');

    expect(uploadFile).toHaveBeenCalledTimes(1);
    const [path, blob] = uploadFile.mock.calls[0];
    expect(path).toBe('Series/VOL 1.curated.mokuro');
    const json = JSON.parse(await (blob as Blob).text());
    expect(json.pages[0].blocks[0].lines).toEqual(['なお']);
    expect(json.edited).toMatchObject({ by: 'mokuro-reader', at: T1 });
    expect(json.ocr_engine).toBeUndefined();

    const curated = (await getLayerWithPages(db, 'v1', 'curated'))!;
    expect(curated).toMatchObject({ kind: 'edit', name: 'Shared corrections' });
    expect(curated.pages).toEqual([pg('なお')]);
    expect(curated.cloud).toMatchObject({ provider: 'webdav', size: 77 });
    expect(curated.cloud?.account).toBeUndefined();
    expect(cacheAdd).toHaveBeenCalledWith('Series/VOL 1.curated.mokuro', expect.anything());

    // The next listing shows the upload: neither pulled back nor pushed.
    uploadFile.mockClear();
    await syncLayersFromListing(
      listing(
        cloudFile('Series/VOL 1.cbz'),
        cloudFile('Series/VOL 1.curated.mokuro', {
          size: 77,
          modifiedTime: '2026-09-16T12:00:00.000Z'
        })
      ),
      'webdav'
    );
    expect(downloadFile).not.toHaveBeenCalled();
    expect(uploadFile.mock.calls.map((c) => c[0])).not.toContain('Series/VOL 1.curated.mokuro');
  });

  it('the published file names the sealed main its corrections sit on, as the edit push does', async () => {
    await seedRow();
    const pages = (await db.volume_ocr.get('v1'))!.pages;
    const seal = (await contentDigest({ id: 'hayai-nova', revision: 2 }, pages))!;
    await db.volumes.update('v1', {
      ocr_provenance: [
        (await provenanceFromParsed({ id: 'hayai-nova', revision: 2, seal }, pages))!
      ]
    });
    await seedEdit();
    expect(await publishCuratedLayer('v1')).toBe('published');

    const json = JSON.parse(await (uploadFile.mock.calls[0][1] as Blob).text());
    expect(json.edited).toMatchObject({ by: 'mokuro-reader', base_seal: seal });
    expect(json.ocr_engine).toBeUndefined();
  });

  it("a 403 is 'refused' and writes no row", async () => {
    await seedRow();
    await seedEdit();
    const { ProviderError } = await import('$lib/util/sync/provider-interface');
    uploadFile.mockRejectedValue(
      new ProviderError('no', 'webdav', 'PERMISSION_DENIED', false, false)
    );
    expect(await publishCuratedLayer('v1')).toBe('refused');
    expect(await getLayerWithPages(db, 'v1', 'curated')).toBeUndefined();
  });

  it("'failed' with no edit layer, no listed archive, or another error — nothing written", async () => {
    await seedRow();
    expect(await publishCuratedLayer('v1')).toBe('failed');
    await seedEdit();
    cachedFiles = [];
    expect(await publishCuratedLayer('v1')).toBe('failed');
    expect(uploadFile).not.toHaveBeenCalled();
    cachedFiles = [cloudFile('Series/VOL 1.cbz')];
    uploadFile.mockRejectedValue(new Error('offline'));
    expect(await publishCuratedLayer('v1')).toBe('failed');
    expect(await getLayerWithPages(db, 'v1', 'curated')).toBeUndefined();
  });

  it('never publishes for an account without the right', async () => {
    await seedRow();
    await seedEdit();
    curatedPublish = 'none';
    expect(await publishCuratedLayer('v1')).toBe('refused');
    curatedPublish = undefined;
    expect(await publishCuratedLayer('v1')).toBe('refused');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  // bunko 0.8: in a shared folder, an uploader controls its own uploads.
  describe('per volume under scope owned (curated.volumes)', () => {
    beforeEach(() => {
      curatedPublish = 'owned';
    });

    it('publishes a volume this account uploaded to a shared folder', async () => {
      curatedVolumes = [{ series: 'Series', volume: 'VOL 1' }];
      await seedRow();
      await seedEdit();
      expect(await publishCuratedLayer('v1')).toBe('published');
      expect(uploadFile.mock.calls[0][0]).toBe('Series/VOL 1.curated.mokuro');
    });

    it("refuses another account's volume of the same folder, without a request", async () => {
      curatedVolumes = [{ series: 'Series', volume: 'VOL 2' }];
      await seedRow();
      await seedEdit();
      expect(await publishCuratedLayer('v1')).toBe('refused');
      expect(uploadFile).not.toHaveBeenCalled();
    });

    it('an older bunko (no volumes) refuses a folder it does not own, as before', async () => {
      await seedRow();
      await seedEdit();
      expect(await publishCuratedLayer('v1')).toBe('refused');
      expect(uploadFile).not.toHaveBeenCalled();
    });

    it('unpublishes only a volume it controls, and its retry follows the same rule', async () => {
      curatedVolumes = [{ series: 'Series', volume: 'VOL 1' }];
      await seedRow();
      await seedEdit();
      await publishCuratedLayer('v1');
      cachedFiles.push(cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }));
      deleteFile.mockRejectedValueOnce(new Error('offline'));
      expect(await unpublishCuratedLayer('v1')).toBe('unconfirmed');

      // The retry: refused while the volume is not listed as this account's...
      deleteFile.mockReset();
      deleteFile.mockResolvedValue(undefined);
      curatedVolumes = [{ series: 'Series', volume: 'VOL 2' }];
      await syncLayersFromListing(listing(...cachedFiles), 'webdav');
      expect(deleteFile).not.toHaveBeenCalled();
      // ...and sent once it is.
      curatedVolumes = [{ series: 'Series', volume: 'VOL 1' }];
      await syncLayersFromListing(listing(...cachedFiles), 'webdav');
      expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual(['Series/VOL 1.curated.mokuro']);
    });

    it("refuses to unpublish another account's volume", async () => {
      curatedVolumes = [{ series: 'Series', volume: 'VOL 2' }];
      await seedRow();
      cachedFiles.push(cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }));
      expect(await unpublishCuratedLayer('v1')).toBe('refused');
      expect(deleteFile).not.toHaveBeenCalled();
    });
  });

  it('listedCuratedLayerFile finds the published file of the volume', async () => {
    await seedRow();
    expect(await listedCuratedLayerFile('v1')).toBeNull();
    cachedFiles.push(cloudFile('Series/VOL 1.curated.mokuro'));
    expect((await listedCuratedLayerFile('v1'))?.path).toBe('Series/VOL 1.curated.mokuro');
  });

  it('unpublish deletes every listed copy, then the row', async () => {
    await seedRow();
    await seedEdit();
    await publishCuratedLayer('v1');
    cachedFiles.push(
      cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }),
      cloudFile('Series/VOL 1.curated.mokuro.gz')
    );
    expect(await unpublishCuratedLayer('v1')).toBe('gone');
    expect(deleteFile.mock.calls.map(([f]) => f.path).sort()).toEqual([
      'Series/VOL 1.curated.mokuro',
      'Series/VOL 1.curated.mokuro.gz'
    ]);
    expect(await getLayerWithPages(db, 'v1', 'curated')).toBeUndefined();
    // The account's own corrections are untouched.
    expect(await getLayerWithPages(db, 'v1', 'edit')).toBeDefined();
  });

  it('a failed unpublish leaves a tombstone that the next listing retries', async () => {
    await seedRow();
    await seedEdit();
    await publishCuratedLayer('v1');
    const curatedFile = cloudFile('Series/VOL 1.curated.mokuro', { size: 77 });
    cachedFiles.push(curatedFile);
    deleteFile.mockRejectedValueOnce(new Error('offline'));
    expect(await unpublishCuratedLayer('v1')).toBe('unconfirmed');
    expect(await getLayerWithPages(db, 'v1', 'curated')).toBeUndefined();

    // Not pulled back; deleted by the next listing that can.
    deleteFile.mockResolvedValue(undefined);
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual([
      'Series/VOL 1.curated.mokuro',
      'Series/VOL 1.curated.mokuro'
    ]);
  });

  it('a retried Unpublish refused on the .gz leaves the plain file and keeps its tombstone', async () => {
    await seedRow();
    await seedEdit();
    await publishCuratedLayer('v1');
    cachedFiles.push(cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }));
    deleteFile.mockRejectedValueOnce(new Error('offline'));
    expect(await unpublishCuratedLayer('v1')).toBe('unconfirmed');

    // The next listing shows the plain file (this account's publish) and a
    // `.gz` an engine wrote, which the server will not let this account delete.
    deleteFile.mockReset();
    const { ProviderError } = await import('$lib/util/sync/provider-interface');
    deleteFile.mockImplementation(async (f: CloudFileMetadata) => {
      if (f.path.endsWith('.gz')) {
        throw new ProviderError('no', 'webdav', 'PERMISSION_DENIED', false, false);
      }
    });
    await syncLayersFromListing(
      listing(
        cloudFile('Series/VOL 1.cbz'),
        cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }),
        cloudFile('Series/VOL 1.curated.mokuro.gz')
      ),
      'webdav'
    );
    // Plain deleted first, the refused `.gz` would be the shared layer now.
    expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual(['Series/VOL 1.curated.mokuro.gz']);
    expect(cacheRemove).not.toHaveBeenCalledWith('Series/VOL 1.curated.mokuro');
    expect(JSON.parse(localStorage.getItem('layer-sync:pending-deletes')!)).toEqual([
      expect.objectContaining({ volume_uuid: 'v1', layer_id: 'curated', unpublish: true })
    ]);
  });

  it.each([
    ['a network failure', () => new Error('offline')],
    ['a server error', () => Object.assign(new Error('Internal Server Error'), { status: 500 })]
  ])(
    'a retried Unpublish whose .gz delete hits %s leaves the plain file and keeps its tombstone',
    async (_, failure) => {
      await seedRow();
      await seedEdit();
      await publishCuratedLayer('v1');
      cachedFiles.push(cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }));
      deleteFile.mockRejectedValueOnce(new Error('offline'));
      expect(await unpublishCuratedLayer('v1')).toBe('unconfirmed');

      deleteFile.mockReset();
      deleteFile.mockImplementation(async (f: CloudFileMetadata) => {
        if (f.path.endsWith('.gz')) throw failure();
      });
      await syncLayersFromListing(
        listing(
          cloudFile('Series/VOL 1.cbz'),
          cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }),
          cloudFile('Series/VOL 1.curated.mokuro.gz')
        ),
        'webdav'
      );
      // Going on to the plain file would leave the `.gz` read in its place.
      expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual([
        'Series/VOL 1.curated.mokuro.gz'
      ]);
      expect(cacheRemove).not.toHaveBeenCalledWith('Series/VOL 1.curated.mokuro');
      expect(JSON.parse(localStorage.getItem('layer-sync:pending-deletes')!)).toEqual([
        expect.objectContaining({ volume_uuid: 'v1', layer_id: 'curated', unpublish: true })
      ]);
    }
  );

  it('a refused unpublish keeps the row and leaves no tombstone', async () => {
    await seedRow();
    await seedEdit();
    await publishCuratedLayer('v1');
    cachedFiles.push(cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }));
    const { ProviderError } = await import('$lib/util/sync/provider-interface');
    deleteFile.mockRejectedValue(
      new ProviderError('no', 'webdav', 'PERMISSION_DENIED', false, false)
    );
    expect(await unpublishCuratedLayer('v1')).toBe('refused');
    expect(await getLayerWithPages(db, 'v1', 'curated')).toBeDefined();
    expect(localStorage.getItem('layer-sync:pending-deletes')).toBeNull();
  });

  it('a copy refused after another was deleted never leaves the .gz as the shared layer', async () => {
    // The plain file is this account's publish; the `.gz` an engine wrote is
    // not its to delete. Deleting the plain first would surface the `.gz` as
    // the curated layer for everyone — while the UI said nothing changed.
    await seedRow();
    await seedEdit();
    await publishCuratedLayer('v1');
    cachedFiles.push(
      cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }),
      cloudFile('Series/VOL 1.curated.mokuro.gz')
    );
    const { ProviderError } = await import('$lib/util/sync/provider-interface');
    deleteFile.mockImplementation(async (f: CloudFileMetadata) => {
      if (f.path.endsWith('.gz')) {
        throw new ProviderError('no', 'webdav', 'PERMISSION_DENIED', false, false);
      }
    });
    expect(await unpublishCuratedLayer('v1')).toBe('refused');
    // Nothing anyone reads changed: the plain file stays, and so does the row.
    expect(deleteFile.mock.calls.map(([f]) => f.path)).toEqual(['Series/VOL 1.curated.mokuro.gz']);
    expect(await getLayerWithPages(db, 'v1', 'curated')).toBeDefined();
    expect(localStorage.getItem('layer-sync:pending-deletes')).toBeNull();
  });

  it('the plain copy refused after its .gz went: still nothing anyone reads changed', async () => {
    await seedRow();
    await seedEdit();
    await publishCuratedLayer('v1');
    cachedFiles.push(
      cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }),
      cloudFile('Series/VOL 1.curated.mokuro.gz')
    );
    const { ProviderError } = await import('$lib/util/sync/provider-interface');
    deleteFile.mockImplementation(async (f: CloudFileMetadata) => {
      if (!f.path.endsWith('.gz')) {
        throw new ProviderError('no', 'webdav', 'PERMISSION_DENIED', false, false);
      }
    });
    expect(await unpublishCuratedLayer('v1')).toBe('refused');
    expect(await getLayerWithPages(db, 'v1', 'curated')).toBeDefined();
  });

  it('an Unpublish tombstone names the provider the curated row was synced with', async () => {
    await seedRow();
    await seedEdit();
    await publishCuratedLayer('v1');
    // The provider went away while the confirm was up.
    getActiveProvider.mockReturnValue(undefined);
    expect(await unpublishCuratedLayer('v1')).toBe('unconfirmed');
    const pending = JSON.parse(localStorage.getItem('layer-sync:pending-deletes')!);
    expect(pending).toEqual([
      expect.objectContaining({
        volume_uuid: 'v1',
        layer_id: 'curated',
        provider: 'webdav',
        unpublish: true
      })
    ]);
  });

  it('with no provider to name, an Unpublish fails and keeps the row — never a provider-less tombstone', async () => {
    await seedRow();
    // A curated row with no cloud stamp: nothing says which provider holds it.
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'curated',
      name: 'Shared corrections',
      kind: 'edit',
      created_at: T0,
      updated_at: T0,
      pages: [pg('なお')]
    });
    getActiveProvider.mockReturnValue(undefined);
    expect(await unpublishCuratedLayer('v1')).toBe('failed');
    expect(await getLayerWithPages(db, 'v1', 'curated')).toBeDefined();
    expect(localStorage.getItem('layer-sync:pending-deletes')).toBeNull();
  });

  it('a curated tombstone NOT left by Unpublish never deletes the shared file', async () => {
    await seedRow();
    cachedFiles.push(cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }));
    localStorage.setItem(
      'layer-sync:pending-deletes',
      JSON.stringify([{ volume_uuid: 'v1', layer_id: 'curated', provider: 'webdav' }])
    );
    await syncLayersFromListing(listing(...cachedFiles), 'webdav');
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('a retried Unpublish never deletes a newer curated file another editor published', async () => {
    await seedRow();
    await seedEdit();
    await publishCuratedLayer('v1');
    cachedFiles.push(cloudFile('Series/VOL 1.curated.mokuro', { size: 77 }));
    deleteFile.mockRejectedValueOnce(new Error('offline'));
    expect(await unpublishCuratedLayer('v1')).toBe('unconfirmed');
    deleteFile.mockClear();

    // Another editor publishes before this device lists again.
    const republished = cloudFile('Series/VOL 1.curated.mokuro', {
      size: 120,
      modifiedTime: '2026-09-16T13:00:00.000Z'
    });
    downloadFile.mockResolvedValue(new Blob([mokuroJson('べつ')]));
    await syncLayersFromListing(listing(cloudFile('Series/VOL 1.cbz'), republished), 'webdav');
    expect(deleteFile).not.toHaveBeenCalled();
    expect((await getLayerWithPages(db, 'v1', 'curated'))!.pages[0].blocks[0].lines).toEqual([
      'べつ'
    ]);
    expect(localStorage.getItem('layer-sync:pending-deletes')).toBeNull();
  });
});

describe('the migration guard on shared servers', () => {
  const T0 = '2026-09-16T09:00:00.000Z';
  const T1 = '2026-09-16T09:30:00.000Z';

  it("a 0.7.x bunko's shared edit file never replaces a local edit row with unsynced edits", async () => {
    await seedRow();
    serverCompilesMetadata = true;
    editLayerSync = 'local';
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'edit',
      name: 'Your corrections',
      kind: 'edit',
      created_at: T0,
      updated_at: T1,
      pages: [pg('わたし')]
    });
    downloadFile.mockResolvedValue(new Blob([mokuroJson('だれか')]));
    // Newer than the local edit: newest-wins would take it.
    await syncLayersFromListing(
      listing(
        cloudFile('Series/Vol 1.cbz'),
        cloudFile('Series/Vol 1.edit.mokuro', { modifiedTime: '2026-09-17T00:00:00.000Z' })
      ),
      'webdav'
    );
    expect(downloadFile).not.toHaveBeenCalled();
    expect((await getLayerWithPages(db, 'v1', 'edit'))!.pages[0].blocks[0].lines).toEqual([
      'わたし'
    ]);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
