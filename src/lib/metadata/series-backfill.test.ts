import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// This is a browser-first project with no `@types/node`; these two are Node
// built-ins available at test RUNTIME (Vitest runs under Node) but unresolvable
// by svelte-check's module resolution. Needed only to build ONE real gzipped
// `.mokuro.gz` fixture — jsdom's own `Blob` has no `.stream()`, which
// `decodeMokuroSidecar`'s `.gz` branch needs; Node's `buffer.Blob` does.
// @ts-expect-error no type declarations for node:zlib in this project
import { gzipSync } from 'node:zlib';
// @ts-expect-error no type declarations for node:buffer in this project
import { Blob as NodeBlob, Buffer } from 'node:buffer';
import { readable } from 'svelte/store';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import type { SeriesFile, SeriesFileVolume } from './series-file';

/** The one shape `unifiedCloudManager.writeSeriesFile`'s mock is ever called with here. */
type WriteSeriesFileOptions = { cloudMeasuredVolumes: SeriesFileVolume[] };

/**
 * `series-backfill.ts` end to end: gap-OR-stale detection, entry building
 * (including a REAL gzipped `.mokuro` fixture, decoded and parsed for real —
 * only the network/db/catalog layers below it are mocked), the freshness
 * stamps and their snapshot discipline, and the two entry points'
 * re-entrancy/gating. `materializeSeriesVolumes`/`installCoversForSeries` are
 * mocked: their own behavior is covered by their own test files, and this
 * suite only needs to assert that the backfill CALLS them with the right
 * arguments once a write lands.
 */

let status = {
  hasAnyAuthenticated: true,
  currentProviderType: 'webdav' as string | null,
  providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } } as Record<
    string,
    { isReadOnly?: boolean; serverCompilesMetadata?: boolean } | null
  >
};
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: {
    get status() {
      return readable(status);
    }
  }
}));

const downloadFile = vi.fn();
const getActiveProvider = vi.fn();
const resolveCloudFolderTitle = vi.fn((title: string) => title);
const getCloudVolumesBySeries = vi.fn((_title: string): CloudFileMetadata[] => []);
const refreshSeriesIndexForSeries = vi.fn(
  async (_title: string): Promise<SeriesFile | undefined> => undefined
);
const cloudVolumeTitlesFor = vi.fn((_title: string) => new Set<string>());
const writeSeriesFile = vi.fn(
  async (_seriesTitle: string, _options: WriteSeriesFileOptions) => 'written' as const
);
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: (...a: Parameters<typeof getActiveProvider>) => getActiveProvider(...a),
    resolveCloudFolderTitle: (...a: Parameters<typeof resolveCloudFolderTitle>) =>
      resolveCloudFolderTitle(...a),
    getCloudVolumesBySeries: (...a: Parameters<typeof getCloudVolumesBySeries>) =>
      getCloudVolumesBySeries(...a),
    refreshSeriesIndexForSeries: (...a: Parameters<typeof refreshSeriesIndexForSeries>) =>
      refreshSeriesIndexForSeries(...a),
    cloudVolumeTitlesFor: (...a: Parameters<typeof cloudVolumeTitlesFor>) =>
      cloudVolumeTitlesFor(...a),
    writeSeriesFile: (...a: Parameters<typeof writeSeriesFile>) => writeSeriesFile(...a)
  }
}));

const materializeSeriesVolumes = vi.fn(
  async (_args: {
    seriesTitle: string;
    entries: SeriesFileVolume[];
    cloudVolumeTitles: Set<string>;
  }) => 0
);
vi.mock('$lib/catalog/materialize', () => ({
  materializeSeriesVolumes: (...a: Parameters<typeof materializeSeriesVolumes>) =>
    materializeSeriesVolumes(...a)
}));

const installCoversForSeries = vi.fn(async (_title: string) => 0);
vi.mock('$lib/catalog/cover-install', () => ({
  installCoversForSeries: (...a: Parameters<typeof installCoversForSeries>) =>
    installCoversForSeries(...a)
}));

const fetchCloudThumbnail = vi.fn(
  async (_volume: unknown) => null as { file: File; width: number; height: number } | null
);
vi.mock('$lib/catalog/cloud-thumbnails', () => ({
  fetchCloudThumbnail: (...a: Parameters<typeof fetchCloudThumbnail>) => fetchCloudThumbnail(...a)
}));

