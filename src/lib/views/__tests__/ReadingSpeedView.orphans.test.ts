import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, within } from '@testing-library/svelte';
import { get, readable } from 'svelte/store';

/**
 * THE `[Missing Series Info]` ROW AND ITS TRASH BUTTON.
 *
 * This page is where a reading record with no series metadata becomes visible
 * — collapsed into one fake `[Missing Series Info]` series — and it is the only
 * surface in the app that offers such records for DELETION. `deletedOn` syncs,
 * so a click here is irreversible on every device the user owns. Two things
 * therefore have to hold, and neither is visible to a unit test of any single
 * module:
 *
 * 1. The repair has to reach the orphan set. `patchProgressHolesAndEnrich`
 *    mints rows and then copies them onto the reading records; if the page's
 *    orphan set does not reflect that by the time the user can click, a volume
 *    the app JUST resolved is still sitting in the bucket being offered up.
 * 2. The button has to act on the row it is in. It is revealed by one row of
 *    the "Speed by Series" table and used to hand the whole store's orphan list
 *    to `clearOrphanedVolumeData`.
 *
 * So the component is rendered for real, over the REAL `volume-data` store and
 * the REAL `patchProgressHolesAndEnrich`. Only the edges are doubled: the
 * catalog liveQuery, Chart.js, and the four modules the hole patcher talks to
 * (the row sweep, the index cache, `openSeries`, the cloud listing). A double
 * for `patchProgressHolesAndEnrich` itself would make case 1 vacuous — the
 * ordering IS the thing under test.
 */

const { catalogVolumes } = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    const subs = new Set<(v: T) => void>();
    let current = initial;
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(current);
        return () => subs.delete(fn);
      },
      set(v: T) {
        current = v;
        subs.forEach((fn) => fn(current));
      }
    };
  }
  return { catalogVolumes: createStore<Record<string, unknown>>({}) };
});
vi.mock('$lib/catalog', () => ({ volumes: catalogVolumes }));

/** The `volumes` table the sweep writes into and the enrichment reads back. */
let rows = new Map<string, Record<string, unknown>>();
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: async (uuid: string) => rows.get(uuid),
      bulkGet: async (uuids: string[]) => uuids.map((uuid) => rows.get(uuid)),
      orderBy: (index: string) => ({
        uniqueKeys: async () => {
          if (index !== 'series_title') throw new Error(`unexpected index: ${index}`);
          return [...new Set([...rows.values()].map((row) => row.series_title))];
        }
      })
    }
  }
}));

/**
 * Phase 1 of the hole patcher, doubled at the seam where it WRITES. Its own
 * behaviour has its own suite (`history-rows.test.ts`); what matters here is
 * that a row it writes is reflected on this page before the user can act.
 */
const materializeHistoryRows = vi.fn(async () => 0);
vi.mock('$lib/metadata/history-rows', () => ({
  materializeHistoryRows: () => materializeHistoryRows()
}));
vi.mock('$lib/metadata/series-index', () => ({ listSeriesIndexes: async () => [] }));
vi.mock('$lib/metadata/series-open', () => ({ openSeries: vi.fn(async () => {}) }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: () => ({ type: 'google-drive' }),
    // Already loaded, matching `cacheManager.isLoaded()` below being `true`
    // from the start: `patchProgressHolesWhenListingReady` subscribes to
    // this, and its own "already loaded at mount" fast path is what this
    // suite exercises — a real retry is `hole-patch.test.ts`'s job.
    cloudFiles: readable(new Map([['Dr Stone', [{}]]]))
  }
}));
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: { getCache: () => ({ isLoaded: () => true }) }
}));

vi.mock('chart.js/auto', () => ({
  default: class {
    destroy() {}
    update() {}
  }
}));

import ReadingSpeedView from '$lib/views/ReadingSpeedView.svelte';
import { VolumeData, volumes, volumesWithTrash } from '$lib/settings/volume-data';

/** A record that clears `processVolumeSpeedData`'s filters, so it is SPEED-TRACKED. */
function speedTracked(over: Partial<VolumeData> = {}) {
  return new VolumeData({
    completed: true,
    progress: 180,
    chars: 5000,
    timeReadInMinutes: 100,
    lastProgressUpdate: '2026-08-01T00:00:00.000Z',
    ...over
  });
}

/** Marked as read but with no time recorded — an orphan the speed table never lists. */
function markedOnly(over: Partial<VolumeData> = {}) {
  return new VolumeData({
    completed: true,
    chars: 5000,
    lastProgressUpdate: '2026-08-01T00:00:00.000Z',
    ...over
  });
}

function seriesRow(title: string): HTMLElement | undefined {
  return screen
    .getAllByRole('row')
    .find((row) => row.textContent?.includes(title) && row.textContent?.includes('cpm'));
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = new Map();
  materializeHistoryRows.mockImplementation(async () => 0);
  volumesWithTrash.set({});
  catalogVolumes.set({});
});

afterEach(() => {
  cleanup();
  volumesWithTrash.set({});
});

