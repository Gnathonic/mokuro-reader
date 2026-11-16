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
  pagesNotReadHere,
  passFiguresFor,
  type BaselineSource,
  type ReadingStatsState
} from './stats-store';
import type { ReadingEvent } from './types';

/*
 * A sweep over the states a volume's history can be in (#224): reading here
 * and on other devices, skims, converted page turns, older editors' adjusts,
 * Reset All, restarts, reading from before history (frozen snapshots with
 * archived reads), pages counted at an older OCR, credits made by THIS flow
 * (`pagesNotReadHere` → the credit `markRead` records) and by a device that
 * had not seen the rest, retracts, double marks. Whatever the state:
 *
 * - a pass never counts more than the volume once credits are in: what
 *   credits add stops at the volume's characters, less what the pass counts
 *   without them (views, adjusts, the baseline's share);
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

  // Reading from before history: the old counter's lump, frozen at `before`.
  const record: BaselineSource = {};
  if (r.chance(0.4)) {
    const archived = r.chance(0.3) ? [{ at: t - 10 * MIN, chars: size }] : [];
    if (archived.length > 0) {
      events.push({
        device: `legacy:${VOLUME}`,
        seq: archived[0].at,
        t: archived[0].at,
        kind: 'restart',
        volume: VOLUME
      });
    }
    const position = cumulative(r.int(0, pages), pageChars);
    record.archivedReads = archived;
    record.legacyStats = {
      time_ms: r.int(0, 60) * MIN,
      chars: position + sum(archived.map((a) => a.chars)),
      before: t + MIN
    };
    pageExact = false;
  }
  // Converted page turns (before the freeze), one per spread.
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
        dwell_ms: page + 2 <= pages ? MIN : null,
        layout: 'unknown',
        orientation: 'unknown',
        viewport: null
      });
    }
    pageExact = false;
  }
  t += 2 * MIN;

  const steps = r.int(1, 14);
  for (let step = 0; step < steps; step++) {
    const roll = r.next();
    if (roll < 0.35) {
      // A page view; sometimes counted at an older OCR, sometimes a skim.
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
          dwell_ms: r.chance(0.2) ? 500 : r.int(10, 90) * 1000,
          layout: 'single',
          orientation: 'portrait',
          viewport: null
        })
      );
    } else if (roll < 0.45) {
      // An older editor's page edit (+) or Reset All (−).
      events.push(
        ev({ kind: 'adjust', time_delta_ms: 0, chars_delta: r.int(-size, size) }, 'dev-c')
      );
      pageExact = false;
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
  return { pageChars, events, record, pageExact };
}

/** The same history without any credit: what reading alone counts. */
const withoutCredits = (events: ReadingEvent[]) =>
  events.filter((e) => e.kind !== 'credit' && e.kind !== 'retract');

function check({ pageChars, events, record, pageExact }: Case) {
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

  // What credits count matches the figures, and is never negative.
  expect(figures.credit.chars).toBeGreaterThanOrEqual(0);
  expect(figures.credit.timeMs).toBeGreaterThanOrEqual(-1e-6);
  expect(sum(credits.map((c) => c.chars))).toBeCloseTo(figures.credit.chars, 6);

  // Each pass: credits stop at the volume, less what it counts without them.
  for (let pass = 0; pass < totals.passes.length; pass++) {
    const here = credits.filter((c) => c.pass === pass);
    const creditChars = sum(here.map((c) => c.chars));
    const without = plain.passes[pass].chars;
    expect(creditChars).toBeLessThanOrEqual(Math.max(0, size - without) + 1e-6);
    expect(totals.passes[pass].chars).toBeLessThanOrEqual(Math.max(size, without) + 1e-6);
    if (pageExact) expect(totals.passes[pass].chars).toBeLessThanOrEqual(size);

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
});
