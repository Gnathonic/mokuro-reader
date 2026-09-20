/**
 * The editor's one write path. `persistPageEdit` replaces one page of the
 * PRIMARY OCR row (`volume_ocr`) and recounts the volume's characters in a
 * single transaction; the first save for a volume also snapshots the pre-edit
 * pages into the `original` layer, in that same transaction, so a crash can
 * never leave an edited primary without its original.
 *
 * The primary row is what the backup serializes into `.mokuro`
 * (`buildVolumeSidecarsFromData`), so an edit here IS the cloud edit — the
 * `ocr_edited_at` stamp plus `noteOcrEdited` are what get that sidecar
 * re-uploaded (see `sidecar-backfill.ts`).
 */
import { db } from '$lib/catalog/db';
import {
  getLayerMeta,
  getLayerPages,
  layerTables,
  putLayerWithPages
} from '$lib/catalog/layer-store';
import { buildPageCharCounts } from '$lib/catalog/cloud-ocr-upgrade';
import { noteOcrEdited } from '$lib/util/sync/sidecar-backfill';
import type { Page } from '$lib/types';

export const ORIGINAL_LAYER_ID = 'original';

export async function persistPageEdit(
  volumeUuid: string,
  pageIndex: number,
  page: Page
): Promise<void> {
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
  try {
    noteOcrEdited(volumeUuid);
  } catch (error) {
    console.debug('[edit-persist] could not nominate volume for sidecar re-upload:', error);
  }
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
