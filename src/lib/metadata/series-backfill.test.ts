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
const previewSeriesFileBuild = vi.fn(
  async (
    _title: string,
    _existing: SeriesFile | undefined
  ): Promise<{ built: SeriesFile | undefined; cloudTitleKeys: Set<string> } | undefined> =>
    undefined
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
    writeSeriesFile: (...a: Parameters<typeof writeSeriesFile>) => writeSeriesFile(...a),
    previewSeriesFileBuild: (...a: Parameters<typeof previewSeriesFileBuild>) =>
      previewSeriesFileBuild(...a)
  }
}));

// The heal seam's collaborators: the cached record (for the raw-doubles flag)
// and the debounced scheduler the seam hands its decision to.
const getSeriesIndex = vi.fn(
  async (_key: string): Promise<Record<string, unknown> | undefined> => undefined
);
vi.mock('./series-index', () => ({
  getSeriesIndex: (...a: Parameters<typeof getSeriesIndex>) => getSeriesIndex(...a)
}));
const scheduleSeriesFileWrite = vi.fn((_title: string) => {});
vi.mock('./series-file-sync', () => ({
  scheduleSeriesFileWrite: (...a: Parameters<typeof scheduleSeriesFileWrite>) =>
    scheduleSeriesFileWrite(...a)
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

// `cover-persist.ts`'s flush routes a cover with no ROW RELATIONSHIP to the
// `cloud_covers` table instead of the row. Captured rather than executed —
// the `db` stand-in below only models `volumes` — so a refresh's routing and
// its CACHE KEY are both directly assertable.
const putCloudCoversMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/catalog/cloud-covers', () => ({
  putCloudCovers: (...a: unknown[]) => putCloudCoversMock(...a)
}));

// `toArray` is its own `vi.fn()` (not an inline arrow) so a concurrency test
// can override it with a deferred/instrumented implementation per call,
// and so "was it called at all" is directly assertable — the mechanism
// leg (b) of the write-slot fix exists to prove (a converged series must
// never reach this scan).
const { volumeRows, volumesToArray } = vi.hoisted(() => ({
  volumeRows: [] as Record<string, unknown>[],
  volumesToArray: vi.fn(async () => [] as Record<string, unknown>[])
}));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      toArray: (...a: Parameters<typeof volumesToArray>) => volumesToArray(...a),
      get: async (uuid: string) => volumeRows.find((v) => v.volume_uuid === uuid),
      // `cover-persist.ts`'s flush re-reads its whole batch with ONE keyed
      // bulk read rather than a `get` per entry.
      bulkGet: async (uuids: string[]) =>
        uuids.map((uuid) => volumeRows.find((v) => v.volume_uuid === uuid)),
      update: async (uuid: string, patch: Record<string, unknown>) => {
        const row = volumeRows.find((v) => v.volume_uuid === uuid);
        if (row) Object.assign(row, patch);
      },
      // `volumesForFoldedSeriesTitle`'s two indexed reads. `uniqueKeys` is
      // routed through the SAME `volumesToArray` spy the scan-count and
      // concurrency assertions below key off — an index-only read replaces
      // the full scan, but it is still the one call gated behind
      // `acquireBackfillSlot`, so the existing instrumentation keeps working
      // unchanged.
      where(index: string) {
        return {
          anyOf: (values: unknown[]) => ({
            toArray: async () => volumeRows.filter((r) => values.includes(r[index]))
          })
        };
      },
      orderBy(index: string) {
        return {
          uniqueKeys: async () => {
            const rows = await volumesToArray();
            return [...new Set(rows.map((r) => r[index]))];
          }
        };
      }
    },
    // Real Dexie serializes overlapping `rw` transactions; this fire-through
    // stand-in is sufficient here because every test drives the race by hand
    // (mutating `volumeRows` directly between a deferred fetch and its
    // release), not by relying on real lock ordering.
    transaction: async (_mode: string, _table: unknown, body: () => Promise<unknown>) => body()
  }
}));

// `cover-persist.ts`'s flush now consults the reading-state store
// (`$lib/settings/volume-data`) to tell a genuine "kept for its history"
// metadata-only row apart from one minted purely by browsing. Hand-rolled
// (same pattern as `cover-persist.test.ts`) so this file can mark specific
// uuids as having a relationship without touching real localStorage.
const readingHistory = vi.hoisted(() => {
  let value: Record<string, unknown> = {};
  const subs = new Set<(v: Record<string, unknown>) => void>();
  return {
    store: {
      subscribe(fn: (v: Record<string, unknown>) => void) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      }
    },
    set(next: Record<string, unknown>) {
      value = next;
      subs.forEach((fn) => fn(value));
    }
  };
});
vi.mock('$lib/settings/volume-data', () => ({
  volumes: readingHistory.store
}));

