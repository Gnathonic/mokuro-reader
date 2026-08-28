import { describe, expect, it } from 'vitest';
import {
  FACTLESS_UPDATED_AT,
  SERIES_FILE_NAME,
  buildSeriesFile,
  entryMokuroVersion,
  isMetadataLessEntry,
  isSeriesFilePath,
  mergeSeriesFileForCache,
  orderVolumeEntryFields,
  parseSeriesFile,
  parseSeriesFileWithReport,
  seriesFileHealDifference,
  stringifySeriesFile,
  volumeToIndexEntry,
  type SeriesFile,
  type SeriesFileVolume
} from './series-file';
import { normalizeVolumeTitleKey } from './series-key';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
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

/**
 * Display data and a per-series title preference, as an older version of the app
 * stored them. No migration ran, so a record linked back then still carries these
 * keys in IndexedDB — and none of them may reach the shared file.
 */
const LEGACY_RECORD_FIELDS = {
  format: 'MANGA',
  status: 'RELEASING',
  total_volumes: 110,
  cover_url: 'https://img/op.jpg',
  title_preference: 'native'
};

function linkedMeta(): SeriesMetadata {
  return {
    ...createEmptySeriesMetadata('One Piece', '2026-08-16T00:00:00.000Z'),
    external_ids: { anilist: 30013, mal: 13 },
    titles: { native: 'ONE PIECE', romaji: 'ONE PIECE', english: 'One Piece' },
    synonyms: ['ワンピース'],
    tag: '[color]',
    spine_offset: 12,
    volume_offsets: { 'vol-1': 4 },
    ...LEGACY_RECORD_FIELDS
  } as unknown as SeriesMetadata;
}

/**
 * The path a published file actually takes to a reader: the same
 * serialize → parse that `readCloudSeriesFile` performs — including the
 * parse-time HEAL of doubled entries. Fixtures for anything `existing`-shaped
 * should come through here rather than be hand-built, so a test exercises
 * what the healer really hands the build instead of a state that cannot
 * reach it.
 */
function roundTrip(file: SeriesFile): SeriesFile {
  return parseSeriesFile(JSON.parse(stringifySeriesFile(file)))!;
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
      // Index data, published on purpose — the shelf alignment describes the
      // archives' cover geometry, not the reader (see the offsets suite below).
      spine_offset: 12,
      volumes: []
    });
    const json = JSON.stringify(file);
    for (const forbidden of [
      'tracking',
      'read_count',
      'title_preference',
      'reread_prompt_suppressed',
      // The local uuid→px map never rides the file; per-entry `offset` does.
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
    // The catalog writes spine offsets on records that were never linked here;
    // those writes bump `updated_at`, which must not read as "this series was
    // just unlinked" on every other device.
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
      spine_offset: 12
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

describe('buildSeriesFile and a published archive_size', () => {
  function published(entry: Partial<import('./series-file').SeriesFileVolume> = {}): SeriesFile {
    return {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-08-16T00:00:00.000Z',
      volumes: [
        {
          volume_uuid: 'vol-1',
          volume_title: 'Vol 1',
          page_count: 2,
          character_count: 123,
          mokuro_version: '0.2.1',
          archive_size: 193_000_000,
          ...entry
        }
      ]
    };
  }

  it('keeps the size the file already carries when the local row has none', () => {
    // A locally imported volume was never uploaded or downloaded here, so its
    // row has no size — that is a gap, not a correction of what another device
    // measured. The installed row still wins for everything it does know.
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: linkedMeta(),
      localVolumes: [volume({ character_count: 999 })],
      existing: published()
    })!;

    expect(file.volumes[0].archive_size).toBe(193_000_000);
    expect(file.volumes[0].character_count).toBe(999);
  });

  it('lets a measured size replace the published one', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: linkedMeta(),
      localVolumes: [volume({ archive_size: 7 })],
      existing: published()
    })!;

    expect(file.volumes[0].archive_size).toBe(7);
  });
});

describe('buildSeriesFile and cloudMeasuredVolumes (the sidecar backfill)', () => {
  function published(): SeriesFile {
    return {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-08-16T00:00:00.000Z',
      volumes: [
        {
          volume_uuid: 'vol-1',
          volume_title: 'Vol 1',
          page_count: 5,
          character_count: 50,
          mokuro_version: '0.4.0'
        }
      ]
    };
  }

  it('overrides a stale published entry for the same uuid', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [],
      existing: published(),
      cloudMeasuredVolumes: [
        {
          volume_uuid: 'vol-1',
          volume_title: 'Vol 1',
          page_count: 300,
          character_count: 9000,
          mokuro_version: '0.4.12'
        }
      ]
    })!;
    expect(file.volumes).toEqual([
      {
        volume_uuid: 'vol-1',
        volume_title: 'Vol 1',
        page_count: 300,
        character_count: 9000,
        mokuro_version: '0.4.12'
      }
    ]);
  });

  it('retires the stale entry by folded title when a re-OCR minted a new uuid', () => {
    // A re-upload can change `volume_uuid`. Without a title-based retirement
    // the archive would show up TWICE: once under the old (stale) uuid and
    // once under the fresh one.
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [],
      existing: published(),
      cloudMeasuredVolumes: [
        {
          volume_uuid: 'vol-1-reocr',
          volume_title: 'Vol 1',
          page_count: 300,
          character_count: 9000,
          mokuro_version: '0.4.12'
        }
      ]
    })!;
    expect(file.volumes).toHaveLength(1);
    expect(file.volumes[0].volume_uuid).toBe('vol-1-reocr');
  });

  it('fills a genuine gap the published index had no entry for', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [],
      existing: published(),
      cloudMeasuredVolumes: [
        {
          volume_uuid: 'vol-2',
          volume_title: 'Vol 2',
          page_count: 10,
          character_count: 200,
          mokuro_version: '0.4.12'
        }
      ]
    })!;
    expect(file.volumes.map((v) => v.volume_uuid).sort()).toEqual(['vol-1', 'vol-2']);
  });

  it('still loses to an INSTALLED row for the same volume', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume({ character_count: 42 })], // installed, measured here
      existing: published(),
      cloudMeasuredVolumes: [
        {
          volume_uuid: 'vol-1',
          volume_title: 'Vol 1',
          page_count: 300,
          character_count: 9000,
          mokuro_version: '0.4.12'
        }
      ]
    })!;
    expect(file.volumes).toEqual([
      {
        volume_uuid: 'vol-1',
        volume_title: 'Vol 1',
        page_count: 2,
        character_count: 42,
        mokuro_version: '0.2.1'
      }
    ]);
  });
});

