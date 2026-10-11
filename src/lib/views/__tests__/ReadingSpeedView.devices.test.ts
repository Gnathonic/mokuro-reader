import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import type { PauseReview } from '$lib/reading-history/pause-review';
import type { DeviceStats, DeviceStatsRow } from '$lib/reading-history/device-stats';
import type { DeviceView } from '$lib/reading-history/devices';

const { catalogVolumes, reviewStore, rowsStore, devicesStore } = vi.hoisted(() => {
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
    reviewStore: createStore<PauseReview>({ pauses: [], unanswered: 0, answered: 0 }),
    rowsStore: createStore<DeviceStats>({
      rows: [],
      totalTimeMs: 0,
      totalChars: 0,
      nativeGroups: 0
    }),
    devicesStore: createStore<Map<string, DeviceView>>(new Map())
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
vi.mock('$lib/reading-history/device-stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/reading-history/device-stats')>();
  return { ...actual, deviceStats: rowsStore, devices: devicesStore };
});

import ReadingSpeedView from '$lib/views/ReadingSpeedView.svelte';
import { volumesWithTrash } from '$lib/settings/volume-data';

const MIN = 60_000;

const deviceView = (id: string, over: Partial<DeviceView> = {}): DeviceView => ({
  id,
  label: `Label ${id}`,
  generated: `Label ${id}`,
  named: false,
  class: 'desktop',
  detectedClass: 'desktop',
  isThisDevice: false,
  canonical: id,
  mergedFrom: [],
  firstSeen: '2026-03-01T00:00:00.000Z',
  ...over
});
const deviceRow = (id: string): DeviceStatsRow => ({
  key: id,
  kind: 'device',
  members: [id],
  timeMs: 30 * MIN,
  readChars: 3000,
  skippedChars: 0,
  sampleMs: 0,
  sampleChars: 0,
  charsPerMinute: null,
  share: 0.5,
  firstReadAt: null,
  lastReadAt: null
});
const statsOf = (rows: DeviceStatsRow[]): DeviceStats => ({
  rows,
  totalTimeMs: rows.reduce((s, r) => s + r.timeMs, 0),
  totalChars: rows.reduce((s, r) => s + r.readChars, 0),
  nativeGroups: rows.filter((r) => r.kind === 'device').length
});

beforeEach(() => {
  window.localStorage.clear();
  volumesWithTrash.set({});
  catalogVolumes.set({});
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
  rowsStore.set(statsOf([]));
  devicesStore.set(new Map());
});
afterEach(cleanup);

describe('ReadingSpeedView devices', () => {
  it('shows no device banner or device card for a single device', () => {
    devicesStore.set(new Map([['me', deviceView('me', { isThisDevice: true })]]));
    rowsStore.set(statsOf([deviceRow('me')]));
    render(ReadingSpeedView);
    expect(screen.queryByTestId('device-banner')).toBeNull();
    expect(screen.queryByTestId('device-stats')).toBeNull();
  });

  it('asks right under the heading, and lists devices after the long pauses', async () => {
    devicesStore.set(
      new Map([
        ['me', deviceView('me', { isThisDevice: true })],
        ['b', deviceView('b')]
      ])
    );
    rowsStore.set(statsOf([deviceRow('me'), deviceRow('b')]));
    render(ReadingSpeedView);
    const banner = await screen.findByTestId('device-banner');
    const heading = screen.getByRole('heading', { level: 1, name: 'Reading Speed History' });
    expect(heading.nextElementSibling).toBe(banner);
    const pauses = screen.getByTestId('long-pauses');
    const card = screen.getByTestId('device-stats');
    expect(pauses.nextElementSibling).toBe(card);
    expect(screen.getAllByTestId('device-row')).toHaveLength(2);
  });
});
