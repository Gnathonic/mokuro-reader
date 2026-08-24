import { describe, expect, it } from 'vitest';
import { FACTLESS_UPDATED_AT, type SeriesFile } from './series-file';
import type { SeriesMetadata } from './types';
import {
  buildCatalogFile,
  catalogEntryFromMeta,
  catalogSeriesEqual,
  catalogEntryFromSeriesFile,
  catalogEntryToSeriesFile,
  isCatalogFilePath,
  parseCatalogFile,
  stringifyCatalogFile,
  type CatalogFile,
  type CatalogFileEntry
} from './catalog-file';

function meta(overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return {
    series_key: 'dr stone (hd scan)',
    series_title: 'Dr Stone (HD Scan)',
    external_ids: { anilist: 98416 },
    titles: { native: 'Dr.STONE', romaji: 'Dr. STONE', english: 'Dr. STONE' },
    synonyms: [],
    tag: 'HD Scan',
    updated_at: '2026-08-18T19:36:24.324Z',
    facts_updated_at: '2026-08-18T19:36:24.324Z',
    ...overrides
  };
}

function entry(overrides: Partial<CatalogFileEntry> = {}): CatalogFileEntry {
  return {
    series_title: 'Dr Stone (HD Scan)',
    external_ids: { anilist: 98416 },
    titles: { native: 'Dr.STONE' },
    synonyms: [],
    tag: 'HD Scan',
    updated_at: '2026-08-18T19:36:24.324Z',
    ...overrides
  };
}

describe('catalogEntryFromMeta', () => {
  it('projects the facts subset stamped with the facts clock', () => {
    expect(catalogEntryFromMeta('Dr Stone (HD Scan)', meta())).toEqual({
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE', romaji: 'Dr. STONE', english: 'Dr. STONE' },
      synonyms: [],
      tag: 'HD Scan',
      updated_at: '2026-08-18T19:36:24.324Z'
    });
  });

  it('stamps a series with no record at the epoch and keeps only its title', () => {
    expect(catalogEntryFromMeta('Bare Folder', undefined)).toEqual({
      series_title: 'Bare Folder',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT
    });
  });

  it('publishes a deliberate unlink: factless facts with a real stamp', () => {
    const unlinked = meta({
      external_ids: {},
      titles: {},
      synonyms: [],
      tag: undefined,
      facts_updated_at: '2026-08-20T00:00:00.000Z'
    });
    expect(catalogEntryFromMeta('Dr Stone (HD Scan)', unlinked).updated_at).toBe(
      '2026-08-20T00:00:00.000Z'
    );
  });
});

describe('catalogEntryFromSeriesFile / catalogEntryToSeriesFile', () => {
  it('round-trips the facts subset of a series.json', () => {
    const file: SeriesFile = {
      version: 2,
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE' },
      synonyms: ['Doctor Stone'],
      tag: 'HD Scan',
      unit: 'volumes',
      updated_at: '2026-08-18T19:36:24.324Z',
      volumes: [
        {
          volume_uuid: 'uuid-1',
          volume_title: 'Volume 1',
          page_count: 200,
          character_count: 5000,
          mokuro_version: '0.4.11'
        }
      ]
    };
    const projected = catalogEntryFromSeriesFile(file);
    expect(projected).toEqual({
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE' },
      synonyms: ['Doctor Stone'],
      tag: 'HD Scan',
      unit: 'volumes',
      updated_at: '2026-08-18T19:36:24.324Z'
    });
    expect(catalogEntryToSeriesFile(projected)).toEqual({
      version: 2,
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE' },
      synonyms: ['Doctor Stone'],
      tag: 'HD Scan',
      unit: 'volumes',
      updated_at: '2026-08-18T19:36:24.324Z',
      volumes: []
    });
  });
});

