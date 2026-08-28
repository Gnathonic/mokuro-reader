import type { VolumeMetadata } from '$lib/types';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';
import { browser } from '$app/environment';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
import { enqueueCloudOcrUpgrade } from '$lib/catalog/cloud-ocr-upgrade';
import {
  isArchiveSize,
  isSeriesFilePath,
  type SeriesFileVolume,
  entryMokuroVersion
} from '$lib/metadata/series-file';
import type { SeriesIndexRecord } from '$lib/metadata/series-index';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from '$lib/metadata/series-key';

/**
 * The identity of one archive across the sources that spell it differently: a
 * local row (`<series_title>/<volume_title>`), a cloud `.cbz` filename, and a
 * `series.json` entry. Mirrors `cover-install.ts`'s `coverKey` exactly — same
 * per-segment fold, so a row, its cover sidecar and its archive always agree
 * about which volume they are.
 *
 * `normalizeVolumeTitleKey` rather than a `.toLowerCase()`: a name that made the
 * round trip through a filesystem can come back decomposed (NFD) while the JSON
 * and the IndexedDB row beside it stay composed.
 */
function archiveKey(seriesTitle: string, volumeTitle: string): string {
  return `${normalizeVolumeTitleKey(seriesTitle)}/${normalizeVolumeTitleKey(volumeTitle)}`;
}

/** {@link archiveKey} for a listed cloud path (`<Series>/<Volume>.cbz`). */
function cloudArchiveKey(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) return '';
  return archiveKey(trimmed.slice(0, cut), trimmed.slice(cut + 1).replace(/\.cbz$/i, ''));
}

/**
 * Extract series title from description field
 * Format: "Series: <series name>" on the first line (case-insensitive)
 * Allows user to add their own notes on subsequent lines
 */
