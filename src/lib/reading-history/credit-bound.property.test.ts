import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/env', () => ({ browser: false }));
vi.mock('#lib/catalog/db.js', () => ({ db: {} }));

import {
  DEFAULT_K,
  countVolume,
  prepareVolume,
  type IdleSettings,
  type VolumeTotals
} from './stats-engine';
import {
  creditsFor,
  figuresFor,
  measuredFigures,
  minutesAfterReset,
  pagesNotReadHere,
  passFiguresFor,
  type BaselineSource,
  type ReadingStatsState
} from './stats-store';
import type { ReadingEvent } from './types';
import type { LegacyStats } from '#lib/settings/volume-data.js';

/*
 * A sweep over the states a volume's history can be in (#224): reading here
 * and on other devices, skims, converted page turns (some too fast to say
 * what was read), older editors' adjusts, this editor's Reset All, restarts,
 * reading from before history (snapshots frozen at any point of the history —
 * views, skims and credits before the freeze included — with archived
 * reads), pages counted at an older OCR, credits made by THIS flow
 * (`pagesNotReadHere` → the credit `markRead` records) and by a device that
 * had not seen the rest, retracts, double marks. Whatever the state:
 *
 * - a pass never counts more than the volume once credits are in: what
 *   credits add stops at the volume's characters, less what the pass counts
 *   without them (views, adjusts, the baseline's share) — in the engine's
 *   totals and in the figures (`passFiguresFor`, the baseline in);
 * - the baseline is the same with or without credits, and a pass Reset All
 *   ended counts nothing;
 * - what the sheet offers fits in what the pass has left;
 * - a credit counts only pages it claimed, each page once per pass, never one
 *   a view read, never more of a page than the page holds;
 * - credits leave speed alone: samples, the pace input and the measured
 *   figures are the same as with no credit at all.
 */

const AUTO: IdleSettings = { k: DEFAULT_K, overrideMs: null };
const MIN = 60_000;
const PACE = 200;
const VOLUME = 'vol';

/** mulberry32: a small seeded PRNG, so a failure names its case. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(items: T[]) => items[Math.floor(next() * items.length)]
  };
}

type Rng = ReturnType<typeof rng>;

function stateOf(events: ReadingEvent[]): ReadingStatsState {
  const totals = countVolume(prepareVolume(events), PACE, AUTO);
  return {
    ready: true,
    pace: PACE,
    idle: AUTO,
    byVolume: new Map<string, VolumeTotals>([[VOLUME, totals]]),
    recent: { charsPerMinute: 0, minutes: 0 }
  };
}

const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);

interface Case {
  pageChars: number[];
  events: ReadingEvent[];
  record: BaselineSource;
  /** Every page view used today's page counts, and nothing counts without pages. */
  pageExact: boolean;
  /** An unfrozen record (the old minute counter): the same snapshot, frozen now. */
  frozenNow?: BaselineSource;
}

