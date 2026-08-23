import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesFileVolume } from '$lib/metadata/series-file';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
import { isVolumeInstalled } from '$lib/catalog/volume-state';

/**
 * Promote a series' index entries into real `volumes` rows in the
 * metadata-only state — the same state "remove from device" leaves behind.
 *
 * This is what makes a cloud-only series a first-class citizen: the row carries
 * the volume's REAL uuid (so synced progress attaches to it), its counts, its
 * `mokuro_version` and its `spine_width`, so the catalog, the stats views and
 * the tracker all work before a single archive is downloaded. It replaces the
 * transient placeholder for that volume permanently — `generatePlaceholders`
 * already skips any path or uuid that has a local row.
 *
 * The index stays UNAUTHORITATIVE, so three rules are absolute:
 *
 * 1. An INSTALLED row is never touched. Its data was measured, the index's was
 *    copied.
 * 2. A volume title a local row already owns is never given a second row, even
 *    when the index lists a different uuid for it (a volume re-OCR'd elsewhere,
 *    or a row created from a path-derived placeholder uuid). That second row
 *    could never be downloaded and would sit in the catalog forever — exactly
 *    the duplicate `stranded-rows.ts` exists to clean up after a download.
 * 3. An existing metadata-only row is only ever FILLED, never downgraded: a
 *    zero count or the `'unknown'` placeholder version is a gap, any other
 *    local value wins.
 *
 * Gated on `cloudVolumeTitles` — the `.cbz` titles the current listing shows in
 * the folder — so a stale index cannot resurrect a deleted volume. An empty set
 * means the listing is unavailable as often as it means the folder is empty, so
 * nothing is materialized.
 *
 * Returns how many rows were created or filled.
 */
export async function materializeSeriesVolumes(args: {
  seriesTitle: string;
  entries: SeriesFileVolume[];
  cloudVolumeTitles: Set<string>;
}): Promise<number> {
  const { seriesTitle, entries, cloudVolumeTitles } = args;
  if (entries.length === 0 || cloudVolumeTitles.size === 0) return 0;

  const seriesKey = normalizeSeriesKey(seriesTitle);
  if (!seriesKey) return 0;

  const cloudTitleKeys = new Set([...cloudVolumeTitles].map((t) => normalizeSeriesKey(t)));

  return db.transaction('rw', db.volumes, async () => {
    const siblings = (await db.volumes
      .where('series_title')
      .equalsIgnoreCase(seriesTitle)
      .toArray()) as VolumeMetadata[];

    const byUuid = new Map(siblings.map((row) => [row.volume_uuid, row]));
    const titlesTaken = new Map(siblings.map((row) => [normalizeSeriesKey(row.volume_title), row]));
    const seriesUuid = siblings[0]?.series_uuid ?? generateDeterministicUUID(seriesTitle);

    let changed = 0;
    for (const entry of entries) {
      const titleKey = normalizeSeriesKey(entry.volume_title);
      if (!titleKey || !cloudTitleKeys.has(titleKey)) continue;

      const existing = byUuid.get(entry.volume_uuid);
      if (existing) {
        // Rule 1: an installed row was measured; the index was copied.
        if (isVolumeInstalled(existing)) continue;
        // Rule 3: fill gaps only.
        const patch: Partial<VolumeMetadata> = {};
        if (!existing.page_count && entry.page_count) patch.page_count = entry.page_count;
        if (!existing.character_count && entry.character_count) {
          patch.character_count = entry.character_count;
        }
        // `''` is a real value (image-only volume); `'unknown'` is the
        // placeholder default, i.e. "nobody has told us yet".
        if (existing.mokuro_version === 'unknown' && entry.mokuro_version !== 'unknown') {
          patch.mokuro_version = entry.mokuro_version;
        }
        if (existing.spine_width === undefined && entry.spine_width !== undefined) {
          patch.spine_width = entry.spine_width;
        }
        if (Object.keys(patch).length === 0) continue;
        await db.volumes.update(entry.volume_uuid, patch);
        changed += 1;
        continue;
      }

      // Rule 2: a local row already owns this title under another uuid.
      if (titlesTaken.has(titleKey)) continue;

      const row: VolumeMetadata = {
        volume_uuid: entry.volume_uuid,
        series_uuid: seriesUuid,
        series_title: seriesTitle,
        volume_title: entry.volume_title,
        mokuro_version: entry.mokuro_version,
        page_count: entry.page_count,
        character_count: entry.character_count,
        // Totals only — the index deliberately carries no per-page array.
        page_char_counts: [],
        metadata_only: true
      };
      if (entry.spine_width !== undefined) row.spine_width = entry.spine_width;

      await db.volumes.put(row);
      byUuid.set(row.volume_uuid, row);
      titlesTaken.set(titleKey, row);
      changed += 1;
    }
    return changed;
  });
}
