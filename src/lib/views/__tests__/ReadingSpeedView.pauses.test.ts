import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import type { PauseReview } from '$lib/reading-history/pause-review';

const { catalogVolumes, reviewStore } = vi.hoisted(() => {
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
  return {
    catalogVolumes: createStore<Record<string, unknown>>({}),
    // Built here, not in the mock factory: the factory only runs once something imports the module.
    reviewStore: createStore<PauseReview>({ pauses: [], unanswered: 0, answered: 0 })
  };
});
vi.mock('$lib/catalog', () => ({ volumes: catalogVolumes }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: async () => undefined,
      bulkGet: async (uuids: string[]) => uuids.map(() => undefined),
      orderBy: () => ({ uniqueKeys: async () => [] })
    }
  }
}));
vi.mock('$lib/metadata/history-rows', () => ({ materializeHistoryRows: async () => 0 }));
vi.mock('$lib/metadata/series-index', () => ({ listSeriesIndexes: async () => [] }));
vi.mock('$lib/metadata/series-open', () => ({ openSeries: vi.fn(async () => {}) }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: () => ({ type: 'google-drive' }),
    cloudFiles: readable(new Map()),
    whenSeriesIndexesSettled: () => Promise.resolve()
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

vi.mock('$lib/reading-history/pause-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/reading-history/pause-review')>();
  return { ...actual, pauseReview: reviewStore };
});

import ReadingSpeedView from '$lib/views/ReadingSpeedView.svelte';
import { volumesWithTrash } from '$lib/settings/volume-data';

const MIN = 60_000;

beforeEach(() => {
  volumesWithTrash.set({});
  catalogVolumes.set({});
  reviewStore.set({ pauses: [], unanswered: 0, answered: 0 });
});
afterEach(cleanup);

describe('ReadingSpeedView long pauses', () => {
  it('shows no review card without pauses', () => {
    render(ReadingSpeedView);
    expect(screen.queryByText(/Long pauses to review/)).toBeNull();
  });

  it('lists long pauses on the stats page, titled from the catalog', async () => {
    catalogVolumes.set({
      v1: { volume_uuid: 'v1', series_title: 'Dr Stone', volume_title: 'Dr Stone 01' }
    });
    reviewStore.set({
      pauses: [
        {
          volume: 'v1',
          device: 'dev-a',
          seq: 1,
          t: Date.now() - MIN,
          page: 4,
          dwell: 12 * MIN,
          cap: 5 * MIN,
          typical: 4 * MIN,
          counted: 4 * MIN,
          answer: null
        }
      ],
      unanswered: 1,
      answered: 0
    });
    render(ReadingSpeedView);
    expect(await screen.findByText('Long pauses to review (1)')).toBeTruthy();
    expect(screen.getByText('Dr Stone — Dr Stone 01')).toBeTruthy();
  });
});
