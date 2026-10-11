import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined), bulkGet: vi.fn(async () => []) },
    volume_ocr: { get: vi.fn(async () => undefined) }
  }
}));

import { get, type Readable } from 'svelte/store';
import { setTrackingStates } from '$lib/settings/tracking-data';
import { VolumeData, clearVolumes, volumes, volumesWithTrash } from '$lib/settings/volume-data';
import { HistoryDexie, historyDb } from './history-db';
import { getOrCreateDeviceId, notifyEventsRecorded } from './record';
import { _resetHistoryTurns, loadHistoryTurns } from './turns-store';
import { _resetPositionStoreForTests, initPositionOffers, ownDeviceId } from './position-store';
import {
  _countedForTests,
  _resetReadingStatsForTests,
  figuresFor,
  flushReadingStats,
  initReadingStats,
  readingStats
} from './stats-store';
import {
  BEFORE_HISTORY,
  EDITS,
  deviceStats,
  devices,
  knownDevices,
  liveDeviceFacts,
  type DeviceStatsRow
} from './device-stats';
import type { DeviceFacts, ReadingEvent } from './types';

const MIN = 60_000;
const T1 = '2026-10-01T00:00:00.000Z';
let db: HistoryDexie;
let seq = 0;

const view = (
  device: string,
  volume: string,
  t: number,
  page: number,
  chars: number,
  dwell: number
): ReadingEvent => ({
  device,
  seq: ++seq,
  t,
  kind: 'page',
  volume,
  first_page: page,
  last_page: page,
  page_chars: [chars],
  chars_before: 0,
  dwell_ms: dwell,
  layout: 'single',
  orientation: 'portrait',
  viewport: null
});

const adjust = (
  device: string,
  volume: string,
  t: number,
  ms: number,
  chars: number
): ReadingEvent => ({
  device,
  seq: ++seq,
  t,
  kind: 'adjust',
  volume,
  time_delta_ms: ms,
  chars_delta: chars
});

/** A converted page turn: `cumulative` characters read before it. */
const legacyTurn = (
  volume: string,
  t: number,
  page: number,
  cumulative: number,
  dwell: number | null
): ReadingEvent => ({
  device: `legacy:${volume}`,
  seq: ++seq,
  t,
  kind: 'page',
  volume,
  first_page: page,
  last_page: page,
  page_chars: [0],
  chars_before: cumulative,
  dwell_ms: dwell,
  layout: 'unknown',
  orientation: 'unknown',
  viewport: null
});

async function record(events: ReadingEvent[]) {
  await db.reading_events.bulkAdd(events);
  notifyEventsRecorded(events);
  await Promise.resolve();
  flushReadingStats();
}

function setRecords(records: Record<string, Partial<VolumeData>>) {
  volumesWithTrash.set(
    Object.fromEntries(Object.entries(records).map(([id, r]) => [id, new VolumeData(r)]))
  );
}

const stops: Array<() => void> = [];

/** Keep a store subscribed (a `liveQuery` behind it delivers asynchronously). */
function watch<T>(store: Readable<T>) {
  let value!: T;
  let emissions = 0;
  const stop = store.subscribe((v) => {
    value = v;
    emissions++;
  });
  stops.push(stop);
  return { latest: () => value, emissions: () => emissions };
}

const row = (over: Partial<DeviceStatsRow> & Pick<DeviceStatsRow, 'key' | 'kind'>) => ({
  members: [],
  timeMs: 0,
  readChars: 0,
  skippedChars: 0,
  sampleMs: 0,
  sampleChars: 0,
  charsPerMinute: null,
  share: 0,
  firstReadAt: null,
  lastReadAt: null,
  ...over
});

beforeEach(async () => {
  clearVolumes();
  window.localStorage.clear();
  setTrackingStates({});
  _resetHistoryTurns();
  _resetReadingStatsForTests();
  _resetPositionStoreForTests();
  await historyDb().devices.clear();
  db = new HistoryDexie(`devices-${Math.random()}`);
  await loadHistoryTurns(db);
  initReadingStats();
  flushReadingStats();
});

afterEach(() => {
  while (stops.length) stops.pop()!();
});

