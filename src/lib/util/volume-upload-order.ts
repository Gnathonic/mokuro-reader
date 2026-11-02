/**
 * The order a backup sends a volume's files in — one rule for the Worker
 * upload and the main-thread one (`backup-queue.ts`). Pure, so the Worker can
 * import it.
 */

import type { VolumeSidecarBlobData, VolumeSidecarBlobResult } from './compress-volume';

type LayerSidecar = NonNullable<VolumeSidecarBlobResult['layers']>[number];

/**
 * The layer ids mokuro-bunko 0.8 reserves for its per-account corrections
 * (`edit`, `edit-<n>`) and its shared `curated` layer — a layer named "Edit"
 * or "Curated" here slugs to one of them.
 */
const ANCHORED_LAYER_ID_RE = /^(?:edit(?:-\d+)?|curated)$/;

/**
 * A layer file mokuro-bunko anchors on the volume's archive: such an id is
 * refused (409 `no-volume`) while no `<Volume>.cbz` is listed beside it.
 */
function anchoredOnArchive(layerId: string): boolean {
  return ANCHORED_LAYER_ID_RE.test(layerId);
}

/**
 * The server refused THIS layer file (403 forbidden / 409 conflict, or a
 * provider's non-auth `PERMISSION_DENIED`): bunko 0.8 answers so for a layer id it
 * reserves (`previous-ocr*`, `pre-upgrade*`, `curated-<n>` — refused
 * whatever the order) or one it cannot anchor yet. Never a 401 (credentials), a
 * 5xx or a network failure — those fail the backup as before.
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
 * anchored on it. Up to the archive, a failure fails the backup (the archive
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

  if (sidecars?.mokuro) {
    const primary = await upload.sidecar(sidecars.mokuro);
    await hooks.onPrimary?.(sidecars.mokuro, primary);
    hooks.onSidecar?.();
  }
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