const { volumeRows } = vi.hoisted(() => ({ volumeRows: [] as Record<string, unknown>[] }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      toArray: async () => [...volumeRows],
      get: async (uuid: string) => volumeRows.find((v) => v.volume_uuid === uuid),
      update: async (uuid: string, patch: Record<string, unknown>) => {
        const row = volumeRows.find((v) => v.volume_uuid === uuid);
        if (row) Object.assign(row, patch);
      }
    }
  }
}));

import {
  _resetSeriesBackfillForTests,
  backfillNewlyLinkedSeries,
  backfillSeriesEntries
} from './series-backfill';

function cloudFile(
  path: string,
  size: number,
  modifiedTime = '2026-01-01T00:00:00.000Z'
): CloudFileMetadata {
  return { provider: 'webdav', fileId: path, path, size, modifiedTime } as CloudFileMetadata;
}

function seriesFile(volumes: SeriesFile['volumes']): SeriesFile {
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

function mokuroFixture(overrides: Record<string, unknown> = {}) {
  return {
    version: '0.4.12',
    title: 'WRONG TITLE — never used for volume_title',
    title_uuid: 'series-uuid-from-mokuro',
    volume: 'WRONG VOLUME — never used for volume_title',
    volume_uuid: 'vol-uuid-from-mokuro',
    pages: [{ blocks: [{ lines: ['あいう'] }] }, { blocks: [{ lines: ['えお'] }] }],
    ...overrides
  };
}

/**
 * A real gzipped `.mokuro.gz`, so decode+parse actually runs — for the ONE
 * test that exercises the compressed path end to end. jsdom's own `Blob` has
 * no `.stream()` (what `decodeMokuroSidecar` needs for the `.gz` branch), so
 * this uses Node's `buffer.Blob`, which does.
 */
function gzippedMokuro(overrides: Record<string, unknown> = {}): Blob {
  const gz = gzipSync(Buffer.from(JSON.stringify(mokuroFixture(overrides))));
  return new NodeBlob([gz]) as unknown as Blob;
}

/** A plain (uncompressed) `.mokuro` blob — every OTHER test that just needs a valid or invalid sidecar. */
function plainMokuro(overrides: Record<string, unknown> = {}): Blob {
  return new Blob([JSON.stringify(mokuroFixture(overrides))], { type: 'application/json' });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetSeriesBackfillForTests();
  status = {
    hasAnyAuthenticated: true,
    currentProviderType: 'webdav',
    providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } }
  };
  volumeRows.length = 0;
  getActiveProvider.mockReturnValue({ type: 'webdav', downloadFile });
  resolveCloudFolderTitle.mockImplementation((t: string) => t);
  cloudVolumeTitlesFor.mockReturnValue(new Set(['Volume 01']));
  writeSeriesFile.mockResolvedValue('written');
  materializeSeriesVolumes.mockResolvedValue(0);
  installCoversForSeries.mockResolvedValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gap detection', () => {
  it('costs zero downloads when every archive already has a fresh entry', async () => {
    getCloudVolumesBySeries.mockReturnValue([cloudFile('One Piece/Volume 01.cbz', 100)]);
    refreshSeriesIndexForSeries.mockResolvedValue(
      seriesFile([
        {
          volume_uuid: 'v1',
          volume_title: 'Volume 01',
          page_count: 2,
          character_count: 5,
          mokuro_version: '0.4.0'
        }
      ])
    );

    await backfillSeriesEntries('One Piece');

    expect(downloadFile).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('matches an archive to its entry on a FOLDED volume title', async () => {
    getCloudVolumesBySeries.mockReturnValue([cloudFile('One Piece/Café  Vol 1.cbz', 100)]);
    refreshSeriesIndexForSeries.mockResolvedValue(
      seriesFile([
        {
          volume_uuid: 'v1',
          volume_title: 'café vol 1', // NFD, different case/spacing
          page_count: 2,
          character_count: 5,
          mokuro_version: '0.4.0'
        }
      ])
    );

    await backfillSeriesEntries('One Piece');

    expect(downloadFile).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('requires an existing series.json for the ordinary trigger', async () => {
    getCloudVolumesBySeries.mockReturnValue([cloudFile('One Piece/Volume 01.cbz', 100)]);
    refreshSeriesIndexForSeries.mockResolvedValue(undefined);

    await backfillSeriesEntries('One Piece');

    expect(downloadFile).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('pulls the sidecar for a genuine gap and publishes the built entry', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 999),
      cloudFile('One Piece/Volume 01.mokuro.gz', 321, '2026-02-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(seriesFile([])) // no entry yet -> gap
      .mockResolvedValueOnce(seriesFile([])); // post-write re-read (materialize step)
    downloadFile.mockResolvedValue(gzippedMokuro());

    await backfillSeriesEntries('One Piece');

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    const [, options] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes).toEqual([
      expect.objectContaining({
        volume_uuid: 'vol-uuid-from-mokuro',
        volume_title: 'Volume 01', // from the ARCHIVE stem, never the mokuro's own fields
        page_count: 2,
        character_count: 5, // あいう=3 + えお=2
        mokuro_version: '0.4.12',
        archive_size: 999,
        mokuro_size: 321
      })
    ]);
  });

  it('skips an archive whose title matches a LOCALLY INSTALLED volume — never pulls its sidecar', async () => {
    volumeRows.push({
      volume_uuid: 'installed-1',
      series_title: 'One Piece',
      volume_title: 'Volume 01',
      mokuro_version: '0.4.0',
      page_count: 5,
      character_count: 50,
      page_char_counts: [50]
    });
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 999),
      cloudFile('One Piece/Volume 01.mokuro', 321)
    ]);
    refreshSeriesIndexForSeries.mockResolvedValue(seriesFile([]));

    await backfillSeriesEntries('One Piece');

    expect(downloadFile).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('builds a zero-count image-only entry when the archive has no sidecar at all', async () => {
    getCloudVolumesBySeries.mockReturnValue([cloudFile('One Piece/Volume 02.cbz', 555)]);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(seriesFile([]))
      .mockResolvedValueOnce(seriesFile([]));

    await backfillSeriesEntries('One Piece');

    expect(downloadFile).not.toHaveBeenCalled();
    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    const [, options] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes).toEqual([
      expect.objectContaining({
        volume_title: 'Volume 02',
        page_count: 0,
        character_count: 0,
        mokuro_version: '',
        archive_size: 555
      })
    ]);
    // A deterministic uuid, not a made-up one — same convention as a placeholder.
    expect(options.cloudMeasuredVolumes[0].volume_uuid).toMatch(/.+/);
  });
});