describe('deviceStats', () => {
  it('splits the page total by device, with Before history and Edits rows that make it add up', async () => {
    setRecords({
      v1: { legacyStats: { time_ms: 10 * MIN, chars: 2000, before: 5 * MIN } },
      v2: {}
    });
    await record([
      view('dev-a', 'v1', 0, 1, 300, 2 * MIN),
      view('dev-b', 'v1', 10 * MIN, 2, 600, 3 * MIN),
      adjust('dev-b', 'v1', 20 * MIN, MIN, 50),
      legacyTurn('v2', 30 * MIN, 1, 0, 2 * MIN),
      legacyTurn('v2', 32 * MIN, 2, 400, null)
    ]);
    const stats = get(deviceStats);
    expect(stats.rows).toEqual([
      row({
        key: 'dev-a',
        kind: 'device',
        members: ['dev-a'],
        timeMs: 2 * MIN,
        readChars: 300,
        sampleMs: 2 * MIN,
        sampleChars: 300,
        share: 2 / 16,
        firstReadAt: 0,
        lastReadAt: 2 * MIN
      }),
      row({
        key: 'dev-b',
        kind: 'device',
        members: ['dev-b'],
        timeMs: 3 * MIN,
        readChars: 600,
        sampleMs: 3 * MIN,
        sampleChars: 600,
        share: 3 / 16,
        firstReadAt: 10 * MIN,
        lastReadAt: 13 * MIN
      }),
      // v1's snapshot less the 2 min / 300 chars read before its freeze, plus
      // v2's converted turns.
      row({
        key: BEFORE_HISTORY,
        kind: 'before-history',
        timeMs: 10 * MIN,
        readChars: 2100,
        sampleMs: 2 * MIN,
        sampleChars: 400,
        share: 10 / 16,
        firstReadAt: 30 * MIN,
        lastReadAt: 32 * MIN
      }),
      row({ key: EDITS, kind: 'edits', timeMs: MIN, readChars: 50, share: 1 / 16 })
    ]);
    expect(stats.nativeGroups).toBe(2);
    const records = get(volumes);
    const pageTotal = Object.keys(records).reduce(
      (sum, id) => sum + figuresFor(get(readingStats), id, records[id]).timeMs,
      0
    );
    expect(stats.totalTimeMs).toBe(16 * MIN);
    expect(stats.totalTimeMs).toBe(pageTotal);
    expect(stats.totalChars).toBe(3050);
  });

  it('groups merged devices under their target; a label change regroups without a recount', async () => {
    setRecords({ v1: {} });
    await record([
      view('dev-a', 'v1', 0, 1, 300, 2 * MIN),
      view('dev-b', 'v1', 10 * MIN, 2, 600, 3 * MIN)
    ]);
    const counted = _countedForTests().length;
    setTrackingStates({ devices: { 'dev-b': { merged_into: 'dev-a', lastUpdated: T1 } } });
    const stats = get(deviceStats);
    expect(stats.rows).toEqual([
      row({
        key: 'dev-a',
        kind: 'device',
        members: ['dev-a', 'dev-b'],
        timeMs: 5 * MIN,
        readChars: 900,
        sampleMs: 5 * MIN,
        sampleChars: 900,
        share: 1,
        firstReadAt: 0,
        lastReadAt: 13 * MIN
      })
    ]);
    expect(stats.nativeGroups).toBe(1);
    expect(_countedForTests().length).toBe(counted);
  });

  it("shows a device's speed only from half an hour of its reading", async () => {
    setRecords({ v1: {} });
    await record([
      ...Array.from({ length: 10 }, (_, i) =>
        view('dev-a', 'v1', i * 4 * MIN, i + 1, 600, 3 * MIN)
      ),
      view('dev-b', 'v1', 60 * MIN, 20, 600, 3 * MIN)
    ]);
    const [a, b] = get(deviceStats).rows;
    expect(a).toMatchObject({ key: 'dev-a', sampleMs: 30 * MIN, charsPerMinute: 200 });
    expect(b).toMatchObject({ key: 'dev-b', sampleMs: 3 * MIN, charsPerMinute: null });
  });

  it('puts what the zero clamp takes back on the Edits row, so the rows still add up', async () => {
    setRecords({ v1: {} });
    await record([
      view('dev-a', 'v1', 0, 1, 300, 2 * MIN),
      adjust('dev-a', 'v1', MIN, -10 * MIN, -1000)
    ]);
    const stats = get(deviceStats);
    expect(stats.rows.map((r) => [r.key, r.timeMs, r.readChars, r.share])).toEqual([
      ['dev-a', 2 * MIN, 300, 0],
      [EDITS, -2 * MIN, -300, 0]
    ]);
    expect(stats.totalTimeMs).toBe(0);
    expect(stats.totalChars).toBe(0);
  });

  it('has no Before history or Edits row when they hold nothing', async () => {
    setRecords({ v1: {} });
    await record([view('dev-a', 'v1', 0, 1, 300, 2 * MIN)]);
    expect(get(deviceStats).rows.map((r) => r.key)).toEqual(['dev-a']);
  });

  it('counts only volumes the page counts (those with a record)', async () => {
    await record([view('dev-a', 'gone', 0, 1, 300, 2 * MIN)]);
    expect(get(deviceStats)).toMatchObject({ rows: [], nativeGroups: 0, totalTimeMs: 0 });
  });
});

