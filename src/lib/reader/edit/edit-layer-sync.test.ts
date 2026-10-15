/**
 * bunko design 0.8 D4, end to end on the reader side: an edit is saved into
 * the `edit` layer and reaches the cloud as `<Volume>.edit.mokuro` with the
 * `edited` block — and the main `<Volume>.mokuro` is never uploaded for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Page } from '$lib/types';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_edit_layer_sync_test') };
});
const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { getActiveProvider: () => getActiveProvider() }
}));
let cachedFiles: CloudFileMetadata[] = [];
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: {
    getCache: () => ({
      add: vi.fn(),
      removeById: vi.fn(),
      getAllFiles: () => cachedFiles,
      isLoaded: () => true
    })
  }
}));

import { db } from '$lib/catalog/db';
import { clearAllLayers, getLayerWithPages, putLayerWithPages } from '$lib/catalog/layer-store';
import {
  LAYER_PUSH_DEBOUNCE_MS,
  cancelScheduledLayerPushForTest,
  migrateEditedPrimariesToEditLayers,
  resetEditLayerMigrationForTest,
  syncLayersFromListing
} from '$lib/metadata/layer-sync';
import { persistPageEdit } from './edit-persist';
import { promoteLayer, createLayer } from './layers';
import { mainSidecarPagesForCloud } from './edit-persist';

const SHA = 'cd'.repeat(32);

function pg(text: string, img_path = 'p.png'): Page {
  return {
    version: '0.2.1',
    img_width: 100,
    img_height: 100,
    img_path,
    blocks: [{ box: [0, 0, 10, 10], vertical: true, font_size: 10, lines: [text] }]
  };
}

function cloudFile(path: string): CloudFileMetadata {
  return {
    provider: 'webdav',
    fileId: path,
    path,
    modifiedTime: '2026-09-16T10:00:00.000Z',
    size: 100
  };
}

const uploadFile = vi.fn(async (_path: string, blob: Blob) => ({
  fileId: 'x',
  size: blob.size,
  modifiedTime: new Date().toISOString()
}));

function listing(): Map<string, CloudFileMetadata[]> {
  return new Map([['Series', cachedFiles]]);
}

beforeEach(async () => {
  localStorage.clear();
  resetEditLayerMigrationForTest();
  uploadFile.mockClear();
  getActiveProvider.mockReturnValue({
    type: 'webdav',
    getStatus: () => ({ isReadOnly: false, serverCompilesMetadata: false }),
    uploadFile,
    downloadFile: vi.fn(),
    deleteFile: vi.fn()
  });
  cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.mokuro')];
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), clearAllLayers(db)]);
  await db.volumes.put({
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'Series',
    volume_title: 'Vol 1',
    mokuro_version: '0.2.1',
    page_count: 2,
    character_count: 4,
    page_char_counts: [2, 4],
    mokuro_sha256: SHA
  });
  await db.volume_ocr.put({ volume_uuid: 'v1', pages: [pg('あい'), pg('うえ', 'q.png')] });
});

afterEach(() => {
  cancelScheduledLayerPushForTest();
  vi.useRealTimers();
});

function uploadedPaths(): string[] {
  return uploadFile.mock.calls.map((c) => c[0]);
}

describe('an OCR edit goes up as the edit layer, never as the main sidecar', () => {
  it('pushes <Vol>.edit.mokuro with the edited block and no ocr_engine', async () => {
    await persistPageEdit('v1', 1, pg('直した', 'q.png'));
    await syncLayersFromListing(listing(), 'webdav');

    // Plain storage also keeps the `original` snapshot (Revert's base) as a layer.
    expect(uploadedPaths().sort()).toEqual([
      'Series/Vol 1.edit.mokuro',
      'Series/Vol 1.original.mokuro'
    ]);
    const call = uploadFile.mock.calls.find((c) => c[0] === 'Series/Vol 1.edit.mokuro')!;
    const json = JSON.parse(await (call[1] as Blob).text());
    const originalCall = uploadFile.mock.calls.find(
      (c) => c[0] === 'Series/Vol 1.original.mokuro'
    )!;
    expect(JSON.parse(await (originalCall[1] as Blob).text()).edited).toBeUndefined();
    const edit = await getLayerWithPages(db, 'v1', 'edit');
    expect(json.edited).toEqual({ by: 'mokuro-reader', at: edit!.updated_at, base_sha256: SHA });
    expect(json.ocr_engine).toBeUndefined();
    expect(json.pages[1].blocks[0].lines).toEqual(['直した']);
    expect(json.pages[0].blocks[0].lines).toEqual(['あい']);
    expect(uploadedPaths()).not.toContain('Series/Vol 1.mokuro');
  });

  it('schedules the push itself once the edits settle (no listing needed)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cachedFiles = [cloudFile('Series/Vol 1.cbz'), cloudFile('Series/Vol 1.mokuro')];
    await persistPageEdit('v1', 0, pg('一'));
    await persistPageEdit('v1', 0, pg('二'));
    await vi.advanceTimersByTimeAsync(LAYER_PUSH_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    await vi.waitFor(() => expect(uploadedPaths()).toContain('Series/Vol 1.edit.mokuro'));
    expect(uploadedPaths()).not.toContain('Series/Vol 1.mokuro');
  });

  it('a promoted layer stays local: nothing goes up as the main sidecar, and the main is model output', async () => {
    await createLayer('v1', { name: 'Better', kind: 'ocr', pages: [pg('良'), pg('い', 'q.png')] });
    await promoteLayer('v1', 'better');
    const row = await db.volumes.get('v1');
    const primary = (await db.volume_ocr.get('v1'))!.pages;
    expect(primary[0].blocks[0].lines).toEqual(['良']);
    // The main sidecar any cloud write would build: the pre-promote OCR.
    const main = await mainSidecarPagesForCloud(row!, primary);
    expect(main?.[0].blocks[0].lines).toEqual(['あい']);

    await syncLayersFromListing(listing(), 'webdav');
    expect(uploadedPaths()).not.toContain('Series/Vol 1.mokuro');
    expect(await getLayerWithPages(db, 'v1', 'edit')).toBeUndefined();
  });
});

describe('the one-time edit-layer migration', () => {
  async function legacyEdited() {
    // An edit made before D4: corrections in the primary, an original, no edit
    // layer — and this device first ran the new reader after it.
    localStorage.setItem('edit-layer:epoch', '2026-10-01T00:00:00.000Z');
    await db.volumes.update('v1', { ocr_edited_at: '2026-09-01T00:00:00.000Z' });
    await db.volume_ocr.put({ volume_uuid: 'v1', pages: [pg('なおし'), pg('うえ', 'q.png')] });
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
      pages: [pg('あい'), pg('うえ', 'q.png')]
    });
  }

  it('carries corrections that live only in the primary into an edit layer, and pushes it', async () => {
    await legacyEdited();
    localStorage.setItem('sidecar-backfill:edited-volumes', JSON.stringify(['v1']));
    await syncLayersFromListing(listing(), 'webdav');

    const edit = await getLayerWithPages(db, 'v1', 'edit');
    expect(edit?.kind).toBe('edit');
    expect(edit?.pages[0].blocks[0].lines).toEqual(['なおし']);
    expect(edit?.updated_at).toBe('2026-09-01T00:00:00.000Z');
    expect(uploadedPaths()).toContain('Series/Vol 1.edit.mokuro');
    expect(uploadedPaths()).not.toContain('Series/Vol 1.mokuro');
    expect(localStorage.getItem('sidecar-backfill:edited-volumes')).toBeNull();
    // The primary is untouched: the local view is as it was.
    expect((await db.volume_ocr.get('v1'))?.pages[0].blocks[0].lines).toEqual(['なおし']);
  });

  it('runs once, keeps an existing edit layer, and skips a primary equal to its original', async () => {
    await legacyEdited();
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'edit',
      name: 'Mine',
      kind: 'edit',
      created_at: 'x',
      updated_at: 'x',
      pages: [pg('既存'), pg('うえ', 'q.png')]
    });
    expect(await migrateEditedPrimariesToEditLayers()).toBe(0);
    expect((await getLayerWithPages(db, 'v1', 'edit'))?.name).toBe('Mine');

    resetEditLayerMigrationForTest();
    localStorage.clear();
    localStorage.setItem('edit-layer:epoch', '2026-10-01T00:00:00.000Z');
    await clearAllLayers(db);
    await db.volume_ocr.put({ volume_uuid: 'v1', pages: [pg('あい'), pg('うえ', 'q.png')] });
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: 'x',
      updated_at: 'x',
      pages: [pg('あい'), pg('うえ', 'q.png')]
    });
    expect(await migrateEditedPrimariesToEditLayers()).toBe(0);
    expect(await getLayerWithPages(db, 'v1', 'edit')).toBeUndefined();

    // Done once: a later edited primary is not migrated again by it.
    await db.volume_ocr.put({ volume_uuid: 'v1', pages: [pg('後'), pg('うえ', 'q.png')] });
    expect(await migrateEditedPrimariesToEditLayers()).toBe(0);
  });
});
