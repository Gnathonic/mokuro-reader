import { describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesFileVolume } from '$lib/metadata/series-file';
import type { SeriesIndexRecord } from '$lib/metadata/series-index';
import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/cloud-ocr-upgrade', () => ({ enqueueCloudOcrUpgrade: vi.fn() }));

import { generatePlaceholders } from './placeholders';

function cloudFile(path: string, fileId = path): CloudVolumeWithProvider {
  return {
    provider: 'webdav',
    fileId,
    path,
    modifiedTime: '2026-08-17T00:00:00.000Z',
    size: 10
  } as CloudVolumeWithProvider;
}

function indexEntry(overrides: Partial<SeriesFileVolume> = {}): SeriesFileVolume {
  return {
    volume_uuid: 'real-uuid-1',
    volume_title: 'Volume 1',
    page_count: 180,
    character_count: 5000,
    page_char_counts: [100, 250],
    mokuro_version: '0.4.11',
    ...overrides
  };
}

/** One cached `series.json`, keyed the way `seriesIndexMap` keys it. */
function indexMap(
  seriesTitle: string,
  volumes: SeriesFileVolume[]
): Map<string, SeriesIndexRecord> {
  const key = seriesTitle.trim().replace(/\s+/g, ' ').toLowerCase();
  return new Map([
    [
      key,
      {
        series_key: key,
        series_title: seriesTitle,
        file: {
          version: 2,
          series_title: seriesTitle,
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2026-08-16T00:00:00.000Z',
          volumes
        },
        source: {
          provider: 'webdav',
          path: `${seriesTitle}/series.json`,
          size: 10,
          modifiedTime: '2026-08-17T00:00:00.000Z'
        },
        fetched_at: '2026-08-17T00:00:00.000Z'
      } as SeriesIndexRecord
    ]
  ]);
}

function localVolume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'local-uuid',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 180,
    character_count: 5000,
    page_char_counts: [100, 250],
    ...overrides
  } as VolumeMetadata;
}

describe('generatePlaceholders', () => {
  it('never turns the series sidecar into a cloud-only volume', () => {
    // `series.json` is now a listed, cached file. It is a sidecar of the SERIES
    // FOLDER — a placeholder built from it would show up in the catalog as a
    // volume named "series.json" that can never be downloaded.
    const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
      ['One Piece', [cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json')]]
    ]);

    const placeholders = generatePlaceholders(cloudFiles, []);

    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].volume_title).toBe('Volume 1');
  });

  it('produces nothing at all for a series folder holding only the sidecar', () => {
    const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
      ['One Piece', [cloudFile('One Piece/series.json')]]
    ]);

    expect(generatePlaceholders(cloudFiles, [])).toEqual([]);
  });
});

describe('generatePlaceholders with a series index', () => {
  const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
    ['One Piece', [cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json')]]
  ]);

  it('adopts the indexed uuid, counts, version and spine width', () => {
    const placeholders = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('One Piece', [indexEntry({ spine_width: 42 })])
    );

    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toMatchObject({
      volume_uuid: 'real-uuid-1',
      volume_title: 'Volume 1',
      page_count: 180,
      character_count: 5000,
      page_char_counts: [100, 250],
      mokuro_version: '0.4.11',
      spine_width: 42,
      isPlaceholder: true,
      cloudFileId: 'One Piece/Volume 1.cbz'
    });
  });

  it('matches the entry ignoring case and whitespace', () => {
    const placeholders = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('  ONE   PIECE ', [indexEntry({ volume_title: 'volume  1' })])
    );

    expect(placeholders[0].volume_uuid).toBe('real-uuid-1');
  });

  it('copies page_char_counts rather than sharing the cached array', () => {
    const map = indexMap('One Piece', [indexEntry()]);
    const placeholders = generatePlaceholders(cloudFiles, [], map);

    expect(placeholders[0].page_char_counts).not.toBe(
      [...map.values()][0].file.volumes[0].page_char_counts
    );
  });

  it('falls back to the deterministic uuid and zero counts without a matching entry', () => {
    const withIndex = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('One Piece', [indexEntry({ volume_title: 'Volume 2' })])
    );
    const withoutIndex = generatePlaceholders(cloudFiles, []);

    expect(withIndex[0].volume_uuid).toBe(withoutIndex[0].volume_uuid);
    expect(withIndex[0]).toMatchObject({
      page_count: 0,
      character_count: 0,
      page_char_counts: [],
      mokuro_version: 'unknown'
    });
    expect(withIndex[0].spine_width).toBeUndefined();
  });

  it('skips the placeholder when a local volume already holds the indexed uuid', () => {
    // The local row is filed under a different volume title (renamed here, not
    // in the cloud), so the path/title dedupe misses it — only the uuid catches
    // this, and without it the same volume would show up twice in the catalog.
    const placeholders = generatePlaceholders(
      cloudFiles,
      [localVolume({ volume_uuid: 'real-uuid-1', volume_title: 'Vol. 1' })],
      indexMap('One Piece', [indexEntry()])
    );

    expect(placeholders).toEqual([]);
  });

  it('still dedupes by path when the index knows nothing about the volume', () => {
    const placeholders = generatePlaceholders(
      cloudFiles,
      [localVolume()],
      indexMap('One Piece', [])
    );

    expect(placeholders).toEqual([]);
  });

  it('looks the index up by folder name, not by the description series title', () => {
    // A "Series: …" description renames the series for display; the index (and
    // the cloud folder) is still keyed by the folder it lives in.
    const described = new Map<string, CloudVolumeWithProvider[]>([
      [
        'One Piece',
        [
          {
            ...cloudFile('One Piece/Volume 1.cbz'),
            description: 'Series: ワンピース'
          } as CloudVolumeWithProvider
        ]
      ]
    ]);

    const placeholders = generatePlaceholders(described, [], indexMap('One Piece', [indexEntry()]));

    expect(placeholders[0].series_title).toBe('ワンピース');
    expect(placeholders[0].volume_uuid).toBe('real-uuid-1');
  });

  it('warns once when two cloud files claim the same indexed uuid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const duplicated = new Map<string, CloudVolumeWithProvider[]>([
      [
        'One Piece',
        [
          cloudFile('One Piece/Volume 1.cbz'),
          cloudFile('One Piece/Volume 1 (copy).cbz'),
          cloudFile('One Piece/Volume 1 (dupe).cbz')
        ]
      ]
    ]);

    const placeholders = generatePlaceholders(
      duplicated,
      [],
      indexMap('One Piece', [
        indexEntry(),
        indexEntry({ volume_title: 'Volume 1 (copy)' }),
        indexEntry({ volume_title: 'Volume 1 (dupe)' })
      ])
    );

    expect(placeholders).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('never builds a placeholder for the sidecar itself, index or not', () => {
    const placeholders = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('One Piece', [indexEntry()])
    );

    expect(placeholders.map((p) => p.volume_title)).toEqual(['Volume 1']);
  });
});