describe('known devices', () => {
  const phone: DeviceFacts = {
    device: 'dev-x',
    class: 'phone',
    os: 'Android',
    first_seen: '2026-03-02T00:00:00.000Z',
    last_seen: '2026-10-01T00:00:00.000Z'
  };

  it('are the facts rows and every device with events, never converted turns', async () => {
    const known = watch(knownDevices);
    await historyDb().devices.put(phone);
    const may = Date.UTC(2026, 4, 1);
    await record([
      view('dev-a', 'v1', may + MIN, 2, 300, MIN),
      view('dev-a', 'v1', may, 1, 300, MIN),
      view('dev-x', 'v1', may + 2 * MIN, 3, 300, MIN),
      legacyTurn('v1', 0, 1, 0, MIN)
    ]);
    await vi.waitFor(() =>
      expect(known.latest()).toEqual([
        { id: 'dev-a', facts: { class: 'unknown' }, firstSeen: new Date(may).toISOString() },
        { id: 'dev-x', facts: { class: 'phone', os: 'Android' }, firstSeen: phone.first_seen }
      ])
    );
  });

  it('do not re-emit when a page turn changes nothing about them', async () => {
    const known = watch(knownDevices);
    await record([view('dev-a', 'v1', 0, 1, 300, MIN)]);
    await vi.waitFor(() => expect(known.latest().map((d) => d.id)).toEqual(['dev-a']));
    const before = known.emissions();
    await record([view('dev-a', 'v1', 5 * MIN, 2, 300, MIN)]);
    expect(known.emissions()).toBe(before);
  });

  it('are labelled, with this device marked', async () => {
    await initPositionOffers(db);
    const own = await getOrCreateDeviceId(db);
    const labelled = watch(devices);
    await historyDb().devices.put(phone);
    await record([view(own, 'v1', 0, 1, 300, MIN)]);
    await vi.waitFor(() => expect(labelled.latest().size).toBe(2));
    expect(labelled.latest().get(own)).toMatchObject({
      label: 'Unknown device',
      isThisDevice: true
    });
    expect(labelled.latest().get('dev-x')).toMatchObject({
      label: 'Phone · Android',
      isThisDevice: false
    });
    setTrackingStates({ devices: { [own]: { name: 'Kitchen tablet', lastUpdated: T1 } } });
    expect(labelled.latest().get(own)).toMatchObject({ label: 'Kitchen tablet', named: true });
  });

  it('mark this device once its id arrives, without reordering anything', async () => {
    const own = await getOrCreateDeviceId(db);
    const labelled = watch(devices);
    const stats = watch(deviceStats);
    setRecords({ v1: {} });
    await historyDb().devices.put(phone);
    await record([view('dev-x', 'v1', 0, 1, 300, MIN), view(own, 'v1', 5 * MIN, 2, 300, MIN)]);
    await vi.waitFor(() => expect(labelled.latest().size).toBe(2));
    // Before `initPositionOffers` resolves the id is null: nothing is this device.
    expect(get(ownDeviceId)).toBeNull();
    expect([...labelled.latest().values()].some((d) => d.isThisDevice)).toBe(false);
    const order = [...labelled.latest().keys()];
    const rows = stats.latest().rows.map((r) => r.key);
    await initPositionOffers(db);
    expect(labelled.latest().get(own)).toMatchObject({ isThisDevice: true });
    expect(labelled.latest().get('dev-x')).toMatchObject({ isThisDevice: false });
    expect([...labelled.latest().keys()]).toEqual(order);
    expect(stats.latest().rows.map((r) => r.key)).toEqual(rows);
  });

  it('liveDeviceFacts follows the devices table', async () => {
    const local = new HistoryDexie(`facts-${Math.random()}`);
    const facts = watch(liveDeviceFacts(async () => local));
    expect(facts.latest()).toEqual([]);
    await local.devices.put(phone);
    await vi.waitFor(() => expect(facts.latest()).toEqual([phone]));
    await local.devices.update('dev-x', { class: 'tablet' });
    await vi.waitFor(() => expect(facts.latest()[0].class).toBe('tablet'));
  });
});