/** One random history, credits made the way the app makes them along the way. */
function build(r: Rng): Case {
  const pages = r.int(1, 12);
  const pageChars = Array.from({ length: pages }, () => (r.chance(0.15) ? 0 : r.int(1, 300)));
  const size = sum(pageChars);
  const oldOcr = pageChars.map((c) => Math.round(c * (0.5 + r.next())));
  const events: ReadingEvent[] = [];
  let seq = 0;
  let t = 1_000_000;
  let pageExact = true;
  const tick = () => (t += r.int(1, 5) * MIN);
  const ev = (payload: Record<string, unknown>, device = r.pick(['dev-a', 'dev-b'])) =>
    ({ device, seq: ++seq, t: tick(), volume: VOLUME, ...payload }) as ReadingEvent;
  const cumulative = (page: number, counts: number[]) => sum(counts.slice(0, page));

  // Reading from before history: the old counter's lump, frozen at `before`
  // — at ANY point of the history, not only before it: a record merge keeps
  // the winning record's snapshot, so a device that froze later leaves other
  // devices' views, skims, edits and even credits before `before`.
  const record: BaselineSource = {};
  const archived = r.chance(0.12) ? [{ at: t - 30 * MIN, chars: size }] : [];
  if (archived.length > 0) {
    events.push({
      device: `legacy:${VOLUME}`,
      seq: archived[0].at,
      t: archived[0].at,
      kind: 'restart',
      volume: VOLUME
    });
  }
  const steps = r.int(1, 16);
  /** The step the snapshot is frozen at (`steps` = after them all); −1 = none. */
  const freezeAt = r.chance(0.45) ? r.int(0, steps) : -1;
  // Not frozen at all: a record on the old minute counter, its live count
  // the snapshot (`before: Infinity`) the whole time.
  let unfrozen: LegacyStats | null = null;
  if (freezeAt === -1 && r.chance(0.4)) {
    const position = cumulative(r.int(0, pages), pageChars);
    record.archivedReads = archived;
    record.timeReadInMinutes = r.int(1, 60);
    record.chars = position;
    unfrozen = {
      time_ms: record.timeReadInMinutes * MIN,
      chars: position + sum(archived.map((a) => a.chars)),
      before: Infinity
    };
  }
  const freeze = () => {
    const position = cumulative(r.int(0, pages), pageChars);
    record.archivedReads = archived;
    record.legacyStats = {
      time_ms: r.int(0, 60) * MIN,
      chars: position + sum(archived.map((a) => a.chars)),
      before: t + 1
    };
    pageExact = false;
  };
  // Converted page turns, one per spread; some too fast to say what was read.
  if (r.chance(0.25)) {
    for (let page = 1; page <= pages; page += 2) {
      const at = t - (pages - page + 1) * MIN;
      events.push({
        device: `legacy:${VOLUME}`,
        seq: at,
        t: at,
        kind: 'page',
        volume: VOLUME,
        first_page: page,
        last_page: page,
        page_chars: [0],
        chars_before: cumulative(page, pageChars),
        dwell_ms: page + 2 <= pages ? (r.chance(0.3) ? 100 : MIN) : null,
        layout: 'unknown',
        orientation: 'unknown',
        viewport: null
      });
    }
    pageExact = false;
  }
  t += 2 * MIN;

  for (let step = 0; step < steps; step++) {
    if (step === freezeAt) freeze();
    const roll = r.next();
    if (roll < 0.35) {
      // A page view; sometimes counted at an older OCR, often a skim.
      const page = r.int(1, pages);
      const old = r.chance(0.2);
      if (old) pageExact = false;
      const counts = old ? oldOcr : pageChars;
      events.push(
        ev({
          kind: 'page',
          first_page: page,
          last_page: page,
          page_chars: [counts[page - 1]],
          chars_before: cumulative(page - 1, counts),
          dwell_ms: r.chance(0.35) ? 500 : r.int(10, 90) * 1000,
          layout: 'single',
          orientation: 'portrait',
          viewport: null
        })
      );
    } else if (roll < 0.42) {
      // An older editor's page edit (+) or Reset All (−), recorded as characters.
      events.push(
        ev({ kind: 'adjust', time_delta_ms: 0, chars_delta: r.int(-size, size) }, 'dev-c')
      );
      pageExact = false;
    } else if (roll < 0.47) {
      // This editor's Reset All.
      events.push(ev({ kind: 'reset' }, 'dev-c'));
    } else if (roll < 0.52) {
      events.push(ev({ kind: 'restart' }));
    } else if (roll < 0.85) {
      // "Mark as read" here: the pages the sheet offers, up to a page.
      const state = stateOf(events);
      const notRead = pagesNotReadHere(state, VOLUME, pageChars, record);
      const upTo = r.chance(0.7) ? pages : r.int(1, pages);
      const chosen = notRead.filter((page) => page <= upTo);
      if (chosen.length > 0) {
        events.push(
          ev({
            kind: 'credit',
            pages: chosen,
            page_chars: chosen.map((page) => pageChars[page - 1]),
            time_ms: r.int(0, 30) * MIN,
            total_chars: size
          })
        );
        // A double tap: the same credit again, before the stats caught up.
        if (r.chance(0.15)) events.push({ ...events.at(-1)!, seq: ++seq, t: tick() });
      }
    } else if (roll < 0.93) {
      // A device that had not seen the rest: any pages at all.
      const chosen = Array.from({ length: pages }, (_, i) => i + 1).filter(() => r.chance(0.6));
      if (chosen.length > 0) {
        events.push(
          ev({
            kind: 'credit',
            pages: chosen,
            page_chars: chosen.map((page) => pageChars[page - 1]),
            time_ms: r.int(0, 30) * MIN,
            total_chars: size
          })
        );
      }
    } else {
      const credits = events.filter((e) => e.kind === 'credit');
      if (credits.length > 0) {
        const target = r.pick(credits);
        events.push(ev({ kind: 'retract', target: [target.device, target.seq] }));
      }
    }
  }
  if (freezeAt === steps) freeze();
  if (unfrozen) {
    return {
      pageChars,
      events,
      record,
      pageExact: false,
      frozenNow: { archivedReads: archived, legacyStats: { ...unfrozen, before: t + 1 } }
    };
  }
  return { pageChars, events, record, pageExact };
}

