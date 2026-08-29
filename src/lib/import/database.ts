/**
 * Database Operations for Volume Import
 *
 * Handles atomic writes to IndexedDB for imported volumes.
 * Writes to three tables in a single transaction:
 * - volumes: metadata
 * - volume_ocr: OCR data (pages with text blocks)
 * - volume_files: image files
 */

import { db } from '$lib/catalog/db';
import { requestPersistentStorage } from '$lib/util/upload';
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';
import type { ProcessedVolume } from './types';
import type { VolumeMetadata } from '$lib/types';
import { naturalSort } from '$lib/util/natural-sort';
import { isVolumeInstalled } from '$lib/catalog/volume-state';

/**
 * Is this volume already INSTALLED?
 *
 * The import's duplicate check, so a row whose files were removed from the
 * device does not count: re-importing that volume is exactly how the user gets
 * its pages back, and the save fills the retained row (same uuid, so the read
 * history stays attached) instead of adding a second one.
 *
 * @param volumeUuid - The volume UUID to check
 * @returns True if the volume exists with its files
 */
export async function volumeExists(volumeUuid: string): Promise<boolean> {
  const existing = await db.volumes.get(volumeUuid);
  return existing !== undefined && isVolumeInstalled(existing);
}

/**
 * The title a volume is actually stored under: sanitized unless the caller asked
 * to preserve it (see `saveVolume`), and never empty. Exported because callers
 * that key other records off the stored series title (the `series.json` import)
 * must use exactly the same value.
 */
export function storedTitleSegment(raw: string, preserveTitles?: boolean): string {
  return (preserveTitles ? raw : sanitizeTitleSegment(raw)) || 'Untitled';
}

/**
 * What `saveVolume` committed, in EXACTLY the shape the database now holds.
 *
 * This is the byte-identity contract the import-time sidecar backfill relies
 * on: `metadata` is the very row written to `db.volumes` (including a
 * reinstall's merged-in thumbnail), and `ocrPages` is the very array written
 * to `volume_ocr` — `cumulativeChars` already stripped. Serializing a
 * `.mokuro` from these through `buildVolumeSidecarsFromData` produces the
 * same bytes `loadVolumeSidecars` would later produce from the database, so
 * an import-time upload and a future backup agree on size to the byte.
 */
export interface SavedVolumeData {
  /** The row written to `db.volumes`, post any reinstall merge. */
  metadata: VolumeMetadata;
  /** The pages array written to `volume_ocr` (`cumulativeChars` stripped). */
  ocrPages: unknown[];
}

/**
 * Save a processed volume to the database
 *
 * Performs an atomic write to all three tables.
 * Will fail if the volume already exists (duplicate prevention).
 *
 * @param volume - The processed volume to save
 * @param options.preserveTitles - Keep the titles EXACTLY as provided instead
 *   of sanitizing them. Set by cloud downloads: their titles come from the
 *   remote path / legacy .mokuro, and rewriting them here would break the
 *   stored-title === cloud-path identity every cloud lookup relies on (the
 *   volume would read as un-backed-up and renames would miss its files).
 *   Legacy titles get sanitized later, at rename time, where the rename
 *   machinery moves the cloud files along with the title.
 * @returns The exact objects committed — see {@link SavedVolumeData}. A cloud
 *   download feeds these straight to the import-time sidecar backfill
 *   (`queueSidecarBackfillFromImport`) so it can serialize the `.mokuro` from
 *   the DB-shaped data without re-reading what was just written.
 * @throws If the volume already exists or if the transaction fails
 */