describe('malformed sidecars', () => {
  it('skips ONE volume on a malformed sidecar without aborting the series or the queue', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 10),
      cloudFile('One Piece/Volume 02.cbz', 200),
      cloudFile('One Piece/Volume 02.mokuro', 20)
    ]);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(seriesFile([]))
      .mockResolvedValueOnce(seriesFile([]));
    downloadFile.mockImplementation(async (file: CloudFileMetadata) => {
      if (file.path.includes('Volume 01')) {
        return new Blob(['not json at all'], { type: 'application/json' });
      }
      return plainMokuro({ volume_uuid: 'vol-2-uuid' });
    });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await backfillSeriesEntries('One Piece');

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    const [, options] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes).toHaveLength(1);
    expect(options.cloudMeasuredVolumes[0].volume_title).toBe('Volume 02');
    expect(debugSpy).toHaveBeenCalled();
  });
});

describe('gates', () => {
  beforeEach(() => {
    getCloudVolumesBySeries.mockReturnValue([cloudFile('One Piece/Volume 01.cbz', 100)]);
    refreshSeriesIndexForSeries.mockResolvedValue(seriesFile([]));
  });

  it('skips when the provider is read-only', async () => {
    status.providers.webdav = { isReadOnly: true, serverCompilesMetadata: false };
    await backfillSeriesEntries('One Piece');
    expect(getCloudVolumesBySeries).not.toHaveBeenCalled();
  });

  it('skips when the server compiles series.json itself', async () => {
    status.providers.webdav = { isReadOnly: false, serverCompilesMetadata: true };
    await backfillSeriesEntries('One Piece');
    expect(getCloudVolumesBySeries).not.toHaveBeenCalled();
  });

  it('skips when no provider is connected', async () => {
    status = { hasAnyAuthenticated: false, currentProviderType: null, providers: {} };
    await backfillSeriesEntries('One Piece');
    expect(getCloudVolumesBySeries).not.toHaveBeenCalled();
  });
});

describe('re-entrancy', () => {
  it('runs one backfill per series at a time, sharing the same in-flight pass', async () => {
    getCloudVolumesBySeries.mockReturnValue([cloudFile('One Piece/Volume 01.cbz', 100)]);
    let resolveIndex!: (file: SeriesFile) => void;
    refreshSeriesIndexForSeries.mockReturnValue(
      new Promise<SeriesFile>((resolve) => {
        resolveIndex = resolve;
      })
    );

    const first = backfillSeriesEntries('One Piece');
    const second = backfillSeriesEntries('One Piece');
    expect(getCloudVolumesBySeries).toHaveBeenCalledTimes(1);

    resolveIndex(seriesFile([]));
    await Promise.all([first, second]);
    expect(getCloudVolumesBySeries).toHaveBeenCalledTimes(1);
  });
});