describe('buildSeriesFile and cloudSidecarStamps (installed rows)', () => {
  it('stamps an installed entry from the listing snapshot when it has one', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume()],
      cloudSidecarStamps: new Map([
        [
          'vol 1',
          {
            mokuro_size: 4096,
            mokuro_modified: 1_700_000_000,
            cover_size: 512,
            cover_modified: 1_700_000_100
          }
        ]
      ])
    })!;
    expect(file.volumes[0]).toMatchObject({
      mokuro_size: 4096,
      mokuro_modified: 1_700_000_000,
      cover_size: 512,
      cover_modified: 1_700_000_100
    });
  });

  it('leaves the stamps absent when the listing has nothing for that title', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume()],
      cloudSidecarStamps: new Map()
    })!;
    expect(file.volumes[0].mokuro_size).toBeUndefined();
    expect(file.volumes[0].mokuro_modified).toBeUndefined();
  });

  function publishedWithStamps(): SeriesFile {
    return roundTrip({
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
          page_count: 2,
          character_count: 123,
          mokuro_version: '0.2.1',
          mokuro_size: 999,
          mokuro_modified: 1
        }
      ]
    });
  }

  it('prefers the listing snapshot over the stamps of the entry it displaces', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume()],
      existing: publishedWithStamps(),
      cloudSidecarStamps: new Map([
        ['vol 1', { mokuro_size: 4096, mokuro_modified: 1_700_000_000 }]
      ])
    })!;
    expect(file.volumes[0].mokuro_size).toBe(4096);
    expect(file.volumes[0].mokuro_modified).toBe(1_700_000_000);
  });

  it("inherits the displaced entry's stamps when no listing snapshot is available", () => {
    // Publishing STAMPLESS would be strictly worse than publishing a
    // possibly-behind stamp: a stampless entry is never stale
    // (`isSidecarStale`), so staleness detection for the volume would never
    // fire again on any device — while a behind stamp just triggers one
    // self-correcting re-verify when the sidecar next moves. So with no
    // listing to consult, the displaced entry's stamps ride through on the
    // installed row, by the same merger inheritance that preserves
    // `archive_size`.
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume()],
      existing: publishedWithStamps()
      // No cloudSidecarStamps passed — the listing is not available here.
    })!;
    expect(file.volumes[0].mokuro_size).toBe(999);
    expect(file.volumes[0].mokuro_modified).toBe(1);
  });
});

