import { describe, expect, it } from 'vitest';
import {
  CEILING_MS,
  DEFAULT_K,
  FLOOR_MS,
  NO_DATA_CAP_MS,
  countVolume,
  estimatePace,
  prepareVolume,
  speedFromSamples,
  viewCap,
  type IdleSettings,
  type PreparedVolume
} from './stats-engine';
import type { ReadingEvent } from './types';

const AUTO: IdleSettings = { k: DEFAULT_K, overrideMs: null };
const MIN = 60_000;
let seq = 0;

function view(
  t: number,
  first: number,
  page_chars: number[],
  dwell: number | null,
  device = 'dev-a'
): ReadingEvent {
  return {
    device,
    seq: ++seq,
    t,
    kind: 'page',
    volume: 'vol',
    first_page: first,
    last_page: first + page_chars.length - 1,
    page_chars,
    chars_before: 0,
    dwell_ms: dwell,
    layout: 'single',
    orientation: 'portrait',
    viewport: { w: 1, h: 1 }
  };
}

/** A converted turn: `[t, page, cumulativeChars]` → single-page legacy view. */
function legacy(t: number, page: number, cumulative: number, dwell: number | null): ReadingEvent {
  return {
    device: 'legacy:vol',
    seq: t,
    t,
    kind: 'page',
    volume: 'vol',
    first_page: page,
    last_page: page,
    page_chars: [0],
    chars_before: cumulative,
    dwell_ms: dwell,
    layout: 'unknown',
    orientation: 'unknown',
    viewport: null
  };
}

const restart = (t: number): ReadingEvent => ({
  device: 'dev-a',
  seq: ++seq,
  t,
  kind: 'restart',
  volume: 'vol'
});
const forget = (t: number, before: number): ReadingEvent => ({
  device: 'dev-a',
  seq: ++seq,
  t,
  kind: 'forget',
  volume: 'vol',
  before
});
const adjust = (t: number, time: number, chars: number): ReadingEvent => ({
  device: 'dev-a',
  seq: ++seq,
  t,
  kind: 'adjust',
  volume: 'vol',
  time_delta_ms: time,
  chars_delta: chars
});

/** A library whose pace is exactly `msPerChar`: 40 views of 100 chars. */
function paced(msPerChar: number): PreparedVolume[] {
  const events = Array.from({ length: 40 }, (_, i) => view(i * MIN, i + 1, [100], 100 * msPerChar));
  return [prepareVolume(events)];
}

describe('estimatePace', () => {
  it('is the median ms per character, so one overnight view does not move it', () => {
    const events = Array.from({ length: 40 }, (_, i) => view(i * MIN, i + 1, [100], 20_000));
    events.push(view(100 * MIN, 50, [100], 8 * 60 * MIN));
    expect(estimatePace([prepareVolume(events)])).toBe(200);
  });

  it('has no pace from fewer than 30 usable views', () => {
    const events = Array.from({ length: 29 }, (_, i) => view(i * MIN, i + 1, [100], 20_000));
    expect(estimatePace([prepareVolume(events)])).toBeNull();
  });

  it('ignores views with too few characters to time', () => {
    const events = Array.from({ length: 40 }, (_, i) => view(i * MIN, i + 1, [5], 20_000));
    expect(estimatePace([prepareVolume(events)])).toBeNull();
  });
});

describe('viewCap', () => {
  it('is k × expected, between the floor and the ceiling', () => {
    expect(viewCap(400, 200, AUTO)).toBe(DEFAULT_K * 400 * 200);
    expect(viewCap(0, 200, AUTO)).toBe(FLOOR_MS);
    expect(viewCap(100_000, 200, AUTO)).toBe(CEILING_MS);
  });

  it('falls back to the old 5 minutes without a pace, and obeys the override', () => {
    expect(viewCap(400, null, AUTO)).toBe(NO_DATA_CAP_MS);
    expect(viewCap(400, 200, { k: DEFAULT_K, overrideMs: 7 * MIN })).toBe(7 * MIN);
  });
});

