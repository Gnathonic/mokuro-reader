import { db } from '$lib/catalog/db';
import { entryMokuroVersion } from '$lib/metadata/series-file';
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
 * `mokuro_version`, its `spine_width` and its `archive_size`, so the catalog,
 * the stats views and the tracker all work before a single archive is
 * downloaded. It replaces the
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
 *    the duplicate `stranded-rows.ts` cleans up after a download, which is the
 *    safety net behind this rule and folds titles and series identically (it
 *    scans the whole table for that reason: this function can create a row
 *    under a whitespace-variant series title that an index lookup would miss).
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
 * Every row it CREATES is written as one `bulkPut` at the end of its
 * transaction rather than a `put` per entry: the guards above are per-row and
 * stay per-row, but the writes are not, because each mutation of `volumes`
 * costs a full catalog re-derive downstream. Callers with more than one entry
 * in hand should therefore hand them over in ONE call rather than looping.
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

    // Every NEW row this call decides to write, collected and issued as ONE
    // `bulkPut` below rather than a `put` per row. Purely a write-shape
    // change: the guards below still run per entry, in order, and the rows
    // that reach the array are byte-for-byte the ones the per-row puts wrote.
    // The saving is the round trip — Dexie issues the same one put per item,
    // but inside this single transaction instead of paying for each
    // separately, and the whole batch lands as one mutation the catalog's
    // `volumes` liveQuery sees.
    const created: VolumeMetadata[] = [];
    const createdUuids = new Set<string>();
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
        // Through `entryMokuroVersion`: measured content carries a real value
        // (`''` genuinely meaning image-only), and cover stamps on a
        // zero-content entry prove the same; an entry for an archive missing
        // ALL sidecars (mokuro probably EMBEDDED in the .cbz) answers
        // 'unknown' and must never overwrite the row's own honest 'unknown'
        // with a false image-only claim.
        const entryVersion = entryMokuroVersion(entry);
        if (existing.mokuro_version === 'unknown' && entryVersion !== 'unknown') {
          patch.mokuro_version = entryVersion;
        }
        if (existing.spine_width === undefined && entry.spine_width !== undefined) {
          patch.spine_width = entry.spine_width;
        }
        // Same gap rule: a size recorded here came from an upload or a download
        // this device performed, which beats a copied claim.
        if (existing.archive_size === undefined && entry.archive_size !== undefined) {
          patch.archive_size = entry.archive_size;
        }
        if (Object.keys(patch).length === 0) continue;
        if (createdUuids.has(entry.volume_uuid)) {
          // A row THIS call queued (two entries naming the same uuid — two
          // archives sharing one mokuro). It is not in the table yet, so an
          // `update` would be a silent no-op and the fill would be lost when
          // the bulk write lands; patch the queued row itself instead, which
          // is exactly what a `put`-then-`update` pair used to leave behind.
          Object.assign(existing, patch);
        } else {
          await db.volumes.update(entry.volume_uuid, patch);
        }
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
        // `entryMokuroVersion`, not the raw field: a row minted from an
        // all-sidecars-missing entry must say 'unknown', not claim image-only
        // (`''`) for an archive whose mokuro is probably embedded.
        mokuro_version: entryMokuroVersion(entry),
        page_count: entry.page_count,
        character_count: entry.character_count,
        // Totals only — the index deliberately carries no per-page array.
        page_char_counts: [],
        metadata_only: true
      };
      if (entry.spine_width !== undefined) row.spine_width = entry.spine_width;
      if (entry.archive_size !== undefined) row.archive_size = entry.archive_size;

      // Queued, not written yet — but recorded in BOTH ledgers immediately,
      // because a later entry's rule 0/2 guards must see this decision
      // exactly as they would have seen the row a `put` had just written.
      created.push(row);
      createdUuids.add(row.volume_uuid);
      owners.set(row.volume_uuid, row);
      titlesTaken.set(titleKey, row);
      changed += 1;
    }

    if (created.length > 0) await db.volumes.bulkPut(created);
    return changed;
  });
}