describe('the volume-entry wire order (bunko parity contract)', () => {
  // docs/superpowers/plans/2026-08-23-catalog-distribution-bunko.md §2 pins the
  // exact key order the server compiler emits: volume_uuid, volume_title,
  // page_count, character_count, mokuro_version, spine_width?, archive_size?,
  // mokuro_size?, mokuro_modified?, cover_size?, cover_modified?, offset?. The
  // reader's writer must match byte-for-byte since `stringifySeriesFile` is a
  // plain `JSON.stringify` (key-insertion order).
  it('serializes an entry carrying every optional field in the pinned order', () => {
    const entry = orderVolumeEntryFields({
      // Deliberately scrambled insertion order going IN, to prove the
      // assembler — not incidental call-site ordering — is what pins the
      // output.
      offset: 25,
      cover_modified: 1_700_000_400,
      cover_size: 512,
      mokuro_modified: 1_700_000_100,
      mokuro_size: 4096,
      archive_size: 193_000_000,
      spine_width: 17,
      mokuro_version: '0.4.12',
      character_count: 9000,
      page_count: 300,
      volume_title: 'Vol 1',
      volume_uuid: 'vol-1'
    });

    const file: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-08-24T00:00:00.000Z',
      volumes: [entry]
    };

    expect(stringifySeriesFile(file)).toBe(
      '{"version":2,"series_title":"One Piece","external_ids":{},"titles":{},"synonyms":[],' +
        '"updated_at":"2026-08-24T00:00:00.000Z","volumes":[{"volume_uuid":"vol-1",' +
        '"volume_title":"Vol 1","page_count":300,"character_count":9000,' +
        '"mokuro_version":"0.4.12","spine_width":17,"archive_size":193000000,' +
        '"mokuro_size":4096,"mokuro_modified":1700000100,"cover_size":512,' +
        '"cover_modified":1700000400,"offset":25}]}'
    );
  });

  it('keeps the pinned order for an entry a real file parses into', () => {
    const parsed = parseSeriesFile({
      version: 2,
      series_title: 'S',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-08-24T00:00:00.000Z',
      volumes: [
        {
          volume_uuid: 'v1',
          volume_title: 'V1',
          page_count: 1,
          character_count: 1,
          mokuro_version: '0.4.0',
          spine_width: 10,
          archive_size: 100,
          mokuro_size: 200,
          mokuro_modified: 300,
          cover_size: 400,
          cover_modified: 500,
          offset: 5
        }
      ]
    })!;
    expect(Object.keys(parsed.volumes[0])).toEqual([
      'volume_uuid',
      'volume_title',
      'page_count',
      'character_count',
      'mokuro_version',
      'spine_width',
      'archive_size',
      'mokuro_size',
      'mokuro_modified',
      'cover_size',
      'cover_modified',
      'offset'
    ]);
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

  it('round-trips the sidecar freshness stamps (mokuro_size/modified, cover_size/modified)', () => {
    const stamped = {
      ...valid.volumes[0],
      mokuro_size: 4096,
      mokuro_modified: 1_700_000_000,
      cover_size: 512,
      cover_modified: 1_700_000_100
    };
    const parsed = parseSeriesFile({ ...valid, volumes: [stamped] })!;
    expect(parsed.volumes[0]).toEqual(stamped);
  });

  it('drops junk or absent stamps instead of inventing a value', () => {
    for (const bad of [-1, 1.5, Infinity, 'now', null]) {
      const parsed = parseSeriesFile({
        ...valid,
        volumes: [
          {
            ...valid.volumes[0],
            mokuro_size: bad,
            mokuro_modified: bad,
            cover_size: bad,
            cover_modified: bad
          }
        ]
      })!;
      expect('mokuro_size' in parsed.volumes[0]).toBe(false);
      expect('mokuro_modified' in parsed.volumes[0]).toBe(false);
      expect('cover_size' in parsed.volumes[0]).toBe(false);
      expect('cover_modified' in parsed.volumes[0]).toBe(false);
    }
    // 0 is a valid epoch-seconds stamp (the unix epoch) even though it is not
    // a valid SIZE — the two guards are deliberately different.
    const zeroModified = parseSeriesFile({
      ...valid,
      volumes: [{ ...valid.volumes[0], mokuro_modified: 0 }]
    })!;
    expect(zeroModified.volumes[0].mokuro_modified).toBe(0);
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
    expect(isSeriesFilePath('One Piece/my-series.json')).toBe(false);
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

describe('spine offsets in series.json', () => {
  const meta = (partial: Partial<SeriesMetadata> = {}): SeriesMetadata => ({
    ...createEmptySeriesMetadata('One Piece'),
    ...partial
  });

  it('publishes the local shelf alignment as index data, not as facts', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: meta({ spine_offset: 12, volume_offsets: { 'vol-1': -30 } }),
      localVolumes: [volume()]
    })!;

    expect(file.spine_offset).toBe(12);
    expect(file.volumes[0].offset).toBe(-30);
    // Offsets are not facts: an offsets-only record still publishes nothing to
    // outrank anybody's link.
    expect(file.updated_at).toBe(FACTLESS_UPDATED_AT);
  });

  it('carries the published alignment through when this library has none', () => {
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT,
      spine_offset: 8,
      volumes: [{ ...volumeToIndexEntry(volume()), offset: 25 }]
    };

    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: meta(),
      localVolumes: [volume()],
      existing
    })!;

    expect(file.spine_offset).toBe(8);
    expect(file.volumes[0].offset).toBe(25);
  });

  it('lets a local reset (an explicit 0) clear the published alignment', () => {
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT,
      spine_offset: 8,
      volumes: [{ ...volumeToIndexEntry(volume()), offset: 25 }]
    };

    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: meta({ spine_offset: 0, volume_offsets: { 'vol-1': 0 } }),
      localVolumes: [volume()],
      existing
    })!;

    expect('spine_offset' in file).toBe(false);
    expect('offset' in file.volumes[0]).toBe(false);
  });

  it('round-trips offsets through stringify → parse and drops junk', () => {
    const built = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: meta({ spine_offset: 12, volume_offsets: { 'vol-1': -30 } }),
      localVolumes: [volume()]
    })!;

    expect(parseSeriesFile(JSON.parse(stringifySeriesFile(built)))).toEqual(built);

    const junk = parseSeriesFile({
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-08-23T00:00:00.000Z',
      spine_offset: 9999,
      volumes: [{ ...volumeToIndexEntry(volume()), offset: 'nope' }]
    })!;

    expect(junk.spine_offset).toBe(50); // clamped to SPINE_OFFSET_LIMIT
    expect('offset' in junk.volumes[0]).toBe(false);
  });

  const cachedFile = (partial: Partial<SeriesFile> = {}): SeriesFile => ({
    version: 2,
    series_title: 'One Piece',
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at: '2026-08-01T00:00:00.000Z',
    volumes: [],
    ...partial
  });

  it("takes the winning side's alignment when caching an imported file", () => {
    const cached = cachedFile({ spine_offset: 5 });
    const arriving = cachedFile({
      updated_at: '2026-08-20T00:00:00.000Z',
      spine_offset: 12,
      volumes: [{ ...volumeToIndexEntry(volume()), offset: 11 }]
    });

    const merged = mergeSeriesFileForCache('One Piece', arriving, cached);

    expect(merged.spine_offset).toBe(12);
    expect(merged.volumes[0].offset).toBe(11);
  });

  it('inherits the alignment of the losing side when the winner has no opinion', () => {
    // The alignment is index data, so it does NOT follow the facts clock: an
    // arriving file that simply never measured a nudge must not erase one the
    // cached copy holds. Absent = no opinion = inherit, as everywhere else.
    const cached = cachedFile({
      spine_offset: 5,
      volumes: [{ ...volumeToIndexEntry(volume()), offset: 7 }]
    });
    const arriving = cachedFile({ updated_at: '2026-08-20T00:00:00.000Z' });

    const merged = mergeSeriesFileForCache('One Piece', arriving, cached);

    expect(merged.spine_offset).toBe(5);
    // The cached volume entry is untouched — the arriving file lists no volumes.
    expect(merged.volumes[0].offset).toBe(7);
  });

  it('inherits the alignment when the LOSER is the arriving file', () => {
    // Same rule with the sides swapped: the cached copy wins on the stamp but
    // has no alignment, so the older import's rides through.
    const cached = cachedFile({ updated_at: '2026-08-20T00:00:00.000Z' });
    const arriving = cachedFile({ spine_offset: 9 });

    expect(mergeSeriesFileForCache('One Piece', arriving, cached).spine_offset).toBe(9);
  });
});