describe('countVolume', () => {
  const pace = 200;

  it('counts a view within its cap in full', () => {
    const totals = countVolume(prepareVolume([view(0, 1, [400], 60_000)]), pace, AUTO);
    expect(totals.timeMs).toBe(60_000);
    expect(totals.readChars).toBe(400);
    expect(totals.samples).toEqual([{ end: 60_000, ms: 60_000, chars: 400 }]);
  });

  it('counts a view left open overnight as typical time, not hours', () => {
    const totals = countVolume(prepareVolume([view(0, 1, [400], 8 * 60 * MIN)]), pace, AUTO);
    expect(totals.timeMs).toBe(400 * pace);
    expect(totals.readChars).toBe(400);
  });

  it('gives an art-only page the floor as its typical time when left open', () => {
    const totals = countVolume(prepareVolume([view(0, 1, [0], 60 * MIN)]), pace, AUTO);
    expect(totals.timeMs).toBe(FLOOR_MS);
  });

  it('classifies a view faster than 1500 cpm as a skip: time counts, chars are skipped', () => {
    const totals = countVolume(prepareVolume([view(0, 1, [1000], 10_000)]), pace, AUTO);
    expect(totals.timeMs).toBe(10_000);
    expect(totals.readChars).toBe(0);
    expect(totals.skippedChars).toBe(1000);
    expect(totals.samples).toEqual([]);
  });

  it('counts pages skipped first and read later in the same pass as read', () => {
    const totals = countVolume(
      prepareVolume([view(0, 1, [1000], 5_000), view(MIN, 1, [1000], 120_000)]),
      pace,
      AUTO
    );
    expect(totals.readChars).toBe(1000);
    expect(totals.skippedChars).toBe(0);
    expect(totals.samples.map((s) => s.chars)).toEqual([1000]);
  });

  it('credits a page once per pass, and again after a restart', () => {
    const events = [
      view(0, 1, [300], 60_000),
      view(MIN, 1, [300], 60_000),
      restart(10 * MIN),
      view(11 * MIN, 1, [300], 60_000)
    ];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    expect(totals.readChars).toBe(600);
    expect(totals.timeMs).toBe(180_000);
    expect(totals.samples.map((s) => s.chars)).toEqual([300, 0, 300]);
  });

  it('hides everything a forget covers', () => {
    const events = [
      view(0, 1, [300], 60_000),
      forget(5 * MIN, 5 * MIN),
      view(6 * MIN, 2, [200], 30_000)
    ];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    expect(totals.readChars).toBe(200);
    expect(totals.timeMs).toBe(30_000);
  });

  it('adds adjust deltas after the forget horizon', () => {
    const events = [adjust(0, 99 * MIN, 999), forget(1, 1), adjust(2, 5 * MIN, 50)];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    expect(totals.timeMs).toBe(5 * MIN);
    expect(totals.readChars).toBe(50);
  });

  it('reads legacy page chars from consecutive cumulative counts', () => {
    const events = [
      legacy(0, 1, 100, 60_000),
      legacy(60_000, 2, 400, 90_000),
      legacy(150_000, 3, 600, null)
    ];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    // Pages 1 and 2 have a following turn (300 and 200 chars); the last is unknown.
    expect(totals.readChars).toBe(500);
    expect(totals.timeMs).toBe(150_000);
  });

  it('counts neither time nor chars for a legacy view over its cap (the old idle rule)', () => {
    const events = [legacy(0, 1, 0, 10 * 60 * MIN), legacy(10 * 60 * MIN, 9, 5000, null)];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    expect(totals.timeMs).toBe(0);
    expect(totals.readChars).toBe(0);
  });

  it('ignores a legacy turn a native view already covers', () => {
    const events = [view(0, 1, [300], 60_000), legacy(1_000, 1, 300, 59_000)];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    expect(totals.timeMs).toBe(60_000);
    expect(totals.readChars).toBe(300);
  });

  it('orders views across devices by time', () => {
    const events = [view(MIN, 1, [300], 60_000, 'dev-b'), view(0, 1, [300], 30_000, 'dev-a')];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    expect(totals.samples).toEqual([
      { end: 30_000, ms: 30_000, chars: 300 },
      { end: 2 * MIN, ms: 60_000, chars: 0 }
    ]);
    expect(totals.lastReadAt).toBe(2 * MIN);
  });

  it('uses the pace of the whole library for the cap', () => {
    const library = paced(200);
    const p = estimatePace(library);
    expect(p).toBe(200);
  });
});

describe('speedFromSamples', () => {
  it('reads the newest samples up to the window, by time, with no per-volume cliff', () => {
    const samples = [
      { end: 1, ms: 5 * 60 * MIN, chars: 5 * 60 * 100 }, // old: 100 cpm
      { end: 2, ms: 3 * 60 * MIN, chars: 3 * 60 * 300 }, // 300 cpm
      { end: 3, ms: 2 * 60 * MIN, chars: 2 * 60 * 300 } // 300 cpm
    ];
    const speed = speedFromSamples(samples, 6 * 60 * MIN);
    // Newest 5 h at 300 cpm, then 1 h of the 100 cpm volume (pro rata).
    expect(speed.minutes).toBe(360);
    expect(speed.charsPerMinute).toBeCloseTo((5 * 60 * 300 + 60 * 100) / 360, 5);
  });

  it('is zero minutes with no samples', () => {
    expect(speedFromSamples([])).toEqual({ charsPerMinute: 0, minutes: 0 });
  });
});