describe('freshness stamps: stale re-pull vs. no-op', () => {
  function withMokuroEntry(
    stamp: { mokuro_size?: number; mokuro_modified?: number } = {}
  ): SeriesFile {
    return seriesFile([
      {
        volume_uuid: 'v1',
        volume_title: 'Volume 01',
        page_count: 2,
        character_count: 5,
        mokuro_version: '0.4.0',
        ...stamp
      }
    ]);
  }

  it('re-pulls and republishes with new stamps when the listing size differs', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 999, '2026-02-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(withMokuroEntry({ mokuro_size: 111, mokuro_modified: 1_800_000_000 }))
      .mockResolvedValueOnce(withMokuroEntry());
    downloadFile.mockResolvedValue(plainMokuro());

    await backfillSeriesEntries('One Piece');

    expect(downloadFile).toHaveBeenCalledTimes(1);
    const [, options] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes[0].mokuro_size).toBe(999);
  });

  it('re-pulls when the listing mtime is strictly newer, same size', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 321, '2026-06-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(withMokuroEntry({ mokuro_size: 321, mokuro_modified: 1_000_000_000 }))
      .mockResolvedValueOnce(withMokuroEntry());
    downloadFile.mockResolvedValue(plainMokuro());

    await backfillSeriesEntries('One Piece');

    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-pull on an older-or-equal mtime with an equal size', async () => {
    const listingModified = Math.floor(Date.parse('2026-06-01T00:00:00.000Z') / 1000);
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 321, '2026-06-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries.mockResolvedValue(
      withMokuroEntry({ mokuro_size: 321, mokuro_modified: listingModified })
    );

    await backfillSeriesEntries('One Piece');

    expect(downloadFile).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('heals a stampless entry once when the listing shows a sidecar, then goes quiet', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 321, '2026-06-01T00:00:00.000Z')
    ]);
    // First pass: no stamps at all (an entry built before this scheme, or by
    // an older client) — heals once.
    refreshSeriesIndexForSeries.mockResolvedValueOnce(withMokuroEntry()).mockResolvedValueOnce(
      withMokuroEntry({
        mokuro_size: 321,
        mokuro_modified: Math.floor(Date.parse('2026-06-01T00:00:00.000Z') / 1000)
      })
    );
    downloadFile.mockResolvedValue(plainMokuro());

    await backfillSeriesEntries('One Piece');
    expect(downloadFile).toHaveBeenCalledTimes(1);

    // Second pass: the SAME listing, now against the healed (stamped) entry —
    // must go quiet.
    downloadFile.mockClear();
    writeSeriesFile.mockClear();
    _resetSeriesBackfillForTests();
    refreshSeriesIndexForSeries.mockReset();
    refreshSeriesIndexForSeries.mockResolvedValue(
      withMokuroEntry({
        mokuro_size: 321,
        mokuro_modified: Math.floor(Date.parse('2026-06-01T00:00:00.000Z') / 1000)
      })
    );
    await backfillSeriesEntries('One Piece');
    expect(downloadFile).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
  });
});

describe('snapshot discipline (stamp source is the listing, never the wall clock)', () => {
  it('stamps the entry from the captured listing values, not from the moment of the pull', async () => {
    // A `Date.now()` spy (not fake timers — those also freeze jsdom's
    // File/Blob async plumbing, which the real decode/parse path needs) pins
    // the wall clock somewhere the listing's own timestamp could never land.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2099-01-01T00:00:00.000Z'));
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 321, '2026-06-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(seriesFile([]))
      .mockResolvedValueOnce(seriesFile([]));
    downloadFile.mockResolvedValue(plainMokuro());

    await backfillSeriesEntries('One Piece');

    const [, options] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes[0].mokuro_modified).toBe(
      Math.floor(Date.parse('2026-06-01T00:00:00.000Z') / 1000)
    );
  });

  it('stamps the DECISION-time listing even if the listing fixture is mutated before the stamp is read', async () => {
    // `getCloudVolumesBySeries` is called ONCE per pass and its result is
    // captured; mutating the array afterwards must never be observed.
    const files = [
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 321, '2026-06-01T00:00:00.000Z')
    ];
    getCloudVolumesBySeries.mockReturnValue(files);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(seriesFile([]))
      .mockResolvedValueOnce(seriesFile([]));
    downloadFile.mockImplementation(async () => {
      // Simulate a re-list arriving mid-pull, after the decision was made.
      files[1] = cloudFile('One Piece/Volume 01.mokuro', 999, '2026-12-01T00:00:00.000Z');
      return plainMokuro();
    });

    await backfillSeriesEntries('One Piece');

    expect(getCloudVolumesBySeries).toHaveBeenCalledTimes(1);
    const [, options] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes[0].mokuro_size).toBe(321); // decision-time, not the mutated 999
  });
});

