/**
 * What a layer's id and kind say about what it may be used for. Dependency
 * free on purpose: the picker, the settings panel, the action orchestrator and
 * the store all ask the same question, and none of them should have to pull in
 * Dexie to do it.
 */
import type { VolumeOcrLayerKind } from '$lib/types';
import { EDIT_LAYER_ID, isCuratedLayerId, isServerKeepsakeLayerId } from './layer-names';

const TRANSLATION_ID_RE = /^tr-[a-z0-9-]+$/;

/** `tr-en`, `tr-pt-br`: the id shape every translation engine writes. */
export function isTranslationLayerId(layerId: string): boolean {
  return TRANSLATION_ID_RE.test(layerId);
}

/**
 * A translation by its row's kind OR by its id alone. The id counts even when
 * the row says otherwise, because a layer's kind does not travel: the cloud
 * file and an imported sidecar carry only the id, and every other device files
 * a `tr-<lang>` layer as a translation (`layerKindForId`).
 */
export function isTranslationLayer(layer: {
  layer_id: string;
  kind?: VolumeOcrLayerKind;
}): boolean {
  return layer.kind === 'translation' || isTranslationLayerId(layer.layer_id);
}

/**
 * Why a translation can never be promoted, as the UI states it. The primary
 * OCR row is what the volume's character counts are taken from, and the count
 * only knows Japanese (`countCharsInLines`): an English layer recounts to ~0,
 * and that number reaches the catalog, the reading-speed stats, the cloud
 * `.mokuro` sidecar and `series.json`.
 */
export const TRANSLATION_PROMOTE_BLOCKED =
  'A translation cannot be the primary OCR: character stats are counted from its Japanese text.';

/**
 * OCR a cloud's model wrote: an `ocr` row with an engine that a cloud vouches
 * for (pulled, not a run on this device). On a server that compiles its
 * metadata it is the server's to write: an edit forks into `edit`
 * (`forksOnEdit`), and nothing of it goes up (`layerStaysLocal`, for a row an
 * edit reached anyway).
 */
export function isCloudModelOutput(layer: {
  kind?: VolumeOcrLayerKind;
  engine?: string;
  cloud?: unknown;
}): boolean {
  return layer.kind === 'ocr' && !!layer.engine && !!layer.cloud;
}

/**
 * Does an edit of this layer go into the account's own `edit` layer instead
 * (bunko design 0.8 D4: human corrections live in their own file)? Always for
 * the shared `curated` layer: it is written by Publish alone. On a server that
 * compiles its metadata (mokuro-bunko) also for its keepsake (a case merge's
 * `curated-<n>`) and for the OCR a server stamped
 * (`isCloudModelOutput`): on a shared library those are the one copy every
 * account reads. On plain storage they are the user's own files, edited in place.
 */
export function forksOnEdit(
  layer: { layer_id: string; kind?: VolumeOcrLayerKind; engine?: string; cloud?: unknown },
  status: { serverCompilesMetadata?: boolean } | null | undefined
): boolean {
  if (isCuratedLayerId(layer.layer_id)) return true;
  if (status?.serverCompilesMetadata !== true) return false;
  if (isServerKeepsakeLayerId(layer.layer_id)) return true;
  return isCloudModelOutput(layer);
}

/** The per-row layer actions whose presence depends on what the layer is. */
export interface LayerRowActions {
  /** Publish the account's `edit` layer as the library's shared `curated`. */
  publish: boolean;
  /** Remove the shared `curated` layer for everyone. */
  unpublish: boolean;
  /** Replace the account's `edit` layer with this one's pages. */
  copyToEdit: boolean;
  delete: boolean;
}

/**
 * The layer menu's id-dependent actions (picker and settings panel alike).
 * Publish/Unpublish need the right to publish this volume
 * (`canPublishCurated`, `canPublish`). Delete is never offered on `curated`:
 * this device may not delete the shared file (`layerIdStaysLocal`), so a
 * Delete would only hide it here — Unpublish is the deliberate way.
 */
export function layerRowActions(
  layer: { layer_id: string; kind?: VolumeOcrLayerKind; engine?: string; cloud?: unknown },
  opts: { canPublish: boolean; status: { serverCompilesMetadata?: boolean } | null | undefined }
): LayerRowActions {
  const curated = isCuratedLayerId(layer.layer_id);
  return {
    publish: opts.canPublish && layer.layer_id === EDIT_LAYER_ID,
    unpublish: opts.canPublish && curated,
    copyToEdit: forksOnEdit(layer, opts.status),
    delete: !curated && layer.layer_id !== 'original'
  };
}
