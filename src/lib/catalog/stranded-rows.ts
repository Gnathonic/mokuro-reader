import { db } from '$lib/catalog/db';
import { deleteVolumeCompletely } from '$lib/import/database';
import { isMetadataOnly } from '$lib/catalog/volume-state';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';

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
 * Candidates are found with a full-table scan, then filtered by the catalog's
 * own grouping key. The `series_title` index would be cheaper, but
 * `equalsIgnoreCase` is case- but not whitespace-insensitive, so it cannot see
 * a row filed under 'Dr  Stone' when the download landed under 'Dr Stone' —
 * and `materializeSeriesVolumes` groups those as ONE series, so it can create
 * exactly that row. A sibling missed here is the permanent duplicate this
 * function exists to prevent, which outweighs the scan: it runs once per
 * completed download, and `writeSeriesFile` already reads the table whole.
 */
export async function dropStrandedMetadataOnlyRow(savedUuid: string): Promise<void> {
  try {
    const saved = await db.volumes.get(savedUuid);
    if (!saved) return;

    const sameTitle = (a: string, b: string) =>
      normalizeVolumeTitleKey(a) === normalizeVolumeTitleKey(b);
    const savedSeriesKey = normalizeSeriesKey(saved.series_title);

    const siblings = await db.volumes.toArray();
    for (const row of siblings) {
      if (row.volume_uuid === savedUuid) continue;
      if (!isMetadataOnly(row)) continue;
      if (normalizeSeriesKey(row.series_title) !== savedSeriesKey) continue;
      if (!sameTitle(row.volume_title, saved.volume_title)) continue;
      console.log('[Download Queue] Dropping the stranded metadata-only row for', row.volume_title);
      await deleteVolumeCompletely(row.volume_uuid);
    }
  } catch (error) {
    console.warn('[Download Queue] Could not drop a stranded metadata-only row:', error);
  }
}
