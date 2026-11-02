import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { HistoryDexie } from './history-db';
import { lastReadFromEvents, lastReadTime, lastReadTimes, seriesLastRead } from './last-read';
import { notifyEventsRecorded } from './record';
import { _resetHistoryTurns, loadHistoryTurns } from './turns-store';
import { _resetRemoteReadsForTests, noteRemoteRead } from './remote-reads';
import type { ReadingEvent } from './types';

let seq = 0;
const view = (
  t: number,
  page: number,
  dwell: number,
  { device = 'dev-a', volume = 'vol', chars = 300 } = {}
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
/** Home p.40, a quick peek at p.41, back to p.40. */
const lookup = (t: number, volume = 'vol') => [
  view(t, 40, 20_000, { volume }),
  view(t + 21_000, 41, 800, { volume }),
  view(t + 22_000, 40, 1000, { volume })
];
const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

describe('lastReadFromEvents', () => {
  it('a look-up never moves last read; reading does', () => {
    const reading = [view(0, 39, 20_000), view(21_000, 40, 20_000)];
    expect(lastReadFromEvents(reading)?.at).toBe(41_000);
    expect(lastReadFromEvents([...reading, ...lookup(HOUR)])?.at).toBe(41_000);
    const later = [view(2 * HOUR, 40, 20_000), view(2 * HOUR + 21_000, 41, 20_000)];
    expect(lastReadFromEvents([...reading, ...lookup(HOUR), ...later])?.at).toBe(2 * HOUR + 41_000);
  });

  it('legacy views count; no events → null; only look-ups → 0', () => {
    expect(lastReadFromEvents([view(5000, 3, 0, { device: 'legacy:vol' })])?.at).toBe(5000);
    expect(lastReadFromEvents([])).toBeNull();
    expect(
      lastReadFromEvents([{ device: 'dev-a', seq: ++seq, t: 1, kind: 'restart', volume: 'vol' }])
    ).toBeNull();
    expect(lastReadFromEvents(lookup(HOUR))?.at).toBe(0);
  });

  it('views before a forget do not count', () => {
    const events: ReadingEvent[] = [
      view(0, 39, 20_000),
      { device: 'dev-a', seq: ++seq, t: HOUR, kind: 'forget', volume: 'vol', before: HOUR }
    ];
    expect(lastReadFromEvents(events)?.at).toBe(0);
  });
});

describe('lastReadTime / seriesLastRead', () => {
  it('lastReadTime falls back to lastProgressUpdate only without events', () => {
    const record = { lastProgressUpdate: iso(9 * HOUR) };
    expect(lastReadTime('a', record, new Map())).toBe(9 * HOUR);
    expect(lastReadTime('a', record, new Map([['a', { at: 2 * HOUR, since: 0 }]]))).toBe(2 * HOUR);
    expect(lastReadTime('a', record, new Map([['a', { at: 0, since: 0 }]]))).toBe(0);
    expect(lastReadTime('a', undefined, new Map())).toBe(0);
    expect(lastReadTime('a', { lastProgressUpdate: 'garbage' }, new Map())).toBe(0);
  });

  it('a volume read before history keeps its date after a mere look-up', () => {
    // Its stamp predates every event: real reading, which history never saw.
    const record = { lastProgressUpdate: iso(2 * HOUR) };
    const times = new Map([['a', { at: 0, since: 5 * HOUR }]]);
    expect(lastReadTime('a', record, times)).toBe(2 * HOUR);
    // A stamp from after the first event is a re-stamp, never a read.
    expect(lastReadTime('a', { lastProgressUpdate: iso(6 * HOUR) }, times)).toBe(0);
  });

  it('seriesLastRead ignores volumes at progress ≤ 1, as smart sort did', () => {
    const records = {
      a: { progress: 1, lastProgressUpdate: iso(9 * HOUR) },
      b: { progress: 5, lastProgressUpdate: iso(3 * HOUR) }
    };
    expect(seriesLastRead(['a', 'b'], records, new Map())).toBe(3 * HOUR);
    expect(seriesLastRead(['a'], records, new Map())).toBe(0);
    expect(seriesLastRead([], records, new Map())).toBe(0);
  });

  it('a re-asserted lastProgressUpdate does not move seriesLastRead when events exist', () => {
    const records = { a: { progress: 40, lastProgressUpdate: iso(9 * HOUR) } };
    const times = new Map([['a', lastReadFromEvents([view(0, 39, 20_000)])!]]);
    expect(seriesLastRead(['a'], records, times)).toBe(20_000);
  });
});

describe('lastReadTimes', () => {
  beforeEach(() => _resetHistoryTurns());

  it('holds every volume with page events, and follows new events per volume', async () => {
    const stored = [view(0, 39, 20_000, { volume: 'v1' }), view(0, 1, 5000, { volume: 'v2' })];
    const db = { reading_events: { toArray: async () => stored } } as unknown as HistoryDexie;
    await loadHistoryTurns(db);
    const seen: Array<ReadonlyMap<string, { at: number }>> = [];
    const stop = lastReadTimes.subscribe((m) => seen.push(m));
    expect(Object.fromEntries(get(lastReadTimes))).toEqual({
      v1: { at: 20_000, since: 0 },
      v2: { at: 5000, since: 0 }
    });

    notifyEventsRecorded(lookup(HOUR, 'v1'));
    await Promise.resolve();
    expect(get(lastReadTimes).get('v1')?.at).toBe(20_000);

    notifyEventsRecorded([view(2 * HOUR, 2, 20_000, { volume: 'v2' })]);
    await Promise.resolve();
    expect(get(lastReadTimes).get('v2')?.at).toBe(2 * HOUR + 20_000);
    stop();
    expect(seen.length).toBeGreaterThan(1);
  });
});

describe("another device's adopted reading (remote reads)", () => {
  beforeEach(() => {
    _resetHistoryTurns();
    _resetRemoteReadsForTests();
  });

  async function load(events: ReadingEvent[]) {
    const db = { reading_events: { toArray: async () => events } } as unknown as HistoryDexie;
    await loadHistoryTurns(db);
  }

  it('lastReadTime: an uncovered remote read outranks older local history', () => {
    const times = new Map([['a', { at: 2 * HOUR, since: 0, remote: 5 * HOUR }]]);
    expect(lastReadTime('a', { lastProgressUpdate: iso(5 * HOUR) }, times)).toBe(5 * HOUR);
    // Newer local reading still wins.
    const newer = new Map([['a', { at: 7 * HOUR, since: 0, remote: 5 * HOUR }]]);
    expect(lastReadTime('a', undefined, newer)).toBe(7 * HOUR);
    // Only look-ups locally: the remote read still counts.
    const lookupsOnly = new Map([['a', { at: 0, since: HOUR, remote: 5 * HOUR }]]);
    expect(lastReadTime('a', { lastProgressUpdate: iso(5 * HOUR) }, lookupsOnly)).toBe(5 * HOUR);
  });

  it("the series moves up in smart sort when another device's position is adopted", async () => {
    // This device read volume "vol" an hour in; the phone read it at 5 h.
    await load([view(HOUR, 39, 20_000)]);
    const records = { vol: { progress: 120, lastProgressUpdate: iso(5 * HOUR) } };
    const before = seriesLastRead(['vol'], records, get(lastReadTimes));
    expect(before).toBe(HOUR + 20_000); // develop: the adopted stamp was ignored
    noteRemoteRead('vol', 5 * HOUR, 'phone');
    expect(seriesLastRead(['vol'], records, get(lastReadTimes))).toBe(5 * HOUR);
  });

  it("once that device's own events arrive, history judges it (a look-up there drops back)", async () => {
    const stop = lastReadTimes.subscribe(() => {});
    await load([view(HOUR, 39, 20_000)]);
    noteRemoteRead('vol', 5 * HOUR, 'phone');
    expect(get(lastReadTimes).get('vol')?.remote).toBe(5 * HOUR);
    // The phone's history: the 5 h stamp was a look-up that leaked its stamp.
    notifyEventsRecorded([
      view(5 * HOUR - 1000, 40, 20_000, { device: 'phone' }),
      view(5 * HOUR + 21_000, 41, 800, { device: 'phone' }),
      view(5 * HOUR + 22_000, 40, 1000, { device: 'phone' })
    ]);
    await Promise.resolve();
    const times = get(lastReadTimes);
    expect(times.get('vol')?.remote).toBeUndefined();
    expect(lastReadTime('vol', { lastProgressUpdate: iso(5 * HOUR) }, times)).toBe(HOUR + 20_000);
    stop();
  });

  it('earlier views of that device do not cover the stamp, however recent they started', async () => {
    // The phone read p.38–40 seconds before its p.44 stamp; history knows
    // nothing of p.41–44 yet.
    await load([
      view(5 * HOUR - 4000, 38, 5, { device: 'phone' }),
      view(5 * HOUR - 3990, 39, 5, { device: 'phone' }),
      view(5 * HOUR - 3980, 40, 5, { device: 'phone' }),
      view(HOUR, 39, 20_000)
    ]);
    noteRemoteRead('vol', 5 * HOUR, 'phone');
    expect(get(lastReadTimes).get('vol')?.remote).toBe(5 * HOUR);
    // The view the turn ended (p.43, ending at the stamp) covers it.
    notifyEventsRecorded([view(5 * HOUR - 3000, 43, 3000, { device: 'phone' })]);
    await Promise.resolve();
    expect(get(lastReadTimes).get('vol')?.remote).toBeUndefined();
    expect(get(lastReadTimes).get('vol')?.at).toBe(5 * HOUR);
  });

  it('a read from an unknown device (a volume-data.json merge) stays a read', async () => {
    await load([view(HOUR, 39, 20_000), view(6 * HOUR, 39, 20_000, { device: 'phone' })]);
    noteRemoteRead('vol', 5 * HOUR, null);
    expect(get(lastReadTimes).get('vol')?.remote).toBe(5 * HOUR);
  });

  it('a remote read at or before a forget does not count', async () => {
    await load([
      view(HOUR, 39, 20_000),
      { device: 'dev-a', seq: ++seq, t: 6 * HOUR, kind: 'forget', volume: 'vol', before: 6 * HOUR }
    ]);
    noteRemoteRead('vol', 5 * HOUR, 'phone');
    expect(get(lastReadTimes).get('vol')?.remote).toBeUndefined();
  });
});