describe('the published facts stamp never moves backwards', () => {
  const factlessFile = (updated_at: string): SeriesFile => ({
    version: 2,
    series_title: 'One Piece',
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at,
    volumes: []
  });

  const factlessMeta = (factsStamp: string): SeriesMetadata => ({
    ...createEmptySeriesMetadata('One Piece', '2026-09-01T00:00:00.000Z'),
    facts_updated_at: factsStamp
  });

  it('keeps the published stamp when neither side has facts and ours is older', () => {
    // Belt and braces for the relay: even if a device somehow still holds the
    // older clock, WRITING the file must not lower the stamp already published —
    // that is what strands somebody else's unlink.
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: factlessMeta('2026-01-01T00:00:00.000Z'),
      localVolumes: [volume()],
      existing: factlessFile('2026-02-01T00:00:00.000Z')
    })!;

    expect(file.updated_at).toBe('2026-02-01T00:00:00.000Z');
  });

  it('publishes our own factless stamp when it is the newer one', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: factlessMeta('2026-03-01T00:00:00.000Z'),
      localVolumes: [volume()],
      existing: factlessFile('2026-02-01T00:00:00.000Z')
    })!;

    expect(file.updated_at).toBe('2026-03-01T00:00:00.000Z');
  });

  it('does not let a stale local link lower a newer published unlink', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: {
        ...createEmptySeriesMetadata('One Piece', '2026-09-01T00:00:00.000Z'),
        external_ids: { anilist: 30013 },
        facts_updated_at: '2026-01-01T00:00:00.000Z'
      },
      localVolumes: [volume()],
      existing: factlessFile('2026-02-01T00:00:00.000Z')
    })!;

    expect(file.updated_at).toBe('2026-02-01T00:00:00.000Z');
    expect(file.external_ids).toEqual({});
  });
});

