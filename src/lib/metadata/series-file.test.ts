import { describe, expect, it } from 'vitest';
import {
  FACTLESS_UPDATED_AT,
  SERIES_FILE_NAME,
  buildSeriesFile,
  isSeriesFilePath,
  mergeSeriesFileForCache,
  parseSeriesFile,
  volumeToIndexEntry,
  type SeriesFile
} from './series-file';
import { createEmptySeriesMetadata, type SeriesMetadata } from './types';
import type { VolumeMetadata } from '$lib/types';

function volume(partial: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    mokuro_version: '0.2.1',
    series_title: 'One Piece',
    series_uuid: 'series-uuid',
    volume_title: 'Vol 1',
    volume_uuid: 'vol-1',
    page_count: 2,
    character_count: 123,
    page_char_counts: [60, 123],
    ...partial
  };
}

function linkedMeta(): SeriesMetadata {
  return {
    ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
    external_ids: { anilist: 30013, mal: 13 },
    titles: { native: 'ONE PIECE', romaji: 'ONE PIECE', english: 'One Piece' },
    synonyms: ['ワンピース'],
    tag: '[color]',
    format: 'MANGA',
    status: 'RELEASING',
    total_volumes: 110,
    cover_url: 'https://img/op.jpg',
    title_preference: 'native',
    spine_offset: 12,
    volume_offsets: { 'vol-1': 4 },
    read_count: 3,
    reread_prompt_suppressed: true,
    tracking: { number_overrides: { 'vol-1': 2 } }
  };
}

describe('volumeToIndexEntry', () => {
  it('copies only the index fields', () => {
    expect(volumeToIndexEntry(volume({ spine_width: 17 }))).toEqual({
      volume_uuid: 'vol-1',
      volume_title: 'Vol 1',
      page_count: 2,
      character_count: 123,
      mokuro_version: '0.2.1',
      spine_width: 17
    });
  });

  it('omits a zero or non-finite spine_width so build → parse stays an identity', () => {
    expect('spine_width' in volumeToIndexEntry(volume({ spine_width: 0 }))).toBe(false);
    expect('spine_width' in volumeToIndexEntry(volume({ spine_width: NaN }))).toBe(false);
    expect('spine_width' in volumeToIndexEntry(volume({ spine_width: -3 }))).toBe(false);
  });

  it('copies the archive size when the row knows it', () => {
    expect(volumeToIndexEntry(volume({ archive_size: 193_000_000 })).archive_size).toBe(
      193_000_000
    );
  });

  it('omits a junk archive_size so build → parse stays an identity', () => {
    for (const size of [0, -1, 1.5, NaN, Infinity]) {
      expect('archive_size' in volumeToIndexEntry(volume({ archive_size: size }))).toBe(false);
    }
  });

  it('omits spine_width when the volume has none and never carries local-only fields', () => {
    const entry = volumeToIndexEntry(
      volume({
        thumbnail: new File([''], 't.webp') as File,
        cloudFileId: 'file-1',
        missing_page_paths: ['3.jpg']
      })
    );
    expect('spine_width' in entry).toBe(false);
    expect('archive_size' in entry).toBe(false);
    expect(Object.keys(entry).sort()).toEqual([
      'character_count',
      'mokuro_version',
      'page_count',
      'volume_title',
      'volume_uuid'
    ]);
  });
});

