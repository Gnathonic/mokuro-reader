import { describe, expect, it } from 'vitest';
import { parseMokuroFile } from '../processing';
import { buildMokuroMetadata } from '$lib/util/mokuro-metadata';
import { createEmptySeriesMetadata } from '$lib/metadata/types';
import type { VolumeMetadata } from '$lib/types';

describe('.mokuro series_metadata round trip', () => {
  it('what buildMokuroMetadata writes, parseMokuroFile reads back identically', async () => {
    const volume: VolumeMetadata = {
      mokuro_version: '0.2.1',
      series_title: 'One Piece',
      series_uuid: 's',
      volume_title: 'Vol 1',
      volume_uuid: 'v',
      page_count: 1,
      character_count: 5,
      page_char_counts: [5]
    };
    const seriesMetadata = {
      ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
      external_ids: { anilist: 30013, mal: 13 },
      titles: { native: 'ONE PIECE', romaji: 'ONE PIECE', english: 'One Piece' },
      synonyms: ['ワンピース'],
      tag: '[color]'
    };
    const written = buildMokuroMetadata(volume, [{ img_path: '1.jpg', blocks: [] }], {
      seriesMetadata
    });
    const file = new File([JSON.stringify(written)], 'Vol 1.mokuro');
    const parsed = await parseMokuroFile(file);
    expect(parsed.seriesMetadata).toEqual(written.series_metadata);
    expect(parsed.series).toBe('One Piece');
  });
});
