/**
 * What a layer's id and kind say about what it may be used for. Free of
 * stores and Dexie on purpose: the picker, the settings panel, the action
 * orchestrator, the key handlers and the store all ask the same question, and
 * none of them should have to pull in the database to do it.
 */
import type { VolumeOcrLayerKind } from '$lib/types';
import { EDIT_LAYER_ID, isCuratedLayerId, isServerKeepsakeLayerId } from './layer-names';
import { CANNOT_PUBLISH_CURATED_MESSAGE } from '$lib/util/sync/account-capabilities';

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

/** Every action the layer UI offers (the picker's rows, its New button, the keys). */
export type LayerCommand =
  'new' | 'rename' | 'promote' | 'export' | 'delete' | 'publish' | 'unpublish' | 'copy-to-edit';

/**
 * `shown`: the picker still draws the button, disabled, with `reason` as its
 * tooltip — an action every other layer has, so its absence needs explaining
 * (Promote on a translation). Without it the button is simply not there.
 */
export type LayerActionAvailability =
  { available: true } | { available: false; reason: string; shown?: true };

export const PRIMARY_LAYER_ACTION_BLOCKED = 'Not available for the primary layer';

const unavailable = (reason: string): LayerActionAvailability => ({ available: false, reason });

/**
 * May `action` run on `layer` — `null` being the primary — and if not, why.
 * ONE answer for the picker's rows and for the keys bound to the layer
 * commands, which act on the displayed layer (#55, spec 17.10): a key can
 * never do what the row's buttons would not offer, and says why instead.
 *
 * New is the one action that needs no layer. Everything else is a row
 * action, and the primary has no row actions.
 */
export function layerActionAvailable(
  action: LayerCommand,
  layer: {
    layer_id: string;
    kind?: VolumeOcrLayerKind;
    engine?: string;
    cloud?: unknown;
  } | null,
  opts: { canPublish: boolean; status: { serverCompilesMetadata?: boolean } | null | undefined }
): LayerActionAvailability {
  if (action === 'new') return { available: true };
  if (!layer) return unavailable(PRIMARY_LAYER_ACTION_BLOCKED);
  const original = layer.layer_id === 'original';
  const row = layerRowActions(layer, opts);
  switch (action) {
    case 'rename':
      return original ? unavailable('The original layer cannot be renamed') : { available: true };
    case 'promote':
      if (original) return unavailable('The original layer cannot be promoted');
      if (isTranslationLayer(layer)) {
        return { available: false, reason: TRANSLATION_PROMOTE_BLOCKED, shown: true };
      }
      return { available: true };
    case 'publish':
      if (layer.layer_id !== EDIT_LAYER_ID) {
        return unavailable('Only your corrections layer can be published');
      }
      return row.publish ? { available: true } : unavailable(CANNOT_PUBLISH_CURATED_MESSAGE);
    case 'unpublish':
      if (!isCuratedLayerId(layer.layer_id)) {
        return unavailable('Only the shared corrections can be unpublished');
      }
      return row.unpublish ? { available: true } : unavailable(CANNOT_PUBLISH_CURATED_MESSAGE);
    case 'copy-to-edit':
      return row.copyToEdit
        ? { available: true }
        : unavailable('This layer is edited in place: there is nothing to copy');
    case 'export':
      return { available: true };
    case 'delete':
      if (row.delete) return { available: true };
      return unavailable(
        original
          ? 'The original layer cannot be deleted'
          : 'The shared corrections are removed with Unpublish'
      );
  }
}
