/**
 * The editor's one write path. `persistPageEdit` replaces one page of the
 * PRIMARY OCR row (`volume_ocr`) — the local view every consumer reads — and
 * recounts the volume's characters in a single transaction. The same
 * transaction:
 *
 * - snapshots the pre-edit pages into the `original` layer on the first save
 *   (Revert's base, and the model output a cloud upload of the main sidecar
 *   is built from — see below), so a crash can never leave an edited primary
 *   without its original;
 * - writes the page into the `edit` layer (`EDIT_LAYER_ID`), created from the
 *   pre-edit primary on the first save. THAT layer is how corrections reach
 *   the cloud: layer-sync pushes it as `<Volume>.edit.mokuro`, with the
 *   top-level `edited` block (`buildLayerMokuroMetadata`).
 *
 * The main `<Volume>.mokuro` is model output (bunko design 0.8 D4): an edit
 * NEVER re-uploads it. Every cloud write of an edited volume's main sidecar
 * (a first backup, the sidecar backfill, a rename's regeneration) is built
 * from the `original` snapshot instead of the edited primary
 * (`catalog/main-sidecar.ts`). Promotion likewise stays a local view choice.
 */
import { db } from '$lib/catalog/db';
import {
  getLayerMeta,
  getLayerPages,
  getLayerWithPages,
  layerTables,
  putLayerWithPages
} from '$lib/catalog/layer-store';
import { buildPageCharCounts } from '$lib/catalog/cloud-ocr-upgrade';
import { mainSidecarPagesForCloud as mainSidecarPagesFor } from '$lib/catalog/main-sidecar';
import type { Page } from '$lib/types';
import { EDIT_LAYER_ID, layerNameForId } from './layer-names';
import { editLayerEpoch } from './edit-layer-epoch';

export const ORIGINAL_LAYER_ID = 'original';
export { EDIT_LAYER_ID };

/** Ask layer-sync to push edited layers once the edits settle. Never throws. */
export function noteLayerEdited(): void {
  void import('$lib/metadata/layer-sync')
    .then((m) => m.scheduleLayerPush())
    .catch((error) => console.debug('[edit-persist] could not schedule the layer push:', error));
}

export async function persistPageEdit(
  volumeUuid: string,
  pageIndex: number,
  page: Page
): Promise<void> {
  editLayerEpoch(); // before the stamp below: this edit is on the new path
  const editedAt = new Date().toISOString();
  await db.transaction('rw', [db.volumes, db.volume_ocr, ...layerTables(db)], async () => {
    const ocr = await db.volume_ocr.get(volumeUuid);
    if (!ocr) throw new Error(`Volume ${volumeUuid} has no OCR row to edit`);

    // Every save asks this, so it must stay a metadata read: the snapshot's
    // pages are a whole volume of OCR.
    if (!(await getLayerMeta(db, volumeUuid, ORIGINAL_LAYER_ID))) {
      await putLayerWithPages(db, {
        volume_uuid: volumeUuid,
        layer_id: ORIGINAL_LAYER_ID,
        name: 'Original',
        kind: 'original',
        created_at: editedAt,
        updated_at: editedAt,
        pages: ocr.pages
      });
    }

    // The corrections layer: the pre-edit primary on its first save (so it
    // also carries corrections an older reader left in the primary), then this
    // page. Page by page, so pages edited in the layer itself are kept.
    const editLayer = await getLayerWithPages(db, volumeUuid, EDIT_LAYER_ID);
    const editPages = (editLayer?.pages ?? ocr.pages).slice();
    editPages[pageIndex] = page;
    await putLayerWithPages(
      db,
      editLayer
        ? { ...editLayer, updated_at: editedAt, pages: editPages }
        : {
            volume_uuid: volumeUuid,
            layer_id: EDIT_LAYER_ID,
            name: layerNameForId(EDIT_LAYER_ID),
            kind: 'edit',
            created_at: editedAt,
            updated_at: editedAt,
            pages: editPages
          }
    );

    const pages = ocr.pages.slice();
    pages[pageIndex] = page;
    const { totalChars, cumulative } = buildPageCharCounts(pages);
    await db.volume_ocr.put({ volume_uuid: volumeUuid, pages });
    await db.volumes.update(volumeUuid, {
      page_char_counts: cumulative,
      character_count: totalChars,
      ocr_edited_at: editedAt
    });
  });
  noteLayerEdited();
}

/** `catalog/main-sidecar.ts`'s rule on the app's own connection. */
export function mainSidecarPagesForCloud(
  volume: { volume_uuid: string; ocr_edited_at?: string },
  primaryPages: Page[] | null
): Promise<Page[] | null> {
  return mainSidecarPagesFor(db, volume, primaryPages);
}

export async function hasOriginalLayer(volumeUuid: string): Promise<boolean> {
  return (await getLayerMeta(db, volumeUuid, ORIGINAL_LAYER_ID)) !== undefined;
}

export async function loadOriginalPage(
  volumeUuid: string,
  pageIndex: number
): Promise<Page | null> {
  const pages = await getLayerPages(db, volumeUuid, ORIGINAL_LAYER_ID);
  return pages?.[pageIndex] ?? null;
}
