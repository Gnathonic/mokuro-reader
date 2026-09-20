import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { get } from 'svelte/store';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_layer_summaries_test') };
});
vi.mock('$lib/util/sync/sidecar-backfill', () => ({ noteOcrEdited: vi.fn() }));

import { countIdbOps } from '$lib/catalog/__tests__/idb-op-counter';
import { db } from '$lib/catalog/db';
import { clearAllLayers, putLayerWithPages } from '$lib/catalog/layer-store';
import type { Page } from '$lib/types';
import { layerSummaries, type LayerSummary } from './layer-list';
import { persistLayerPageEdit } from './layers';

function pg(text: string): Page {
  return {
    version: '0.2.1',
    img_width: 10,
    img_height: 10,
    img_path: 'p.png',
    blocks: [{ box: [0, 0, 1, 1], vertical: true, font_size: 5, lines: [text] }]
  };
}

async function seed(layer_id: string, created_at: string) {
  await putLayerWithPages(db, {
    volume_uuid: 'v1',
    layer_id,
    name: layer_id,
    kind: layer_id === 'original' ? 'original' : 'edit',
    created_at,
    updated_at: created_at,
    pages: [pg('あい'), pg('うえ')]
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

afterEach(() => clearAllLayers(db));

/**
 * PERFORMANCE CONTRACT. The picker's list is a liveQuery, and the editor
 * autosaves the displayed layer every 500 ms. Every one of those saves re-runs
 * the query (it moves `updated_at`, which the list shows) — so the query must
 * cost a few tiny metadata rows, never the pages of every layer of the volume.
 */
describe('layerSummaries', () => {
  it('lists a volume’s layers, and re-lists after an autosave, without ever reading pages', async () => {
    await seed('fix', '2026-02-01');
    await seed('original', '2026-03-01');

    let latest: LayerSummary[] = [];
    let unsubscribe = () => {};
    const initial = await countIdbOps(async () => {
      unsubscribe = layerSummaries('v1').subscribe((rows) => (latest = rows));
      await until(() => latest.length === 2);
    });
    try {
      expect(latest.map((l) => l.layer_id)).toEqual(['original', 'fix']);
      expect(Object.keys(initial).filter((k) => k.startsWith('volume_ocr_layer_pages.'))).toEqual(
        []
      );
      // Anchor: the counter saw the query, on the metadata table.
      expect(Object.keys(initial).some((k) => k.startsWith('volume_ocr_layers.'))).toBe(true);

      const before = latest.find((l) => l.layer_id === 'fix')!.updated_at;
      // The save AND the re-run it triggers, in one window (the re-run can land
      // before the save's promise resolves, so it cannot be counted apart).
      const autosave = await countIdbOps(async () => {
        await persistLayerPageEdit('v1', 'fix', 0, pg('なおした'));
        await until(() => latest.find((l) => l.layer_id === 'fix')!.updated_at !== before);
      });
      // Exactly the save's own page traffic — one read, one write, of the ONE
      // layer being edited. A list that read pages would show up here as more.
      expect(
        Object.fromEntries(
          Object.entries(autosave).filter(([k]) => k.startsWith('volume_ocr_layer_pages.'))
        )
      ).toEqual({ 'volume_ocr_layer_pages.get': 1, 'volume_ocr_layer_pages.put': 1 });
    } finally {
      unsubscribe();
    }
    expect(get(layerSummaries('v2'))).toEqual([]);
  });
});
