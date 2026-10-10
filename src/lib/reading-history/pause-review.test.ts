import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined), bulkGet: vi.fn(async () => []) },
    volume_ocr: { get: vi.fn(async () => undefined) }
  }
}));

import { get } from 'svelte/store';
import { clearVolumes } from '$lib/settings/volume-data';
import { setTrackingStates } from '$lib/settings/tracking-data';
import { HistoryDexie } from './history-db';
import { appendEvent, recordResolve } from './record';
import { _resetHistoryTurns, loadHistoryTurns } from './turns-store';
import { _resetReadingStatsForTests, flushReadingStats, initReadingStats } from './stats-store';
import { pauseKey, pauseReview, pauseVolumeTitle, reviewPauses } from './pause-review';
import type { Pause, VolumeTotals } from './stats-engine';
import type { PagePayload, ReadingEvent } from './types';

const MIN = 60_000;
let db: HistoryDexie;

const page = (volume: string, p: number, chars: number, dwell: number): PagePayload => ({
  kind: 'page',
  volume,
  first_page: p,
  last_page: p,
  page_chars: [chars],
  chars_before: 0,
  dwell_ms: dwell,
  layout: 'single',
  orientation: 'portrait',
  viewport: null
});

/** Let turns-store hand the stored events on (a microtask), then count now. */
async function settle(): Promise<void> {
  await Promise.resolve();
  flushReadingStats();
}

async function view(
  volume: string,
  t: number,
  p: number,
  chars: number,
  dwell: number
): Promise<ReadingEvent> {
  const event = await appendEvent(db, page(volume, p, chars, dwell), t);
  await settle();
  return event;
}

beforeEach(async () => {
  clearVolumes();
  window.localStorage.clear();
  setTrackingStates({});
  _resetHistoryTurns();
  _resetReadingStatsForTests();
  db = new HistoryDexie(`pauses-${Math.random()}`);
  await loadHistoryTurns(db);
  initReadingStats();
  flushReadingStats();
});

describe('pauseReview', () => {
  // No pace yet (fewer than 30 views): every cap is the fixed 5 minutes, and
  // a view over it counts the cap itself as its typical time.
  it('lists a view left open past its cap as provisional, counting typical time', async () => {
    const e = await view('v1', 0, 4, 300, 10 * MIN);
    const review = get(pauseReview);
    expect(review).toMatchObject({ unanswered: 1, answered: 0 });
    expect(review.pauses).toEqual([
      {
        volume: 'v1',
        device: e.device,
        seq: e.seq,
        t: 0,
        page: 4,
        dwell: 10 * MIN,
        cap: 5 * MIN,
        typical: 5 * MIN,
        counted: 5 * MIN,
        answer: null
      }
    ]);
  });

  it('does not list a view within its cap', async () => {
    await view('v1', 0, 1, 300, 4 * MIN);
    expect(get(pauseReview)).toEqual({ pauses: [], unanswered: 0, answered: 0 });
  });

  it("takes an answer from the list: the pause counts it and moves to 'answered'", async () => {
    const e = await view('v1', 0, 1, 300, 10 * MIN);
    await recordResolve('v1', [e.device, e.seq], 'full', 20 * MIN, db);
    await settle();
    const review = get(pauseReview);
    expect(review).toMatchObject({ unanswered: 0, answered: 1 });
    expect(review.pauses[0]).toMatchObject({ answer: 'full', counted: 10 * MIN });
  });

  it('flattens every volume, newest first', async () => {
    await view('v1', 0, 1, 300, 10 * MIN);
    await view('v2', 60 * MIN, 1, 300, 10 * MIN);
    expect(get(pauseReview).pauses.map((p) => p.volume)).toEqual(['v2', 'v1']);
  });
});

describe('reviewPauses', () => {
  const pause = (seq: number, t: number, answer: Pause['answer'] = null): Pause => ({
    device: 'd',
    seq,
    t,
    page: 1,
    dwell: 10 * MIN,
    cap: 5 * MIN,
    typical: 5 * MIN,
    counted: 5 * MIN,
    answer
  });
  const totals = (pauses: Pause[]): Pick<VolumeTotals, 'pauses'> => ({ pauses });

  it('sorts newest first and counts answered and unanswered', () => {
    const review = reviewPauses(
      new Map([
        ['a', totals([pause(1, 100), pause(3, 300, 'none')])],
        ['b', totals([pause(2, 200)])]
      ])
    );
    expect(review.pauses.map((p) => [p.volume, p.seq])).toEqual([
      ['a', 3],
      ['b', 2],
      ['a', 1]
    ]);
    expect(review).toMatchObject({ unanswered: 2, answered: 1 });
  });

  it("reuses a volume's rows while its totals are unchanged (a page turn recounts one volume)", () => {
    const a = totals([pause(1, 100)]);
    const first = reviewPauses(
      new Map([
        ['a', a],
        ['b', totals([pause(2, 200)])]
      ])
    );
    const second = reviewPauses(
      new Map([
        ['a', a],
        ['b', totals([pause(2, 200)])]
      ])
    );
    const rowOf = (r: typeof first, volume: string) => r.pauses.find((p) => p.volume === volume);
    expect(rowOf(second, 'a')).toBe(rowOf(first, 'a'));
    expect(rowOf(second, 'b')).not.toBe(rowOf(first, 'b'));
  });

  it('keys a pause by its page event', () => {
    expect(pauseKey({ device: 'dev-a', seq: 7 })).toBe('dev-a\u00007');
  });
});

describe('pauseVolumeTitle', () => {
  it('names the volume from its catalog row', () => {
    expect(
      pauseVolumeTitle('v1', { v1: { series_title: 'Dr Stone', volume_title: 'Dr Stone 01' } }, {})
    ).toBe('Dr Stone — Dr Stone 01');
  });

  it('falls back to the reading record, then to a placeholder name', () => {
    expect(
      pauseVolumeTitle('v1', undefined, {
        v1: { series_title: 'Frieren', volume_title: 'Frieren 02' }
      })
    ).toBe('Frieren — Frieren 02');
    expect(pauseVolumeTitle('v1', {}, {})).toBe('Unknown volume');
  });

  it('does not repeat a volume title equal to its series', () => {
    expect(
      pauseVolumeTitle('v1', { v1: { series_title: 'Oneshot', volume_title: 'Oneshot' } }, {})
    ).toBe('Oneshot');
  });
});
