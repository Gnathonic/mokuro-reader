import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_layers_schema_test') };
});

import Dexie from 'dexie';
import { db } from '$lib/catalog/db';
import { CatalogDexieV3 } from '$lib/catalog/db-v3';
import { deleteVolumeCompletely, removeVolumeFiles } from '$lib/import/database';
import { MOKURO_DB_SCHEMA } from '$lib/catalog/db-schema';
import {
  getLayerMeta,
  getLayerPages,
  getLayerWithPages,
  putLayerWithPages
} from '$lib/catalog/layer-store';
import type { Page } from '$lib/types';

afterEach(async () => {
  await Promise.all([
    db.volumes.clear(),
    db.volume_ocr.clear(),
    db.volume_files.clear(),
    db.volume_ocr_layers.clear(),
    db.volume_ocr_layer_pages.clear()
  ]);
});

function page(img_path: string): Page {
  return { version: '0.2.1', img_width: 10, img_height: 10, img_path, blocks: [] };
}

function row() {
  return {
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'Series',
    volume_title: 'Vol 1',
    mokuro_version: '0.2.1',
    page_count: 1,
    character_count: 3,
    page_char_counts: [3]
  };
}

describe('volume_ocr_layers schema', () => {
  it('declares version 3 with the layers table and the ocr_edited_at index', () => {
    const v3 = MOKURO_DB_SCHEMA.find((v) => v.version === 3);
    expect(v3?.stores.volume_ocr_layers).toBe('[volume_uuid+layer_id], volume_uuid');
    expect(v3?.stores.volumes).toBe('volume_uuid, series_uuid, series_title, ocr_edited_at');
  });

  it('declares version 4 with the pages table beside the metadata table', () => {
    const v4 = MOKURO_DB_SCHEMA.find((v) => v.version === 4);
    expect(v4?.stores.volume_ocr_layers).toBe('[volume_uuid+layer_id], volume_uuid');
    expect(v4?.stores.volume_ocr_layer_pages).toBe('[volume_uuid+layer_id], volume_uuid');
    expect(typeof v4?.upgrade).toBe('function');
  });

  it('round-trips a layer as a metadata row plus a pages row under one key', async () => {
    await putLayerWithPages(db, {
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original',
      created_at: '2026-09-15T00:00:00.000Z',
      updated_at: '2026-09-15T00:00:00.000Z',
      pages: [page('p.png')]
    });
    const meta = await db.volume_ocr_layers.get(['v1', 'original']);
    expect(meta?.name).toBe('Original');
    expect(meta).not.toHaveProperty('pages');
    expect((await db.volume_ocr_layer_pages.get(['v1', 'original']))?.pages[0].img_path).toBe(
      'p.png'
    );
    expect((await getLayerWithPages(db, 'v1', 'original'))?.pages[0].img_path).toBe('p.png');
    expect(await db.volume_ocr_layers.where('volume_uuid').equals('v1').count()).toBe(1);
    expect(await db.volume_ocr_layer_pages.where('volume_uuid').equals('v1').count()).toBe(1);
  });

  it('indexes only rows that carry ocr_edited_at', async () => {
    await db.volumes.put(row());
    await db.volumes.put({ ...row(), volume_uuid: 'v2', ocr_edited_at: '2026-09-15T00:00:00Z' });
    const keys = await db.volumes.where('ocr_edited_at').above('').primaryKeys();
    expect(keys).toEqual(['v2']);
  });

  it('deleteVolumeCompletely removes both layer rows; removeVolumeFiles keeps both', async () => {
    const layer = {
      volume_uuid: 'v1',
      layer_id: 'original',
      name: 'Original',
      kind: 'original' as const,
      created_at: 'x',
      updated_at: 'x',
      pages: [page('p.png')]
    };
    await db.volumes.put(row());
    await db.volume_ocr.put({ volume_uuid: 'v1', pages: [] });
    await db.volume_files.put({ volume_uuid: 'v1', files: {} });
    await putLayerWithPages(db, layer);
    // Another volume's layer must survive the delete.
    await putLayerWithPages(db, { ...layer, volume_uuid: 'v2' });

    await removeVolumeFiles('v1');
    expect(await getLayerMeta(db, 'v1', 'original')).toBeDefined();
    expect(await getLayerPages(db, 'v1', 'original')).toHaveLength(1);
    expect((await db.volumes.get('v1'))?.metadata_only).toBe(true);

    await deleteVolumeCompletely('v1');
    expect(await db.volume_ocr_layers.get(['v1', 'original'])).toBeUndefined();
    expect(await db.volume_ocr_layer_pages.get(['v1', 'original'])).toBeUndefined();
    expect(await db.volumes.get('v1')).toBeUndefined();
    expect(await getLayerPages(db, 'v2', 'original')).toHaveLength(1);
  });
});

