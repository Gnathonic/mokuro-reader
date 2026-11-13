/**
 * Reactive list of a volume's layers WITHOUT their pages — the picker and the
 * settings panel only need names and kinds, and a layer's pages can be
 * megabytes. Backed by a Dexie liveQuery so a create/rename/delete anywhere
 * re-renders every picker.
 *
 * The query reads the layer METADATA table and nothing else, on purpose. A
 * liveQuery re-runs whenever something it read is written, and the editor
 * autosaves a displayed layer every 500 ms: those saves still re-run this
 * (they move `updated_at`), but over a handful of tiny rows rather than every
 * page of every layer. `layer-summaries.test.ts` holds it to that.
 */
import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { listLayerMetas } from '$lib/catalog/layer-store';
import type { VolumeOcrLayer, VolumeOcrLayerKind } from '$lib/types';
import { ORIGINAL_LAYER_ID } from './edit-persist';
import { layerDisplayName } from './ocr-label';

/** The primary's name (`ocr-label.ts`), re-exported for the picker and the settings panel. */
export { primaryLayerName } from './ocr-label';

export interface LayerSummary {
  layer_id: string;
  name: string;
  kind: VolumeOcrLayerKind;
  engine?: string;
  updated_at: string;
  /** The provider the layer was last synced with: a cloud vouches for it (`forksOnEdit`). */
  cloud?: { provider: string };
}

export function summarizeLayers(rows: VolumeOcrLayer[]): LayerSummary[] {
  return [...rows]
    .sort((a, b) => {
      if (a.layer_id === ORIGINAL_LAYER_ID) return -1;
      if (b.layer_id === ORIGINAL_LAYER_ID) return 1;
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    })
    .map((row) => ({
      layer_id: row.layer_id,
      // What the row's file says made it, unless the user renamed it (`ocr-label.ts`).
      name: layerDisplayName(row),
      kind: row.kind,
      ...(row.engine ? { engine: row.engine } : {}),
      updated_at: row.updated_at,
      ...(row.cloud ? { cloud: { provider: row.cloud.provider } } : {})
    }));
}

export function layerSummaries(volumeUuid: string): Readable<LayerSummary[]> {
  return readable<LayerSummary[]>([], (set) => {
    const sub = liveQuery(() => listLayerMetas(db, volumeUuid)).subscribe({
      next: (rows) => set(summarizeLayers(rows)),
      error: (error) => {
        console.debug('[layer-list] liveQuery failed:', error);
        set([]);
      }
    });
    return () => sub.unsubscribe();
  });
}

/**
 * The layer the `L` hotkey moves to: Primary (null) → each layer in list
 * order → Primary again. A displayed id that is no longer listed (deleted
 * under us) restarts the cycle; with no layers at all it stays on Primary.
 */
export function nextLayerId(current: string | null, layers: LayerSummary[]): string | null {
  if (layers.length === 0) return null;
  if (current === null) return layers[0].layer_id;
  const i = layers.findIndex((l) => l.layer_id === current);
  if (i === -1) return layers[0].layer_id;
  return i + 1 < layers.length ? layers[i + 1].layer_id : null;
}

/** The reverse of {@link nextLayerId}: Primary ← each layer ← Primary. */
export function prevLayerId(current: string | null, layers: LayerSummary[]): string | null {
  if (layers.length === 0) return null;
  if (current === null) return layers[layers.length - 1].layer_id;
  const i = layers.findIndex((l) => l.layer_id === current);
  if (i === -1) return layers[layers.length - 1].layer_id;
  return i > 0 ? layers[i - 1].layer_id : null;
}
