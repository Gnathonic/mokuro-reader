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

/**
 * What the primary OCR row is called in the layer picker, settings select and
 * switch toasts: the mokuro name with the version that produced it
 * (`mokuro 0.2.2`), so it reads as one engine among the layers rather than a
 * status word. An image-only volume (empty version) is plain `mokuro`.
 */
export function primaryLayerName(mokuroVersion: string | undefined | null): string {
  const v = (mokuroVersion ?? '').trim();
  return v ? `mokuro ${v}` : 'mokuro';
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
