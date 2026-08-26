import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

let progress: Record<string, { series_title?: string; deletedOn?: string }> = {};
/**
 * The pass that copies a `volumes` row onto the READING RECORD. Doubled here so
 * this suite can watch WHEN it runs relative to the sweep — which is the whole
 * of `patchProgressHolesAndEnrich`'s contract — and, more to the point, what
 * the local rows look like by the time it does.
 */
const enrichAllOrphanedVolumes = vi.fn(async () => {});
vi.mock('$lib/settings', () => ({
  get volumes() {
    return readable(progress);
  },
  enrichAllOrphanedVolumes: () => enrichAllOrphanedVolumes()
}));

let localRows: Array<{ volume_uuid: string; series_title: string }> = [];
const uniqueKeysFor = vi.fn((index: string) => {
  // The production call reads the `series_title` INDEX, never the table: a
  // mock that answered any index name would let a change back to a full
  // `toArray()` scan pass unnoticed.
  if (index !== 'series_title') throw new Error(`unexpected index: ${index}`);
  return [...new Set(localRows.map((row) => row.series_title))];
});
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      orderBy: (index: string) => ({ uniqueKeys: async () => uniqueKeysFor(index) })
    }
  }
}));

let indexes: Array<{ series_key: string }> = [];
const listSeriesIndexes = vi.fn(async () => indexes);
vi.mock('$lib/metadata/series-index', () => ({
  listSeriesIndexes: () => listSeriesIndexes()
}));

const openSeries = vi.fn(async (_title: string) => {});
vi.mock('$lib/metadata/series-open', () => ({ openSeries: (t: string) => openSeries(t) }));

// Phase 1 has its own suite (`history-rows.test.ts`); here it is stubbed so
// these cases stay about phase 2's planning, EXCEPT where a case asserts the
// hand-off between the two.
type SweepOptions = { readIndexes?: () => Promise<unknown[]> };
const materializeHistoryRows = vi.fn(async (_options?: SweepOptions) => 0);
vi.mock('$lib/metadata/history-rows', () => ({
  materializeHistoryRows: (options?: SweepOptions) => materializeHistoryRows(options)
}));

// Connected + loaded by default so the existing behavioural tests don't need
// to know about the listing gate; the gate-specific tests flip these.
let activeProvider: { type: string } | null = { type: 'google-drive' };
const getActiveProvider = vi.fn(() => activeProvider);
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider: () => getActiveProvider() }
}));

let cacheLoaded = true;
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: { getCache: () => ({ isLoaded: () => cacheLoaded }) }
}));

import {
  patchProgressHoles,
  patchProgressHolesAndEnrich,
  resetHolePatchSessionForTests
} from './hole-patch';

beforeEach(() => {
  vi.clearAllMocks();
  progress = {};
  localRows = [];
  indexes = [];
  activeProvider = { type: 'google-drive' };
  cacheLoaded = true;
  materializeHistoryRows.mockImplementation(async () => 0);
  enrichAllOrphanedVolumes.mockImplementation(async () => {});
  resetHolePatchSessionForTests();
});

