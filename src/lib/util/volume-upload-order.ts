/**
 * The order a backup sends a volume's files in — one rule for the Worker
 * upload and the main-thread one (`backup-queue.ts`). Pure, so the Worker can
 * import it.
 */

import { isCuratedLayerId, isPersonalLayerId } from '$lib/reader/edit/layer-names';
import type { VolumeSidecarBlobData, VolumeSidecarBlobResult } from './compress-volume';

type LayerSidecar = NonNullable<VolumeSidecarBlobResult['layers']>[number];

/**
 * A layer file mokuro-bunko anchors on the volume's archive: an account's
 * `edit` overlay or the shared `curated` layer is refused (409 `no-volume`)
 * while no `<Volume>.cbz` is listed beside it.
 */
function anchoredOnArchive(layerId: string): boolean {
  return isPersonalLayerId(layerId) || isCuratedLayerId(layerId);
}

/**
 * Primary sidecar, the other layers, the cover, the archive, then the layers
 * anchored on it. Up to the archive, a failure fails the backup (the archive
 * is never sent without its sidecars). After it, a refused layer is logged and
 * left out of `layers` — the layers this upload sent, which the caller stamps
 * synced — so the next listing's layer sync pushes it; the archive is up.
 */
export async function uploadVolumeFiles<A, S>(
  sidecars: VolumeSidecarBlobResult | undefined,
  upload: {
    sidecar: (file: VolumeSidecarBlobData) => Promise<S>;
    archive: () => Promise<A>;
  },
  hooks: {
    /** The primary sidecar went up, with what its upload returned. */
    onPrimary?: (file: VolumeSidecarBlobData, sent: S) => Promise<void> | void;
    /** Any sidecar went up (progress). */
    onSidecar?: () => void;
  } = {}
): Promise<{ archive: A; layers: LayerSidecar[] }> {
  const layers = sidecars?.layers ?? [];
  const before = layers.filter((layer) => !anchoredOnArchive(layer.layerId));
  const after = layers.filter((layer) => anchoredOnArchive(layer.layerId));

  if (sidecars?.mokuro) {
    const sent = await upload.sidecar(sidecars.mokuro);
    await hooks.onPrimary?.(sidecars.mokuro, sent);
    hooks.onSidecar?.();
  }
  for (const layer of before) {
    await upload.sidecar(layer);
    hooks.onSidecar?.();
  }
  if (sidecars?.thumbnail) {
    await upload.sidecar(sidecars.thumbnail);
    hooks.onSidecar?.();
  }

  const archive = await upload.archive();

  const sent = [...before];
  for (const layer of after) {
    try {
      await upload.sidecar(layer);
      sent.push(layer);
    } catch (error) {
      console.warn(`[backup] ${layer.filename} did not go up; layer sync retries it:`, error);
    }
  }
  return { archive, layers: sent };
}
