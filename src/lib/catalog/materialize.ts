import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesFileVolume } from '$lib/metadata/series-file';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';
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
 * The index stays UNAUTHORITATIVE, so four rules are absolute:
 *
 * 0. A row this series does not own is never written, full stop. `volume_uuid`
 *    is the whole table's primary key and is title-independent, so an index
 *    entry can name a uuid that already belongs to an INSTALLED volume of a
 *    DIFFERENT series ('Dr. Stone' and 'Dr Stone' group as different series
 *    here, and a re-OCR elsewhere can mint the same uuid under either). A blind
 *    `put` would replace that row wholesale — thumbnail and counts wiped, its
 *    `volume_ocr`/`volume_files` rows orphaned behind a metadata-only shell. So
 *    every uuid is looked up across the WHOLE table first, and an entry whose
 *    uuid belongs to another series is skipped entirely: not written, and not
 *    given a duplicate row under this series either.
 * 1. An INSTALLED row is never touched. Its data was measured, the index's was
 *    copied.
 * 2. A volume title a local row already owns is never given a second row, even
 *    when the index lists a different uuid for it (a volume re-OCR'd elsewhere,
 *    or a row created from a path-derived placeholder uuid). That second row
 *    could never be downloaded and would sit in the catalog forever — exactly
 *    the duplicate `stranded-rows.ts` exists to clean up after a download.
 * 3. An existing metadata-only row is only ever FILLED, never downgraded: a
 *    zero count or the `'unknown'` placeholder version is a gap, any other
 *    local value wins. A known consequence: counts are frozen at first
 *    materialization, so a later index that CORRECTS them cannot apply. Telling
 *    "filled from an index, never verified" apart from "measured locally" would
 *    need a provenance marker on the row; that is deliberately not implemented,
 *    because fill-never-downgrade is exactly what keeps local authoritative.
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

  const cloudTitleKeys = new Set([...cloudVolumeTitles].map(normalizeVolumeTitleKey));

  return db.transaction('rw', db.volumes, async () => {
    // Indexed lookup of the series' rows. `equalsIgnoreCase` is case- but not
    // whitespace-insensitive, so it is re-filtered by the catalog's own grouping
    // key: a row is a sibling only when it normalizes to this series.
    const fetched = (await db.volumes
      .where('series_title')
      .equalsIgnoreCase(seriesTitle)
      .toArray()) as VolumeMetadata[];
    const siblings = fetched.filter((row) => normalizeSeriesKey(row.series_title) === seriesKey);

    // Rule 0: the uuids in play may belong to rows the indexed lookup above
    // cannot see — another series entirely, or this series under a
    // whitespace-variant spelling that `equalsIgnoreCase` misses. The primary
    // key is global, so resolve them globally before writing anything.
    const owners = new Map<string, VolumeMetadata>();
    for (const row of await db.volumes.bulkGet(entries.map((e) => e.volume_uuid))) {
      if (row) owners.set(row.volume_uuid, row as VolumeMetadata);
    }

    const titlesTaken = new Map(
      siblings.map((row) => [normalizeVolumeTitleKey(row.volume_title), row])
    );
    const seriesUuid = siblings[0]?.series_uuid ?? generateDeterministicUUID(seriesTitle);

    let changed = 0;
    for (const entry of entries) {
      const titleKey = normalizeVolumeTitleKey(entry.volume_title);
      if (!titleKey || !cloudTitleKeys.has(titleKey)) continue;

      const existing = owners.get(entry.volume_uuid);
      if (existing) {
        // Rule 0: someone else's row. Leave it alone and mint nothing for it —
        // a duplicate here could never be downloaded onto that uuid anyway.
        if (normalizeSeriesKey(existing.series_title) !== seriesKey) continue;
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
      owners.set(row.volume_uuid, row);
      titlesTaken.set(titleKey, row);
      changed += 1;
    }
    return changed;
  });
}