/** The same history without any credit: what reading alone counts. */
const withoutCredits = (events: ReadingEvent[]) =>
  events.filter((e) => e.kind !== 'credit' && e.kind !== 'retract');

function check({ pageChars, events, record, pageExact, frozenNow }: Case) {
  const size = sum(pageChars);
  const state = stateOf(events);
  const bare = stateOf(withoutCredits(events));
  const totals = state.byVolume.get(VOLUME)!;
  const plain = bare.byVolume.get(VOLUME)!;
  const figures = figuresFor(state, VOLUME, record);
  const credits = creditsFor(state, VOLUME, record);

  // Credits leave speed alone.
  expect(totals.samples).toEqual(plain.samples);
  expect(totals.pauses).toEqual(plain.pauses);
  expect(prepareVolume(events).paceTail).toEqual(prepareVolume(withoutCredits(events)).paceTail);
  const measured = measuredFigures(figures);
  const reference = figuresFor(bare, VOLUME, record);
  expect(measured.chars).toBeCloseTo(reference.chars, 6);
  expect(measured.timeMs).toBeCloseTo(reference.timeMs, 6);
  // The baseline (measured "Before history" reading) never moves for a credit.
  expect(figures.baseline.chars).toBeCloseTo(reference.baseline.chars, 6);
  expect(figures.baseline.timeMs).toBeCloseTo(reference.baseline.timeMs, 6);
  // So the lifetime figure is at most what reading alone counts, plus the credits.
  expect(figures.chars).toBeLessThanOrEqual(reference.chars + figures.credit.chars + 1e-6);

  // What credits count matches the figures — characters AND time, one
  // computation — and is never negative.
  expect(figures.credit.chars).toBeGreaterThanOrEqual(0);
  expect(figures.credit.timeMs).toBeGreaterThanOrEqual(-1e-6);
  expect(sum(credits.map((c) => c.chars))).toBeCloseTo(figures.credit.chars, 6);
  expect(sum(credits.map((c) => c.ms))).toBeCloseTo(figures.credit.timeMs, 6);

  // An unfrozen snapshot counts as freezing it now would: the freeze moves nothing.
  if (frozenNow) {
    expect(figuresFor(state, VOLUME, frozenNow)).toEqual(figures);
    expect(creditsFor(state, VOLUME, frozenNow)).toEqual(credits);
  }

  // Each pass: credits stop at the volume, less what it counts without them.
  for (let pass = 0; pass < totals.passes.length; pass++) {
    const here = credits.filter((c) => c.pass === pass);
    const creditChars = sum(here.map((c) => c.chars));
    const without = plain.passes[pass].chars;
    expect(creditChars).toBeLessThanOrEqual(Math.max(0, size - without) + 1e-6);
    expect(totals.passes[pass].chars).toBeLessThanOrEqual(Math.max(size, without) + 1e-6);
    if (pageExact) expect(totals.passes[pass].chars).toBeLessThanOrEqual(size);

    // The same, as the figures count each pass: the baseline's share in it.
    const counted = passFiguresFor(state, VOLUME, record, pass);
    const countedWithout = passFiguresFor(bare, VOLUME, record, pass).chars;
    expect(counted.chars).toBeLessThanOrEqual(Math.max(size, countedWithout) + 1e-6);
    expect(counted.credit.chars).toBeLessThanOrEqual(Math.max(0, size - countedWithout) + 1e-6);
    expect(counted.credit.chars).toBeGreaterThanOrEqual(0);
    expect(sum(here.map((c) => c.ms))).toBeCloseTo(counted.credit.timeMs, 6);
    // A pass Reset All ended counts nothing, credits and baseline included.
    if (totals.passes[pass].reset) {
      expect(counted.chars).toBe(0);
      expect(counted.credit.chars).toBe(0);
    }

    // Pages: claimed once, never one a view read, never more than the page holds.
    const seen = new Set<number>();
    for (const credit of here) {
      credit.pages.forEach((page, i) => {
        expect(page).toBeGreaterThanOrEqual(1);
        expect(page).toBeLessThanOrEqual(pageChars.length);
        expect(seen.has(page)).toBe(false);
        seen.add(page);
        expect(credit.pageChars[i]).toBeLessThanOrEqual(pageChars[page - 1]);
      });
    }
  }
  // The current pass with the baseline's share in it (the editor's figure).
  const current = passFiguresFor(state, VOLUME, record);
  const currentWithout = passFiguresFor(bare, VOLUME, record);
  expect(current.chars).toBeLessThanOrEqual(Math.max(size, currentWithout.chars) + 1e-6);
  expect(current.credit.chars).toBeGreaterThanOrEqual(0);
  if (pageExact) expect(figures.chars).toBeLessThanOrEqual(size * totals.passes.length);
  expect(totals.passRead.size).toBeLessThanOrEqual(pageChars.length);

  // The sheet offers no more than the pass has left.
  const offered = pagesNotReadHere(state, VOLUME, pageChars, record);
  expect(sum(offered.map((page) => pageChars[page - 1]))).toBeLessThanOrEqual(
    Math.max(0, size - current.chars)
  );
}

