import { describe, it, expect } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata } from '$lib/metadata/types';
import type { CatalogIndexRecord } from '$lib/metadata/catalog-index';
import {
  deriveNameOnlySeries,
  deriveSeriesFromVolumes,
  partitionCatalogSeries,
  partitionSeriesVolumes,
  type Series
} from './catalog';

function vol(series: string, volume: string): VolumeMetadata {
  return {
    mokuro_version: '0.4.11',
    series_title: series,
    series_uuid: `uuid-${series}`,
    volume_title: volume,
    volume_uuid: `${series}-${volume}`,
    page_count: 10,
    character_count: 100,
    page_char_counts: [10, 20]
  };
}

function meta(seriesTitle: string, overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return {
    series_key: seriesTitle.trim().replace(/\s+/g, ' ').toLowerCase(),
    series_title: seriesTitle,
    external_ids: {},
    titles: {},
    synonyms: [],
    read_count: 0,
    updated_at: '2026-08-16T00:00:00.000Z',
    ...overrides
  };
}

describe('deriveSeriesFromVolumes', () => {
  it('groups by normalized series_title and keeps title = raw folder title', () => {
    const series = deriveSeriesFromVolumes([vol('One Piece', '1'), vol('one  piece', '2')]);
    expect(series).toHaveLength(1);
    expect(series[0].title).toBe('One Piece'); // first-seen raw title
    expect(series[0].volumes.map((v) => v.volume_title)).toEqual(['1', '2']);
  });

  it('displayTitle defaults to the raw title without metadata / imported preference', () => {
    const [s] = deriveSeriesFromVolumes([vol('One Piece', '1')]);
    expect(s.displayTitle).toBe('One Piece');
    expect(s.searchTerms).toEqual(['one piece']);
  });

  it('applies metadata + global preference to displayTitle and searchTerms', () => {
    const metaMap = new Map<string, SeriesMetadata>([
      [
        'one piece',
        meta('One Piece', {
          titles: { english: 'One Piece (en)', native: 'ONE PIECE' },
          synonyms: ['ワンピース'],
          tag: '[color]'
        })
      ]
    ]);
    const [s] = deriveSeriesFromVolumes([vol('One Piece', '1')], metaMap, 'english');
    expect(s.title).toBe('One Piece'); // identity untouched
    expect(s.displayTitle).toBe('One Piece (en) (color)');
    expect(s.searchTerms).toContain('ワンピース');
    expect(s.searchTerms).toContain('one piece (en) (color)');
  });

  it('ignores a per-series title_preference override — title language is global-only', () => {
    const metaMap = new Map<string, SeriesMetadata>([
      [
        'one piece',
        meta('One Piece', { titles: { english: 'E', native: 'N' }, title_preference: 'native' })
      ]
    ]);
    const [s] = deriveSeriesFromVolumes([vol('One Piece', '1')], metaMap, 'english');
    expect(s.displayTitle).toBe('E');
  });

  it('sorts series by displayTitle', () => {
    const metaMap = new Map<string, SeriesMetadata>([
      ['zzz', meta('zzz', { titles: { english: 'Aardvark' } })]
    ]);
    const series = deriveSeriesFromVolumes(
      [vol('Middle', '1'), vol('zzz', '1')],
      metaMap,
      'english'
    );
    expect(series.map((s) => s.displayTitle)).toEqual(['Aardvark', 'Middle']);
  });
});

function catalogRow(
  title: string,
  entry: Partial<CatalogIndexRecord['entry']> = {}
): CatalogIndexRecord {
  return {
    series_key: title.trim().toLowerCase(),
    series_title: title,
    entry: {
      series_title: title,
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '1970-01-01T00:00:00.000Z',
      ...entry
    },
    source: { provider: 'webdav', path: 'catalog.json', size: 1, modifiedTime: 'now' },
    fetched_at: '2026-08-23T00:00:00.000Z'
  };
}

describe('deriveNameOnlySeries', () => {
  it('emits a card for a catalog-only series, with no volumes', () => {
    const [series] = deriveNameOnlySeries(
      [catalogRow('Dr Stone')],
      new Set(),
      undefined,
      'imported'
    );
    expect(series).toMatchObject({
      title: 'Dr Stone',
      displayTitle: 'Dr Stone',
      nameOnly: true,
      volumes: []
    });
    expect(series.series_uuid).toBeTruthy();
  });

  it('skips series that already have rows or placeholders locally', () => {
    expect(
      deriveNameOnlySeries([catalogRow('Dr Stone')], new Set(['dr stone']), undefined, 'imported')
    ).toEqual([]);
  });

  it('lists a factless folder by its folder name', () => {
    const [series] = deriveNameOnlySeries(
      [catalogRow('Bare Folder')],
      new Set(),
      undefined,
      'imported'
    );
    expect(series.displayTitle).toBe('Bare Folder');
  });

  it('is searchable by every alt title, synonym and tag', () => {
    const meta = new Map<string, SeriesMetadata>([
      [
        'dr stone',
        {
          series_key: 'dr stone',
          series_title: 'Dr Stone',
          external_ids: { anilist: 98416 },
          titles: { native: 'Dr.STONE', english: 'Dr. STONE' },
          synonyms: ['Doctor Stone'],
          tag: 'HD Scan',
          read_count: 0,
          updated_at: '2026-08-18T19:36:24.324Z'
        }
      ]
    ]);
    const [series] = deriveNameOnlySeries([catalogRow('Dr Stone')], new Set(), meta, 'english');
    expect(series.searchTerms).toEqual(
      expect.arrayContaining(['dr stone', 'dr.stone', 'doctor stone', 'hd scan'])
    );
    expect(series.displayTitle).toBe('Dr. STONE (HD Scan)');
  });

  it('sorts by display title', () => {
    const out = deriveNameOnlySeries(
      [catalogRow('Zeta'), catalogRow('Alpha')],
      new Set(),
      undefined,
      'imported'
    );
    expect(out.map((s) => s.title)).toEqual(['Alpha', 'Zeta']);
  });
});