describe('buildSeriesFile', () => {
  it('returns undefined when there are no facts and no volumes', () => {
    expect(
      buildSeriesFile({ seriesTitle: 'One Piece', meta: undefined, localVolumes: [] })
    ).toBeUndefined();
    expect(
      buildSeriesFile({
        seriesTitle: 'One Piece',
        meta: createEmptySeriesMetadata('One Piece'),
        localVolumes: []
      })
    ).toBeUndefined();
  });

  it('writes facts + tag from the local record and never per-user fields', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: linkedMeta(),
      localVolumes: []
    })!;
    expect(file).toEqual({
      version: 2,
      series_title: 'One Piece',
      external_ids: { anilist: 30013, mal: 13 },
      titles: { native: 'ONE PIECE', romaji: 'ONE PIECE', english: 'One Piece' },
      synonyms: ['ワンピース'],
      tag: '[color]',
      updated_at: '2026-08-16T00:00:00.000Z',
      volumes: []
    });
    const json = JSON.stringify(file);
    for (const forbidden of [
      'tracking',
      'read_count',
      'title_preference',
      'reread_prompt_suppressed',
      'spine_offset',
      'volume_offsets',
      'cover_url',
      'total_volumes'
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('keeps the existing facts when no local record is supplied', () => {
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: { anilist: 30013 },
      titles: { english: 'One Piece' },
      synonyms: [],
      tag: '[color]',
      updated_at: '2026-01-01T00:00:00.000Z',
      volumes: []
    };
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume()],
      existing
    })!;
    expect(file.external_ids).toEqual({ anilist: 30013 });
    expect(file.tag).toBe('[color]');
    expect(file.updated_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('never lets a factless local record overwrite the facts already published', () => {
    // The catalog writes spine offsets/read counts on records that were never
    // linked here; those writes bump `updated_at`, which must not read as
    // "this series was just unlinked" on every other device.
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: { anilist: 30013 },
      titles: { english: 'One Piece' },
      synonyms: [],
      tag: '[color]',
      updated_at: '2026-01-01T00:00:00.000Z',
      volumes: []
    };
    const neverLinkedHere = {
      ...createEmptySeriesMetadata('One Piece', '2026-06-01T00:00:00.000Z'),
      spine_offset: 12,
      read_count: 2
    };
    expect(neverLinkedHere.facts_updated_at).toBeUndefined(); // no facts clock at all
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: neverLinkedHere,
      localVolumes: [volume()],
      existing
    })!;
    expect(file.external_ids).toEqual({ anilist: 30013 });
    expect(file.titles).toEqual({ english: 'One Piece' });
    expect(file.tag).toBe('[color]');
    expect(file.updated_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('stamps the file with the facts clock, not the record clock', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: {
        ...linkedMeta(),
        // linked at 08-16, then a per-user write bumped the record on 09-01
        updated_at: '2026-09-01T00:00:00.000Z',
        facts_updated_at: '2026-08-16T00:00:00.000Z'
      },
      localVolumes: []
    })!;
    expect(file.updated_at).toBe('2026-08-16T00:00:00.000Z');
  });

  it('keeps the newer side when both the record and the file carry facts', () => {
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: { anilist: 111 },
      titles: {},
      synonyms: [],
      updated_at: '2026-05-01T00:00:00.000Z',
      volumes: []
    };
    // local facts are older → the file's facts survive
    const stale = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: { ...linkedMeta(), facts_updated_at: '2026-04-01T00:00:00.000Z' },
      localVolumes: [],
      existing
    })!;
    expect(stale.external_ids).toEqual({ anilist: 111 });
    expect(stale.updated_at).toBe('2026-05-01T00:00:00.000Z');

    // local facts are newer → they win, including a deliberate unlink
    const fresh = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: { ...linkedMeta(), facts_updated_at: '2026-06-01T00:00:00.000Z' },
      localVolumes: [],
      existing
    })!;
    expect(fresh.external_ids).toEqual({ anilist: 30013, mal: 13 });
    expect(fresh.updated_at).toBe('2026-06-01T00:00:00.000Z');
  });

  it('re-publishes the same facts unchanged when the file round-trips back', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: linkedMeta(),
      localVolumes: []
    })!;
    // stamps are equal (the record was written from this very file) → local wins
    const again = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: linkedMeta(),
      localVolumes: [],
      existing: file
    })!;
    expect(again).toEqual(file);
  });

  it('publishes a deliberate unlink (factless record WITH a facts clock)', () => {
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: { anilist: 30013 },
      titles: { english: 'One Piece' },
      synonyms: [],
      updated_at: '2026-01-01T00:00:00.000Z',
      volumes: []
    };
    const unlinkedHere = {
      ...createEmptySeriesMetadata('One Piece', '2026-06-01T00:00:00.000Z'),
      facts_updated_at: '2026-06-01T00:00:00.000Z'
    };
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: unlinkedHere,
      localVolumes: [volume()],
      existing
    })!;
    expect(file.external_ids).toEqual({});
    expect(file.titles).toEqual({});
    expect(file.updated_at).toBe('2026-06-01T00:00:00.000Z');

    // …but an unlink older than the published facts does not resurrect itself.
    const stale = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: { ...unlinkedHere, facts_updated_at: '2025-01-01T00:00:00.000Z' },
      localVolumes: [volume()],
      existing
    })!;
    expect(stale.external_ids).toEqual({ anilist: 30013 });
    expect(stale.updated_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('counts synonyms as facts', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: {
        ...createEmptySeriesMetadata('One Piece', '2026-06-01T00:00:00.000Z'),
        synonyms: ['ワンピース']
      },
      localVolumes: []
    })!;
    // Worth uploading on its own, even with no ids/titles/tag and no volumes.
    expect(file.synonyms).toEqual(['ワンピース']);
    expect(file.updated_at).toBe('2026-06-01T00:00:00.000Z');

    // …and a synonyms-only record is not "factless", so it wins over an older file.
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: { anilist: 30013 },
      titles: {},
      synonyms: [],
      updated_at: '2026-01-01T00:00:00.000Z',
      volumes: []
    };
    const merged = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: {
        ...createEmptySeriesMetadata('One Piece', '2026-06-01T00:00:00.000Z'),
        synonyms: ['ワンピース']
      },
      localVolumes: [],
      existing
    })!;
    expect(merged.synonyms).toEqual(['ワンピース']);
    expect(merged.external_ids).toEqual({});
  });

  it('unions volumes by uuid with local winning, and sorts naturally', () => {
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-01-01T00:00:00.000Z',
      volumes: [
        {
          volume_uuid: 'vol-1',
          volume_title: 'Vol 1',
          page_count: 1,
          character_count: 1,
          mokuro_version: ''
        },
        {
          volume_uuid: 'vol-10',
          volume_title: 'Vol 10',
          page_count: 9,
          character_count: 900,
          mokuro_version: '0.2.1'
        }
      ]
    };
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume({ volume_uuid: 'vol-2', volume_title: 'Vol 2' }), volume()],
      existing
    })!;
    expect(file.volumes.map((v) => v.volume_title)).toEqual(['Vol 1', 'Vol 2', 'Vol 10']);
    // local wins over the stale existing entry for the same uuid
    expect(file.volumes[0]).toEqual({
      volume_uuid: 'vol-1',
      volume_title: 'Vol 1',
      page_count: 2,
      character_count: 123,
      mokuro_version: '0.2.1'
    });
  });

  it('excludes local placeholders from the index', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: linkedMeta(),
      localVolumes: [
        volume(),
        volume({ volume_uuid: 'vol-2', volume_title: 'Vol 2', isPlaceholder: true })
      ]
    })!;
    expect(file.volumes.map((v) => v.volume_uuid)).toEqual(['vol-1']);
  });

  it('keeps a metadata-only volume in the index — it is real, just not downloaded here', () => {
    // The row exists with its real uuid and counts (measured when it WAS
    // installed), which is exactly what the index is for: another device
    // reading this file should still learn about the volume.
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: linkedMeta(),
      localVolumes: [volume({ volume_uuid: 'vol-2', volume_title: 'Vol 2', metadata_only: true })]
    })!;
    expect(file.volumes.map((v) => v.volume_uuid)).toEqual(['vol-2']);
  });

  it('lets the published entry win over a metadata-only row for the same uuid', () => {
    // A volume re-OCR'd on another device: its entry in the cloud file is newer
    // than the row this device kept when it removed the files. A materialized or
    // metadata-only row was never measured against THIS content, so it may fill
    // a gap but must never override what is published.
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-01-01T00:00:00.000Z',
      volumes: [
        {
          volume_uuid: 'vol-1',
          volume_title: 'Vol 1',
          page_count: 300,
          character_count: 9000,
          mokuro_version: '0.4.12'
        }
      ]
    };
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume({ metadata_only: true })],
      existing
    })!;
    expect(file.volumes).toEqual(existing.volumes);
  });

  it('does not re-add a pruned volume from a metadata-only row', () => {
    // The volume was deleted from the cloud. This device still holds its
    // metadata-only row (that is the point of the state — the history survives),
    // but the row is not evidence the archive exists, so it must not exempt the
    // entry from the listing prune the way an installed volume does.
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [
        volume(),
        volume({ volume_uuid: 'vol-9', volume_title: 'Vol 9', metadata_only: true })
      ],
      cloudVolumeTitles: new Set(['Vol 1'])
    })!;
    expect(file.volumes.map((v) => v.volume_title)).toEqual(['Vol 1']);
  });

  it('matches the cloud listing on a folded volume title, not an exact string', () => {
    // The listing's titles come from cloud FILENAMES; the entry's come from
    // whoever wrote the file. Case, run-together whitespace and unicode
    // composition all drift between the two, and an exact-string membership
    // test would read that drift as "deleted from the cloud" and prune a volume
    // that is sitting right there. Same fold materialization matches on.
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-01-01T00:00:00.000Z',
      volumes: [
        {
          volume_uuid: 'vol-1',
          volume_title: 'Caf\u00e9  Vol 1', // NFC, doubled space, mixed case
          page_count: 1,
          character_count: 1,
          mokuro_version: '0.2.1'
        }
      ]
    };
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: linkedMeta(),
      localVolumes: [],
      existing,
      cloudVolumeTitles: new Set(['cafe\u0301 vol 1']) // NFD, single space, lowercase
    })!;
    expect(file.volumes.map((v) => v.volume_title)).toEqual(['Caf\u00e9  Vol 1']);
  });

  it('prunes entries the cloud no longer lists unless they are installed locally', () => {
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-01-01T00:00:00.000Z',
      volumes: [
        {
          volume_uuid: 'vol-1',
          volume_title: 'Vol 1',
          page_count: 1,
          character_count: 1,
          mokuro_version: '0.2.1'
        },
        {
          volume_uuid: 'vol-3',
          volume_title: 'Vol 3',
          page_count: 1,
          character_count: 1,
          mokuro_version: '0.2.1'
        }
      ]
    };
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume({ volume_uuid: 'vol-9', volume_title: 'Vol 9' })],
      existing,
      cloudVolumeTitles: new Set(['Vol 1'])
    })!;
    // Vol 3 is gone from the cloud and not installed → dropped.
    // Vol 9 is local-only (not backed up yet) → kept.
    expect(file.volumes.map((v) => v.volume_title)).toEqual(['Vol 1', 'Vol 9']);
  });

  it('writes an index-only file for an unlinked series with volumes', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume()]
    })!;
    expect(file.version).toBe(2);
    expect(file.external_ids).toEqual({});
    expect(file.volumes).toHaveLength(1);
    expect(Date.parse(file.updated_at)).not.toBeNaN();
  });

  it('stamps a factless build with the epoch sentinel — no opinion cannot outrank a link', () => {
    // No local facts clock and no published file: this library has never had an
    // opinion about the series. `new Date()` here would make the emptiest
    // possible file the newest one and unlink the series on every other device.
    const noRecord = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume()]
    })!;
    expect(noRecord.updated_at).toBe(FACTLESS_UPDATED_AT);

    const perUserOnly = buildSeriesFile({
      seriesTitle: 'One Piece',
      // A record that only ever tracked per-user state (a spine nudge bumped
      // `updated_at`, no fact was ever edited) has no facts clock either.
      meta: {
        ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
        spine_offset: 4
      },
      localVolumes: [volume()]
    })!;
    expect(perUserOnly.updated_at).toBe(FACTLESS_UPDATED_AT);
  });

  it('keeps the source stamp when the facts come from the record or the existing file', () => {
    const fromRecord = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: linkedMeta(),
      localVolumes: [volume()]
    })!;
    expect(fromRecord.updated_at).toBe('2026-08-16T00:00:00.000Z');

    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: { anilist: 30013 },
      titles: {},
      synonyms: [],
      updated_at: '2026-05-05T00:00:00.000Z',
      volumes: []
    };
    const fromExisting = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume()],
      existing
    })!;
    expect(fromExisting.updated_at).toBe('2026-05-05T00:00:00.000Z');
    expect(fromExisting.external_ids).toEqual({ anilist: 30013 });
  });
});

