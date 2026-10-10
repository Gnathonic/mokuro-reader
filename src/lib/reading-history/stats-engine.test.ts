import { describe, expect, it } from 'vitest';
import {
  CEILING_MS,
  DEFAULT_K,
  FLOOR_MS,
  K_MAX,
  NO_DATA_CAP_MS,
  countVolume,
  countedDwell,
  estimatePace,
  prepareVolume,
  recentSpeed,
  speedFromSamples,
  totalsBefore,
  viewCap,
  widenedK,
  type IdleSettings,
  type Pause,
  type PreparedVolume
} from './stats-engine';
import type { PauseCount, ReadingEvent } from './types';

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
/** The user's answer about the view `target` (`[device, seq]`). */
const resolve = (
  t: number,
  target: [string, number],
  count: PauseCount,
  device = 'dev-a'
): ReadingEvent => ({
  device,
  seq: ++seq,
  t,
  kind: 'resolve',
  volume: 'vol',
  target,
  count
});
const id = (e: ReadingEvent): [string, number] => [e.device, e.seq];

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

describe('countedDwell', () => {
  it('counts all, typical or nothing as answered, and typical while unanswered over the cap', () => {
    expect(countedDwell(10 * MIN, 4 * MIN, 80_000, 'full')).toBe(10 * MIN);
    expect(countedDwell(10 * MIN, 4 * MIN, 80_000, 'typical')).toBe(80_000);
    expect(countedDwell(10 * MIN, 4 * MIN, 80_000, 'none')).toBe(0);
    expect(countedDwell(10 * MIN, 4 * MIN, 80_000, null)).toBe(80_000);
  });

  it('counts an unanswered view within its cap in full, and typical never above the dwell', () => {
    expect(countedDwell(3 * MIN, 4 * MIN, 80_000, null)).toBe(3 * MIN);
    expect(countedDwell(60_000, 4 * MIN, 80_000, 'typical')).toBe(60_000);
  });
});