describe('either-key volume identity (uuid OR folded title) — the doubled-entry fix', () => {
  /**
   * A no-metadata entry exactly as `buildNoMetadataEntry` mints one: the uuid
   * DERIVED from `<series>/<volume>` (the archive was listed but its `.mokuro`
   * was never read), zero counts, no version.
   */
  function placeholderEntry(
    volumeTitle: string,
    extra: Partial<SeriesFileVolume> = {}
  ): SeriesFileVolume {
    return {
      volume_uuid: generateDeterministicUUID(`One Piece/${volumeTitle}`),
      volume_title: volumeTitle,
      page_count: 0,
      character_count: 0,
      mokuro_version: '',
      ...extra
    };
  }

  function realEntry(
    volumeUuid: string,
    volumeTitle: string,
    extra: Partial<SeriesFileVolume> = {}
  ): SeriesFileVolume {
    return {
      volume_uuid: volumeUuid,
      volume_title: volumeTitle,
      page_count: 180,
      character_count: 9000,
      mokuro_version: '0.4.12',
      ...extra
    };
  }

  function fileWith(volumes: SeriesFileVolume[]): SeriesFile {
    return {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-01-01T00:00:00.000Z',
      volumes
    };
  }

  /** The user-stated invariant, asserted directly: unique on BOTH keys independently. */
  function expectUniqueOnBothKeys(volumes: SeriesFileVolume[]): void {
    const uuids = volumes.map((v) => v.volume_uuid);
    const titleKeys = volumes.map((v) => normalizeVolumeTitleKey(v.volume_title));
    expect(new Set(uuids).size).toBe(volumes.length);
    expect(new Set(titleKeys).size).toBe(volumes.length);
  }

  it('classifies a derived-uuid zero-content entry as no-metadata, and nothing else', () => {
    expect(isMetadataLessEntry('One Piece', placeholderEntry('Vol 1'))).toBe(true);
    // A real mokuro-derived uuid, even with zero content, is not a placeholder.
    expect(
      isMetadataLessEntry('One Piece', {
        volume_uuid: 'real-uuid',
        volume_title: 'Vol 1',
        page_count: 0,
        character_count: 0,
        mokuro_version: ''
      })
    ).toBe(false);
    // An installed IMAGE-ONLY volume also carries the derived uuid (it has no
    // mokuro to name it) but its pages were measured — real, not a placeholder.
    expect(
      isMetadataLessEntry('One Piece', {
        volume_uuid: generateDeterministicUUID('One Piece/Vol 1'),
        volume_title: 'Vol 1',
        page_count: 42,
        character_count: 0,
        mokuro_version: ''
      })
    ).toBe(false);
  });

  it('REPLACES the published no-metadata entry when the installed row brings the real uuid', () => {
    // The reported bug: the placeholder was minted with a derived uuid, the
    // real entry carries the mokuro's own uuid, and a merge keyed by uuid
    // alone kept BOTH. The folded title is the join.
    const existing = roundTrip(
      fileWith([placeholderEntry('Vol 1', { archive_size: 193_000_000 })])
    );
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume()], // installed, volume_uuid 'vol-1', title 'Vol 1'
      existing
    })!;

    expect(file.volumes).toHaveLength(1);
    expect(file.volumes[0]).toMatchObject({
      volume_uuid: 'vol-1',
      volume_title: 'Vol 1',
      page_count: 2,
      character_count: 123,
      mokuro_version: '0.2.1',
      // Inherited across the uuid change: the placeholder learned the archive
      // size from the listing, and the installed row (imported from disk)
      // has no way to know it.
      archive_size: 193_000_000
    });
  });

  it('lets a metadata-only row replace a published no-metadata entry for the same file', () => {
    // The row was measured from a real mokuro once (when it WAS installed);
    // the placeholder never was. Real beats no-metadata even for a fill-rank
    // row — this is the one published thing a metadata-only row may override.
    const existing = fileWith([placeholderEntry('Vol 1')]);
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume({ metadata_only: true })],
      existing
    })!;

    expect(file.volumes).toHaveLength(1);
    expect(file.volumes[0].volume_uuid).toBe('vol-1');
  });

  it('heals an already-doubled published file on the next build, in either order', () => {
    for (const doubled of [
      [placeholderEntry('Vol 1'), realEntry('vol-1-real', 'Vol 1')],
      [realEntry('vol-1-real', 'Vol 1'), placeholderEntry('Vol 1')]
    ]) {
      const file = buildSeriesFile({
        seriesTitle: 'One Piece',
        meta: undefined,
        localVolumes: [],
        existing: fileWith(doubled)
      })!;

      expect(file.volumes).toHaveLength(1);
      expect(file.volumes[0].volume_uuid).toBe('vol-1-real');
    }
  });

  it('parseSeriesFile collapses a doubled file so every reader sees one entry per volume', () => {
    for (const doubled of [
      [placeholderEntry('Vol 1'), realEntry('vol-1-real', 'Vol 1')],
      [realEntry('vol-1-real', 'Vol 1'), placeholderEntry('Vol 1')]
    ]) {
      const parsed = parseSeriesFile(JSON.parse(stringifySeriesFile(fileWith(doubled))))!;
      expect(parsed.volumes).toHaveLength(1);
      expect(parsed.volumes[0].volume_uuid).toBe('vol-1-real');
    }
  });

  it('never lets two REAL entries survive on one title — the installed row wins', () => {
    // A re-OCR minted a new uuid for the same archive; the published entry
    // still carries the old one. Both are real, so the winner is rank order:
    // the row measured on this device.
    const existing = fileWith([realEntry('vol-1-old', 'Vol 1')]);
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume({ volume_uuid: 'vol-1-new' })],
      existing
    })!;

    expect(file.volumes).toHaveLength(1);
    expect(file.volumes[0].volume_uuid).toBe('vol-1-new');
  });

  it('never lets a no-metadata rebuild claw back a real published entry', () => {
    // The backfill re-listed an archive whose `.mokuro` sidecar has vanished
    // and built an image-only entry for it. The published entry's counts were
    // measured from a real mokuro; zero knowledge must not overwrite them.
    const existing = fileWith([realEntry('vol-1-real', 'Vol 1')]);
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [],
      existing,
      cloudMeasuredVolumes: [placeholderEntry('Vol 1', { archive_size: 5 })]
    })!;

    // The measured CONTENT is protected — but the file fact the rebuild
    // carried (the archive's currently-listed byte size) still lands on the
    // surviving entry via the merger's field inheritance.
    expect(file.volumes).toEqual([{ ...realEntry('vol-1-real', 'Vol 1'), archive_size: 5 }]);
  });

  it('treats a RENAMED file as the same volume: uuid matches, the new title wins', () => {
    // The user renamed the archive; the mokuro inside (and so the uuid) is
    // unchanged. One volume, and the entry follows the current filename.
    const existing = fileWith([realEntry('vol-1', 'Old Name')]);
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume({ volume_title: 'New Name' })], // volume_uuid 'vol-1'
      existing,
      cloudVolumeTitles: new Set(['New Name'])
    })!;

    expect(file.volumes).toHaveLength(1);
    expect(file.volumes[0]).toMatchObject({ volume_uuid: 'vol-1', volume_title: 'New Name' });
  });

  it('collapses BOTH matches when a rename lands on a squatted title (multi-match)', () => {
    // The incoming installed row matches entry A by uuid (the pre-rename
    // entry) AND entry B by title (the no-metadata placeholder that was
    // minted for the new filename before anyone read its mokuro). All three
    // must collapse into ONE entry carrying the real uuid, the new title and
    // the measured metadata.
    const existing = fileWith([
      realEntry('vol-1', 'Old Name'),
      placeholderEntry('New Name', { archive_size: 7 })
    ]);
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume({ volume_title: 'New Name' })], // volume_uuid 'vol-1'
      existing,
      cloudVolumeTitles: new Set(['New Name'])
    })!;

    expect(file.volumes).toHaveLength(1);
    expect(file.volumes[0]).toMatchObject({
      volume_uuid: 'vol-1',
      volume_title: 'New Name',
      page_count: 2,
      character_count: 123
    });
    expectUniqueOnBothKeys(file.volumes);
  });

  it('heals a published file carrying an old-title AND a new-title entry for one uuid', () => {
    // Both entries are real and there is no listing to consult at parse time,
    // so the collapse just has to be deterministic and single: the first
    // entry wins a pure tie, and the next build (which has the listing and
    // the local rows) settles the title for good.
    const parsed = parseSeriesFile(
      JSON.parse(
        stringifySeriesFile(
          fileWith([realEntry('vol-1', 'Old Name'), realEntry('vol-1', 'New Name')])
        )
      )
    )!;

    expect(parsed.volumes).toHaveLength(1);
    expect(parsed.volumes[0].volume_title).toBe('Old Name');
  });

  it('caching an import replaces the cached no-metadata entry — and never the reverse', () => {
    // Arriving real entry supersedes the cached placeholder for the same file...
    const healed = mergeSeriesFileForCache(
      'One Piece',
      fileWith([realEntry('vol-1-real', 'Vol 1')]),
      fileWith([placeholderEntry('Vol 1')])
    );
    expect(healed.volumes).toHaveLength(1);
    expect(healed.volumes[0].volume_uuid).toBe('vol-1-real');

    // ...and an arriving placeholder must not claw back the cached real entry,
    // even though the arriving file wins ties.
    const kept = mergeSeriesFileForCache(
      'One Piece',
      fileWith([placeholderEntry('Vol 1')]),
      fileWith([realEntry('vol-1-real', 'Vol 1')])
    );
    expect(kept.volumes).toHaveLength(1);
    expect(kept.volumes[0].volume_uuid).toBe('vol-1-real');
  });

  it('holds the uniqueness invariant across a worst-case mixed merge', () => {
    // A doubled existing file, a re-OCR'd pulled sidecar, a renamed installed
    // row and a metadata-only fill all at once: whatever wins, no two
    // surviving entries may share a uuid or a folded title.
    const existing = fileWith([
      placeholderEntry('Vol 1'),
      realEntry('vol-1-old', 'Vol 1'),
      realEntry('vol-2', 'Old Vol 2 Name'),
      placeholderEntry('Vol 3')
    ]);
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [
        volume({ volume_uuid: 'vol-2', volume_title: 'Vol 2' }), // renamed, installed
        volume({ volume_uuid: 'vol-3-real', volume_title: 'Vol 3', metadata_only: true })
      ],
      existing,
      cloudMeasuredVolumes: [realEntry('vol-1-reocr', 'Vol 1')]
    })!;

    expectUniqueOnBothKeys(file.volumes);
    expect(file.volumes.map((v) => v.volume_uuid).sort()).toEqual([
      'vol-1-reocr',
      'vol-2',
      'vol-3-real'
    ]);
  });

  it("carries the superseded entry's shelf nudge across the uuid change", () => {
    // The offset describes the archive's cover geometry; when the real entry
    // replaces the no-metadata one for the same file, the nudge follows the
    // file instead of dying with the derived uuid.
    const existing = roundTrip(fileWith([placeholderEntry('Vol 1', { offset: 5 })]));
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume()],
      existing
    })!;

    expect(file.volumes).toHaveLength(1);
    expect(file.volumes[0]).toMatchObject({ volume_uuid: 'vol-1', offset: 5 });
  });

  it('still publishes archive_size, offset and cover stamps after the read healer collapsed a doubled file', () => {
    // The REAL path to `existing` is readCloudSeriesFile → parseSeriesFile,
    // and the parse HEALS the doubled file before buildSeriesFile ever sees
    // it — a hand-built doubled `existing` fed straight to the build would
    // pass even if that collapse destroyed these fields. The rescue must live
    // inside the collapse itself, so this fixture takes the real
    // serialize → parse path first.
    const facts = {
      archive_size: 193_000_000,
      cover_size: 512,
      cover_modified: 1_700_000_100,
      offset: 5
    };
    for (const doubled of [
      [realEntry('vol-1', 'Vol 1'), placeholderEntry('Vol 1', facts)],
      [placeholderEntry('Vol 1', facts), realEntry('vol-1', 'Vol 1')]
    ]) {
      const existing = roundTrip(fileWith(doubled));
      const file = buildSeriesFile({
        seriesTitle: 'One Piece',
        meta: undefined,
        localVolumes: [],
        existing
      })!;

      expect(file.volumes).toHaveLength(1);
      expect(file.volumes[0]).toMatchObject({
        volume_uuid: 'vol-1',
        volume_title: 'Vol 1',
        page_count: 180,
        archive_size: 193_000_000,
        cover_size: 512,
        cover_modified: 1_700_000_100,
        offset: 5
      });
    }
  });

  it('an installed row publishing over the parse-healed file keeps the inherited facts', () => {
    const existing = roundTrip(
      fileWith([
        placeholderEntry('Vol 1', { archive_size: 193_000_000, offset: 5 }),
        realEntry('vol-1', 'Vol 1')
      ])
    );
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [volume()], // installed vol-1 'Vol 1'; never measured its archive
      existing
    })!;

    expect(file.volumes).toHaveLength(1);
    expect(file.volumes[0]).toMatchObject({
      volume_uuid: 'vol-1',
      character_count: 123,
      archive_size: 193_000_000,
      offset: 5
    });
  });

  it("caching an import keeps the cached entry's file facts on the arriving winner", () => {
    // The same gap, cache flavor: the arriving real entry supersedes the
    // cached placeholder, and the placeholder's archive size and shelf nudge
    // follow the FILE onto the winner instead of dying with the derived uuid.
    const merged = mergeSeriesFileForCache(
      'One Piece',
      roundTrip(fileWith([realEntry('vol-1-real', 'Vol 1')])),
      roundTrip(fileWith([placeholderEntry('Vol 1', { archive_size: 7, offset: 3 })]))
    );

    expect(merged.volumes).toHaveLength(1);
    expect(merged.volumes[0]).toMatchObject({
      volume_uuid: 'vol-1-real',
      archive_size: 7,
      offset: 3
    });
  });

  it('parse keeps case-distinct titles apart — they coexist on case-sensitive providers', () => {
    // `Vol 1.cbz` and `VOL 1.cbz` are two different files on a case-sensitive
    // provider. The parse-time healer has no listing to ask, so it merges
    // only what is provably the same volume — folding here would delete the
    // entry of a file that still exists.
    const parsed = roundTrip(fileWith([realEntry('vol-a', 'Vol 1'), realEntry('vol-b', 'VOL 1')]));

    expect(parsed.volumes).toHaveLength(2);
    expect(parsed.volumes.map((v) => v.volume_uuid).sort()).toEqual(['vol-a', 'vol-b']);
  });

  it('buildSeriesFile folds the case-drifted pair once the listing shows only one file', () => {
    // The build site DOES know which files exist: its folded join collapses
    // the pair, and the survivor stands for the one file the listing shows.
    const existing = roundTrip(
      fileWith([realEntry('vol-a', 'Vol 1'), realEntry('vol-b', 'VOL 1')])
    );
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: undefined,
      localVolumes: [],
      existing,
      cloudVolumeTitles: new Set(['Vol 1'])
    })!;

    expect(file.volumes).toHaveLength(1);
    // 'fill' order: the earlier entry wins the pure tie.
    expect(file.volumes[0].volume_uuid).toBe('vol-a');
  });
});