describe('buildCatalogFile', () => {
  it('unions with the cloud copy, newest facts stamp winning per series', () => {
    const existing: CatalogFile = {
      version: 1,
      updated_at: '2026-08-19T00:00:00.000Z',
      series: [
        entry({ titles: { native: 'OLD' }, updated_at: '2026-08-19T00:00:00.000Z' }),
        entry({ series_title: 'Other Device Only', updated_at: '2026-08-10T00:00:00.000Z' })
      ]
    };
    const built = buildCatalogFile({
      entries: [entry({ titles: { native: 'NEW' }, updated_at: '2026-08-20T00:00:00.000Z' })],
      existing,
      cloudSeriesTitles: new Set(['Dr Stone (HD Scan)', 'Other Device Only']),
      now: '2026-08-23T00:00:00.000Z'
    });
    expect(built?.series.map((s) => s.series_title)).toEqual([
      'Dr Stone (HD Scan)',
      'Other Device Only'
    ]);
    expect(built?.series[0].titles).toEqual({ native: 'NEW' });
    expect(built?.updated_at).toBe('2026-08-23T00:00:00.000Z');
  });

  it('keeps the cloud facts when the local entry is older', () => {
    const existing: CatalogFile = {
      version: 1,
      updated_at: '2026-08-21T00:00:00.000Z',
      series: [entry({ titles: { native: 'CLOUD' }, updated_at: '2026-08-21T00:00:00.000Z' })]
    };
    const built = buildCatalogFile({
      entries: [entry({ titles: { native: 'LOCAL' }, updated_at: '2026-08-20T00:00:00.000Z' })],
      existing,
      cloudSeriesTitles: new Set(['Dr Stone (HD Scan)'])
    });
    expect(built?.series[0].titles).toEqual({ native: 'CLOUD' });
  });

  it('never lets a factless epoch entry outrank published facts', () => {
    const existing: CatalogFile = {
      version: 1,
      updated_at: '2026-08-21T00:00:00.000Z',
      series: [entry({ updated_at: '2026-08-21T00:00:00.000Z' })]
    };
    const built = buildCatalogFile({
      entries: [
        {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: FACTLESS_UPDATED_AT
        }
      ],
      existing,
      cloudSeriesTitles: new Set(['Dr Stone (HD Scan)'])
    });
    expect(built?.series[0].external_ids).toEqual({ anilist: 98416 });
  });

  it('keeps the newer stamp when BOTH copies are factless', () => {
    // Device A unlinked the series and published that: a factless entry carrying a REAL
    // stamp. Device C is merely offline-ignorant of the series — factless at the epoch.
    // Letting C's epoch replace A's stamp would put the entry back below every stale link
    // still out there, and the next union would resurrect the dead one.
    const existing: CatalogFile = {
      version: 1,
      updated_at: '2026-08-21T00:00:00.000Z',
      series: [
        {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2026-08-21T00:00:00.000Z'
        }
      ]
    };
    const built = buildCatalogFile({
      entries: [
        {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: FACTLESS_UPDATED_AT
        }
      ],
      existing,
      cloudSeriesTitles: new Set(['Dr Stone (HD Scan)'])
    });
    expect(built?.series[0].updated_at).toBe('2026-08-21T00:00:00.000Z');
  });

  it('still lets a factless local entry replace an OLDER factless one', () => {
    const existing: CatalogFile = {
      version: 1,
      updated_at: '2026-08-10T00:00:00.000Z',
      series: [
        {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2026-08-10T00:00:00.000Z'
        }
      ]
    };
    const built = buildCatalogFile({
      entries: [
        {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2026-08-20T00:00:00.000Z'
        }
      ],
      existing,
      cloudSeriesTitles: new Set(['Dr Stone (HD Scan)'])
    });
    expect(built?.series[0].updated_at).toBe('2026-08-20T00:00:00.000Z');
  });

  it('lets local FACTS replace a factless entry however it is stamped', () => {
    const existing: CatalogFile = {
      version: 1,
      updated_at: '2026-08-21T00:00:00.000Z',
      series: [
        {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2026-08-21T00:00:00.000Z'
        }
      ]
    };
    const built = buildCatalogFile({
      entries: [entry({ updated_at: '2026-08-20T00:00:00.000Z' })],
      existing,
      cloudSeriesTitles: new Set(['Dr Stone (HD Scan)'])
    });
    expect(built?.series[0].external_ids).toEqual({ anilist: 98416 });
  });

  it('needs a STRICTLY newer stamp to publish an unlink', () => {
    const existing: CatalogFile = {
      version: 1,
      updated_at: '2026-08-21T00:00:00.000Z',
      series: [entry({ updated_at: '2026-08-21T00:00:00.000Z' })]
    };
    const built = buildCatalogFile({
      entries: [
        {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2026-08-21T00:00:00.000Z'
        }
      ],
      existing,
      cloudSeriesTitles: new Set(['Dr Stone (HD Scan)'])
    });
    expect(built?.series[0].external_ids).toEqual({ anilist: 98416 });
  });

  it('prunes series whose folder is gone from the listing', () => {
    const built = buildCatalogFile({
      entries: [entry(), entry({ series_title: 'Deleted Series' })],
      cloudSeriesTitles: new Set(['dr stone (hd scan)']),
      now: '2026-08-23T00:00:00.000Z'
    });
    expect(built?.series.map((s) => s.series_title)).toEqual(['Dr Stone (HD Scan)']);
  });

  it('keeps a factless folder listed by name', () => {
    const built = buildCatalogFile({
      entries: [
        {
          series_title: 'Bare Folder',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: FACTLESS_UPDATED_AT
        }
      ],
      cloudSeriesTitles: new Set(['Bare Folder'])
    });
    expect(built?.series).toEqual([
      {
        series_title: 'Bare Folder',
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: FACTLESS_UPDATED_AT
      }
    ]);
  });

  it('returns undefined when nothing survives', () => {
    expect(
      buildCatalogFile({ entries: [entry()], cloudSeriesTitles: new Set<string>() })
    ).toBeUndefined();
  });
});