describe('parseSeriesFile', () => {
  const valid = {
    version: 2,
    series_title: 'One Piece',
    external_ids: { anilist: 30013, mal: 13 },
    titles: { english: 'One Piece' },
    synonyms: ['ワンピース'],
    tag: '[color]',
    updated_at: '2026-08-16T00:00:00.000Z',
    volumes: [
      {
        volume_uuid: 'vol-1',
        volume_title: 'Vol 1',
        page_count: 2,
        character_count: 123,
        mokuro_version: '0.2.1',
        spine_width: 17,
        archive_size: 193_000_000
      }
    ]
  };

  it('rejects junk', () => {
    expect(parseSeriesFile(undefined)).toBeUndefined();
    expect(parseSeriesFile('nope')).toBeUndefined();
    expect(parseSeriesFile(42)).toBeUndefined();
    expect(parseSeriesFile([valid])).toBeUndefined();
    expect(parseSeriesFile({})).toBeUndefined();
    expect(parseSeriesFile({ ...valid, version: 3 })).toBeUndefined();
    expect(parseSeriesFile({ ...valid, version: '2' })).toBeUndefined();
    expect(parseSeriesFile({ ...valid, series_title: '  ' })).toBeUndefined();
    expect(parseSeriesFile({ ...valid, series_title: 7 })).toBeUndefined();
    expect(parseSeriesFile({ ...valid, updated_at: 'yesterday' })).toBeUndefined();
    expect(parseSeriesFile({ ...valid, updated_at: 1755345600000 })).toBeUndefined();
  });

  it('accepts a v2 file and drops unknown keys', () => {
    expect(parseSeriesFile({ ...valid, tracking: { enabled: true }, read_count: 4 })).toEqual(
      valid
    );
  });

  it('accepts a v1 file with no volume index', () => {
    const { volumes: _drop, ...v1 } = valid;
    expect(parseSeriesFile({ ...v1, version: 1 })).toEqual({ ...valid, volumes: [] });
  });

  it('normalizes and clamps updated_at', () => {
    expect(
      parseSeriesFile({ ...valid, updated_at: 'Aug 16 2020 00:00:00 GMT+0000' })?.updated_at
    ).toBe('2020-08-16T00:00:00.000Z');
    const clamped = parseSeriesFile({ ...valid, updated_at: '2999-01-01T00:00:00.000Z' })!;
    expect(Date.parse(clamped.updated_at)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('sanitizes the facts', () => {
    const parsed = parseSeriesFile({
      ...valid,
      external_ids: { anilist: 30013, mal: -1, kitsu: 5 },
      titles: { english: 'One Piece', klingon: 'nope', romaji: '  ' },
      synonyms: ['ok', '', 42],
      tag: '   ',
      unit: 'tankobon'
    })!;
    expect(parsed.external_ids).toEqual({ anilist: 30013 });
    expect(parsed.titles).toEqual({ english: 'One Piece' });
    expect(parsed.synonyms).toEqual(['ok']);
    expect('tag' in parsed).toBe(false);
    // An unknown unit is "nobody has corrected it", not a third unit.
    expect('unit' in parsed).toBe(false);
  });

  it('keeps a known unit', () => {
    expect(parseSeriesFile({ ...valid, unit: 'chapters' })?.unit).toBe('chapters');
    expect(parseSeriesFile({ ...valid, unit: 'volumes' })?.unit).toBe('volumes');
  });

  it('drops bad volume entries and keeps the good ones', () => {
    const parsed = parseSeriesFile({
      ...valid,
      volumes: [
        ...valid.volumes,
        'garbage',
        null,
        { volume_title: 'No uuid', page_count: 1, character_count: 1 },
        { ...valid.volumes[0], volume_uuid: 'v', volume_title: '   ' },
        { ...valid.volumes[0], volume_uuid: 'v', page_count: -1 },
        { ...valid.volumes[0], volume_uuid: 'v', page_count: 1.5 },
        { ...valid.volumes[0], volume_uuid: 'v', character_count: 'lots' },
        { ...valid.volumes[0], volume_uuid: 'v', mokuro_version: 3 },
        {
          volume_uuid: 'vol-2',
          volume_title: 'Vol 2',
          page_count: 0,
          character_count: 0,
          mokuro_version: '',
          spine_width: 'wide',
          thumbnail: 'nope'
        }
      ]
    })!;
    expect(parsed.volumes).toEqual([
      valid.volumes[0],
      {
        volume_uuid: 'vol-2',
        volume_title: 'Vol 2',
        page_count: 0,
        character_count: 0,
        mokuro_version: ''
      }
    ]);
  });

  it('drops an archive_size that is not a positive whole number of bytes', () => {
    for (const size of [0, -1, 1.5, Infinity, '184MB', null]) {
      const parsed = parseSeriesFile({
        ...valid,
        volumes: [{ ...valid.volumes[0], archive_size: size }]
      })!;
      expect('archive_size' in parsed.volumes[0]).toBe(false);
    }
    const kept = parseSeriesFile({
      ...valid,
      volumes: [{ ...valid.volumes[0], archive_size: 1 }]
    })!;
    expect(kept.volumes[0].archive_size).toBe(1);
  });

  it('ignores a legacy page_char_counts array instead of carrying it into the cache', () => {
    const parsed = parseSeriesFile({
      ...valid,
      volumes: [{ ...valid.volumes[0], page_char_counts: [10, 20, 30] }]
    })!;
    expect(parsed.volumes).toHaveLength(1);
    expect('page_char_counts' in parsed.volumes[0]).toBe(false);
  });

  it('treats a non-array volumes field as an empty index', () => {
    expect(parseSeriesFile({ ...valid, volumes: 'nope' })?.volumes).toEqual([]);
  });

  it('round-trips what buildSeriesFile writes', () => {
    const built = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: linkedMeta(),
      localVolumes: [
        volume({ spine_width: 17, archive_size: 193_000_000 }),
        volume({ volume_uuid: 'vol-2', volume_title: 'Vol 2' }),
        volume({ volume_uuid: 'vol-3', volume_title: 'Vol 3', spine_width: 0, archive_size: 0 })
      ]
    })!;
    expect(parseSeriesFile(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });
});

describe('isSeriesFilePath', () => {
  it('matches series.json anywhere, case-insensitively', () => {
    expect(SERIES_FILE_NAME).toBe('series.json');
    expect(isSeriesFilePath('series.json')).toBe(true);
    expect(isSeriesFilePath('One Piece/series.json')).toBe(true);
    expect(isSeriesFilePath('mokuro/One Piece/Series.JSON')).toBe(true);
    expect(isSeriesFilePath('One Piece\\series.json')).toBe(true);
    expect(isSeriesFilePath('One Piece/series-metadata.json')).toBe(false);
    expect(isSeriesFilePath('One Piece/series.json.bak')).toBe(false);
    expect(isSeriesFilePath('series.json/')).toBe(false);
    expect(isSeriesFilePath('')).toBe(false);
  });
});

describe('the tracking unit as a shared fact', () => {
  it('round-trips through build → JSON → parse', () => {
    const built = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: { ...linkedMeta(), unit: 'chapters' },
      localVolumes: [volume()]
    })!;
    expect(built.unit).toBe('chapters');
    expect(parseSeriesFile(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  it('is worth publishing on its own', () => {
    // Nobody linked the series, but somebody corrected its unit: that is a fact
    // about the archives and the next device should not have to guess again.
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: {
        ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
        unit: 'chapters',
        facts_updated_at: '2026-08-16T00:00:00.000Z'
      },
      localVolumes: []
    })!;
    expect(file.unit).toBe('chapters');
    expect(file.updated_at).toBe('2026-08-16T00:00:00.000Z');
  });

  it('takes the unit from whichever side wins the facts comparison', () => {
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: { anilist: 30013 },
      titles: {},
      synonyms: [],
      unit: 'volumes',
      updated_at: '2026-08-17T00:00:00.000Z',
      volumes: []
    };
    // Older local facts lose: the published unit is carried through untouched.
    expect(
      buildSeriesFile({
        seriesTitle: 'One Piece',
        meta: { ...linkedMeta(), unit: 'chapters' },
        localVolumes: [],
        existing
      })!.unit
    ).toBe('volumes');
    // Newer local facts win, and clearing the unit locally clears it in the file.
    expect(
      buildSeriesFile({
        seriesTitle: 'One Piece',
        meta: {
          ...linkedMeta(),
          updated_at: '2026-08-18T00:00:00.000Z',
          facts_updated_at: '2026-08-18T00:00:00.000Z'
        },
        localVolumes: [],
        existing
      })!.unit
    ).toBeUndefined();
  });

  it('drops the unit when a factless file wins the cache merge', () => {
    const withUnit: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      unit: 'chapters',
      updated_at: '2026-08-16T00:00:00.000Z',
      volumes: []
    };
    const newer: SeriesFile = { ...withUnit, updated_at: '2026-08-18T00:00:00.000Z' };
    delete newer.unit;
    expect(mergeSeriesFileForCache('One Piece', newer, withUnit).unit).toBeUndefined();
    expect(mergeSeriesFileForCache('One Piece', withUnit, newer).unit).toBeUndefined();
  });
});
