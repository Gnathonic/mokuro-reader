import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { HistoryDexie } from './history-db';
import { lastReadFromEvents, lastReadTime, lastReadTimes, seriesLastRead } from './last-read';
import { notifyEventsRecorded } from './record';
import { _resetHistoryTurns, loadHistoryTurns } from './turns-store';
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