describe('partitionCatalogSeries', () => {
  function series(title: string, volumes: VolumeMetadata[], nameOnly?: true): Series {
    return {
      title,
      displayTitle: title,
      searchTerms: [title.toLowerCase()],
      series_uuid: `uuid-${title}`,
      volumes,
      ...(nameOnly ? { nameOnly } : {})
    };
  }

  const installed = () => vol('Here', '1');
  const removed = (): VolumeMetadata => ({ ...vol('Gone', '1'), metadata_only: true });
  const cloudOnly = (): VolumeMetadata => ({ ...vol('Cloud', '1'), isPlaceholder: true });

  const local = series('Here', [installed()]);
  const absent = series('Gone', [removed()]);
  const half = series('Half', [installed(), removed()]);
  const placeholders = series('Cloud', [cloudOnly()]);
  const nameOnly = series('Named', [], true);
  const all = [local, absent, half, placeholders, nameOnly];

  it('keeps metadata-only series in the library in mixed mode', () => {
    const { localSeries, cloudSeries, nameOnlySeries } = partitionCatalogSeries(all, 'mixed');
    expect(localSeries.map((s) => s.title)).toEqual(['Here', 'Gone', 'Half']);
    expect(cloudSeries.map((s) => s.title)).toEqual(['Cloud']);
    expect(nameOnlySeries.map((s) => s.title)).toEqual(['Named']);
  });

  it('groups fully-absent series with the cloud ones in cloud-section mode', () => {
    const { localSeries, cloudSeries, nameOnlySeries } = partitionCatalogSeries(
      all,
      'cloud-section'
    );
    // "Half" still has a volume on the device, so it stays in the library.
    expect(localSeries.map((s) => s.title)).toEqual(['Here', 'Half']);
    expect(cloudSeries.map((s) => s.title)).toEqual(['Gone', 'Cloud']);
    expect(nameOnlySeries.map((s) => s.title)).toEqual(['Named']);
  });

  it('groups a series that mixes removed rows with cloud-only volumes', () => {
    const mixedAbsence = series('Mixed', [removed(), cloudOnly()]);
    expect(partitionCatalogSeries([mixedAbsence], 'mixed').localSeries).toHaveLength(1);
    expect(partitionCatalogSeries([mixedAbsence], 'cloud-section').cloudSeries).toHaveLength(1);
  });

  it('never puts an empty non-catalog series anywhere', () => {
    const empty = series('Empty', []);
    for (const mode of ['mixed', 'cloud-section'] as const) {
      const sections = partitionCatalogSeries([empty], mode);
      expect(sections.localSeries).toEqual([]);
      expect(sections.cloudSeries).toEqual([]);
      expect(sections.nameOnlySeries).toEqual([]);
    }
  });

  it('preserves the order it was handed', () => {
    const a = series('B', [installed()]);
    const b = series('A', [installed()]);
    expect(partitionCatalogSeries([a, b], 'mixed').localSeries.map((s) => s.title)).toEqual([
      'B',
      'A'
    ]);
  });
});

describe('partitionSeriesVolumes', () => {
  const installed = vol('Series', '1');
  const removed: VolumeMetadata = { ...vol('Series', '2'), metadata_only: true };

  it('lists every row in the main list in mixed mode', () => {
    const { listed, absent } = partitionSeriesVolumes([installed, removed], 'mixed');
    expect(listed).toEqual([installed, removed]);
    expect(absent).toEqual([]);
  });

  it('moves rows whose pages are gone to the cloud section in cloud-section mode', () => {
    const { listed, absent } = partitionSeriesVolumes([installed, removed], 'cloud-section');
    expect(listed).toEqual([installed]);
    expect(absent).toEqual([removed]);
  });

  it('keeps the given order within each half', () => {
    const removedFirst: VolumeMetadata = { ...vol('Series', '0'), metadata_only: true };
    const { listed, absent } = partitionSeriesVolumes(
      [removedFirst, installed, removed],
      'cloud-section'
    );
    expect(listed.map((v) => v.volume_title)).toEqual(['1']);
    expect(absent.map((v) => v.volume_title)).toEqual(['0', '2']);
  });
});