// A PARTIAL mock: the real semaphore logic keeps running (so the tests below
// exercise the actual cap, not a stub), but wrapped in `vi.fn()` so calls can
// be counted/ordered — proof leg (c) of the write-slot fix needs (publishes
// actually acquire this pool, not just "a write happens").
const { acquireWriteSlotSpy, releaseWriteSlotSpy } = vi.hoisted(() => ({
  acquireWriteSlotSpy: vi.fn(),
  releaseWriteSlotSpy: vi.fn()
}));
vi.mock('./write-slot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./write-slot')>();
  return {
    ...actual,
    acquireWriteSlot: (...a: Parameters<typeof actual.acquireWriteSlot>) => {
      acquireWriteSlotSpy(...a);
      return actual.acquireWriteSlot(...a);
    },
    releaseWriteSlot: (...a: Parameters<typeof actual.releaseWriteSlot>) => {
      releaseWriteSlotSpy(...a);
      return actual.releaseWriteSlot(...a);
    }
  };
});

import {
  _resetSeriesBackfillForTests,
  backfillNewlyLinkedSeries,
  backfillSeriesEntries,
  maybeScheduleSeriesHealWrite
} from './series-backfill';
import { buildSeriesFile, parseSeriesFile, stringifySeriesFile } from './series-file';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
import type { VolumeMetadata } from '$lib/types';
import { normalizeVolumeTitleKey } from './series-key';
import { _resetWriteSlotForTests } from './write-slot';

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
  _resetWriteSlotForTests();
  status = {
    hasAnyAuthenticated: true,
    currentProviderType: 'webdav',
    providers: { webdav: { isReadOnly: false, serverCompilesMetadata: false } }
  };
  volumeRows.length = 0;
  readingHistory.set({});
  // `getStatus` is what `activeAccountScope()` reads (a DIFFERENT call than
  // the `getActiveProvider()` the backfill itself makes) to decide which
  // account's `cloud_covers` bucket a row-less cover may be attributed to.
  getActiveProvider.mockReturnValue({
    type: 'webdav',
    downloadFile,
    getStatus: () => ({ isAuthenticated: true, accountScope: 'webdav:test-account' })
  });
  resolveCloudFolderTitle.mockImplementation((t: string) => t);
  cloudVolumeTitlesFor.mockReturnValue(new Set(['Volume 01']));
  writeSeriesFile.mockResolvedValue('written');
  materializeSeriesVolumes.mockResolvedValue(0);
  installCoversForSeries.mockResolvedValue(0);
  // `clearAllMocks` drops implementations too — re-pin the default so a
  // `mockImplementationOnce` in one test cannot leak into the next.
  volumesToArray.mockImplementation(async () => [...volumeRows]);
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
    // Write-slot fix leg (b): the gap-or-stale check must run against the
    // listing + cached index ALONE — a converged series must never reach the
    // `db.volumes` scan, let alone the backfill-pass slot.
    expect(volumesToArray).not.toHaveBeenCalled();
  });

  it('N converged series cost ZERO volumes-table scans and ZERO writes', async () => {
    // Same shape `reconcileMissingMetadataFiles` sweeps: many sidecar-bearing
    // folders, every one of them already fully converged.
    const titles = ['One Piece', 'Berserk', 'Naruto', 'Bleach', 'Dr Stone'];
    getCloudVolumesBySeries.mockImplementation((title: string) => [
      cloudFile(`${title}/Volume 01.cbz`, 100)
    ]);
    refreshSeriesIndexForSeries.mockImplementation(async (title: string) =>
      seriesFile([
        {
          volume_uuid: `${title}-v1`,
          volume_title: 'Volume 01',
          page_count: 2,
          character_count: 5,
          mokuro_version: '0.4.0'
        }
      ])
    );

    await Promise.all(titles.map((title) => backfillSeriesEntries(title)));

    expect(volumesToArray).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
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

  it('a PROVISIONAL upload-time sidecar entry publishes its pulled entry with NO mokuro stamp', async () => {
    // The reconcile-off-the-cache shape from the backup buttons: sidecar
    // uploads put a client-clock cache entry (marked provisional) into the
    // provider cache, and `reconcileMissingMetadataFiles()` with no listing
    // argument dispatches `backfillSeriesEntries`, which reads that SAME
    // cache. The built entry's content facts are real (the sidecar bytes were
    // pulled), but its freshness stamp must be withheld: publishing the
    // client clock would make the next real listing's server mtime look
    // newer and re-pull a file this device itself just wrote.
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 999),
      { ...cloudFile('One Piece/Volume 01.mokuro', 321), modifiedTimeProvisional: true }
    ]);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(seriesFile([])) // no entry yet -> gap
      .mockResolvedValueOnce(seriesFile([])); // post-write re-read (materialize step)
    downloadFile.mockResolvedValue(plainMokuro());

    await backfillSeriesEntries('One Piece');

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    const [, options] = writeSeriesFile.mock.calls[0];
    expect(options.cloudMeasuredVolumes).toHaveLength(1);
    const entry = options.cloudMeasuredVolumes[0];
    // Positive control: the pull really happened and produced a real entry.
    expect(entry).toMatchObject({
      volume_uuid: 'vol-uuid-from-mokuro',
      volume_title: 'Volume 01',
      page_count: 2,
      archive_size: 999
    });
    // The stamp is fully withheld — no client-clock mtime, no size either
    // (a stampless entry adopts the next listing as its baseline).
    expect(entry.mokuro_modified).toBeUndefined();
    expect(entry.mokuro_size).toBeUndefined();
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

describe('the stampless-migration fix (field regression 2026-08-24)', () => {
  it('N series whose entries are all complete-but-stampless: ZERO pulls, ZERO cover fetches, ZERO publishes', async () => {
    // Reproduces the reported regression at scale: a library upgrading from
    // pre-stamp code has every entry in every series.json stampless (real
    // report: 197 series, ~1800 archives). The listing DOES show a
    // `.mokuro`/cover sidecar next to each archive — the exact shape that
    // used to trip "stampless + listed = stale, heal once" and queue a pull
    // per archive. None of that may happen any more.
    const titles = Array.from({ length: 10 }, (_, i) => `Series ${i}`);
    getCloudVolumesBySeries.mockImplementation((title: string) => [
      cloudFile(`${title}/Volume 01.cbz`, 100),
      cloudFile(`${title}/Volume 01.mokuro`, 50_000_000, '2026-06-01T00:00:00.000Z'),
      cloudFile(`${title}/Volume 01.webp`, 900, '2026-06-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries.mockImplementation(async (title: string) =>
      seriesFile([
        {
          // Complete: a real uuid and real counts, exactly what a pre-stamp
          // client (or this client before it ever saw a listing sidecar)
          // would have written. No mokuro_*/cover_* fields at all.
          volume_uuid: `${title}-v1`,
          volume_title: 'Volume 01',
          page_count: 200,
          character_count: 50_000,
          mokuro_version: '0.4.11'
        }
      ])
    );

    await Promise.all(titles.map((title) => backfillSeriesEntries(title)));

    expect(downloadFile).not.toHaveBeenCalled();
    expect(fetchCloudThumbnail).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
    // Leg (b) of the previous fix still holds too: nothing here is even a
    // CANDIDATE, so the volumes table is never scanned either.
    expect(volumesToArray).not.toHaveBeenCalled();
  });
});

describe('the write-slot fix: cross-series concurrency caps', () => {
  /** A different series per index, each with its own genuine gap (no published entry at all). */
  function setUpStaleSeries(count: number): string[] {
    const titles = Array.from({ length: count }, (_, i) => `Series ${i}`);
    getCloudVolumesBySeries.mockImplementation((title: string) => [
      // No sidecar in the listing either — the image-only path, so the ONLY
      // async work gated behind the backfill-pass slot is the volumes scan
      // and the write, which is exactly what this test needs to control.
      cloudFile(`${title}/Volume 01.cbz`, 100)
    ]);
    refreshSeriesIndexForSeries.mockImplementation(async () => seriesFile([]));
    return titles;
  }

  it('never runs more than BACKFILL_PASS_CONCURRENCY (2) volumes-table scans at once', async () => {
    const titles = setUpStaleSeries(5);

    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    volumesToArray.mockImplementation(
      () =>
        new Promise<Record<string, unknown>[]>((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          releases.push(() => {
            active -= 1;
            resolve([]);
          });
        })
    );

    const passes = titles.map((title) => backfillSeriesEntries(title));

    // Let every pass reach (and block on) the scan it can reach.
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
    // Only 2 of the 5 could possibly have gotten a slot yet.
    expect(active).toBeLessThanOrEqual(2);

    // Drain the queue: release whichever scans are currently blocked, which
    // frees their pass-slot for the next waiting series — but each release
    // still has to fall all the way through the REST of that pass (write,
    // materialize, install-covers, `finally { releaseBackfillSlot() }`)
    // before a waiting series can acquire the freed slot and call `toArray`
    // itself. That is many microtask hops deep, so this polls across real
    // macrotask boundaries (`setTimeout`) rather than a fixed number of
    // `Promise.resolve()` ticks, which underran it and hung the test.
    let settled = false;
    void Promise.all(passes).then(() => {
      settled = true;
    });
    while (!settled) {
      while (releases.length > 0) releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await Promise.all(passes);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2); // 5 concurrent stale series DID contend for the cap
    expect(volumesToArray).toHaveBeenCalledTimes(5);
  });

  it('a publish acquires the SAME shared write-slot pool the debounced writer uses', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 50)
    ]);
    refreshSeriesIndexForSeries.mockResolvedValueOnce(seriesFile([])).mockResolvedValueOnce(
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

    await backfillSeriesEntries('One Piece');

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    expect(acquireWriteSlotSpy).toHaveBeenCalledTimes(1);
    expect(releaseWriteSlotSpy).toHaveBeenCalledTimes(1);
    // Acquired before the PUT, released after — not merely called at some
    // point during the pass.
    const acquireOrder = acquireWriteSlotSpy.mock.invocationCallOrder[0];
    const writeOrder = writeSeriesFile.mock.invocationCallOrder[0];
    const releaseOrder = releaseWriteSlotSpy.mock.invocationCallOrder[0];
    expect(acquireOrder).toBeLessThan(writeOrder);
    expect(releaseOrder).toBeGreaterThan(writeOrder);
  });

  it('releases the write slot even when the publish throws', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 50)
    ]);
    refreshSeriesIndexForSeries.mockResolvedValue(seriesFile([]));
    downloadFile.mockResolvedValue(plainMokuro());
    writeSeriesFile.mockRejectedValueOnce(new Error('offline'));

    await backfillSeriesEntries('One Piece'); // never throws out to the caller

    expect(acquireWriteSlotSpy).toHaveBeenCalledTimes(1);
    expect(releaseWriteSlotSpy).toHaveBeenCalledTimes(1);
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

  it('a stampless COMPLETE entry is never a pull candidate, even when the listing has the sidecar', async () => {
    // DECIDED 2026-08-24 (field regression, overrides the old "heal once"
    // behavior): the entry already carries a real uuid and real counts —
    // exactly what a pull would produce — so pulling it again to learn its
    // OWN listing size/mtime gains zero information. It adopts the listing
    // as baseline silently; the stamp attaches later via the organic path
    // (an installed row's own write, `buildCloudSidecarStamps`), never by a
    // dedicated pull.
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 321, '2026-06-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries.mockResolvedValue(withMokuroEntry()); // no stamps at all

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

  it('a stampless cover is never a pull candidate, even when the listing has one', async () => {
    // Same inversion as the mokuro side: a stampless cover adopts the
    // listing as baseline instead of triggering a fetch.
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 321, '2026-06-01T00:00:00.000Z'),
      cloudFile('One Piece/Volume 01.webp', 900, '2026-07-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries.mockResolvedValue(withCoverEntry()); // no cover stamps at all

    await backfillSeriesEntries('One Piece');

    expect(fetchCloudThumbnail).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
  });

  it('does not clobber a thumbnail measured locally when the row installs while the cover fetch is in flight', async () => {
    // Mirrors `cover-install.test.ts`'s own race test: a download can finish
    // during `fetchCloudThumbnail`'s up-to-15s fetch, installing the volume
    // with a REAL thumbnail measured from its own pages. The pre-fetch
    // `needsDownload` snapshot is stale by the time the network answers, so
    // the write must re-check inside a transaction and skip.
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 321, '2026-06-01T00:00:00.000Z'),
      cloudFile('One Piece/Volume 01.webp', 900, '2026-07-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(withCoverEntry({ cover_size: 100, cover_modified: 1 }))
      .mockResolvedValueOnce(withCoverEntry());

    let releaseFetch!: (result: { file: File; width: number; height: number }) => void;
    fetchCloudThumbnail.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFetch = resolve;
      })
    );

    const pass = backfillSeriesEntries('One Piece');
    await vi.waitFor(() => expect(fetchCloudThumbnail).toHaveBeenCalled());

    // The volume installs mid-fetch: a real download measured a real cover.
    const row = volumeRows.find((v) => v.volume_uuid === 'v1')!;
    Object.assign(row, {
      metadata_only: undefined,
      thumbnail: 'REAL-PAGE-THUMBNAIL',
      thumbnail_width: 999,
      thumbnail_height: 999
    });

    releaseFetch({ file: new File([''], 'v1.webp'), width: 10, height: 10 });
    await pass;

    const fresh = volumeRows.find((v) => v.volume_uuid === 'v1')!;
    expect(fresh.thumbnail).toBe('REAL-PAGE-THUMBNAIL');
    expect(fresh.thumbnail_width).toBe(999);
  });
});

