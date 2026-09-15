/**
 * Reactive list of a volume's layers WITHOUT their pages — the picker and the
 * settings panel only need names and kinds, and a layer's pages can be
 * megabytes. Backed by a Dexie liveQuery so a create/rename/delete anywhere
 * re-renders every picker.
 */
import { liveQuery } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { db } from '$lib/catalog/db';
import type { VolumeOcrLayer, VolumeOcrLayerKind } from '$lib/types';
import { ORIGINAL_LAYER_ID } from './edit-persist';

export interface LayerSummary {
  layer_id: string;
  name: string;
  kind: VolumeOcrLayerKind;
  engine?: string;
  updated_at: string;
}

export function summarizeLayers(rows: VolumeOcrLayer[]): LayerSummary[] {
  return [...rows]
    .sort((a, b) => {
      if (a.layer_id === ORIGINAL_LAYER_ID) return -1;
      if (b.layer_id === ORIGINAL_LAYER_ID) return 1;
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    })
    .map(({ layer_id, name, kind, engine, updated_at }) => ({
      layer_id,
      name,
      kind,
      ...(engine ? { engine } : {}),
      updated_at
    }));
}

export function layerSummaries(volumeUuid: string): Readable<LayerSummary[]> {
  return readable<LayerSummary[]>([], (set) => {
    const sub = liveQuery(() =>
      db.volume_ocr_layers.where('volume_uuid').equals(volumeUuid).toArray()
    ).subscribe({
      next: (rows) => set(summarizeLayers(rows)),
      error: (error) => {
        console.debug('[layer-list] liveQuery failed:', error);
        set([]);
      }
    });
    return () => sub.unsubscribe();
  });
}
