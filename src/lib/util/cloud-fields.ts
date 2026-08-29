import type { VolumeMetadata } from '$lib/types';
import { isVolumeInstalled, needsDownload } from '$lib/catalog/volume-state';
import { isArchiveSize } from '$lib/metadata/series-file';
import type { ProviderType } from './sync/provider-interface';

/**
 * Cloud field helpers for VolumeMetadata
 *
 * Handles migration from legacy Drive-specific fields to generic cloud fields.
 *
 * They answer "where would this volume be downloaded from", so they apply to
 * both kinds of not-installed volume: a cloud placeholder, and a metadata-only
 * row the catalog decorated with its cloud file (`cloudFieldsForRemovedVolume`).
 * An installed volume has nothing to download and always reads as null.
 */

/**
 * Get the cloud provider for a placeholder volume
 * Automatically migrates from legacy driveFileId format
 */
export function getCloudProvider(volume: VolumeMetadata): ProviderType | null {
  if (!needsDownload(volume)) return null;

  // New format: explicit cloudProvider
  if (volume.cloudProvider) {
    return volume.cloudProvider;
  }

  // Legacy format: has driveFileId but no cloudProvider
  if (volume.driveFileId) {
    return 'google-drive';
  }

  return null;
}

/**
 * Get the cloud file ID for a placeholder volume
 * Automatically migrates from legacy driveFileId format
 */
export function getCloudFileId(volume: VolumeMetadata): string | null {
  if (!needsDownload(volume)) return null;

  // New format: explicit cloudFileId
  if (volume.cloudFileId) {
    return volume.cloudFileId;
  }

  // Legacy format: driveFileId
  if (volume.driveFileId) {
    return volume.driveFileId;
  }

  return null;
}

/**
 * Get the cloud modified time for a placeholder volume
 * Automatically migrates from legacy driveModifiedTime format
 */
export function getCloudModifiedTime(volume: VolumeMetadata): string | null {
  if (!needsDownload(volume)) return null;

  // New format
  if (volume.cloudModifiedTime) {
    return volume.cloudModifiedTime;
  }

  // Legacy format
  if (volume.driveModifiedTime) {
    return volume.driveModifiedTime;
  }

  return null;
}

/**
 * Get the cloud file size for a placeholder volume
 * Automatically migrates from legacy driveSize format
 */
export function getCloudSize(volume: VolumeMetadata): number | null {
  if (!needsDownload(volume)) return null;

  // New format
  if (volume.cloudSize !== undefined) {
    return volume.cloudSize;
  }

  // Legacy format
  if (volume.driveSize !== undefined) {
    return volume.driveSize;
  }

  return null;
}

/**
 * How big this volume's `.cbz` is, in bytes, or null when nobody has measured it.
 *
 * Two sources, in order: the CURRENT cloud listing (`cloudSize`, decorated onto
 * the row for exactly as long as a provider is connected and reporting), then
 * `archive_size` — the fact recorded by whichever upload, download or index
 * last knew it, which survives disconnecting the provider.
 *
 * Unlike the helpers above this is not gated on `needsDownload`: the size of an
 * installed volume's archive is just as true, it simply has nowhere to show yet.
 */
export function getArchiveSize(volume: VolumeMetadata): number | null {
  const listed = getCloudSize(volume);
  if (listed !== null && listed > 0) return listed;
  return isArchiveSize(volume.archive_size) ? volume.archive_size : null;
}

/**
 * Migrate a volume from legacy Drive format to new cloud format
 * Returns a new object with migrated fields (does not mutate original)
 */
export function migrateToCloudFormat(volume: VolumeMetadata): VolumeMetadata {
  // If already in new format, return as-is
  if (volume.cloudProvider && volume.cloudFileId) {
    return volume;
  }

  // If has legacy Drive fields, migrate them
  if (volume.driveFileId) {
    return {
      ...volume,
      cloudProvider: 'google-drive',
      cloudFileId: volume.driveFileId,
      cloudModifiedTime: volume.driveModifiedTime,
      cloudSize: volume.driveSize
    };
  }

  // No cloud fields at all
  return volume;
}

/**
 * Create cloud metadata fields for a placeholder
 */
export function createCloudFields(
  provider: ProviderType,
  fileId: string,
  modifiedTime: string,
  size: number
): Partial<VolumeMetadata> {
  return {
    isPlaceholder: true,
    cloudProvider: provider,
    cloudFileId: fileId,
    cloudModifiedTime: modifiedTime,
    cloudSize: size
  };
}

/**
 * Check if a volume has cloud metadata (either new or legacy format)
 */
export function hasCloudMetadata(volume: VolumeMetadata): boolean {
  return !!(needsDownload(volume) && (volume.cloudFileId || volume.driveFileId));
}

/**
 * May the catalog show this volume? Installed pages always qualify; absent ones
 * (placeholders and metadata-only rows) only when the ACTIVE listing carries the
 * file to download them from — i.e. the placeholder pass minted them or the
 * catalog decorated them (`cloudFieldsForRemovedVolume`) this session.
 *
 * A metadata-only row whose cloud copy is gone, or lives on a provider that is
 * not connected right now, fails this check: its row, thumbnail and history stay
 * in the database for the stats views, but it gets no card — a card would offer
 * a download from a provider that does not have it.
 */
export function isCatalogVisible(volume: VolumeMetadata): boolean {
  return isVolumeInstalled(volume) || hasCloudMetadata(volume);
}
