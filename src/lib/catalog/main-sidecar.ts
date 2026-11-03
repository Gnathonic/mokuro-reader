/**
 * What a CLOUD upload of a volume's MAIN sidecar (`<Volume>.mokuro`) carries.
 *
 * The main sidecar is model output (bunko design 0.8 D4): a person's
 * corrections ride in the `edit` layer (`reader/edit/edit-persist.ts`), and a
 * promoted layer is only a local view. So the local primary row — which holds
 * those corrections and promotions, because every local consumer reads it —
 * is uploaded as the main sidecar only while the volume is UNEDITED
 * (`ocr_edited_at` absent). An edited volume's main sidecar is built from its
 * `original` layer, the read-only pre-edit snapshot the first edit (or
 * promotion) took. Exports and other local files keep the primary as it is.
 *
 * Worker-safe: takes the connection, imports only `layer-store`.
 */
import type Dexie from 'dexie';
import type { Page } from '$lib/types';
import { getLayerPages } from './layer-store';

/** The editor's pre-edit snapshot (`edit-persist.ts`'s `ORIGINAL_LAYER_ID`). */
const ORIGINAL_LAYER = 'original';

/**
 * The pages for a cloud main sidecar: the primary's when unedited, else the
 * `original` snapshot's. Null when the volume is edited and has no snapshot —
 * the caller then uploads NO main sidecar rather than the corrected primary.
 */
export async function mainSidecarPagesForCloud(
  db: Dexie,
  volume: { volume_uuid: string; ocr_edited_at?: string },
  primaryPages: Page[] | null
): Promise<Page[] | null> {
  if (!volume.ocr_edited_at) return primaryPages;
  return getLayerPages(db, volume.volume_uuid, ORIGINAL_LAYER);
}