describe('long-pause answers (resolve events)', () => {
  // 400 chars at 200 ms/char: expected 80 s, cap 240 s.
  const pace = 200;
  const long = () => view(0, 1, [400], 8 * 60 * MIN);

  it('counts a long pause in full, typical or not at all as answered', () => {
    const cases = [
      ['full', 8 * 60 * MIN],
      ['typical', 80_000],
      ['none', 0]
    ] as const;
    for (const [count, ms] of cases) {
      const v = long();
      const totals = countVolume(
        prepareVolume([v, resolve(8 * 60 * MIN, id(v), count)]),
        pace,
        AUTO
      );
      expect(totals.timeMs).toBe(ms);
    }
  });

  it("keeps the pages of a 'none' pause read, but takes no speed sample from it", () => {
    const v = long();
    const totals = countVolume(
      prepareVolume([v, resolve(8 * 60 * MIN, id(v), 'none')]),
      pace,
      AUTO
    );
    expect(totals.timeMs).toBe(0);
    expect(totals.readChars).toBe(400);
    expect(totals.samples).toEqual([]);
  });

  it('takes the latest answer by time, whatever order the events arrive in', () => {
    const v = long();
    const events = [resolve(9 * 60 * MIN, id(v), 'none'), v, resolve(8 * 60 * MIN, id(v), 'full')];
    expect(countVolume(prepareVolume(events), pace, AUTO).timeMs).toBe(0);
  });

  it('breaks a tie in time by device, the same on every device', () => {
    const v = long();
    const a = resolve(8 * 60 * MIN, id(v), 'full', 'dev-a');
    const b = resolve(8 * 60 * MIN, id(v), 'none', 'dev-b');
    expect(countVolume(prepareVolume([v, b, a]), pace, AUTO).timeMs).toBe(0);
    expect(countVolume(prepareVolume([a, v, b]), pace, AUTO).timeMs).toBe(0);
  });

  it('applies an answer under the cap, and keeps it when the pace moves', () => {
    const v = view(0, 1, [400], 3 * MIN);
    const none = [v, resolve(3 * MIN, id(v), 'none')];
    expect(countVolume(prepareVolume(none), 200, AUTO).timeMs).toBe(0);
    expect(countVolume(prepareVolume(none), 400, AUTO).timeMs).toBe(0);
    const typical = [v, resolve(3 * MIN, id(v), 'typical')];
    expect(countVolume(prepareVolume(typical), 200, AUTO).timeMs).toBe(80_000);
  });

  it('never applies an answer to a legacy view, and never lists one', () => {
    const events = [
      legacy(0, 1, 0, 10 * 60 * MIN),
      legacy(10 * 60 * MIN, 9, 5000, null),
      resolve(11 * 60 * MIN, ['legacy:vol', 0], 'full')
    ];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    expect(totals.timeMs).toBe(0);
    expect(totals.readChars).toBe(0);
    expect(totals.pauses).toEqual([]);
  });

  it('ignores an answer aimed at no view', () => {
    const v = long();
    const stray = resolve(8 * 60 * MIN, ['dev-z', 99], 'none');
    expect(countVolume(prepareVolume([v, stray]), pace, AUTO).timeMs).toBe(80_000);
  });

  it('drops answers a forget hides, even one whose view is after the horizon', () => {
    const v = long();
    const w = view(10 * 60 * MIN, 2, [400], 8 * 60 * MIN);
    // dev-b's slow clock stamps its answer about w before the forget's horizon.
    const skewed = resolve(8 * 60 * MIN + 30 * MIN, id(w), 'full', 'dev-b');
    const events = [
      v,
      resolve(8 * 60 * MIN, id(v), 'full'),
      forget(9 * 60 * MIN, 9 * 60 * MIN),
      w,
      skewed
    ];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    expect(totals.timeMs).toBe(80_000);
    expect(totals.pauses.map((p) => [p.seq, p.answer])).toEqual([[w.seq, null]]);
  });

  it('lists long pauses and answered views in time order, with what each counted', () => {
    const a = view(0, 1, [400], MIN); // within its cap, unanswered: not listed
    const b = view(10 * MIN, 5, [400, 100], 8 * 60 * MIN); // provisional
    const c = view(9 * 60 * MIN, 7, [400], 20 * MIN); // answered: all
    const d = view(10 * 60 * MIN, 8, [400], 2 * MIN); // under its cap, answered: typical
    const events = [
      a,
      b,
      c,
      resolve(9 * 60 * MIN + 20 * MIN, id(c), 'full'),
      d,
      resolve(11 * 60 * MIN, id(d), 'typical')
    ];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    const expected: Pause[] = [
      {
        device: 'dev-a',
        seq: b.seq,
        t: 10 * MIN,
        page: 5,
        dwell: 8 * 60 * MIN,
        cap: 300_000,
        typical: 100_000,
        counted: 100_000,
        answer: null
      },
      {
        device: 'dev-a',
        seq: c.seq,
        t: 9 * 60 * MIN,
        page: 7,
        dwell: 20 * MIN,
        cap: 240_000,
        typical: 80_000,
        counted: 20 * MIN,
        answer: 'full'
      },
      {
        device: 'dev-a',
        seq: d.seq,
        t: 10 * 60 * MIN,
        page: 8,
        dwell: 2 * MIN,
        cap: 240_000,
        typical: 80_000,
        counted: 80_000,
        answer: 'typical'
      }
    ];
    expect(totals.pauses).toEqual(expected);
    expect(totals.timeMs).toBe(60_000 + 100_000 + 20 * MIN + 80_000);
  });
});