describe('parseCatalogFile', () => {
  it('accepts a well-formed file and drops unknown keys', () => {
    const parsed = parseCatalogFile({
      version: 1,
      updated_at: '2026-08-23T00:00:00.000Z',
      evil: 'ignored',
      series: [
        {
          series_title: 'Dr Stone (HD Scan)',
          titles: { native: 'Dr.STONE', klingon: 'nope' },
          synonyms: ['Doctor Stone', ''],
          tag: ' HD Scan ',
          unit: 'volumes',
          external_ids: { anilist: 98416, mal: 0 },
          updated_at: '2026-08-18T19:36:24.324Z',
          volumes: [{ volume_uuid: 'uuid-1' }]
        }
      ]
    });
    expect(parsed).toEqual({
      version: 1,
      updated_at: '2026-08-23T00:00:00.000Z',
      series: [
        {
          series_title: 'Dr Stone (HD Scan)',
          external_ids: { anilist: 98416 },
          titles: { native: 'Dr.STONE' },
          synonyms: ['Doctor Stone'],
          tag: 'HD Scan',
          unit: 'volumes',
          updated_at: '2026-08-18T19:36:24.324Z'
        }
      ]
    });
  });

  it('rejects a wrong version and junk', () => {
    expect(
      parseCatalogFile({ version: 2, updated_at: '2026-08-23T00:00:00.000Z' })
    ).toBeUndefined();
    expect(parseCatalogFile('nope')).toBeUndefined();
    expect(parseCatalogFile({ version: 1, updated_at: 'not a date' })).toBeUndefined();
  });

  it('drops bad entries individually and de-duplicates by series key', () => {
    const parsed = parseCatalogFile({
      version: 1,
      updated_at: '2026-08-23T00:00:00.000Z',
      series: [
        { series_title: '  ', updated_at: '2026-08-18T19:36:24.324Z' },
        { series_title: 'Good', updated_at: 'garbage' },
        { series_title: 'Good', updated_at: '2026-08-18T19:36:24.324Z' },
        { series_title: 'GOOD', updated_at: '2026-08-19T19:36:24.324Z' }
      ]
    });
    expect(parsed?.series).toHaveLength(1);
    expect(parsed?.series[0].series_title).toBe('Good');
  });

  it('clamps a far-future stamp so it cannot win forever', () => {
    const far = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString();
    const parsed = parseCatalogFile({
      version: 1,
      updated_at: far,
      series: [{ series_title: 'Good', updated_at: far }]
    });
    expect(Date.parse(parsed!.series[0].updated_at)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('stringifyCatalogFile / isCatalogFilePath', () => {
  it('serializes compactly', () => {
    const json = stringifyCatalogFile({
      version: 1,
      updated_at: '2026-08-23T00:00:00.000Z',
      series: []
    });
    expect(json).toBe('{"version":1,"updated_at":"2026-08-23T00:00:00.000Z","series":[]}');
  });

  it('matches only the ROOT catalog.json', () => {
    expect(isCatalogFilePath('catalog.json')).toBe(true);
    expect(isCatalogFilePath('/catalog.json')).toBe(true);
    expect(isCatalogFilePath('CATALOG.JSON')).toBe(true);
    expect(isCatalogFilePath('Dr Stone/catalog.json')).toBe(false);
    expect(isCatalogFilePath('my-catalog.json')).toBe(false);
  });
});

describe('catalogSeriesEqual', () => {
  function entry(overrides: Partial<CatalogFileEntry> = {}): CatalogFileEntry {
    return {
      series_title: 'Dr Stone',
      external_ids: { anilist: 98416 },
      titles: {},
      synonyms: [],
      updated_at: '2026-08-23T00:00:00.000Z',
      ...overrides
    };
  }

  it('is true for the same series, whatever order they are listed in', () => {
    const a = [entry(), entry({ series_title: 'Other', external_ids: {} })];
    expect(catalogSeriesEqual(a, [...a].reverse())).toBe(true);
  });

  it('ignores key order inside an entry (a parsed copy vs a rebuilt one)', () => {
    // `parseCatalogFile` appends `tag` AFTER `updated_at`; a locally built entry
    // puts it before. Same facts — a raw JSON.stringify would disagree.
    const built = { ...entry(), tag: 'reading', updated_at: '2026-08-23T00:00:00.000Z' };
    const parsed = JSON.parse(
      JSON.stringify({
        series_title: 'Dr Stone',
        external_ids: { anilist: 98416 },
        titles: {},
        synonyms: [],
        updated_at: '2026-08-23T00:00:00.000Z',
        tag: 'reading'
      })
    );
    expect(catalogSeriesEqual([built], [parsed])).toBe(true);
  });

  it('is false when any fact, title, stamp or series differs', () => {
    expect(catalogSeriesEqual([entry()], [entry({ external_ids: { anilist: 1 } })])).toBe(false);
    expect(catalogSeriesEqual([entry()], [entry({ synonyms: ['Dr. Stone'] })])).toBe(false);
    expect(catalogSeriesEqual([entry()], [entry({ tag: 'reading' })])).toBe(false);
    expect(catalogSeriesEqual([entry()], [entry({ updated_at: FACTLESS_UPDATED_AT })])).toBe(false);
    expect(catalogSeriesEqual([entry()], [entry(), entry({ series_title: 'Extra' })])).toBe(false);
  });

  it('treats a missing copy as unequal — there is nothing to compare against', () => {
    expect(catalogSeriesEqual([entry()], undefined)).toBe(false);
  });
});