describe('row-level cover staleness (persistent catalog-card covers, design point 3)', () => {
  // Row-level checks piggyback on an EXPENSIVE phase some OTHER archive in
  // the series already earned (see `findStaleRowCovers`'s own doc) — so
  // every test here gives Volume 01 a genuine mokuro gap purely to enter
  // that phase, and puts the row-level scenario under test on Volume 02,
  // which the SERIES.JSON entry itself already describes as fully fresh
  // (matching mokuro stamps, no cover stamp opinion) so only the ROW's own
  // stamp can be the source of any staleness verdict.
  function twoVolumeListing(
    volume2Cover: { size: number; modifiedTime: string } = {
      size: 900,
      modifiedTime: '2026-07-01T00:00:00.000Z'
    }
  ) {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 100),
      cloudFile('One Piece/Volume 01.mokuro', 50),
      cloudFile('One Piece/Volume 02.cbz', 100),
      cloudFile('One Piece/Volume 02.mokuro', 321, '2026-06-01T00:00:00.000Z'),
      cloudFile('One Piece/Volume 02.webp', volume2Cover.size, volume2Cover.modifiedTime)
    ]);
  }

  /** Volume 01 has no entry at all (the gap); Volume 02's is fully fresh. */
  function existingIndex(): SeriesFile {
    return seriesFile([
      {
        volume_uuid: 'v2',
        volume_title: 'Volume 02',
        page_count: 2,
        character_count: 5,
        mokuro_version: '0.4.0',
        mokuro_size: 321,
        mokuro_modified: Math.floor(Date.parse('2026-06-01T00:00:00.000Z') / 1000)
      }
    ]);
  }

  function metadataOnlyRowV2(overrides: Record<string, unknown> = {}) {
    // This row already carries a thumbnail from a prior session — the only
    // legitimate way that happens is a real relationship (installed at some
    // point, or read), never pure browsing. Reflect that so `cover-persist.ts`'s
    // relationship gate doesn't route this refresh to `cloud_covers` instead.
    readingHistory.set({ v2: { progress: 1 } });
    volumeRows.push({
      volume_uuid: 'v2',
      series_title: 'One Piece',
      volume_title: 'Volume 02',
      mokuro_version: '0.4.0',
      page_count: 2,
      character_count: 5,
      page_char_counts: [],
      metadata_only: true,
      thumbnail: 'OLD-THUMBNAIL',
      thumbnail_width: 100,
      thumbnail_height: 100,
      ...overrides
    });
  }

  beforeEach(() => {
    twoVolumeListing();
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(existingIndex())
      .mockResolvedValueOnce(existingIndex());
    downloadFile.mockResolvedValue(plainMokuro()); // Volume 01's gap pull
  });

  it('stale row stamps trigger exactly one refetch + restamp', async () => {
    metadataOnlyRowV2({ cover_size: 100, cover_modified: 1 }); // stale vs the listing's 900 @ 2026-07-01
    fetchCloudThumbnail.mockResolvedValue({
      file: new File([''], 'v2.webp'),
      width: 20,
      height: 20
    });

    await backfillSeriesEntries('One Piece');

    expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1);
    const row = volumeRows.find((v) => v.volume_uuid === 'v2')!;
    expect(row.thumbnail_width).toBe(20); // restamped with the new cover
    expect(row.cover_size).toBe(900);
    expect(row.cover_modified).toBe(Math.floor(Date.parse('2026-07-01T00:00:00.000Z') / 1000));
  });

  it("routes a relationship-less row's refreshed cover to the cover cache, keyed by the ARCHIVE path", async () => {
    metadataOnlyRowV2({ cover_size: 100, cover_modified: 1 }); // stale vs the listing's 900 @ 2026-07-01
    // A metadata-only row WITH a thumbnail but NO relationship is what older
    // builds left behind everywhere: `cover-install.ts` used to fill such a
    // row's thumbnail with no reading-history gate of its own. (History
    // being cleared afterwards gets to the same place.) The helper above adds
    // the relationship every other test here wants; drop it back off.
    readingHistory.set({});
    fetchCloudThumbnail.mockResolvedValue({
      file: new File([''], 'v2.webp'),
      width: 20,
      height: 20
    });

    await backfillSeriesEntries('One Piece');

    expect(fetchCloudThumbnail).toHaveBeenCalledTimes(1);
    // No relationship, so the blob may not sit on the row — that is
    // `cover-persist.ts`'s routing rule, and it is why the row keeps its old
    // thumbnail here.
    const row = volumeRows.find((v) => v.volume_uuid === 'v2')!;
    expect(row.thumbnail).toBe('OLD-THUMBNAIL');
    // ...which makes the CACHE the only place this fetch can land. Keyed by
    // the ARCHIVE's own cloud path, the one key `catalog/index.ts` reads a
    // cached cover back under. Handing `installCover` a bare uuid instead
    // gives the cover no cache identity at all and the flush drops it, so the
    // stale cover could never refresh.
    const cached = putCloudCoversMock.mock.calls.flatMap((call) => call[0] as unknown[]);
    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatchObject({
      account_scope: 'webdav:test-account',
      path: 'One Piece/Volume 02.cbz'
    });
  });

  it('a stampless row thumbnail is untouched, even though the listing has a cover sidecar', async () => {
    metadataOnlyRowV2(); // no cover_size/cover_modified at all
    fetchCloudThumbnail.mockResolvedValue({
      file: new File([''], 'v2.webp'),
      width: 20,
      height: 20
    });

    await backfillSeriesEntries('One Piece');

    expect(fetchCloudThumbnail).not.toHaveBeenCalled();
    const row = volumeRows.find((v) => v.volume_uuid === 'v2')!;
    expect(row.thumbnail).toBe('OLD-THUMBNAIL');
    expect(row.thumbnail_width).toBe(100);
  });

  it("an installed volume's page-measured thumbnail is never replaced, even with stale-looking row stamps", async () => {
    metadataOnlyRowV2({
      metadata_only: undefined, // installed: real pages, real thumbnail
      cover_size: 100, // would read as stale if it were even considered
      cover_modified: 1
    });
    fetchCloudThumbnail.mockResolvedValue({
      file: new File([''], 'v2.webp'),
      width: 20,
      height: 20
    });

    await backfillSeriesEntries('One Piece');

    expect(fetchCloudThumbnail).not.toHaveBeenCalled();
    const row = volumeRows.find((v) => v.volume_uuid === 'v2')!;
    expect(row.thumbnail).toBe('OLD-THUMBNAIL');
    expect(row.thumbnail_width).toBe(100);
    expect(row.cover_size).toBe(100); // untouched too
  });

  it('does NOT re-fetch a row cover on an older-or-equal listing mtime with an equal size', async () => {
    const coverModified = Math.floor(Date.parse('2026-07-01T00:00:00.000Z') / 1000);
    metadataOnlyRowV2({ cover_size: 900, cover_modified: coverModified });

    await backfillSeriesEntries('One Piece');

    expect(fetchCloudThumbnail).not.toHaveBeenCalled();
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

describe('the heal seam — maybeScheduleSeriesHealWrite (heal-by-overwrite)', () => {
  const SERIES = 'One Piece';

  function measuredEntry(
    uuid: string,
    title: string,
    extra: Partial<SeriesFileVolume> = {}
  ): SeriesFileVolume {
    return {
      volume_uuid: uuid,
      volume_title: title,
      page_count: 180,
      character_count: 12_000,
      mokuro_version: '0.2.1',
      archive_size: 100,
      ...extra
    };
  }

  /** The 0/0 no-metadata shape the ratchet published for every unseen volume. */
  function noMetaEntry(title: string): SeriesFileVolume {
    return {
      volume_uuid: generateDeterministicUUID(`${SERIES}/${title}`),
      volume_title: title,
      page_count: 0,
      character_count: 0,
      mokuro_version: '',
      archive_size: 100
    };
  }

  function installRow(title: string, uuid: string, pages = 100, chars = 9000): void {
    volumeRows.push({
      series_title: SERIES,
      series_uuid: 'series-uuid',
      volume_title: title,
      volume_uuid: uuid,
      page_count: pages,
      character_count: chars,
      mokuro_version: '0.2.1',
      archive_size: 100,
      page_char_counts: []
    });
  }

  /**
   * Arm the preview with the REAL build engine over the db fixture — the seam
   * tests exercise the actual `buildSeriesFile` + predicate interplay, with
   * only the manager's plumbing (gates, listing lookups) doubled.
   */
  function armRealPreview(cloudTitles: string[]): void {
    previewSeriesFileBuild.mockImplementation(async (title, existing) => ({
      built: buildSeriesFile({
        seriesTitle: title,
        meta: undefined,
        localVolumes: volumeRows.filter((r) => !r.isPlaceholder) as unknown as VolumeMetadata[],
        existing,
        cloudVolumeTitles: new Set(cloudTitles)
      }),
      cloudTitleKeys: new Set(cloudTitles.map(normalizeVolumeTitleKey))
    }));
  }

  it("the user's exact scenario: installed volumes vs a published 0/0 index — exactly ONE write scheduled for the folder", async () => {
    const published = seriesFile([
      measuredEntry('mokuro-uuid-1', 'Vol 1'),
      noMetaEntry('Vol 2'),
      noMetaEntry('Vol 3'),
      noMetaEntry('Vol 4')
    ]);
    installRow('Vol 2', 'mokuro-uuid-2');
    installRow('Vol 3', 'mokuro-uuid-3');
    installRow('Vol 4', 'mokuro-uuid-4');
    armRealPreview(['Vol 1', 'Vol 2', 'Vol 3', 'Vol 4']);

    await expect(maybeScheduleSeriesHealWrite(SERIES, published)).resolves.toBe(true);

    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(1);
    // The folder title, and NO options: no `fromCloudListing` (nothing fetched
    // a listing to back this schedule) and no `cloudMeasuredVolumes` (a heal
    // write must never carry provisional stamps).
    expect(scheduleSeriesFileWrite).toHaveBeenCalledWith(SERIES);
  });

  it('TWO FULL CYCLES converge: the heal-write lands, the next read+build schedules NOTHING', async () => {
    const published = seriesFile([
      measuredEntry('mokuro-uuid-1', 'Vol 1'),
      noMetaEntry('Vol 2'),
      noMetaEntry('Vol 3')
    ]);
    installRow('Vol 2', 'mokuro-uuid-2');
    installRow('Vol 3', 'mokuro-uuid-3');
    armRealPreview(['Vol 1', 'Vol 2', 'Vol 3']);

    // Cycle 1: the damaged file is material — one write scheduled.
    await expect(maybeScheduleSeriesHealWrite(SERIES, published)).resolves.toBe(true);
    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(1);

    // The scheduled write publishes exactly what the preview built (same
    // engine, same inputs); the wire round trip is what the cloud sees.
    const { built } = (await previewSeriesFileBuild.mock.results[0].value)!;
    const healedAll = built!.volumes.filter((v: SeriesFileVolume) => v.page_count > 0);
    expect(healedAll).toHaveLength(3); // every 0/0 entry healed in the ONE write
    const published2 = parseSeriesFile(JSON.parse(stringifySeriesFile(built!)))!;

    // Cycle 2: same local state, healed published copy — nothing material.
    await expect(maybeScheduleSeriesHealWrite(SERIES, published2)).resolves.toBe(false);
    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(1);
  });

  it('the two-real-uuid tie does NOT trigger: divergent uuids on both sides stay an unscheduled alternation', async () => {
    // Device B published its re-OCR (`uuid-new`); this device holds `uuid-old`
    // installed. The build prefers its own — the documented flip — and the
    // predicate must not weaponize it into a write loop.
    const published = seriesFile([measuredEntry('uuid-new', 'Vol 1')]);
    installRow('Vol 1', 'uuid-old', 181, 12_500);
    armRealPreview(['Vol 1']);

    await expect(maybeScheduleSeriesHealWrite(SERIES, published)).resolves.toBe(false);

    // Non-vacuous: the gate passed and the preview genuinely ran — the
    // PREDICATE declined, not some earlier bail-out.
    expect(previewSeriesFileBuild).toHaveBeenCalledTimes(1);
    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
  });

  it('gates: a read-only provider, a server that compiles series.json, and no provider each schedule nothing', async () => {
    const published = seriesFile([noMetaEntry('Vol 2')]);
    installRow('Vol 2', 'mokuro-uuid-2');
    armRealPreview(['Vol 2']);

    status.providers.webdav = { isReadOnly: true, serverCompilesMetadata: false };
    await expect(maybeScheduleSeriesHealWrite(SERIES, published)).resolves.toBe(false);

    status.providers.webdav = { isReadOnly: false, serverCompilesMetadata: true };
    await expect(maybeScheduleSeriesHealWrite(SERIES, published)).resolves.toBe(false);

    status = { hasAnyAuthenticated: false, currentProviderType: null, providers: {} };
    await expect(maybeScheduleSeriesHealWrite(SERIES, published)).resolves.toBe(false);

    // Fully excluded: not even the record read or the preview happens for a
    // browser without write rights.
    expect(getSeriesIndex).not.toHaveBeenCalled();
    expect(previewSeriesFileBuild).not.toHaveBeenCalled();
    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
  });

  it('a DOUBLED published file on a FOREIGN folder never schedules — no local rows, no publishable facts, across TWO reconcile passes', async () => {
    // The raw bytes hold the same volume twice; the parsed copy in hand is
    // already healed (parse-time healing), so the flag on the cached record
    // is the only evidence — and this device has NO local row for the
    // series at all (`volumeRows` stays empty: no `installRow` call).
    const healedView = seriesFile([measuredEntry('mokuro-uuid-1', 'Vol 1')]);
    getSeriesIndex.mockResolvedValue({ raw_entry_collapse: true });
    armRealPreview(['Vol 1']);

    // Pass 1: the flag is set, but this device has no standing to act on it.
    await expect(maybeScheduleSeriesHealWrite(SERIES, healedView)).resolves.toBe(false);
    // Pass 2: nothing here ever clears the flag (only a successful write
    // does), so a reconcile sweep re-parsing the same doubled bytes would
    // re-set the SAME flag and land right back here — zero schedules is the
    // fix, not "eventually clears".
    await expect(maybeScheduleSeriesHealWrite(SERIES, healedView)).resolves.toBe(false);

    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
    // Non-vacuous: both passes genuinely reached and evaluated the flag
    // (preview ran, the record was read) rather than bailing out earlier —
    // an unconditional decline (e.g. a broken gate) would pass this
    // assertion too, so the counts below are what tell them apart.
    expect(previewSeriesFileBuild).toHaveBeenCalledTimes(2);
    expect(getSeriesIndex).toHaveBeenCalledTimes(2);
  });

  it('mirror: the SAME doubled file on a folder WITH an installed row — exactly ONE write, doubles healed, flag cleared', async () => {
    // Identical fixture to the foreign-folder case above, except this
    // device holds Vol 1 installed with the SAME measured content already
    // published — so none of `seriesFileHealDifference`'s own four terms
    // can explain a write (no supersede, no enrichment, nothing to
    // collapse or add): only the standing check on the raw-collapse flag
    // can, isolating exactly what this fix changed.
    const healedView = seriesFile([measuredEntry('mokuro-uuid-1', 'Vol 1')]);
    installRow('Vol 1', 'mokuro-uuid-1', 180, 12_000);
    getSeriesIndex.mockResolvedValue({ raw_entry_collapse: true });
    armRealPreview(['Vol 1']);

    await expect(maybeScheduleSeriesHealWrite(SERIES, healedView)).resolves.toBe(true);
    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(1);
    // Doubles healed: the scheduled write publishes exactly what the preview
    // built, which merges from the ALREADY-healed `existing.volumes` — one
    // entry for Vol 1, not two.
    const { built } = (await previewSeriesFileBuild.mock.results[0].value)!;
    expect(built!.volumes).toHaveLength(1);
    expect(built!.volumes[0].volume_uuid).toBe('mokuro-uuid-1');

    // The write re-stamps the record WITHOUT the flag; the next cycle finds
    // the published copy equal to the build and goes quiet — same
    // convergence guarantee as every other trigger.
    getSeriesIndex.mockResolvedValue({});
    const published2 = parseSeriesFile(JSON.parse(stringifySeriesFile(built!)))!;
    await expect(maybeScheduleSeriesHealWrite(SERIES, published2)).resolves.toBe(false);
    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(1);
  });

  it('runBackfill reaches the seam for a sidecar-converged series: the ratchet fixture heals with ZERO downloads', async () => {
    // The published index has entries for every archive (so nothing is a pull
    // candidate: 0/0 entries are stampless, and stampless is never stale) —
    // exactly the state the ratchet leaves behind. The heal seam is the only
    // thing left that can publish the installed volume's measured counts.
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Vol 1.cbz', 100),
      cloudFile('One Piece/Vol 2.cbz', 100)
    ]);
    refreshSeriesIndexForSeries.mockResolvedValue(
      seriesFile([measuredEntry('mokuro-uuid-1', 'Vol 1'), noMetaEntry('Vol 2')])
    );
    installRow('Vol 2', 'mokuro-uuid-2');
    armRealPreview(['Vol 1', 'Vol 2']);

    await backfillSeriesEntries(SERIES);

    expect(downloadFile).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled(); // no direct publish — the debounced writer owns it
    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(1);
    expect(scheduleSeriesFileWrite).toHaveBeenCalledWith(SERIES);
  });

  it('a pass that publishes DIRECTLY (a genuine pull) never also schedules a heal write', async () => {
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Volume 01.cbz', 999),
      cloudFile('One Piece/Volume 01.mokuro.gz', 321, '2026-02-01T00:00:00.000Z')
    ]);
    refreshSeriesIndexForSeries
      .mockResolvedValueOnce(seriesFile([]))
      .mockResolvedValueOnce(seriesFile([]));
    downloadFile.mockResolvedValue(gzippedMokuro());

    await backfillSeriesEntries(SERIES);

    expect(writeSeriesFile).toHaveBeenCalledTimes(1);
    expect(scheduleSeriesFileWrite).not.toHaveBeenCalled();
  });

  it('candidates ALL excluded as locally installed: the second seam site schedules the write the exclusion swallowed', async () => {
    // A cloud archive with a sidecar and NO published entry is a pull
    // candidate — but the volume is installed here, so the pull is excluded
    // as waste (the install already measured it). Before the seam existed
    // this path simply never wrote, which is how an installed volume's entry
    // stayed missing forever.
    getCloudVolumesBySeries.mockReturnValue([
      cloudFile('One Piece/Vol 1.cbz', 100),
      cloudFile('One Piece/Vol 1.mokuro.gz', 321)
    ]);
    refreshSeriesIndexForSeries.mockResolvedValue(seriesFile([]));
    installRow('Vol 1', 'mokuro-uuid-1');
    armRealPreview(['Vol 1']);

    await backfillSeriesEntries(SERIES);

    expect(downloadFile).not.toHaveBeenCalled();
    expect(writeSeriesFile).not.toHaveBeenCalled();
    expect(scheduleSeriesFileWrite).toHaveBeenCalledTimes(1);
  });
});