describe('ReadingSpeedView orphan bucket', () => {
  it('drops a volume the sweep resolved out of the orphan bucket during the same visit', async () => {
    // The reported shape: read on another device, so this one holds progress
    // and no row at all.
    volumesWithTrash.set({ 'uuid-swept': speedTracked() });
    // The sweep mints the row mid-visit — exactly what `materializeHistoryRows`
    // does from the cached indexes.
    materializeHistoryRows.mockImplementation(async () => {
      rows.set('uuid-swept', {
        volume_uuid: 'uuid-swept',
        series_uuid: 'series-swept',
        series_title: 'Swept Series',
        volume_title: 'Swept Series v01'
      });
      return 1;
    });

    render(ReadingSpeedView);

    // The load-bearing assertion is the page's own orphan bucket, not the
    // store: the fake series must be gone and its trash button with it — a
    // volume the app just resolved must not still be offered for deletion for
    // the rest of the visit.
    await vi.waitFor(() => {
      expect(seriesRow('[Missing Series Info]')).toBeUndefined();
    });
    expect(seriesRow('Swept Series')).toBeDefined();
    expect(get(volumes)['uuid-swept'].series_title).toBe('Swept Series');
  });

  it('still shows the bucket for a volume the sweep could NOT resolve', async () => {
    // The negative control for the case above: without it, "the bucket is
    // empty" would pass on a page that never renders a bucket at all.
    volumesWithTrash.set({ 'uuid-unresolved': speedTracked() });

    render(ReadingSpeedView);

    await vi.waitFor(() => {
      expect(materializeHistoryRows).toHaveBeenCalled();
    });
    const row = await vi.waitFor(() => {
      const found = seriesRow('[Missing Series Info]');
      expect(found).toBeDefined();
      return found!;
    });
    expect(within(row).getAllByRole('button').length).toBe(1);
  });

  it('deletes only the clicked row bucket, never every orphan in the store', async () => {
    volumesWithTrash.set({
      // In the clicked bucket: orphaned AND speed-tracked.
      'uuid-bucket-1': speedTracked(),
      'uuid-bucket-2': speedTracked({ chars: 4000, timeReadInMinutes: 80 }),
      // Orphaned but NOT in that row — no speed data, so the series table never
      // lists them. These are the 456 the button used to take with it.
      'uuid-elsewhere-1': markedOnly(),
      'uuid-elsewhere-2': markedOnly(),
      'uuid-elsewhere-3': new VolumeData({ progress: 12, chars: 900 })
    });

    render(ReadingSpeedView);

    const row = await vi.waitFor(() => {
      const found = seriesRow('[Missing Series Info]');
      expect(found).toBeDefined();
      return found!;
    });
    await fireEvent.click(within(row).getAllByRole('button')[0]);

    const confirm = await screen.findByText(/Yes, Remove/);
    // The confirmation has to name the scope it will actually act on.
    expect(confirm.textContent).toMatch(/Yes, Remove 2 volumes/);
    await fireEvent.click(confirm);

    const after = get(volumesWithTrash);
    expect(after['uuid-bucket-1'].deletedOn).toBeTruthy();
    expect(after['uuid-bucket-2'].deletedOn).toBeTruthy();
    for (const id of ['uuid-elsewhere-1', 'uuid-elsewhere-2', 'uuid-elsewhere-3']) {
      expect(after[id].deletedOn).toBeUndefined();
      expect(after[id].chars).toBeGreaterThan(0);
    }
  });

  it('does not count a volume genuinely titled "Volume 3" among the orphans', async () => {
    // The predicate used to end in `volume_title.startsWith('Volume ')`, which
    // is a perfectly ordinary mokuro volume title — so this fully-populated
    // record counted as an orphan forever. The count in the confirmation dialog
    // is where that is observable from here (and, before this round, it was
    // also in the list the button deleted).
    volumesWithTrash.set({
      'uuid-bucket': speedTracked(),
      // One genuine orphan outside the clicked row.
      'uuid-orphan-elsewhere': markedOnly(),
      // Fully populated. An orphan only under the dropped clause.
      'uuid-vol3': speedTracked({
        series_uuid: 'series-real',
        series_title: 'Real Series',
        volume_title: 'Volume 3'
      })
    });

    render(ReadingSpeedView);

    const row = await vi.waitFor(() => {
      const found = seriesRow('[Missing Series Info]');
      expect(found).toBeDefined();
      return found!;
    });
    // Its own row is drawn from its real series, with no trash button on it.
    expect(within(seriesRow('Real Series')!).queryAllByRole('button').length).toBe(0);

    await fireEvent.click(within(row).getAllByRole('button')[0]);

    // ONE other orphan, not two: `uuid-vol3` is not one.
    const others = await screen.findByText(/other volume\(s\)/);
    expect(others.textContent).toMatch(/\b1 other volume\(s\)/);
    expect(others.textContent).not.toMatch(/\b2 other volume\(s\)/);
  });
});
