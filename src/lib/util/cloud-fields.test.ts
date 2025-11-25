import { describe, it, expect } from 'vitest';
import {
  getCloudProvider,
  getCloudFileId,
  getCloudModifiedTime,
  getCloudSize,
  migrateToCloudFormat,
  createCloudFields,
  hasCloudMetadata
} from './cloud-fields';
import type { VolumeMetadata } from '$lib/types';

// Helper to create minimal volume metadata
function createVolume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'test-uuid',
    series_uuid: 'series-uuid',
    series_title: 'Test Series',
    volume_title: 'Test Volume',
    page_count: 100,
    chars: 5000,
    ...overrides
  } as VolumeMetadata;
}

describe('getCloudProvider', () => {
  it('should return null for non-placeholder volumes', () => {
    const volume = createVolume({ isPlaceholder: false });
    expect(getCloudProvider(volume)).toBeNull();
  });

  it('should return cloudProvider when set (new format)', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudProvider: 'google-drive',
      cloudFileId: 'file-123'
    });
    expect(getCloudProvider(volume)).toBe('google-drive');
  });

  it('should return google-drive for legacy driveFileId format', () => {
    const volume = createVolume({
      isPlaceholder: true,
      driveFileId: 'legacy-file-id'
    });
    expect(getCloudProvider(volume)).toBe('google-drive');
  });

  it('should return null for placeholder without cloud fields', () => {
    const volume = createVolume({ isPlaceholder: true });
    expect(getCloudProvider(volume)).toBeNull();
  });

  it('should prefer new format over legacy', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudProvider: 'mega',
      cloudFileId: 'new-id',
      driveFileId: 'legacy-id'
    });
    expect(getCloudProvider(volume)).toBe('mega');
  });
});

describe('getCloudFileId', () => {
  it('should return null for non-placeholder volumes', () => {
    const volume = createVolume({ isPlaceholder: false });
    expect(getCloudFileId(volume)).toBeNull();
  });

  it('should return cloudFileId when set (new format)', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudFileId: 'new-file-id'
    });
    expect(getCloudFileId(volume)).toBe('new-file-id');
  });

  it('should return driveFileId for legacy format', () => {
    const volume = createVolume({
      isPlaceholder: true,
      driveFileId: 'legacy-file-id'
    });
    expect(getCloudFileId(volume)).toBe('legacy-file-id');
  });

  it('should return null for placeholder without file ID', () => {
    const volume = createVolume({ isPlaceholder: true });
    expect(getCloudFileId(volume)).toBeNull();
  });

  it('should prefer new format over legacy', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudFileId: 'new-id',
      driveFileId: 'legacy-id'
    });
    expect(getCloudFileId(volume)).toBe('new-id');
  });
});

describe('getCloudModifiedTime', () => {
  it('should return null for non-placeholder volumes', () => {
    const volume = createVolume({ isPlaceholder: false });
    expect(getCloudModifiedTime(volume)).toBeNull();
  });

  it('should return cloudModifiedTime when set', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudModifiedTime: '2024-01-01T00:00:00Z'
    });
    expect(getCloudModifiedTime(volume)).toBe('2024-01-01T00:00:00Z');
  });

  it('should return driveModifiedTime for legacy format', () => {
    const volume = createVolume({
      isPlaceholder: true,
      driveModifiedTime: '2023-12-01T00:00:00Z'
    });
    expect(getCloudModifiedTime(volume)).toBe('2023-12-01T00:00:00Z');
  });

  it('should prefer new format over legacy', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudModifiedTime: '2024-01-01T00:00:00Z',
      driveModifiedTime: '2023-12-01T00:00:00Z'
    });
    expect(getCloudModifiedTime(volume)).toBe('2024-01-01T00:00:00Z');
  });
});

