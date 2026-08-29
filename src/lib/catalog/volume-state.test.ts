import { describe, expect, it } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import { isMetadataOnly, isVolumeInstalled, needsDownload } from './volume-state';

function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-1',
    series_title: 'One Piece',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 200,
    character_count: 5000,
    page_char_counts: [],
    ...overrides
  };
}

describe('volume state', () => {
  it('treats a plain row as installed', () => {
    const v = volume();
    expect(isVolumeInstalled(v)).toBe(true);
    expect(needsDownload(v)).toBe(false);
    expect(isMetadataOnly(v)).toBe(false);
  });

  it('treats a row whose files were removed as not installed', () => {
    const v = volume({ metadata_only: true });
    expect(isVolumeInstalled(v)).toBe(false);
    expect(needsDownload(v)).toBe(true);
    expect(isMetadataOnly(v)).toBe(true);
  });

  it('treats a cloud placeholder as not installed', () => {
    const v = volume({ isPlaceholder: true });
    expect(isVolumeInstalled(v)).toBe(false);
    expect(needsDownload(v)).toBe(true);
    // A placeholder has no row, so it has no history to keep.
    expect(isMetadataOnly(v)).toBe(false);
  });
});
