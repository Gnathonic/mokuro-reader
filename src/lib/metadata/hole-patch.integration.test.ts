import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { countIdbOps } from '$lib/catalog/__tests__/idb-op-counter';
import type { SeriesFile, SeriesFileVolume } from './series-file';
import type { SeriesIndexRecord } from './series-index';

/**
 * THE COLD-CACHE HARNESS — the measurement that motivated moving resolution
 * out of the views (2026-08-31): against a cold `series_index` the old
 * startup sweep materialized 5 of 30 synced series; against a warm one, 30
 * of 30. `resolveSyncedProgress` awaits the index refresh the listing
 * started, so the cache is warm by the time phase 1 runs, and phase 1 is
 * uncapped — one run must resolve every series, with no network pull left
 * for phase 2.
 *
 * Real Dexie over fake-indexeddb and the REAL `materializeHistoryRows`, so
 * the assertion is about rows that actually landed. The index refresh is the
 * one controllable seam: releasing it is what lands the 30 `series.json`
 * records, exactly as the listing-wide refresh does.
 */
vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_hole_patch_integration_test') };
});

const { progressStore } = vi.hoisted(() => {
  let value: Record<string, unknown> = {};
  const subscribers = new Set<(v: Record<string, unknown>) => void>();
  return {
    progressStore: {
      set(next: Record<string, unknown>) {
        value = next;
        subscribers.forEach((fn) => fn(value));
      },
      subscribe(fn: (v: Record<string, unknown>) => void) {
        subscribers.add(fn);
        fn(value);
        return () => subscribers.delete(fn);
      }
    }
  };
});
vi.mock('$lib/settings/volume-data', () => ({ volumes: progressStore }));
const enrichAllOrphanedVolumes = vi.fn(async () => {});
vi.mock('$lib/settings', () => ({
  get volumes() {
    return progressStore;
  },
  enrichAllOrphanedVolumes: () => enrichAllOrphanedVolumes()
}));

const openSeries = vi.fn(async (_title: string) => {});
vi.mock('$lib/metadata/series-open', () => ({ openSeries: (t: string) => openSeries(t) }));

/** The listing: every seeded series folder, with its one archive. */
let listing = new Map<string, Set<string>>();
/** The index refresh in flight; `null` = nothing running. */
let indexRefresh: Promise<void> | null = null;
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: () => ({ type: 'webdav' }),
    cloudVolumeTitlesFor: (title: string) => listing.get(title) ?? new Set<string>(),
    whenSeriesIndexesSettled: () => indexRefresh ?? Promise.resolve()
  }
}));
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: { getCache: () => ({ isLoaded: () => true }) }
}));

import { db } from '$lib/catalog/db';
import { resolveSyncedProgress } from './hole-patch';
import { resetHistoryRowsSessionForTests } from './history-rows';

const SERIES = 30;

function seriesTitle(i: number): string {
  return `Series ${String(i).padStart(2, '0')}`;
}

function indexRecord(i: number): SeriesIndexRecord {
  const title = seriesTitle(i);
  const volume: SeriesFileVolume = {
    volume_uuid: `uuid-${i}`,
    volume_title: `${title} v01`,
    page_count: 180,
    character_count: 12_000,
    mokuro_version: '0.2.1'
  };
  const file: SeriesFile = {
    version: 2,
    series_title: title,
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at: '2026-08-01T00:00:00.000Z',
    volumes: [volume]
  };
  return {
    series_key: title.toLowerCase(),
    series_title: title,
    file,
    source: {
      provider: 'webdav',
      path: `${title}/series.json`,
      size: 1,
      modifiedTime: '2026-08-01T00:00:00.000Z'
    },
    fetched_at: '2026-08-01T00:00:00.000Z'
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetHistoryRowsSessionForTests();
  await db.volumes.clear();
  await db.series_index.clear();

  // 30 series in the listing, progress synced for one volume of each, and a
  // COLD index cache: nothing in `series_index` yet.
  listing = new Map();
  const progress: Record<string, unknown> = {};
  for (let i = 0; i < SERIES; i++) {
    listing.set(seriesTitle(i), new Set([`${seriesTitle(i)} v01`]));
    progress[`uuid-${i}`] = { progress: 5, series_title: seriesTitle(i) };
  }
  progressStore.set(progress);
  indexRefresh = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveSyncedProgress against a cold index cache', () => {
  it('materializes every synced series in ONE run once the refresh lands, with no network pull', async () => {
    let landIndexes!: () => void;
    indexRefresh = new Promise<void>((resolve) => {
      landIndexes = resolve;
    }).then(async () => {
      // The listing-wide refresh landing all 30 sidecars at once.
      await db.series_index.bulkPut(Array.from({ length: SERIES }, (_, i) => indexRecord(i)));
    });

    const run = resolveSyncedProgress();
    // Nothing happens against the cold cache: the sweep is waiting.
    await Promise.resolve();
    await Promise.resolve();
    expect(await db.volumes.count()).toBe(0);

    landIndexes();
    await run;

    expect(await db.volumes.count()).toBe(SERIES);
    for (let i = 0; i < SERIES; i++) {
      const row = await db.volumes.get(`uuid-${i}`);
      expect(row?.series_title).toBe(seriesTitle(i));
      expect(row?.metadata_only).toBe(true);
    }
    // Phase 2 had nothing left to pull: every series was served locally.
    expect(openSeries).not.toHaveBeenCalled();
    // Enriched on both sides of the sweep.
    expect(enrichAllOrphanedVolumes).toHaveBeenCalledTimes(2);
  });

  it('a second run with nothing missing performs no writes and no network', async () => {
    await db.series_index.bulkPut(Array.from({ length: SERIES }, (_, i) => indexRecord(i)));
    await resolveSyncedProgress();
    expect(await db.volumes.count()).toBe(SERIES);

    openSeries.mockClear();
    const counts = await countIdbOps(async () => {
      await resolveSyncedProgress();
    });
    expect(counts['tx.volumes.readwrite'] ?? 0).toBe(0);
    expect(counts['volumes.getAll'] ?? 0).toBe(0);
    expect(openSeries).not.toHaveBeenCalled();
  });
});