describe('long-pause answers: review focus', () => {
  const pace = 200;

  it('credits a split pair once: the continuation is a harmless skip, only the paused view listed', () => {
    for (const count of ['full', 'typical', 'none'] as const) {
      const paused = view(0, 5, [400, 100], 8 * 60 * MIN);
      const answer = resolve(8 * 60 * MIN, id(paused), count);
      // The continuation opens at the answer, same pages, turned 2 s later.
      const cont = view(8 * 60 * MIN, 5, [400, 100], 2_000);
      const totals = countVolume(prepareVolume([paused, answer, cont]), pace, AUTO);
      expect(totals.readChars).toBe(500);
      expect(totals.skippedChars).toBe(0);
      expect(totals.pauses.map((p) => [p.seq, p.answer])).toEqual([[paused.seq, count]]);
      const pausedMs = { full: 8 * 60 * MIN, typical: 100_000, none: 0 }[count];
      expect(totals.timeMs).toBe(pausedMs + 2_000);
    }
  });

  it('an answer aimed at an earlier pass (after a restart) changes time only', () => {
    const v1 = view(0, 1, [400], 8 * 60 * MIN);
    const r = restart(9 * 60 * MIN);
    const v2 = view(10 * 60 * MIN, 1, [400], MIN);
    const without = countVolume(prepareVolume([v1, r, v2]), pace, AUTO);
    const answered = countVolume(
      prepareVolume([v1, r, v2, resolve(11 * 60 * MIN, id(v1), 'none')]),
      pace,
      AUTO
    );
    expect(without.readChars).toBe(800);
    expect(answered.readChars).toBe(without.readChars);
    expect(answered.skippedChars).toBe(without.skippedChars);
    expect(without.timeMs).toBe(80_000 + MIN);
    expect(answered.timeMs).toBe(MIN);
    expect(answered.pauses.map((p) => [p.seq, p.answer])).toEqual([[v1.seq, 'none']]);
  });

  it('an answer newer than a forget whose target was forgotten matches nothing', () => {
    const v = view(0, 1, [400], 8 * 60 * MIN);
    const w = view(10 * 60 * MIN, 2, [400], MIN);
    const events = [
      v,
      forget(9 * 60 * MIN, 9 * 60 * MIN),
      w,
      resolve(11 * 60 * MIN, id(v), 'full')
    ];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    expect(totals.timeMs).toBe(MIN);
    expect(totals.readChars).toBe(400);
    expect(totals.pauses).toEqual([]);
  });
});