describe('credits never take a pass past its volume: a sweep over states (#224)', () => {
  it('holds for 3,000 random histories', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const built = build(rng(seed));
      try {
        check(built);
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`, { cause: error });
      }
    }
  });

  it('and a mark on top of any of them finishes the pass at the volume, no more', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const r = rng(seed * 7919);
      const { pageChars, events, record } = build(r);
      const size = sum(pageChars);
      const before = stateOf(events);
      const offered = pagesNotReadHere(before, VOLUME, pageChars, record);
      const counted = passFiguresFor(before, VOLUME, record).chars;
      if (offered.length === 0) continue;
      const after = stateOf([
        ...events,
        {
          device: 'dev-a',
          seq: 1_000_000 + seed,
          t: 10_000_000_000,
          kind: 'credit',
          volume: VOLUME,
          pages: offered,
          page_chars: offered.map((page) => pageChars[page - 1]),
          time_ms: 5 * MIN,
          total_chars: size
        }
      ]);
      const pass = passFiguresFor(after, VOLUME, record).chars;
      try {
        expect(pass).toBeLessThanOrEqual(Math.max(size, counted) + 1e-6);
      } catch (error) {
        throw new Error(`seed ${seed * 7919}: ${(error as Error).message}`, { cause: error });
      }
    }
  });

  it("and the editor's Reset All on top of any of them leaves no time, no characters, no credit", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const r = rng(seed * 104_729);
      const { events, record: built, frozenNow } = build(r);
      // The editor works on frozen records (a mark or the start freezes them).
      const record = frozenNow ?? built;
      const before = stateOf(events);
      const from = minutesAfterReset(before, VOLUME, record);
      const at = 10_000_000_000;
      const after = stateOf([
        ...events,
        {
          device: 'dev-c',
          seq: 2_000_000 + seed,
          t: at,
          kind: 'adjust',
          volume: VOLUME,
          time_delta_ms: -from * MIN,
          chars_delta: 0
        },
        { device: 'dev-c', seq: 2_000_001 + seed * 2, t: at + 1, kind: 'reset', volume: VOLUME }
      ]);
      try {
        const figures = figuresFor(after, VOLUME, record);
        // The time field said 0: what is left is under a minute (minutes are whole).
        expect(figures.timeMs).toBeGreaterThanOrEqual(0);
        expect(figures.timeMs).toBeLessThan(MIN);
        const pass = passFiguresFor(after, VOLUME, record);
        expect(pass.chars).toBe(0);
        expect(pass.credit).toEqual({ timeMs: 0, chars: 0 });
      } catch (error) {
        throw new Error(`seed ${seed * 104_729}: ${(error as Error).message}`, { cause: error });
      }
    }
  });
});
