import { describe, expect, it } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import { volumeRowSignature } from './volume-row-signature';

const row = (over: Partial<VolumeMetadata> = {}): VolumeMetadata =>
  ({
    volume_uuid: 'v1',
    series_uuid: 's1',
    series_title: 'S',
    volume_title: 'V',
    mokuro_version: '0.2.1',
    page_count: 2,
    character_count: 10,
    page_char_counts: [4, 10],
    thumbnail: new File([new Uint8Array(8)], 't.webp', { type: 'image/webp' }),
    ...over
  }) as VolumeMetadata;

describe('volumeRowSignature', () => {
  it('is equal for a fresh read of the same row (new arrays, new Blob objects)', () => {
    expect(volumeRowSignature(row())).toBe(volumeRowSignature(row()));
  });

  it('changes when an OCR writer stamps the row', () => {
    const base = volumeRowSignature(row());
    expect(volumeRowSignature(row({ ocr_edited_at: '2026-10-01T00:00:00Z' } as any))).not.toBe(
      base
    );
    expect(volumeRowSignature(row({ page_char_counts: [4, 11] }))).not.toBe(base);
    expect(volumeRowSignature(row({ metadata_only: true }))).not.toBe(base);
  });

  it('changes when the thumbnail is replaced by a different image', () => {
    const other = new File([new Uint8Array(9)], 't.webp', { type: 'image/webp' });
    expect(volumeRowSignature(row({ thumbnail: other }))).not.toBe(volumeRowSignature(row()));
  });
});