describe('getCloudSize', () => {
  it('should return null for non-placeholder volumes', () => {
    const volume = createVolume({ isPlaceholder: false });
    expect(getCloudSize(volume)).toBeNull();
  });

  it('should return cloudSize when set', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudSize: 1000000
    });
    expect(getCloudSize(volume)).toBe(1000000);
  });

  it('should return driveSize for legacy format', () => {
    const volume = createVolume({
      isPlaceholder: true,
      driveSize: 500000
    });
    expect(getCloudSize(volume)).toBe(500000);
  });

  it('should handle zero size correctly', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudSize: 0
    });
    expect(getCloudSize(volume)).toBe(0);
  });

  it('should prefer new format over legacy', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudSize: 2000000,
      driveSize: 1000000
    });
    expect(getCloudSize(volume)).toBe(2000000);
  });
});

describe('migrateToCloudFormat', () => {
  it('should return volume as-is if already in new format', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudProvider: 'google-drive',
      cloudFileId: 'file-123'
    });

    const result = migrateToCloudFormat(volume);
    expect(result).toBe(volume); // Same reference
  });

  it('should migrate legacy Drive fields to new format', () => {
    const volume = createVolume({
      isPlaceholder: true,
      driveFileId: 'legacy-id',
      driveModifiedTime: '2023-12-01T00:00:00Z',
      driveSize: 500000
    });

    const result = migrateToCloudFormat(volume);

    expect(result).not.toBe(volume); // New object
    expect(result.cloudProvider).toBe('google-drive');
    expect(result.cloudFileId).toBe('legacy-id');
    expect(result.cloudModifiedTime).toBe('2023-12-01T00:00:00Z');
    expect(result.cloudSize).toBe(500000);
  });

  it('should preserve original properties when migrating', () => {
    const volume = createVolume({
      isPlaceholder: true,
      driveFileId: 'legacy-id',
      series_title: 'My Series',
      volume_title: 'Volume 1'
    });

    const result = migrateToCloudFormat(volume);

    expect(result.series_title).toBe('My Series');
    expect(result.volume_title).toBe('Volume 1');
    expect(result.volume_uuid).toBe('test-uuid');
  });

  it('should return volume as-is if no cloud fields', () => {
    const volume = createVolume({ isPlaceholder: true });

    const result = migrateToCloudFormat(volume);
    expect(result).toBe(volume);
  });

  it('should not mutate original volume', () => {
    const volume = createVolume({
      isPlaceholder: true,
      driveFileId: 'legacy-id'
    });

    migrateToCloudFormat(volume);

    expect(volume.cloudProvider).toBeUndefined();
    expect(volume.cloudFileId).toBeUndefined();
  });
});

describe('createCloudFields', () => {
  it('should create cloud metadata fields', () => {
    const result = createCloudFields('google-drive', 'file-123', '2024-01-01T00:00:00Z', 1000000);

    expect(result).toEqual({
      isPlaceholder: true,
      cloudProvider: 'google-drive',
      cloudFileId: 'file-123',
      cloudModifiedTime: '2024-01-01T00:00:00Z',
      cloudSize: 1000000
    });
  });

  it('should work with different providers', () => {
    const result = createCloudFields('mega', 'mega-id', '2024-02-01T00:00:00Z', 2000000);

    expect(result.cloudProvider).toBe('mega');
    expect(result.isPlaceholder).toBe(true);
  });
});

describe('hasCloudMetadata', () => {
  it('should return false for non-placeholder volumes', () => {
    const volume = createVolume({
      isPlaceholder: false,
      cloudFileId: 'file-id'
    });
    expect(hasCloudMetadata(volume)).toBe(false);
  });

  it('should return true for placeholder with cloudFileId', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudFileId: 'file-id'
    });
    expect(hasCloudMetadata(volume)).toBe(true);
  });

  it('should return true for placeholder with legacy driveFileId', () => {
    const volume = createVolume({
      isPlaceholder: true,
      driveFileId: 'legacy-id'
    });
    expect(hasCloudMetadata(volume)).toBe(true);
  });

  it('should return false for placeholder without any cloud fields', () => {
    const volume = createVolume({ isPlaceholder: true });
    expect(hasCloudMetadata(volume)).toBe(false);
  });

  it('should return true when both new and legacy fields exist', () => {
    const volume = createVolume({
      isPlaceholder: true,
      cloudFileId: 'new-id',
      driveFileId: 'legacy-id'
    });
    expect(hasCloudMetadata(volume)).toBe(true);
  });
});