describe('cover freshness stamps', () => {
  function withCoverEntry(
    stamp: { cover_size?: number; cover_modified?: number } = {}
  ): SeriesFile {
    return seriesFile([
      {
        volume_uuid: 'v1',
        volume_title: 'Volume 01',
        page_count: 2,
        character_count: 5,
        mokuro_version: '0.4.0',
        mokuro_size: 321,
        mokuro_modified: Math.floor(Date.parse('2026-06-01T00:00:00.000Z') / 1000),
        ...stamp
      }
    ]);
  }

  beforeEach(() => {
    volumeRows.push({
      volume_uuid: 'v1',
      series_title: 'One Piece',
      volume_title: 'Volume 01',
      mokuro_version: '',
      page_count: 0,
      character_count: 0,
      page_char_counts: [],
      metadata_only: true
    });
  });

  it('re-fetches a stale cover (size differs) and restamps the entry', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 321, '2026-06-01T00:00:00.000Z'),
      cloudFile('One Piece/Volume 01.webp', 900, '2026-07-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(withCoverEntry({ cover_size: 100, cover_modified: 1_000_000 }))
      .mockResolvedValueOnce(withCoverEntry());
    fetchCloudThumbnail.mockResolvedValue({
      file: new File([''], 'v1.webp'),
      width: 10,
      height: 10
    });

    await backfillSeriesEntries('One Piece');

    expect(downloadFile).not.toHaveBeenCalled(); // mokuro side was already fresh
    expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1);
    const [, options] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes[0]).toMatchObject({
      cover_size: 900,
      cover_modified: Math.floor(Date.parse('2026-07-01T00:00:00.000Z') / 1000)
    });
  });

  it('does NOT re-fetch on an older cover mtime with equal size', async () => {
    const coverModified = Math.floor(Date.parse('2026-07-01T00:00:00.000Z') / 1000);
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 321, '2026-06-01T00:00:00.000Z'),
      cloudFile('One Piece/Volume 01.webp', 900, '2026-07-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries.mockResolvedValue(
      withCoverEntry({ cover_size: 900, cover_modified: coverModified })
    );

    await backfillSeriesEntries('One Piece');

    expect(fetchCloudThumbnail).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('heals a stampless cover once when the listing has one', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 321, '2026-06-01T00:00:00.000Z'),
      cloudFile('One Piece/Volume 01.webp', 900, '2026-07-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(withCoverEntry()) // no cover stamps at all
      .mockResolvedValueOnce(withCoverEntry({ cover_size: 900, cover_modified: 1 }));
    fetchCloudThumbnail.mockResolvedValue({
      file: new File([''], 'v1.webp'),
      width: 10,
      height: 10
    });

    await backfillSeriesEntries('One Piece');

    expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1);
  });
});

describe('backfillNewlyLinkedSeries (the link-event trigger)', () => {
  it('proceeds even when the listing shows no series.json yet, and flushes the local pipeline', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 50)
    ]);
    // No series.json exists in the cloud yet: the facts-only write is still
    // debouncing when this trigger fires.
    refreshSeriesIndexForSeries.mockResolvedValueOnce(undefined).mockResolvedValueOnce(
      seriesFile([
        {
          volume_uuid: 'vol-uuid-from-mokuro',
          volume_title: 'Volume 01',
          page_count: 2,
          character_count: 5,
          mokuro_version: '0.4.12'
        }
      ])
    );
    downloadFile.mockResolvedValue(plainMokuro());

    await backfillNewlyLinkedSeries('One Piece');

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    // Same pipeline series-open uses: materialize the completed entries
    // (real uuids from what was just built), then install covers.
    expect(materializeSeriesVolumes).toHaveBeenCalledTimes(1);
    expect(materializeSeriesVolumes.mock.calls[0][0]).toMatchObject({
      seriesTitle: 'One Piece',
      entries: [expect.objectContaining({ volume_uuid: 'vol-uuid-from-mokuro' })]
    });
    expect(installCoversForSeries).toHaveBeenCalledTimes(1);
  });
});
