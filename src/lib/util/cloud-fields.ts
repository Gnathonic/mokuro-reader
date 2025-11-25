import type { VolumeMetadata } from '$lib/types';
import type { ProviderType } from './sync/provider-interface';

/**
 * Cloud field helpers for VolumeMetadata
 *
 * Handles migration from legacy Drive-specific fields to generic cloud fields
 */

/**
 * Get the cloud provider for a placeholder volume
 * Automatically migrates from legacy driveFileId format
 */
export function getCloudProvider(volume: VolumeMetadata): ProviderType | null {
  if (!volume.isPlaceholder) return null;

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
  if (!volume.isPlaceholder) return null;

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
  if (!volume.isPlaceholder) return null;

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
  if (!volume.isPlaceholder) return null;

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
  return !!(volume.isPlaceholder && (volume.cloudFileId || volume.driveFileId));
}