describe('the v4 upgrade (layer pages move to their own table)', () => {
  const NAME = 'mokuro_v3_layers_upgrade_test';

  /** A connection that stops at `version` — what an older build declared. */
  function openAt(version: number): Dexie {
    const old = new Dexie(NAME);
    for (const step of MOKURO_DB_SCHEMA) {
      if (step.version <= version) old.version(step.version).stores(step.stores);
    }
    return old;
  }

  afterEach(async () => {
    await Dexie.delete(NAME);
  });

  it('moves the pages out of every v3 layer row, the original included', async () => {
    const old = openAt(3);
    await old.table('volumes').put(row());
    const base = { volume_uuid: 'v1', created_at: 'c', updated_at: 'u' };
    await old.table('volume_ocr_layers').bulkPut([
      { ...base, layer_id: 'original', name: 'Original', kind: 'original', pages: [page('o.png')] },
      {
        ...base,
        layer_id: 'gcv',
        name: 'Gcv',
        kind: 'ocr',
        engine: 'gcv',
        cloud: { provider: 'webdav', size: 7, synced_at: 's' },
        pages: [page('g1.png'), page('g2.png')]
      },
      { ...base, volume_uuid: 'v2', layer_id: 'fix', name: 'Fix', kind: 'edit', pages: [] }
    ]);
    old.close();

    const upgraded = new CatalogDexieV3(NAME);
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(4);
      const metas = await upgraded.volume_ocr_layers.toArray();
      expect(metas.map((m) => `${m.volume_uuid}/${m.layer_id}`).sort()).toEqual([
        'v1/gcv',
        'v1/original',
        'v2/fix'
      ]);
      for (const meta of metas) expect(meta).not.toHaveProperty('pages');
      // Everything that is not pages stays on the metadata row, untouched.
      expect(await upgraded.volume_ocr_layers.get(['v1', 'gcv'])).toEqual({
        ...base,
        layer_id: 'gcv',
        name: 'Gcv',
        kind: 'ocr',
        engine: 'gcv',
        cloud: { provider: 'webdav', size: 7, synced_at: 's' }
      });
      expect(await upgraded.volume_ocr_layer_pages.get(['v1', 'original'])).toEqual({
        volume_uuid: 'v1',
        layer_id: 'original',
        pages: [page('o.png')]
      });
      expect((await getLayerPages(upgraded, 'v1', 'gcv'))?.map((p) => p.img_path)).toEqual([
        'g1.png',
        'g2.png'
      ]);
      expect(await getLayerPages(upgraded, 'v2', 'fix')).toEqual([]);
      // The rest of the database rides through.
      expect((await upgraded.volumes.get('v1'))?.volume_title).toBe('Vol 1');
    } finally {
      upgraded.close();
    }
  });

  it('upgrades a v2 database that never had a layers table', async () => {
    const old = openAt(2);
    await old.table('volumes').put(row());
    old.close();

    const upgraded = new CatalogDexieV3(NAME);
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(4);
      expect(await upgraded.volume_ocr_layers.count()).toBe(0);
      expect(await upgraded.volume_ocr_layer_pages.count()).toBe(0);
      expect((await upgraded.volumes.get('v1'))?.volume_title).toBe('Vol 1');
    } finally {
      upgraded.close();
    }
  });

  it('creates both tables on a fresh install', async () => {
    const fresh = new CatalogDexieV3(NAME);
    try {
      await putLayerWithPages(fresh, {
        volume_uuid: 'v1',
        layer_id: 'fix',
        name: 'Fix',
        kind: 'edit',
        created_at: 'c',
        updated_at: 'u',
        pages: [page('p.png')]
      });
      expect(await getLayerPages(fresh, 'v1', 'fix')).toHaveLength(1);
    } finally {
      fresh.close();
    }
  });
});