describe('patchProgressHoles', () => {
  it('pulls a series that progress references but nothing local knows', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    await expect(patchProgressHoles()).resolves.toEqual(['Dr Stone']);
    expect(openSeries).toHaveBeenCalledWith('Dr Stone');
  });

  it('ignores a series that already has a local row', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    localRows = [{ volume_uuid: 'uuid-1', series_title: 'Dr Stone' }];
    await expect(patchProgressHoles()).resolves.toEqual([]);
  });

  it('ignores a series whose index is already cached', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    indexes = [{ series_key: 'dr stone' }];
    await expect(patchProgressHoles()).resolves.toEqual([]);
  });

  it('ignores tombstones and records with no series title', async () => {
    progress = {
      'uuid-1': { series_title: 'Deleted', deletedOn: '2026-08-01T00:00:00.000Z' },
      'uuid-2': {},
      'uuid-3': { series_title: '   ' }
    };
    await expect(patchProgressHoles()).resolves.toEqual([]);
    expect(openSeries).not.toHaveBeenCalled();
  });

  it('de-duplicates by series and caps the run', async () => {
    progress = {
      a: { series_title: 'One' },
      b: { series_title: 'one' },
      c: { series_title: 'Two' },
      d: { series_title: 'Three' }
    };
    const pulled = await patchProgressHoles({ limit: 2 });
    expect(pulled).toHaveLength(2);
    expect(openSeries).toHaveBeenCalledTimes(2);
  });

  it('never rejects when an open fails', async () => {
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    openSeries.mockRejectedValueOnce(new Error('offline'));
    await expect(patchProgressHoles()).resolves.toEqual([]);
  });

  it('does not re-attempt a series already tried this session, even if it is still a hole', async () => {
    // Nothing in localRows/indexes ever appears for this title — as if the
    // series is genuinely absent from the cloud (or the device is offline).
    progress = { 'uuid-1': { series_title: 'Ghost Series' } };

    await expect(patchProgressHoles()).resolves.toEqual(['Ghost Series']);
    expect(openSeries).toHaveBeenCalledTimes(1);

    // A later catalog open re-runs the patcher against the same still-dangling
    // progress record; it must not call openSeries again this session.
    await expect(patchProgressHoles()).resolves.toEqual([]);
    expect(openSeries).toHaveBeenCalledTimes(1);
  });

  it('does not count an attempt left off by the run cap against the session memory', async () => {
    progress = {
      a: { series_title: 'One' },
      b: { series_title: 'Two' }
    };
    const first = await patchProgressHoles({ limit: 1 });
    expect(first).toEqual(['One']);
    expect(openSeries).toHaveBeenCalledTimes(1);

    // 'Two' was deferred by the cap, not attempted — it must still be picked
    // up on the next run.
    const second = await patchProgressHoles({ limit: 1 });
    expect(second).toEqual(['Two']);
    expect(openSeries).toHaveBeenCalledTimes(2);
  });

  it('is a no-op and memoizes nothing when no provider is connected yet, then pulls once one connects', async () => {
    // CatalogView's onMount can fire before initializeProviders() has
    // authenticated anything — openSeries would no-op with zero I/O in that
    // window, so the run must bail before it, not memoize the title as
    // "attempted".
    activeProvider = null;
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };

    await expect(patchProgressHoles()).resolves.toEqual([]);
    expect(openSeries).not.toHaveBeenCalled();

    // Provider connects (e.g. initializeProviders() finishes); the same
    // still-dangling record must now be picked up, proving nothing was
    // memoized while the provider was absent.
    activeProvider = { type: 'google-drive' };
    await expect(patchProgressHoles()).resolves.toEqual(['Dr Stone']);
    expect(openSeries).toHaveBeenCalledTimes(1);
  });

  it('is a no-op and memoizes nothing when the provider is connected but its listing has not loaded yet, then pulls once the listing loads', async () => {
    // Mirrors initializeCurrentProvider() flipping the provider non-null
    // before fetchAllCloudVolumes() resolves: getActiveProvider() is already
    // truthy here, but the cache reports not-yet-loaded — the SAME window
    // where refreshSeriesIndexForSeries's own `cloudVolumeTitlesFor(...).size
    // === 0` early return would make openSeries a silent no-op if the run
    // weren't gated on the listing itself.
    cacheLoaded = false;
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };

    await expect(patchProgressHoles()).resolves.toEqual([]);
    expect(openSeries).not.toHaveBeenCalled();

    // Listing finishes loading (fetchAllCloudVolumes() resolves); the same
    // still-dangling record must now be picked up, proving nothing was
    // memoized while the listing was unloaded.
    cacheLoaded = true;
    await expect(patchProgressHoles()).resolves.toEqual(['Dr Stone']);
    expect(openSeries).toHaveBeenCalledTimes(1);
  });

  it('stops attempting mid-run if the provider drops, without memoizing the untried titles', async () => {
    progress = {
      a: { series_title: 'One' },
      b: { series_title: 'Two' }
    };
    // Disconnect right after the first attempt starts.
    openSeries.mockImplementationOnce(async (_title: string) => {
      activeProvider = null;
    });

    const pulled = await patchProgressHoles();
    expect(pulled).toEqual(['One']);
    expect(openSeries).toHaveBeenCalledTimes(1);

    // 'Two' was never attempted (provider dropped before its turn), so it is
    // not memoized — reconnecting must let it through on the next run.
    activeProvider = { type: 'google-drive' };
    const second = await patchProgressHoles();
    expect(second).toEqual(['Two']);
  });

  describe('phase 1 hand-off', () => {
    it('runs the local row sweep before planning any network pull', async () => {
      // Phase 1 mints the row; phase 2 must therefore see the series as
      // already covered and ask for nothing. Ordering is the whole assertion:
      // a sweep run AFTER the plan was built would leave `openSeries` called.
      progress = { 'uuid-1': { series_title: 'Dr Stone' } };
      materializeHistoryRows.mockImplementation(async () => {
        localRows = [{ volume_uuid: 'uuid-1', series_title: 'Dr Stone' }];
        return 1;
      });

      await expect(patchProgressHoles()).resolves.toEqual([]);
      expect(materializeHistoryRows).toHaveBeenCalledTimes(1);
      expect(openSeries).not.toHaveBeenCalled();
    });

    it('still falls back to a network pull for a series the local sweep could not serve', async () => {
      progress = { 'uuid-1': { series_title: 'Dr Stone' } };
      // Sweep ran and wrote nothing — no cached index for this series.
      await expect(patchProgressHoles()).resolves.toEqual(['Dr Stone']);
      expect(materializeHistoryRows).toHaveBeenCalledTimes(1);
      expect(openSeries).toHaveBeenCalledWith('Dr Stone');
    });

    it('does not run the local sweep before the cloud listing has loaded', async () => {
      // Phase 1 reads the listing to decide which volumes still exist, so
      // running it in the pre-listing window would burn a pass that can only
      // conclude "nothing".
      cacheLoaded = false;
      progress = { 'uuid-1': { series_title: 'Dr Stone' } };

      await expect(patchProgressHoles()).resolves.toEqual([]);
      expect(materializeHistoryRows).not.toHaveBeenCalled();
    });

    it('contains a local sweep that throws to that run — aborting phase 2, never the next run', async () => {
      // NAMED FOR WHAT IT CHECKS. A sweep rejection propagates to the run's own
      // try/catch, so phase 2 is abandoned for THAT run — `openSeries` is not
      // called, which is the assertion below. What survives is the session: the
      // title was never memoized as attempted, so the very next run pulls it.
      progress = { 'uuid-1': { series_title: 'Dr Stone' } };
      materializeHistoryRows.mockRejectedValueOnce(new Error('idb exploded'));

      await expect(patchProgressHoles()).resolves.toEqual([]);
      expect(openSeries).not.toHaveBeenCalled();

      await expect(patchProgressHoles()).resolves.toEqual(['Dr Stone']);
      expect(openSeries).toHaveBeenCalledWith('Dr Stone');
    });
  });

  it('reads the cached series indexes ONCE for the whole run, not once per phase', async () => {
    // Both phases want the same list and neither can invalidate it — phase 1
    // writes only to `volumes`. They used to issue a `series_index.getAll`
    // each. The double forwards the reader the production code injects, so a
    // regression to a private `listSeriesIndexes()` call in either phase shows
    // up here as two.
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    materializeHistoryRows.mockImplementation(async (options?: SweepOptions) => {
      // Throwing rather than shrugging: if production stops passing the shared
      // reader, `options?.readIndexes?.()` would quietly read nothing and the
      // count below would still be 1 — the assertion satisfied by both
      // branches. The throw makes that case fail the `pulled` assertion.
      if (!options?.readIndexes) throw new Error('phase 1 was not given the shared index reader');
      await options.readIndexes();
      return 0;
    });

    await expect(patchProgressHoles()).resolves.toEqual(['Dr Stone']);
    // Both phases really did ask (the run reached phase 2's index check —
    // otherwise "one read" would be true of a run that only ever had one
    // asker).
    expect(materializeHistoryRows).toHaveBeenCalledTimes(1);
    expect(openSeries).toHaveBeenCalledWith('Dr Stone');
    expect(listSeriesIndexes).toHaveBeenCalledTimes(1);
  });

  it('reads nothing at all on a re-run whose titles are all already memoized', async () => {
    // Why the shared reader is LAZY rather than fetched once up front: a run
    // that bails before either phase wants the indexes must still issue no
    // `series_index` read, and this page's caller re-runs on every mount.
    progress = { 'uuid-1': { series_title: 'Ghost Series' } };
    await expect(patchProgressHoles()).resolves.toEqual(['Ghost Series']);
    expect(listSeriesIndexes).toHaveBeenCalledTimes(1);

    listSeriesIndexes.mockClear();
    await expect(patchProgressHoles()).resolves.toEqual([]);
    expect(listSeriesIndexes).not.toHaveBeenCalled();
  });

  describe('patchProgressHolesAndEnrich', () => {
    it('runs the enrichment AGAIN after the sweep, where it can see the rows the sweep wrote', async () => {
      // The bug this exists to prevent: `ReadingSpeedView` enriched first and
      // fired the sweep off un-awaited, so the rows the sweep minted reached
      // the reading records — and therefore the `[Missing Series Info]` bucket
      // and its trash button — for no part of that visit.
      const order: string[] = [];
      const rowsSeen: string[][] = [];
      progress = { 'uuid-1': { series_title: 'Dr Stone' } };

      enrichAllOrphanedVolumes.mockImplementation(async () => {
        order.push('enrich');
        rowsSeen.push(localRows.map((row) => row.volume_uuid));
      });
      materializeHistoryRows.mockImplementation(async () => {
        order.push('sweep');
        localRows = [{ volume_uuid: 'uuid-1', series_title: 'Dr Stone' }];
        return 1;
      });

      await patchProgressHolesAndEnrich();

      expect(order).toEqual(['enrich', 'sweep', 'enrich']);
      // Not just "twice" — the SECOND pass must observe the sweep's write.
      expect(rowsSeen[0]).toEqual([]);
      expect(rowsSeen[1]).toEqual(['uuid-1']);
    });

    it('keeps sweeping when the FIRST enrichment throws, and still enriches after', async () => {
      // Guarded per pass, not around the sequence: the second pass is the one
      // that closes the window, so a failure in the first must not cost it.
      progress = { 'uuid-1': { series_title: 'Dr Stone' } };
      enrichAllOrphanedVolumes.mockRejectedValueOnce(new Error('idb exploded'));

      await expect(patchProgressHolesAndEnrich()).resolves.toEqual(['Dr Stone']);
      expect(materializeHistoryRows).toHaveBeenCalledTimes(1);
      expect(enrichAllOrphanedVolumes).toHaveBeenCalledTimes(2);
    });

    it('never rejects when the SECOND enrichment throws, and still returns what was pulled', async () => {
      progress = { 'uuid-1': { series_title: 'Dr Stone' } };
      enrichAllOrphanedVolumes
        .mockImplementationOnce(async () => {})
        .mockRejectedValueOnce(new Error('idb exploded'));

      await expect(patchProgressHolesAndEnrich()).resolves.toEqual(['Dr Stone']);
    });
  });

  it('reads the local series titles off the index, never by scanning the table', async () => {
    // A `volumes` scan deserializes every installed volume's thumbnail blob to
    // answer a question about keys. `uniqueKeysFor` throws on any index but
    // `series_title`, so this fails loudly if the read moves.
    progress = { 'uuid-1': { series_title: 'Dr Stone' } };
    localRows = [{ volume_uuid: 'uuid-1', series_title: 'Dr Stone' }];

    await expect(patchProgressHoles()).resolves.toEqual([]);
    expect(uniqueKeysFor).toHaveBeenCalledWith('series_title');
  });
});
