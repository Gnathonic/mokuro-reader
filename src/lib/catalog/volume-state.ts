import type { VolumeMetadata } from '$lib/types';

/**
 * A volume in the catalog is in one of three states:
 *
 * - **installed** — a `volumes` row with its OCR and image rows behind it. The
 *   only state that can be read, exported, backed up or extracted.
 * - **metadata only** — a `volumes` row without its OCR and image rows, because
 *   the user removed them from this device (`metadata_only`). The metadata, the
 *   thumbnail and above all the `volume_uuid` survive, so the read history keyed
 *   by that uuid keeps counting and the catalog keeps its cover. Nothing can
 *   read its pages.
 * - **placeholder** — no row at all: a volume that only ever existed in the
 *   cloud (`isPlaceholder`, synthesised per listing by `placeholders.ts`).
 *
 * The last two both mean "the pages are not here, offer a download"; only the
 * first means "the pages are here". Test them through these two helpers instead
 * of the raw flags, so a site is never accidentally written for one of the two
 * absent states and not the other.
 */

/** Are this volume's pages on the device? */
export function isVolumeInstalled(volume: VolumeMetadata): boolean {
  return !volume.isPlaceholder && !volume.metadata_only;
}

/** Does this volume need downloading before it can be read? */
export function needsDownload(volume: VolumeMetadata): boolean {
  return !!(volume.isPlaceholder || volume.metadata_only);
}

/**
 * A row kept for its history after its files were removed. Placeholders are NOT
 * this: they have no row and no history.
 */
export function isMetadataOnly(volume: VolumeMetadata): boolean {
  return !volume.isPlaceholder && !!volume.metadata_only;
}