describe('widenedK', () => {
  // 400 chars at 200 ms/char: expected 80 s; k = 3 caps it at 240 s.
  it('fits the time so far with 1.5× headroom, rounded up to a half step', () => {
    expect(widenedK(6 * MIN, 400, 200, AUTO)).toBe(7);
    expect(viewCap(400, 200, { k: 7, overrideMs: null })).toBe(560_000);
    expect(widenedK(270_000, 400, 200, AUTO)).toBe(5.5);
  });

  it('stops where the cap of this view reaches the ceiling', () => {
    // 2000 chars: expected 400 s; the ceiling is reached at k = 4.5.
    const k = widenedK(25 * MIN, 2000, 200, AUTO);
    expect(k).toBe(4.5);
    expect(viewCap(2000, 200, { k: k!, overrideMs: null })).toBe(CEILING_MS);
    // 4000 chars: already at the ceiling with k = 3.
    expect(widenedK(40 * MIN, 4000, 200, AUTO)).toBeNull();
  });

  it(`never goes past K_MAX (${K_MAX})`, () => {
    // 30 chars: expected 6 s; the fit (30) is bounded, and the cap still grows past the floor.
    expect(widenedK(2 * MIN, 30, 200, AUTO)).toBe(K_MAX);
  });

  it('is null when widening cannot lengthen this view’s cap', () => {
    expect(widenedK(10 * MIN, 400, 200, { k: DEFAULT_K, overrideMs: 5 * MIN })).toBeNull();
    expect(widenedK(10 * MIN, 400, null, AUTO)).toBeNull();
    expect(widenedK(10 * MIN, 0, 200, AUTO)).toBeNull();
    // 1 char: even k = K_MAX leaves the cap at the floor.
    expect(widenedK(2 * MIN, 1, 200, AUTO)).toBeNull();
    expect(viewCap(1, 200, AUTO)).toBe(FLOOR_MS);
  });

  it('never shrinks k', () => {
    expect(widenedK(4 * MIN, 400, 200, { k: 10, overrideMs: null })).toBeNull();
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

describe('raw totals and totals before a cutoff', () => {
  const pace = 200;

  it('keeps a negative adjust unclamped, so a baseline above it can be edited down', () => {
    const totals = countVolume(
      prepareVolume([view(0, 1, [300], MIN), adjust(5 * MIN, -100 * MIN, -900)]),
      pace,
      AUTO
    );
    expect(totals.timeMs).toBe(-99 * MIN);
    expect(totals.readChars).toBe(-600);
  });

  it('sums only what was recorded before the cutoff (views at their start, adjusts at their time)', () => {
    const totals = countVolume(
      prepareVolume([
        view(0, 1, [300], MIN),
        view(10 * MIN, 2, [1000], 5_000),
        adjust(20 * MIN, 3 * MIN, 50),
        view(30 * MIN, 3, [200], MIN)
      ]),
      pace,
      AUTO
    );
    expect(totalsBefore(totals, 10 * MIN)).toEqual({
      timeMs: MIN,
      readChars: 300,
      skippedChars: 0
    });
    expect(totalsBefore(totals, 25 * MIN)).toEqual({
      timeMs: MIN + 5_000 + 3 * MIN,
      readChars: 350,
      skippedChars: 1000
    });
    expect(totalsBefore(totals, Infinity)).toEqual({
      timeMs: totals.timeMs,
      readChars: totals.readChars,
      skippedChars: totals.skippedChars
    });
  });
});

describe('fast paths agree with the brute force (random libraries)', () => {
  function library(seed: number) {
    let x = seed;
    const rand = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const volumes: PreparedVolume[] = [];
    for (let v = 0; v < 40; v++) {
      const events: ReadingEvent[] = [];
      let t = Math.floor(rand() * 1e9);
      for (let i = 0; i < 20 + Math.floor(rand() * 80); i++) {
        t += Math.floor(rand() * 600_000);
        events.push(
          view(
            t,
            1 + Math.floor(rand() * 50),
            [Math.floor(rand() * 400)],
            Math.floor(rand() * 3_600_000)
          )
        );
      }
      volumes.push(prepareVolume(events));
    }
    return volumes;
  }

  function bruteForcePace(volumes: PreparedVolume[]): number | null {
    const usable = volumes
      .flatMap((v) => v.views)
      .filter(
        (v) => !v.skip && v.dwell !== null && v.chars >= 20 && v.dwell > 0 && v.dwell <= CEILING_MS
      )
      .sort((a, b) => b.t - a.t)
      .slice(0, 500)
      .map((v) => v.dwell! / v.chars)
      .sort((a, b) => a - b);
    if (usable.length < 30) return null;
    const mid = usable.length >> 1;
    return usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
  }

  it('estimatePace is the median of the newest 500 usable views across the library', () => {
    for (const seed of [1, 7, 42, 99, 1234]) {
      const volumes = library(seed);
      expect(estimatePace(volumes)).toBe(bruteForcePace(volumes));
    }
  });

  it('recentSpeed equals the speed over every sample', () => {
    for (const seed of [3, 8, 55, 600]) {
      const totals = library(seed).map((p) => countVolume(p, 200, AUTO));
      const all = speedFromSamples(
        totals.flatMap((t) => t.samples),
        2 * 60 * MIN
      );
      const fast = recentSpeed(totals, 2 * 60 * MIN);
      expect(fast.minutes).toBeCloseTo(all.minutes, 6);
      expect(fast.charsPerMinute).toBeCloseTo(all.charsPerMinute, 6);
    }
  });
});