function extractSeriesTitleFromDescription(description: string | undefined): string | null {
  if (!description) return null;

  const lines = description.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Match "Series:" prefix (case-insensitive)
    const match = trimmed.match(/^series:\s*(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Parse series and volume title from cloud file path and description
 * Expected format: "SeriesTitle/VolumeTitle.cbz"
 * Description overrides folder name if present
 */
function parseCloudPath(
  path: string,
  description?: string
): { seriesTitle: string; volumeTitle: string; folderName: string } | null {
  const parts = path.split('/');
  if (parts.length !== 2) return null;

  const folderName = parts[0];
  const volumeWithExt = parts[1];
  if (!volumeWithExt.toLowerCase().endsWith('.cbz')) return null;

  // Remove .cbz extension
  const volumeTitle = volumeWithExt.replace(/\.cbz$/i, '');

  // Prefer verified series title from description over folder name
  const seriesTitle = extractSeriesTitleFromDescription(description) || folderName;

  return { seriesTitle, volumeTitle, folderName };
}

/**
 * The `series.json` entry describing this cloud file, if the cached index has
 * one. Looked up by FOLDER name — the index is a sidecar of the cloud folder,
 * so a `Series:` description (which only renames the series for display) must
 * not change which file we read. Volume titles are compared with the shared
 * volume fold, so a casing/whitespace/unicode-form difference between the cloud
 * filename and the indexed title still matches — without it the placeholder
 * adopts nothing (derived uuid, zero counts, no synced progress) for a volume
 * the index describes perfectly.
 *
 * The FOLDER lookup stays on `normalizeSeriesKey`: that is the key
 * `seriesIndexMap` is built with, and folding it differently here would just
 * miss every record.
 */
function findIndexEntry(
  indexMap: Map<string, SeriesIndexRecord> | undefined,
  folderName: string,
  volumeTitle: string
): SeriesFileVolume | undefined {
  const record = indexMap?.get(normalizeSeriesKey(folderName));
  if (!record) return undefined;

  const wanted = normalizeVolumeTitleKey(volumeTitle);
  return record.file.volumes.find(
    (entry) => normalizeVolumeTitleKey(entry.volume_title) === wanted
  );
}

/** Every file of a listing, flattened. */
function* allListedFiles(
  cloudFilesMap: Map<string, CloudVolumeWithProvider[]>
): Generator<CloudVolumeWithProvider> {
  for (const files of cloudFilesMap.values()) yield* files;
}

/** The extensions a per-volume cover sidecar can have. */
const COVER_EXT_REGEX = /\.(webp|jpe?g)$/i;

/** One listed cover sidecar's identity plus its listing stamp (bytes + ISO mtime). */
export interface CoverSidecarInfo {
  fileId: string;
  path: string;
  size: number;
  modifiedTime: string;
}

/**
 * Index the per-volume cover sidecars of a listing by their base path
 * (`<Series>/<Volume>`), LOWERCASED so a casing difference between a stored
 * title and the cloud filename still matches — the same rule every other cloud
 * lookup here uses. `.webp` wins over `.jpg`/`.jpeg` for the same volume.
 *
 * The universal cover source: placeholders read it to decorate a cloud-only
 * volume, and `cover-install.ts` reads it to source a materialized row's cover.
 * One definition, so the two can never disagree about which file is a
 * volume's cover. Carries the listing's own `size`/`modifiedTime` alongside the
 * identity — the decision-time stamp a cover-persist path needs to record, not
 * just the `fileId`/`path` a download needs.
 */
export function indexCoverSidecarsByBasePath(
  files: Iterable<CloudFileMetadata>
): Map<string, CoverSidecarInfo> {
  const index = new Map<string, CoverSidecarInfo>();
  for (const file of files) {
    if (isSeriesFilePath(file.path)) continue;
    const match = file.path.match(COVER_EXT_REGEX);
    if (!match) continue;
    const key = file.path.slice(0, -match[0].length).toLowerCase();
    const isWebp = match[1].toLowerCase() === 'webp';
    if (!index.has(key) || isWebp) {
      index.set(key, {
        fileId: file.fileId,
        path: file.path,
        size: file.size,
        modifiedTime: file.modifiedTime
      });
    }
  }
  return index;
}

/** {@link archiveKey} for a listed cover sidecar (`<Series>/<Volume>.webp|.jpg|.jpeg`). */
function cloudCoverArchiveKey(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  const match = trimmed.match(COVER_EXT_REGEX);
  if (!match) return '';
  const withoutExt = trimmed.slice(0, -match[0].length);
  const cut = withoutExt.lastIndexOf('/');
  if (cut < 0) return '';
  return archiveKey(withoutExt.slice(0, cut), withoutExt.slice(cut + 1));
}

/**
 * Cover sidecars indexed by {@link archiveKey} — the SAME folded key
 * `cloudFieldsForRemovedVolume` looks archives up by — so a metadata-only
 * row's cover can be found the same way its archive already is. `.webp` wins
 * over `.jpg`/`.jpeg`, same rule as {@link indexCoverSidecarsByBasePath}
 * (which this does not replace: that one keys by lowercased PATH for the
 * placeholder pass, which never has a stored title to fold against; this one
 * keys by the folded TITLE pair a local row actually has).
 */
export function indexCoverFilesByArchiveKey(
  cloudFilesMap: Map<string, CloudVolumeWithProvider[]>
): Map<string, CloudVolumeWithProvider> {
  const index = new Map<string, CloudVolumeWithProvider>();
  for (const file of allListedFiles(cloudFilesMap)) {
    if (isSeriesFilePath(file.path)) continue;
    const match = file.path.match(COVER_EXT_REGEX);
    if (!match) continue;
    const key = cloudCoverArchiveKey(file.path);
    if (!key) continue;
    const isWebp = match[1].toLowerCase() === 'webp';
    if (!index.has(key) || isWebp) index.set(key, file);
  }
  return index;
}

/**
 * Generate placeholder VolumeMetadata for a cloud-only file
 *
 * With an index entry the placeholder carries the volume's REAL uuid and counts
 * (written by whichever device has it installed), so synced progress — keyed by
 * uuid — attaches to it before it is ever downloaded, and the catalog can show
 * page/character totals. Without one it falls back to the derived identity: a
 * deterministic uuid from the path and zeroed counts, filled in on download.
 */
function createPlaceholder(
  cloudFile: CloudVolumeWithProvider,
  seriesUuid: string,
  indexEntry?: SeriesFileVolume
): VolumeMetadata | null {
  const parsed = parseCloudPath(cloudFile.path, cloudFile.description);
  if (!parsed) return null;

  const { seriesTitle, volumeTitle } = parsed;

  // Generate deterministic volume UUID from series + volume name
  // This ensures the same volume gets the same UUID across devices
  const volumeUuid =
    indexEntry?.volume_uuid ?? generateDeterministicUUID(`${seriesTitle}/${volumeTitle}`);

  const placeholder: VolumeMetadata = {
    // Through `entryMokuroVersion`, never the raw field: an entry minted for
    // an archive with NO sidecars at all carries `''` on the wire, but that is
    // indistinguishable from a legacy backup whose mokuro is embedded in the
    // .cbz — it surfaces as 'unknown' (filled in after download), never as the
    // image-only claim the "Image Only" badge keys on. An entry whose COVER
    // stamps prove a modern backup wrote sidecars without a mokuro keeps `''`
    // (genuinely image-only), and measured content keeps its real version.
    mokuro_version: indexEntry ? entryMokuroVersion(indexEntry) : 'unknown',
    series_title: seriesTitle,
    series_uuid: seriesUuid,
    volume_title: volumeTitle,
    volume_uuid: volumeUuid,
    page_count: indexEntry?.page_count ?? 0, // Unknown until downloaded
    character_count: indexEntry?.character_count ?? 0, // Unknown until downloaded
    page_char_counts: [], // Empty until downloaded — the index carries totals only

    // Placeholder-specific fields
    isPlaceholder: true,
    cloudProvider: cloudFile.provider,
    cloudFileId: cloudFile.fileId,
    cloudModifiedTime: cloudFile.modifiedTime,
    cloudSize: cloudFile.size,
    cloudPath: cloudFile.path // Store path for series extraction during download
  };

  // Where this volume's identity came from, recorded at the one moment it is
  // known for certain (see `isIndexedPlaceholder`).
  if (indexEntry) placeholder.indexed = true;

  if (indexEntry?.spine_width !== undefined) placeholder.spine_width = indexEntry.spine_width;

  // The listing measured THIS file just now; the index is what another device
  // wrote about it, possibly before a re-OCR changed the archive. So the
  // listing wins, and the index only fills a listing that reports no size.
  if (isArchiveSize(cloudFile.size)) {
    placeholder.archive_size = cloudFile.size;
  } else if (isArchiveSize(indexEntry?.archive_size)) {
    placeholder.archive_size = indexEntry.archive_size;
  }

  return placeholder;
}

/**
 * Identify cloud-only files by comparing cloud files with local volumes
 * Returns placeholder VolumeMetadata for files that exist in cloud but not locally
 *
 * `indexMap` is the cached `series.json` per series (`seriesIndexMap`). It is
 * optional and purely additive: a series without an index behaves exactly as
 * before.
 *
 * NO COVER BLOBS. A placeholder carries the sidecar POINTER to its cover
 * (`cloudThumbnailFileId`/`Path`/`Size`/`ModifiedTime`, from `thumbnailMap`
 * below) and never the cover itself. This used to take a `coverMap` of the
 * account's cached blobs and stamp `thumbnail` onto every placeholder that had
 * one — which made a single cover landing regenerate the whole placeholder
 * set, hand ~4,347 fresh objects to 1,027 mounted cards and repaint every one
 * of them (measured: a 1,784 ms main-thread long task, ~15x the next
 * contributor). Cover BYTES now reach a card through `cover-resolver.ts`'s
 * keyed per-path read instead, which costs one `cloud_covers.get` for the one
 * card that wants it. Nothing about a cover may re-enter this function.
 */
export function generatePlaceholders(
  cloudFilesMap: Map<string, CloudVolumeWithProvider[]>,
  localVolumes: VolumeMetadata[],
  indexMap?: Map<string, SeriesIndexRecord>
): VolumeMetadata[] {
  // Skip during SSR/build
  if (!browser) {
    return [];
  }

  // Create a set of local volume keys for fast lookup. Folded through
  // `archiveKey`, like the cloud-field lookup a metadata-only row is decorated
  // with: a casing, whitespace or unicode-form difference between the stored
  // title and the cloud filename must not make the same volume appear twice —
  // once as its own row and once as a placeholder of the same file.
  const localPaths = new Set(
    localVolumes.map((vol) => archiveKey(vol.series_title, vol.volume_title))
  );
  // …and of local uuids. A placeholder that adopts an indexed uuid can collide
  // with an installed volume the path check misses (renamed locally, or filed
  // under the .mokuro's own series title). Emitting it would overwrite the real
  // row in the catalog's combined map — the placeholder is merged in last.
  const localUuids = new Set(localVolumes.map((vol) => vol.volume_uuid));
  const localVolumeByPath = new Map<string, VolumeMetadata>();
  const localImageOnlyByVolumeTitle = new Map<string, VolumeMetadata[]>();
  for (const vol of localVolumes) {
    const key = `${vol.series_title}/${vol.volume_title}.cbz`.toLowerCase();
    if (!vol.isPlaceholder && !localVolumeByPath.has(key)) {
      localVolumeByPath.set(key, vol);
    }

    const currentMokuroVersion =
      typeof vol.mokuro_version === 'string' ? vol.mokuro_version.trim() : '';
    if (!vol.isPlaceholder && currentMokuroVersion === '') {
      const titleKey = vol.volume_title.toLowerCase();
      const existing = localImageOnlyByVolumeTitle.get(titleKey) || [];
      existing.push(vol);
      localImageOnlyByVolumeTitle.set(titleKey, existing);
    }
  }

  // Create a map of series titles to their UUIDs from local volumes
  const seriesTitleToUuid = new Map<string, string>();
  for (const vol of localVolumes) {
    const lowerTitle = vol.series_title.toLowerCase();
    if (!seriesTitleToUuid.has(lowerTitle)) {
      seriesTitleToUuid.set(lowerTitle, vol.series_uuid);
    }
  }

  // basePath (lowercased) -> cover sidecar info, from the shared indexer.
  const thumbnailMap = indexCoverSidecarsByBasePath(allListedFiles(cloudFilesMap));

  // Flatten Map values into a single array, keeping sidecars out of the cbz bucket
  const cloudFiles: CloudVolumeWithProvider[] = [];
  const mokuroMap = new Map<string, CloudVolumeWithProvider>(); // basePath -> sidecar metadata
  for (const files of cloudFilesMap.values()) {
    for (const file of files) {
      // The per-series index is a sidecar of the FOLDER, not of any volume:
      // it must never reach the cbz bucket (a placeholder built from it would
      // be an undownloadable "series.json" volume in the catalog).
      if (isSeriesFilePath(file.path)) continue;
      // Covers are already indexed above; they are not archives either.
      if (COVER_EXT_REGEX.test(file.path)) continue;
      const lowerPath = file.path.toLowerCase();
      if (lowerPath.endsWith('.mokuro.gz')) {
        const basePath = file.path.replace(/\.mokuro\.gz$/i, '');
        // Prefer plain .mokuro over .mokuro.gz when both exist.
        if (!mokuroMap.has(basePath)) {
          mokuroMap.set(basePath, file);
        }
      } else if (lowerPath.endsWith('.mokuro')) {
        const basePath = file.path.replace(/\.mokuro$/i, '');
        mokuroMap.set(basePath, file);
      } else {
        cloudFiles.push(file);
      }
    }
  }

  // Find cloud-only files
  const cloudOnlyFiles = cloudFiles.filter((file) => !localPaths.has(cloudArchiveKey(file.path)));

  // Generate placeholders
  const placeholders: VolumeMetadata[] = [];
  const emittedUuids = new Set<string>();
  let warnedDuplicateUuid = false;
  for (const cloudFile of cloudOnlyFiles) {
    const parsed = parseCloudPath(cloudFile.path, cloudFile.description);
    if (!parsed) continue;

    // Use existing series UUID if we have local volumes with this series title
    // Otherwise generate a deterministic UUID for a new series
    const seriesUuid =
      seriesTitleToUuid.get(parsed.seriesTitle.toLowerCase()) ||
      generateDeterministicUUID(parsed.seriesTitle);

    const indexEntry = findIndexEntry(indexMap, parsed.folderName, parsed.volumeTitle);
    const placeholder = createPlaceholder(cloudFile, seriesUuid, indexEntry);
    if (placeholder) {
      // Installed already (under any title), or a duplicate of a placeholder we
      // just emitted: either way a second row with this uuid would clobber the
      // first one in the catalog's uuid-keyed map.
      if (localUuids.has(placeholder.volume_uuid)) continue;
      if (emittedUuids.has(placeholder.volume_uuid)) {
        // Two cloud files claiming one uuid means a stale or hand-edited index
        // (the same entry listed for two volumes). Warn once per run so the
        // volume that silently vanishes from the catalog is diagnosable.
        if (!warnedDuplicateUuid) {
          warnedDuplicateUuid = true;
          console.warn(
            '[Placeholders] Dropping a cloud volume whose indexed uuid is already taken:',
            cloudFile.path,
            placeholder.volume_uuid
          );
        }
        continue;
      }
      emittedUuids.add(placeholder.volume_uuid);

      const basePath = cloudFile.path.replace(/\.cbz$/i, '').toLowerCase();
      const thumbnailInfo = thumbnailMap.get(basePath);
      if (thumbnailInfo) {
        placeholder.cloudThumbnailFileId = thumbnailInfo.fileId;
        placeholder.cloudThumbnailPath = thumbnailInfo.path;
        if (isArchiveSize(thumbnailInfo.size)) placeholder.cloudThumbnailSize = thumbnailInfo.size;
        if (thumbnailInfo.modifiedTime) {
          placeholder.cloudThumbnailModifiedTime = thumbnailInfo.modifiedTime;
        }
      }

      placeholders.push(placeholder);
    }
  }

  console.log(
    '[Cloud OCR Upgrade] Placeholder matcher scan:',
    `cbz=${cloudFiles.length}`,
    `mokuro=${mokuroMap.size}`,
    `locals=${localPaths.size}`
  );

  // Auto-upgrade local image-only volumes when matching remote .mokuro sidecar exists.
  for (const cloudFile of cloudFiles) {
    const parsed = parseCloudPath(cloudFile.path, cloudFile.description);
    if (!parsed) continue;

    const cloudPathKey = cloudFile.path.toLowerCase();
    let localVolume = localVolumeByPath.get(cloudPathKey);
    if (!localVolume) {
      // Fallback only when series title also matches; never pair by volume title alone.
      const candidates = localImageOnlyByVolumeTitle.get(parsed.volumeTitle.toLowerCase()) || [];
      const seriesMatches = candidates.filter(
        (candidate) => candidate.series_title.toLowerCase() === parsed.seriesTitle.toLowerCase()
      );
      if (seriesMatches.length === 1) {
        localVolume = seriesMatches[0];
      } else if (seriesMatches.length > 1 || candidates.length > 0) {
        console.log(
          '[Cloud OCR Upgrade] Ambiguous local image-only match; skipping fallback:',
          parsed.seriesTitle,
          parsed.volumeTitle,
          `seriesMatches=${seriesMatches.length}`,
          `candidates=${candidates.length}`
        );
      }
    }

    if (!localVolume) continue;

    const currentMokuroVersion =
      typeof localVolume.mokuro_version === 'string' ? localVolume.mokuro_version.trim() : '';
    if (currentMokuroVersion !== '') continue;

    const basePath = cloudFile.path.replace(/\.cbz$/i, '');
    const remoteMokuro = mokuroMap.get(basePath);
    if (remoteMokuro) {
      console.log(
        '[Cloud OCR Upgrade] Match found, enqueueing upgrade:',
        `${localVolume.series_title}/${localVolume.volume_title}`,
        'using',
        remoteMokuro.path
      );
      enqueueCloudOcrUpgrade(localVolume, remoteMokuro);
    } else {
      console.log(
        '[Cloud OCR Upgrade] Local image-only match has no remote mokuro sidecar:',
        `${localVolume.series_title}/${localVolume.volume_title}`
      );
    }
  }

  return placeholders;
}

/**
 * Check if a volume is a placeholder
 */
export function isPlaceholder(volume: VolumeMetadata): boolean {
  return volume.isPlaceholder === true;
}

/**
 * Did this placeholder adopt a `series.json` entry?
 *
 * The difference is what it can be DRAWN as. An indexed placeholder carries the
 * volume's real uuid, counts and version, so everything a metadata-only row
 * shows works for it too — progress against synced history, a reading estimate,
 * its cover sidecar, the not-on-device badge, the download size. A bare-share
 * placeholder has a uuid derived from its path and zeroed counts, and a row
 * claiming "0 pages, no progress" would be a worse card than a plain one.
 *
 * Read off the fallback values `createPlaceholder` uses when it has no entry —
 * `'unknown'` is not a version anything writes, and an index entry always
 * carries a real one (`''` for image-only volumes).
 */
export function isIndexedPlaceholder(volume: VolumeMetadata): boolean {
  if (volume.isPlaceholder !== true) return false;
  if (volume.indexed) return true;
  // Fall-through for a placeholder built before the flag existed (one already
  // in a cached listing when the tab reloaded its code): the fallback values
  // `createPlaceholder` writes when it has no entry — `'unknown'` is not a
  // version anything publishes, and an index entry always carries a real one
  // (`''` for image-only volumes).
  return volume.mokuro_version !== 'unknown' || volume.page_count > 0 || volume.character_count > 0;
}

/**
 * Index a cloud listing by {@link archiveKey} — the same folded identity every
 * other cloud lookup here uses, so a stored title and a cloud filename that
 * differ only in case, whitespace or unicode form still meet.
 *
 * Built once per listing and shared by every lookup: a row whose files were
 * removed needs the same cloud file a placeholder would have been built from,
 * and scanning the listing per row would be O(rows × files).
 */
export function indexCloudFilesByPath(
  cloudFilesMap: Map<string, CloudVolumeWithProvider[]>
): Map<string, CloudVolumeWithProvider> {
  const index = new Map<string, CloudVolumeWithProvider>();
  for (const files of cloudFilesMap.values()) {
    for (const file of files) {
      if (!file.path.toLowerCase().endsWith('.cbz')) continue;
      const key = cloudArchiveKey(file.path);
      if (key) index.set(key, file);
    }
  }
  return index;
}

/**
 * The cloud fields a volume whose files were removed needs to be downloadable
 * again, or `undefined` when the cloud no longer holds it.
 *
 * A retained row shadows the placeholder its cloud file would otherwise
 * produce (`generatePlaceholders` skips paths that have a local row), so the
 * download affordance has to come from somewhere — this is that somewhere, and
 * it deliberately carries exactly the fields `cloud-fields.ts` reads.
 *
 * Matched by stored title, through the same {@link archiveKey} every other
 * cloud lookup uses, so a volume renamed locally without renaming the cloud file
 * reads as "not in the cloud" here too rather than silently pointing at somebody
 * else's archive — while a mere unicode-form or casing difference still meets.
 *
 * `coverIndex` (optional, `indexCoverFilesByArchiveKey`) additionally attaches
 * the SAME `cloudThumbnail*` decoration a placeholder gets when the listing
 * has a cover sidecar for this title — closing the gap that otherwise left a
 * metadata-only row (retained OR materialized from a series index, both
 * `isMetadataOnly`) with no cover source at all: `generatePlaceholders`
 * deliberately never emits a placeholder for a path that already has a local
 * row, so without this a materialized row's card would stay blank until its
 * SERIES is opened (`installCoversForSeries`) rather than the moment it is
 * merely visible in the catalog grid.
 */
export function cloudFieldsForRemovedVolume(
  cloudIndex: Map<string, CloudVolumeWithProvider>,
  volume: VolumeMetadata,
  coverIndex?: Map<string, CloudVolumeWithProvider>
): Partial<VolumeMetadata> | undefined {
  const key = archiveKey(volume.series_title, volume.volume_title);
  const file = cloudIndex.get(key);
  if (!file) return undefined;

  const fields: Partial<VolumeMetadata> = {
    cloudProvider: file.provider,
    cloudFileId: file.fileId,
    cloudModifiedTime: file.modifiedTime,
    cloudSize: file.size,
    cloudPath: file.path
  };

  const cover = coverIndex?.get(key);
  if (cover) {
    fields.cloudThumbnailFileId = cover.fileId;
    fields.cloudThumbnailPath = cover.path;
    if (isArchiveSize(cover.size)) fields.cloudThumbnailSize = cover.size;
    if (cover.modifiedTime) fields.cloudThumbnailModifiedTime = cover.modifiedTime;
  }

  return fields;
}