export async function saveVolume(
  volume: ProcessedVolume,
  options?: { preserveTitles?: boolean }
): Promise<SavedVolumeData> {
  const { metadata, ocrData, fileData } = volume;
  const canonicalVolumeUuid = metadata.volumeUuid;

  // Request persistent storage
  await requestPersistentStorage();

  // Sort files by name for consistent ordering
  const sortedFiles = Object.fromEntries(
    Object.entries(fileData.files).sort(([aKey], [bKey]) => naturalSort(aKey, bKey))
  );

  // Calculate page_char_counts from pages
  const pageCharCounts = ocrData.pages.map((page) => page.cumulativeChars);

  // Convert ProcessedMetadata to VolumeMetadata format
  const volumeMetadata: VolumeMetadata = {
    mokuro_version: metadata.mokuroVersion || '',
    series_title: storedTitleSegment(metadata.series, options?.preserveTitles),
    series_uuid: metadata.seriesUuid,
    volume_title: storedTitleSegment(metadata.volume, options?.preserveTitles),
    volume_uuid: metadata.volumeUuid,
    page_count: metadata.pageCount,
    character_count: metadata.chars,
    page_char_counts: pageCharCounts,
    thumbnail:
      metadata.thumbnail instanceof Blob
        ? metadata.thumbnail instanceof File
          ? metadata.thumbnail
          : new File([metadata.thumbnail], 'thumbnail', {
              type: metadata.thumbnail.type || 'image/jpeg'
            })
        : undefined,
    thumbnail_width: metadata.thumbnailWidth,
    thumbnail_height: metadata.thumbnailHeight,
    missing_pages: metadata.missingPages,
    missing_page_paths: metadata.missingPagePaths,
    spine_width: metadata.spineWidth
  };

  // Strip cumulativeChars (it's stored in page_char_counts) — this is the
  // DB shape of the pages, and the ONLY shape a `.mokuro` may ever be
  // serialized from (see `SavedVolumeData`).
  const pagesForDb = ocrData.pages.map(({ cumulativeChars, ...page }) => page);

  // Write to all 3 tables atomically
  await db.transaction('rw', [db.volumes, db.volume_ocr, db.volume_files], async () => {
    const [existingVolume, existingOcr, existingFiles] = await Promise.all([
      db.volumes.get(canonicalVolumeUuid),
      db.volume_ocr.get(canonicalVolumeUuid),
      db.volume_files.get(canonicalVolumeUuid)
    ]);

    // An INSTALLED row is a real duplicate. A metadata-only row is not: this
    // save is the reinstall, and it fills that row.
    if (existingVolume && isVolumeInstalled(existingVolume)) {
      throw new Error(`Volume ${canonicalVolumeUuid} already exists in database`);
    }

    // Clean up stale rows left behind by an interrupted delete before re-importing.
    if (existingOcr) {
      await db.volume_ocr.delete(canonicalVolumeUuid);
    }

    if (existingFiles) {
      await db.volume_files.delete(canonicalVolumeUuid);
    }

    if (existingVolume) {
      // Reinstall: the retained cover is already the right one, so keep it when
      // the archive did not bring its own rather than re-deriving it from page 1.
      if (!volumeMetadata.thumbnail && existingVolume.thumbnail) {
        volumeMetadata.thumbnail = existingVolume.thumbnail;
        volumeMetadata.thumbnail_width = existingVolume.thumbnail_width;
        volumeMetadata.thumbnail_height = existingVolume.thumbnail_height;
      }
      // Same rule for the archive size: a `put` replaces the whole row, and an
      // import that does not know how big the `.cbz` was must not erase the
      // size the row was already carrying.
      if (!volumeMetadata.archive_size && existingVolume.archive_size) {
        volumeMetadata.archive_size = existingVolume.archive_size;
      }
      // `put` replaces the whole row, which is what clears `metadata_only`:
      // a row written together with its files is installed by definition.
      await db.volumes.put(volumeMetadata);
    } else {
      await db.volumes.add(volumeMetadata);
    }

    // Write OCR data (already DB-shaped, see above)
    await db.volume_ocr.add({
      volume_uuid: canonicalVolumeUuid,
      pages: pagesForDb as any // Cast to any since Page type is stricter
    });

    // Write files
    await db.volume_files.add({
      volume_uuid: canonicalVolumeUuid,
      files: sortedFiles
    });
  });

  // Import-time thumbnail generation can fail for some files.
  // Trigger best-effort background recovery so UI placeholders resolve
  // without requiring navigation or refresh.
  if (
    !volumeMetadata.thumbnail ||
    !volumeMetadata.thumbnail_width ||
    !volumeMetadata.thumbnail_height
  ) {
    db.processThumbnails(1).catch((error) => {
      console.error('Failed to recover missing thumbnail after import:', error);
    });
  }

  // Deliberately NO backfill nomination for local imports (reverted): a local
  // importer's cloud provider is invariably absent, read-only, or
  // server-compiled — the writable gate skips all three, so the nomination
  // only ever no-oped. Cloud downloads nominate from `download-queue.ts`,
  // and the listing-load sweep remains the catch-all for installed volumes.
  return { metadata: volumeMetadata, ocrPages: pagesForDb };
}

/**
 * Remove a volume's files from this device, keeping the volume.
 *
 * The heavy rows (OCR and images) go; the `volumes` row stays, flagged
 * `metadata_only`. That row is the volume's history: the read state, the
 * re-read count and the AniList push bookkeeping are all keyed by
 * `volume_uuid`, and the thumbnail lives inline on it, so keeping it is what
 * makes "remove from device" cost only disk — the catalog still shows the
 * cover, the stats still count, and re-downloading fills the same row.
 *
 * @param volumeUuid - The volume UUID whose files to remove
 */
export async function removeVolumeFiles(volumeUuid: string): Promise<void> {
  await db.transaction('rw', [db.volumes, db.volume_ocr, db.volume_files], async () => {
    await db.volume_ocr.delete(volumeUuid);
    await db.volume_files.delete(volumeUuid);
    await db.volumes.update(volumeUuid, { metadata_only: true });
  });
}

/**
 * Delete a volume from the database entirely
 *
 * Removes all data for a volume from all three tables atomically — the row
 * included, so nothing is left to attach history to. Used by the delete
 * confirmations when the user also asked to forget the stats, and by the
 * download queue's replace-before-resave (which writes a fresh row straight
 * afterwards).
 *
 * @param volumeUuid - The volume UUID to delete
 */
export async function deleteVolumeCompletely(volumeUuid: string): Promise<void> {
  await db.transaction('rw', [db.volumes, db.volume_ocr, db.volume_files], async () => {
    await db.volumes.delete(volumeUuid);
    await db.volume_ocr.delete(volumeUuid);
    await db.volume_files.delete(volumeUuid);
  });
}
