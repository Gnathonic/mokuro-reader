import type { VolumeMetadata } from '$lib/types';
import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';
import { browser } from '$app/environment';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
import { enqueueCloudOcrUpgrade } from '$lib/catalog/cloud-ocr-upgrade';
import { isSeriesFilePath, type SeriesFileVolume } from '$lib/metadata/series-file';
import type { SeriesIndexRecord } from '$lib/metadata/series-index';
import { normalizeSeriesKey } from '$lib/metadata/series-key';

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
 * not change which file we read. Titles are compared with the catalog's own
 * grouping normalisation so a casing/whitespace difference between the cloud
 * filename and the indexed title still matches.
 */
function findIndexEntry(
  indexMap: Map<string, SeriesIndexRecord> | undefined,
  folderName: string,
  volumeTitle: string
): SeriesFileVolume | undefined {
  const record = indexMap?.get(normalizeSeriesKey(folderName));
  if (!record) return undefined;

  const wanted = normalizeSeriesKey(volumeTitle);
  return record.file.volumes.find((entry) => normalizeSeriesKey(entry.volume_title) === wanted);
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
    mokuro_version: indexEntry?.mokuro_version ?? 'unknown', // Filled in after download
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

  if (indexEntry?.spine_width !== undefined) placeholder.spine_width = indexEntry.spine_width;

  return placeholder;
}

/**
 * Identify cloud-only files by comparing cloud files with local volumes
 * Returns placeholder VolumeMetadata for files that exist in cloud but not locally
 *
 * `indexMap` is the cached `series.json` per series (`seriesIndexMap`). It is
 * optional and purely additive: a series without an index behaves exactly as
 * before.
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

  // Create a set of local volume paths for fast lookup. Lowercased, like
  // `localVolumeByPath` below and the cloud-field lookup a metadata-only row is
  // decorated with: a casing difference between the stored title and the cloud
  // filename must not make the same volume appear twice — once as its own row
  // and once as a placeholder of the same file.
  const localPaths = new Set(
    localVolumes.map((vol) => `${vol.series_title}/${vol.volume_title}.cbz`.toLowerCase())
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

  // Flatten Map values into a single array and split out cover sidecars
  const cloudFiles: CloudVolumeWithProvider[] = [];
  const thumbnailMap = new Map<string, { fileId: string; path: string }>(); // basePath -> sidecar info
  const mokuroMap = new Map<string, CloudVolumeWithProvider>(); // basePath -> sidecar metadata
  const coverExtRegex = /\.(webp|jpe?g)$/i;
  for (const files of cloudFilesMap.values()) {
    for (const file of files) {
      // The per-series index is a sidecar of the FOLDER, not of any volume:
      // it must never reach the cbz bucket (a placeholder built from it would
      // be an undownloadable "series.json" volume in the catalog).
      if (isSeriesFilePath(file.path)) continue;
      const lowerPath = file.path.toLowerCase();
      const coverMatch = file.path.match(coverExtRegex);
      if (coverMatch) {
        const basePath = file.path.slice(0, -coverMatch[0].length);
        // Prefer .webp over .jpg/.jpeg when both exist for the same base.
        const existing = thumbnailMap.get(basePath);
        const isWebp = coverMatch[1].toLowerCase() === 'webp';
        if (!existing || isWebp) {
          thumbnailMap.set(basePath, { fileId: file.fileId, path: file.path });
        }
      } else if (lowerPath.endsWith('.mokuro.gz')) {
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
  const cloudOnlyFiles = cloudFiles.filter((file) => !localPaths.has(file.path.toLowerCase()));

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

      const basePath = cloudFile.path.replace(/\.cbz$/i, '');
      const thumbnailInfo = thumbnailMap.get(basePath);
      if (thumbnailInfo) {
        placeholder.cloudThumbnailFileId = thumbnailInfo.fileId;
        placeholder.cloudThumbnailPath = thumbnailInfo.path;
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
 * Index a cloud listing by archive path, lowercased.
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
      index.set(file.path.toLowerCase(), file);
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
 * Matched by stored path, the same identity every other cloud lookup uses
 * (`<series_title>/<volume_title>.cbz`), so a volume renamed locally without
 * renaming the cloud file reads as "not in the cloud" here too rather than
 * silently pointing at somebody else's archive.
 */
export function cloudFieldsForRemovedVolume(
  cloudIndex: Map<string, CloudVolumeWithProvider>,
  volume: VolumeMetadata
): Partial<VolumeMetadata> | undefined {
  const path = `${volume.series_title}/${volume.volume_title}.cbz`;
  const file = cloudIndex.get(path.toLowerCase());
  if (!file) return undefined;

  return {
    cloudProvider: file.provider,
    cloudFileId: file.fileId,
    cloudModifiedTime: file.modifiedTime,
    cloudSize: file.size,
    cloudPath: file.path
  };
}
