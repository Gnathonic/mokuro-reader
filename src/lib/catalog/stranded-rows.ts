import { db } from '$lib/catalog/db';
import { deleteVolumeCompletely } from '$lib/import/database';
import { isMetadataOnly } from '$lib/catalog/volume-state';

/**
 * After a download lands: drop the metadata-only row this volume used to occupy
 * under a different uuid.
 *
 * The uuid comes from the archive's `.mokuro`, which is not always the uuid the
 * row was created with (a volume re-OCR'd elsewhere, or one whose placeholder
 * uuid was derived from the path before an index existed). The new row now owns
 * that series/volume title, so the old one can never be downloaded again — it
 * would sit in the catalog forever as a second, permanently "Not on this
 * device" copy of the same volume.
 *
 * Scoped to the series through the `series_title` index rather than scanning
 * the whole table: every row carries an inline thumbnail blob.
 */
export async function dropStrandedMetadataOnlyRow(savedUuid: string): Promise<void> {
  try {
    const saved = await db.volumes.get(savedUuid);
    if (!saved) return;

    const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const siblings = await db.volumes.where('series_title').equals(saved.series_title).toArray();
    for (const row of siblings) {
      if (row.volume_uuid === savedUuid) continue;
      if (!isMetadataOnly(row)) continue;
      if (!sameTitle(row.volume_title, saved.volume_title)) continue;
      console.log('[Download Queue] Dropping the stranded metadata-only row for', row.volume_title);
      await deleteVolumeCompletely(row.volume_uuid);
    }
  } catch (error) {
    console.warn('[Download Queue] Could not drop a stranded metadata-only row:', error);
  }
}