describe('entryMokuroVersion — the image-only vs legacy rule', () => {
  const base = {
    volume_uuid: 'u1',
    volume_title: 'Volume 1',
    page_count: 0,
    character_count: 0,
    mokuro_version: ''
  };

  it('measured content answers its real version, empty included', () => {
    expect(entryMokuroVersion({ ...base, mokuro_version: '0.4.11', page_count: 200 })).toBe(
      '0.4.11'
    );
    // An installed image-only volume publishes measured pages with '' — that
    // claim stands.
    expect(entryMokuroVersion({ ...base, page_count: 200 })).toBe('');
  });

  it("missing ALL sidecars answers 'unknown' — the mokuro is probably embedded", () => {
    expect(entryMokuroVersion(base)).toBe('unknown');
  });

  it("a cover stamp without a mokuro answers '' — a modern backup would have written the mokuro too", () => {
    expect(entryMokuroVersion({ ...base, cover_size: 12345 })).toBe('');
    expect(entryMokuroVersion({ ...base, cover_modified: 1_700_000_000 })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Heal-by-overwrite: the material-difference predicate and its convergence
// ---------------------------------------------------------------------------

describe('seriesFileHealDifference — the material-difference predicate', () => {
  const SERIES = 'One Piece';

  function healFile(volumes: SeriesFileVolume[]): SeriesFile {
    return {
      version: 2,
      series_title: SERIES,
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT,
      volumes
    };
  }

  /** A fully-measured published entry with every inheritable field present. */
  function measuredEntry(overrides: Partial<SeriesFileVolume> = {}): SeriesFileVolume {
    return {
      volume_uuid: 'real-uuid-1',
      volume_title: 'Vol 1',
      page_count: 180,
      character_count: 12_000,
      mokuro_version: '0.2.1',
      archive_size: 55_555,
      mokuro_size: 2_222,
      mokuro_modified: 1_700_000_000,
      cover_size: 333,
      cover_modified: 1_700_000_001,
      ...overrides
    };
  }

  /** The 0/0 shape `buildNoMetadataEntry` mints: derived uuid, nothing measured. */
  function noMetaEntry(title: string): SeriesFileVolume {
    return {
      volume_uuid: generateDeterministicUUID(`${SERIES}/${title}`),
      volume_title: title,
      page_count: 0,
      character_count: 0,
      mokuro_version: '',
      archive_size: 44_444
    };
  }

  const keysFor = (titles: string[]) => new Set(titles.map(normalizeVolumeTitleKey));

  it('SUPERSEDE: a published 0/0 entry whose built counterpart is measured is material', () => {
    const published = healFile([noMetaEntry('Vol 2')]);
    const built = healFile([
      measuredEntry({ volume_uuid: 'mokuro-uuid-2', volume_title: 'Vol 2' })
    ]);
    expect(seriesFileHealDifference(published, built, keysFor(['Vol 2']))).toBe(true);
  });

  it("the user's exact shape: vol 1 measured, vols 2..N published 0/0 with the data installed — material, and ONE build heals ALL of them", () => {
    // The ratchet fixture: the first browse-time write published volume 1
    // measured (its cover was resolved) and volumes 2..N as 0/0 no-metadata
    // entries; the user then INSTALLED 2..N. The heal must repair every one
    // of them in a single write — one-volume-per-trigger would just be the
    // ratchet again, one notch at a time.
    const titles = ['Vol 2', 'Vol 3', 'Vol 4', 'Vol 5', 'Vol 6'];
    const published = healFile([measuredEntry(), ...titles.map((title) => noMetaEntry(title))]);
    const installedRows = titles.map((title, i) =>
      volume({
        volume_title: title,
        volume_uuid: `mokuro-uuid-${i + 2}`,
        page_count: 100 + i,
        character_count: 9_000 + i,
        page_char_counts: []
      })
    );
    const cloudTitles = new Set(['Vol 1', ...titles]);

    const built = buildSeriesFile({
      seriesTitle: SERIES,
      meta: undefined,
      localVolumes: installedRows,
      existing: published,
      cloudVolumeTitles: cloudTitles
    })!;

    // Every installed volume's counts landed — all of them, not just one.
    expect(built.volumes).toHaveLength(6);
    for (const [i, title] of titles.entries()) {
      const entry = built.volumes.find((v) => v.volume_title === title)!;
      expect(entry.volume_uuid).toBe(`mokuro-uuid-${i + 2}`);
      expect(entry.page_count).toBe(100 + i);
      expect(entry.character_count).toBe(9_000 + i);
      expect(entry.mokuro_version).toBe('0.2.1');
      // The 0/0 entry it displaced still donates the archive size it carried.
      expect(entry.archive_size).toBe(44_444);
    }
    // Volume 1's foreign measured entry rides through untouched.
    expect(built.volumes.find((v) => v.volume_title === 'Vol 1')).toEqual(measuredEntry());

    expect(seriesFileHealDifference(published, built, keysFor([...cloudTitles]))).toBe(true);
  });

  it('the mirror shape: vols 2..N installed but vol 1 NOT — healing never damages vol 1’s measured published entry', () => {
    const published = healFile([measuredEntry(), noMetaEntry('Vol 2')]);
    const built = buildSeriesFile({
      seriesTitle: SERIES,
      meta: undefined,
      localVolumes: [
        volume({ volume_title: 'Vol 2', volume_uuid: 'mokuro-uuid-2', page_char_counts: [] })
      ],
      existing: published,
      cloudVolumeTitles: new Set(['Vol 1', 'Vol 2'])
    })!;

    expect(built.volumes.find((v) => v.volume_title === 'Vol 1')).toEqual(measuredEntry());
    expect(seriesFileHealDifference(published, built, keysFor(['Vol 1', 'Vol 2']))).toBe(true);
  });

  it('CONVERGENCE: after the heal-write publishes the built file, a second full cycle finds nothing material', () => {
    // Two FULL cycles, wire round trip included: build → publish
    // (stringify → parse, exactly what the cloud and the cache round-trip) →
    // rebuild from the same local state → the predicate must go quiet.
    // One write per damaged file per device, ever.
    const titles = ['Vol 2', 'Vol 3', 'Vol 4'];
    const published = healFile([measuredEntry(), ...titles.map((t) => noMetaEntry(t))]);
    const installedRows = titles.map((title, i) =>
      volume({
        volume_title: title,
        volume_uuid: `mokuro-uuid-${i + 2}`,
        page_char_counts: []
      })
    );
    const cloudTitles = new Set(['Vol 1', ...titles]);
    const buildArgs = {
      seriesTitle: SERIES,
      meta: undefined,
      localVolumes: installedRows,
      cloudVolumeTitles: cloudTitles
    };

    const built1 = buildSeriesFile({ ...buildArgs, existing: published })!;
    expect(seriesFileHealDifference(published, built1, keysFor([...cloudTitles]))).toBe(true);

    const published2 = parseSeriesFile(JSON.parse(stringifySeriesFile(built1)))!;
    const built2 = buildSeriesFile({ ...buildArgs, existing: published2 })!;
    expect(seriesFileHealDifference(published2, built2, keysFor([...cloudTitles]))).toBe(false);
  });

  it('COLLAPSE: two published entries landing on one built entry is material', () => {
    // The doubled shape that SURVIVES parse healing: case-distinct titles for
    // the same archive (exact join keeps them apart; the build folds them
    // under the listing).
    const published = healFile([
      measuredEntry({ volume_uuid: 'real-uuid-2', volume_title: 'VOL 2' }),
      noMetaEntry('Vol 2')
    ]);
    const built = healFile([
      measuredEntry({ volume_uuid: 'real-uuid-2', volume_title: 'VOL 2', archive_size: 44_444 })
    ]);
    expect(seriesFileHealDifference(published, built, keysFor(['Vol 2']))).toBe(true);
  });

  it('ENRICHMENT: each inherited file fact landing where the published entry had none is material — and only absent→present counts', () => {
    const fields = [
      'archive_size',
      'mokuro_size',
      'mokuro_modified',
      'cover_size',
      'cover_modified'
    ] as const;
    for (const field of fields) {
      const publishedEntry = measuredEntry();
      delete publishedEntry[field];
      expect(
        seriesFileHealDifference(
          healFile([publishedEntry]),
          healFile([measuredEntry()]),
          keysFor(['Vol 1'])
        ),
        `absent ${field} gained by the build`
      ).toBe(true);
    }

    // `offset` too — it is one of the merger's inherited file facts.
    expect(
      seriesFileHealDifference(
        healFile([measuredEntry()]),
        healFile([measuredEntry({ offset: 6 })]),
        keysFor(['Vol 1'])
      )
    ).toBe(true);

    // The reverse direction — the build LACKING a field the published entry
    // carries — is not material: that is a value the write would drop, not
    // one it would land, and the merger's inheritance normally prevents it.
    const builtEntry = measuredEntry();
    delete builtEntry.mokuro_size;
    expect(
      seriesFileHealDifference(
        healFile([measuredEntry()]),
        healFile([builtEntry]),
        keysFor(['Vol 1'])
      )
    ).toBe(false);
  });

  it('EXCLUDED — the two-real-uuid tie flip: divergent uuids on both sides, both measured, is NOT material', () => {
    // Device A holds `uuid-old` installed; device B re-OCR'd the same archive
    // into `uuid-new` and published it. Each device's build prefers its own —
    // the documented, accepted alternation. If a uuid-only difference counted
    // as heal-worthy, two live devices would ping-pong the published file
    // forever; this exclusion is what keeps heal-writes from weaponizing it.
    const published = healFile([measuredEntry({ volume_uuid: 'uuid-new' })]);
    const built = healFile([
      measuredEntry({ volume_uuid: 'uuid-old', page_count: 181, character_count: 12_500 })
    ]);
    expect(seriesFileHealDifference(published, built, keysFor(['Vol 1']))).toBe(false);
  });

  it('EXCLUDED — value drift in fields both sides carry is NOT material', () => {
    const published = healFile([measuredEntry()]);
    const built = healFile([
      measuredEntry({
        page_count: 200,
        character_count: 13_000,
        mokuro_version: '0.3.0',
        archive_size: 55_556,
        mokuro_size: 2_223,
        mokuro_modified: 1_700_000_002,
        cover_size: 334,
        cover_modified: 1_700_000_003
      })
    ]);
    expect(seriesFileHealDifference(published, built, keysFor(['Vol 1']))).toBe(false);
  });

  it('EXCLUDED — a published entry the build pruned away is NOT material', () => {
    // The prune alternates between devices (one holds the volume locally, one
    // does not); removals as a heal trigger would ping-pong the same way.
    const published = healFile([
      measuredEntry(),
      measuredEntry({ volume_uuid: 'gone', volume_title: 'Vol 9' })
    ]);
    const built = healFile([measuredEntry()]);
    expect(seriesFileHealDifference(published, built, keysFor(['Vol 1']))).toBe(false);
  });

  it('ADDITION: a built entry the listing vouches for is material; a local-only addition is NOT', () => {
    const published = healFile([measuredEntry()]);
    const built = healFile([
      measuredEntry(),
      measuredEntry({ volume_uuid: 'mokuro-uuid-7', volume_title: 'Vol 7' })
    ]);
    // Cloud-listed: every other device's prune keeps it → converges.
    expect(seriesFileHealDifference(published, built, keysFor(['Vol 1', 'Vol 7']))).toBe(true);
    // Local-only install: the next device's ordinary write would prune it and
    // this device would re-add it — never a heal trigger.
    expect(seriesFileHealDifference(published, built, keysFor(['Vol 1']))).toBe(false);
  });

  it('EXCLUDED — entry order and facts are never read', () => {
    const a = measuredEntry();
    const b = measuredEntry({ volume_uuid: 'real-uuid-2', volume_title: 'Vol 2' });
    const published = healFile([a, b]);
    const built = { ...healFile([b, a]), updated_at: '2026-08-01T00:00:00.000Z', tag: '[x]' };
    expect(seriesFileHealDifference(published, built, keysFor(['Vol 1', 'Vol 2']))).toBe(false);
  });
});

describe('parseSeriesFileWithReport — the raw-doubles signal', () => {
  const base = {
    version: 2,
    series_title: 'One Piece',
    updated_at: '2026-08-16T00:00:00.000Z'
  };

  const realEntry = {
    volume_uuid: 'mokuro-uuid-1',
    volume_title: 'Vol 1',
    page_count: 180,
    character_count: 12_000,
    mokuro_version: '0.2.1'
  };

  it('reports a collapse for a raw file holding the same volume twice — and still heals it', () => {
    const doubled = {
      ...base,
      volumes: [
        {
          volume_uuid: generateDeterministicUUID('One Piece/Vol 1'),
          volume_title: 'Vol 1',
          page_count: 0,
          character_count: 0,
          mokuro_version: '',
          archive_size: 44_444
        },
        realEntry
      ]
    };
    const report = parseSeriesFileWithReport(doubled);
    expect(report.entryCollapse).toBe(true);
    expect(report.file?.volumes).toHaveLength(1);
    expect(report.file?.volumes[0].volume_uuid).toBe('mokuro-uuid-1');
    // Healed the same way `parseSeriesFile` always has.
    expect(report.file).toEqual(parseSeriesFile(doubled));
  });

  it('reports NO collapse for a clean file, for an empty index, and for junk', () => {
    expect(parseSeriesFileWithReport({ ...base, volumes: [realEntry] }).entryCollapse).toBe(false);
    expect(parseSeriesFileWithReport({ ...base, version: 1 }).entryCollapse).toBe(false);
    expect(parseSeriesFileWithReport('junk')).toEqual({ file: undefined, entryCollapse: false });
  });

  it('an INVALID entry dropped by validation is not a collapse', () => {
    const report = parseSeriesFileWithReport({
      ...base,
      volumes: [realEntry, { volume_uuid: '', volume_title: 'Vol 2' }]
    });
    expect(report.entryCollapse).toBe(false);
    expect(report.file?.volumes).toHaveLength(1);
  });
});
