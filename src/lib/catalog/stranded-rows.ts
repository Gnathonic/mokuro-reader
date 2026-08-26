import { db } from '$lib/catalog/db';
import { deleteVolumeCompletely } from '$lib/import/database';
import { isMetadataOnly } from '$lib/catalog/volume-state';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import { volumesForFoldedSeriesTitle } from '$lib/catalog/volumes-by-series';

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
 * Candidates are found through `volumesForFoldedSeriesTitle`, folded by the
 * catalog's own grouping key (`normalizeSeriesKey`) rather than a byte-wise
 * `equalsIgnoreCase` lookup — `equalsIgnoreCase` is case- but not
 * whitespace-insensitive, so it cannot see a row filed under 'Dr  Stone' when
 * the download landed under 'Dr Stone', and `materializeSeriesVolumes` groups
 * those as ONE series, so it can create exactly that row. A sibling missed
 * here is the permanent duplicate this function exists to prevent. Unlike a
 * full table scan, an index-only read of the distinct series titles costs
 * nothing for the (typical) case where nothing shares this series' fold.
 */
export async function dropStrandedMetadataOnlyRow(savedUuid: string): Promise<void> {
  try {
    const saved = await db.volumes.get(savedUuid);
    if (!saved) return;

    const sameTitle = (a: string, b: string) =>
      normalizeVolumeTitleKey(a) === normalizeVolumeTitleKey(b);

    // Already folded by `volumesForFoldedSeriesTitle`, so every row here is
    // already known to share the series key — only the volume title still
    // needs checking.
    const siblings = await volumesForFoldedSeriesTitle(saved.series_title, normalizeSeriesKey);
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
