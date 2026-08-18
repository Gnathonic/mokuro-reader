import { describe, expect, it } from 'vitest';
import { buildMokuroMetadata } from './mokuro-metadata';
import type { VolumeMetadata } from '$lib/types';

const volume: VolumeMetadata = {
  mokuro_version: '0.2.1',
  series_title: 'One Piece',
  series_uuid: 'series-uuid',
  volume_title: 'Vol 1',
  volume_uuid: 'vol-uuid',
  page_count: 2,
  character_count: 123,
  page_char_counts: [60, 123],
  spine_width: 17
};

const pages = [
  { img_path: '1.jpg', blocks: [] },
  { img_path: '2.jpg', blocks: [] }
];

describe('buildMokuroMetadata', () => {
  it('builds the classic mokuro shape from volume + pages, including spine_width', () => {
    const meta = buildMokuroMetadata(volume, pages);
    expect(meta).toEqual({
      version: '0.2.1',
      title: 'One Piece',
      title_uuid: 'series-uuid',
      volume: 'Vol 1',
      volume_uuid: 'vol-uuid',
      pages,
      chars: 123,
      spine_width: 17
    });
    // Series facts live in the per-series series.json sidecar, never in a .mokuro.
    expect('series_metadata' in meta).toBe(false);
  });

  it('omits spine_width when the volume has none', () => {
    const { spine_width: _omit, ...noSpine } = volume;
    expect('spine_width' in buildMokuroMetadata(noSpine, pages)).toBe(false);
  });

  it('applies title overrides (rename regeneration) without touching uuids', () => {
    const meta = buildMokuroMetadata(volume, pages, { seriesTitle: 'New', volumeTitle: 'V2' });
    expect(meta.title).toBe('New');
    expect(meta.volume).toBe('V2');
    expect(meta.title_uuid).toBe('series-uuid');
    expect(meta.volume_uuid).toBe('vol-uuid');
  });
});
