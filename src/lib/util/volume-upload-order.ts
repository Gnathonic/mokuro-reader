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
 * A primary `<Title>.mokuro` whose title ends in such a layer id (`Notes.edit`,
 * `X.curated`) reads to bunko as `<stem>.<id>.mokuro`, and is refused the
 * same way until `<Title>.cbz` is listed (only then is it that volume's
 * primary).
 */
function primaryAnchoredOnArchive(filename: string): boolean {
  const title = filename.replace(/\.mokuro(?:\.gz)?$/i, '');
  const dot = title.lastIndexOf('.');
  return dot > 0 && anchoredOnArchive(title.slice(dot + 1));
}

/**
 * The server refused THIS layer file (403 forbidden / 409 conflict, or a
 * provider's non-auth `PERMISSION_DENIED`): bunko answers so for a layer id it
 * reserves (a case merge's `curated-<n>`, a 0.7.x `edit`), a library file this
 * account may not write (another account's series or volume), or one it cannot
 * anchor yet. Never a 401 (credentials), a 5xx or a network failure — those
 * fail the backup as before.
 *
 * Decided on the numeric `status` the error CARRIES, never on its message.
 * Every upload path types its failures: the WebDAV core throws a
 * `WebdavUploadError` (`status`, plus bunko's verdict `reason` — `no-volume`,
 * a reserved id — which the caller's log line carries), Drive a
 * `DriveHttpError` (`status` + `kind`), the main-thread providers a
 * `ProviderError` (`code`). Matching "403" in a message once took the Drive
 * core's `Upload failed: 403 Forbidden` — a rate limit or a full account, in
 * a transient wrapper — for a refusal and silently dropped the layer. A
 * Drive failure whose `kind` names a rate limit, quota, transient or auth
 * cause is not a refusal either, whatever status it rode in on.
 */
export function isLayerFileRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { status, code, isAuthError, kind } = error as {
    status?: unknown;
    code?: unknown;
    isAuthError?: unknown;
    kind?: unknown;
  };
  if (status === 401 || isAuthError === true) return false;
  if (typeof kind === 'string' && kind !== 'other') return false;
  if (status === 403 || status === 409) return true;
  return code === 'PERMISSION_DENIED';
}

/**
 * Primary sidecar, the other layers, the cover, the archive, then the layers
 * anchored on it (and a primary whose title names one,
 * `primaryAnchoredOnArchive`, right after the archive). Up to the archive, a failure fails the backup (the archive
 * is never sent without its sidecars) — except a LAYER the server refuses
 * (`isLayerFileRefusal`), which is somebody else's file or not one this
 * account may write: it is logged at debug and left out. After the archive,
 * any failed layer is left out. `layers` is what this upload sent, which the
 * caller stamps synced; a layer left out stays unstamped, and the next
 * listing's layer sync pushes it (or remembers the refusal).
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
  const sent: LayerSidecar[] = [];

  const sendPrimary = async (mokuro: VolumeSidecarBlobData) => {
    const primary = await upload.sidecar(mokuro);
    await hooks.onPrimary?.(mokuro, primary);
    hooks.onSidecar?.();
  };
  const primaryLast = !!sidecars?.mokuro && primaryAnchoredOnArchive(sidecars.mokuro.filename);

  if (sidecars?.mokuro && !primaryLast) await sendPrimary(sidecars.mokuro);
  for (const layer of before) {
    try {
      await upload.sidecar(layer);
    } catch (error) {
      if (!isLayerFileRefusal(error)) throw error;
      console.debug(`[backup] the server refused ${layer.filename}; layer sync decides:`, error);
      continue;
    }
    sent.push(layer);
    hooks.onSidecar?.();
  }
  if (sidecars?.thumbnail) {
    await upload.sidecar(sidecars.thumbnail);
    hooks.onSidecar?.();
  }

  const archive = await upload.archive();
  // Still required: its failure fails the backup, archive up or not.
  if (sidecars?.mokuro && primaryLast) await sendPrimary(sidecars.mokuro);

  for (const layer of after) {
    try {
      await upload.sidecar(layer);
      sent.push(layer);
    } catch (error) {
      if (isLayerFileRefusal(error)) {
        console.debug(`[backup] the server refused ${layer.filename}; layer sync decides:`, error);
      } else {
        console.warn(`[backup] ${layer.filename} did not go up; layer sync retries it:`, error);
      }
    }
  }
  return { archive, layers: sent };
}
