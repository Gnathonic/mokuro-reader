/**
 * What a layer's id and kind say about what it may be used for. Dependency
 * free on purpose: the picker, the settings panel, the action orchestrator and
 * the store all ask the same question, and none of them should have to pull in
 * Dexie to do it.
 */
import type { VolumeOcrLayerKind } from '$lib/types';

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
