import { describe, expect, it } from 'vitest';
import { parseMokuroFile } from '../processing';
import { buildMokuroMetadata } from '$lib/util/mokuro-metadata';
import { buildSeriesFile, parseSeriesFile } from '$lib/metadata/series-file';
import { createEmptySeriesMetadata } from '$lib/metadata/types';
import type { VolumeMetadata } from '$lib/types';

const volume: VolumeMetadata = {
  mokuro_version: '0.2.1',
  series_title: 'One Piece',
  series_uuid: 's',
  volume_title: 'Vol 1',
  volume_uuid: 'v',
  page_count: 1,
  character_count: 5,
  page_char_counts: [5],
  spine_width: 17
};

const meta = {
  ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
  external_ids: { anilist: 30013, mal: 13 },
  titles: { native: 'ONE PIECE', romaji: 'ONE PIECE', english: 'One Piece' },
  synonyms: ['ワンピース'],
  tag: '[color]'
};

describe('series metadata leaves the .mokuro and lives in series.json', () => {
  it('the .mokuro the app writes carries no series metadata, and the parser reads none back', async () => {
    const written = buildMokuroMetadata(volume, [{ img_path: '1.jpg', blocks: [] }]);
    expect(JSON.stringify(written)).not.toContain('series_metadata');

    const file = new File([JSON.stringify(written)], 'Vol 1.mokuro');
    const parsed = await parseMokuroFile(file);
    expect(parsed.series).toBe('One Piece');
    expect(parsed.spineWidth).toBe(17);
    expect(Object.keys(parsed)).not.toContain('seriesMetadata');
  });

  it('what buildSeriesFile writes, parseSeriesFile reads back identically', () => {
    const built = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta,
      localVolumes: [volume]
    })!;
    const json = JSON.parse(JSON.stringify(built));
    expect(parseSeriesFile(json)).toEqual(built);
    expect(built.volumes).toEqual([
      {
        volume_uuid: 'v',
        volume_title: 'Vol 1',
        page_count: 1,
        character_count: 5,
        mokuro_version: '0.2.1',
        spine_width: 17
      }
    ]);
  });
});
