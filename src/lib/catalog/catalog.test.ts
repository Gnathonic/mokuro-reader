import { describe, it, expect } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata } from '$lib/metadata/types';
import {
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

  it('ignores a legacy per-series title preference — title language is global-only', () => {
    const metaMap = new Map<string, SeriesMetadata>([
      [
        'one piece',
        // No migration ran, so a record linked before the per-series preference
        // was dropped still carries it in IndexedDB. It decides nothing.
        {
          ...meta('One Piece', { titles: { english: 'E', native: 'N' } }),
          title_preference: 'native'
        } as unknown as SeriesMetadata
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

describe('partitionCatalogSeries', () => {
  function series(title: string, volumes: VolumeMetadata[]): Series {
    return {
      title,
      displayTitle: title,
      searchTerms: [title.toLowerCase()],
      series_uuid: `uuid-${title}`,
      volumes
    };
  }

  const installed = () => vol('Here', '1');
  const removed = (): VolumeMetadata => ({ ...vol('Gone', '1'), metadata_only: true });
  const cloudOnly = (): VolumeMetadata => ({ ...vol('Cloud', '1'), isPlaceholder: true });

  const local = series('Here', [installed()]);
  const absent = series('Gone', [removed()]);
  const half = series('Half', [installed(), removed()]);
  const placeholders = series('Cloud', [cloudOnly()]);
  const all = [local, absent, half, placeholders];

  it('groups fully-absent series with the cloud ones', () => {
    const { localSeries, cloudSeries } = partitionCatalogSeries(all);
    // "Half" still has a volume on the device, so it stays in the library.
    expect(localSeries.map((s) => s.title)).toEqual(['Here', 'Half']);
    expect(cloudSeries.map((s) => s.title)).toEqual(['Gone', 'Cloud']);
  });

  it('groups a series that mixes removed rows with cloud-only volumes', () => {
    const mixedAbsence = series('Mixed', [removed(), cloudOnly()]);
    expect(partitionCatalogSeries([mixedAbsence]).localSeries).toHaveLength(0);
    expect(partitionCatalogSeries([mixedAbsence]).cloudSeries).toHaveLength(1);
  });

  it('never puts an empty series anywhere', () => {
    const empty = series('Empty', []);
    const sections = partitionCatalogSeries([empty]);
    expect(sections.localSeries).toEqual([]);
    expect(sections.cloudSeries).toEqual([]);
  });

  it('preserves the order it was handed', () => {
    const a = series('B', [installed()]);
    const b = series('A', [installed()]);
    expect(partitionCatalogSeries([a, b]).localSeries.map((s) => s.title)).toEqual(['B', 'A']);
  });
});

describe('partitionSeriesVolumes', () => {
  const installed = vol('Series', '1');
  const removed: VolumeMetadata = { ...vol('Series', '2'), metadata_only: true };

  it('moves rows whose pages are gone to the cloud section', () => {
    const { listed, absent } = partitionSeriesVolumes([installed, removed]);
    expect(listed).toEqual([installed]);
    expect(absent).toEqual([removed]);
  });

  it('keeps the given order within each half', () => {
    const removedFirst: VolumeMetadata = { ...vol('Series', '0'), metadata_only: true };
    const { listed, absent } = partitionSeriesVolumes([removedFirst, installed, removed]);
    expect(listed.map((v) => v.volume_title)).toEqual(['1']);
    expect(absent.map((v) => v.volume_title)).toEqual(['0', '2']);
  });
});
