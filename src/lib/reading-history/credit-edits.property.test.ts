import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/env', () => ({ browser: false }));
vi.mock('#lib/catalog/db.js', () => ({ db: {} }));

import { currentPassCredits } from './credit';
import { editorSave, editorStats, type EditorSave } from './editor-stats';
import {
  DEFAULT_K,
  countVolume,
  prepareVolume,
  recentSpeed,
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
import type { EventPayload, ReadingEvent } from './types';

/*
 * A credit ("mark as read" counting pages not read here, #224) never mixes
 * with anything measured. The sweep runs ONE user's actions twice: in world A
 * every mark counts its pages; in world B the same marks count nothing
 * ("Don't count"), so B holds no credit at all. Both worlds see the same
 * reading, the same editor saves (time edits — below a credit's time
 * included — and Reset All), the same v1.11.0 edits from another device
 * (time-only, characters-only, both), restarts, re-reads, and syncs between
 * two devices of this app, each acting on what it holds. A also undoes marks,
 * un-reads, Removes and makes credits on a device that had not seen the rest.
 *
 * After every step, on each device and on the merged history:
 *
 * - A's events less its credits and retracts ARE B's: no editor save, no
 *   Reset All, no gate ever depends on a credit;
 * - A's measured figures (and what its editor shows) ARE B's figures, time
 *   and characters, exactly — lifetime and per pass;
 * - where A counts no credit (the volume, or a pass), its figures are B's: a
 *   credit taken back by Reset All, Mark as unread, Remove or Undo leaves no
 *   trace, and reading after it counts exactly as without the credit;
 * - credits never take a pass past the volume, never count below zero, and
 *   never reach speed (samples, pauses).
 */

const AUTO: IdleSettings = { k: DEFAULT_K, overrideMs: null };
const MIN = 60_000;
const PACE = 200;
const VOLUME = 'vol';
const APP_DEVICES = ['dev-a', 'dev-b'] as const;
/** A v1.11.0 install: it edits time and characters, and syncs like any device. */
const OLD_DEVICE = 'dev-old';

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
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]
  };
}

const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);

function stateOf(events: ReadingEvent[]): ReadingStatsState {
  const totals = countVolume(prepareVolume(events), PACE, AUTO);
  return {
    ready: true,
    pace: PACE,
    idle: AUTO,
    byVolume: new Map<string, VolumeTotals>([[VOLUME, totals]]),
    recent: recentSpeed([totals])
  };
}

type Device = (typeof APP_DEVICES)[number];

type Action =
  | { kind: 'read'; device: Device; pages: number[]; dwell: number[]; oldOcr: boolean }
  | { kind: 'reread'; device: Device; dwell: number }
  | { kind: 'mark'; device: Device; upTo: number; ms: number; double: boolean }
  | { kind: 'blind'; device: Device; pages: number[]; ms: number }
  | { kind: 'undo'; device: Device }
  | { kind: 'unread'; device: Device }
  | { kind: 'remove'; device: Device }
  | { kind: 'edit'; device: Device; to: number | 'same'; syncBeforeSave: boolean }
  | { kind: 'resetAll'; device: Device; syncBeforeSave: boolean }
  | { kind: 'old'; time: number; chars: number }
  | { kind: 'restart'; device: Device }
  | { kind: 'sync' };

interface Case {
  pageChars: number[];
  oldOcr: number[];
  /** Events every device holds from the start (converted turns, archived reads). */
  seed: ReadingEvent[];
  record: BaselineSource;
  actions: Array<Action & { t: number }>;
}

/** One random case: a volume, what came before history, then a run of actions. */
function build(seed: number): Case {
  const r = rng(seed);
  const pages = r.int(1, 10);
  const pageChars = Array.from({ length: pages }, () => (r.chance(0.15) ? 0 : r.int(1, 300)));
  const size = sum(pageChars);
  const oldOcr = pageChars.map((c) => Math.round(c * (0.5 + r.next())));
  const cumulative = (page: number) => sum(pageChars.slice(0, page));
  let t = 1_000_000;
  const events: ReadingEvent[] = [];

  // Before history: an archived read, converted page turns.
  const archived = r.chance(0.15) ? [{ at: t - 30 * MIN, chars: size }] : [];
  for (const read of archived) {
    events.push({
      device: `legacy:${VOLUME}`,
      seq: read.at,
      t: read.at,
      kind: 'restart',
      volume: VOLUME
    });
  }
  if (r.chance(0.2)) {
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
        chars_before: cumulative(page),
        dwell_ms: page + 2 <= pages ? (r.chance(0.3) ? 100 : MIN) : null,
        layout: 'unknown',
        orientation: 'unknown',
        viewport: null
      });
    }
  }

  const steps = r.int(1, 24);
  const actions: Case['actions'] = [];
  for (let step = 0; step < steps; step++) {
    t += r.int(1, 5) * MIN;
    const device = r.pick(APP_DEVICES);
    const roll = r.next();
    let action: Action;
    if (roll < 0.17) {
      const count = r.int(1, pages);
      const read = Array.from({ length: count }, () => r.int(1, pages));
      action = {
        kind: 'read',
        device,
        pages: read,
        // Some skims (fast), most read.
        dwell: read.map(() => (r.chance(0.3) ? 500 : r.int(10, 90) * 1000)),
        oldOcr: r.chance(0.15)
      };
    } else if (roll < 0.25) {
      action = { kind: 'reread', device, dwell: r.int(20, 90) * 1000 };
    } else if (roll < 0.38) {
      action = {
        kind: 'mark',
        device,
        upTo: r.chance(0.7) ? pages : r.int(1, pages),
        ms: r.int(0, 60) * MIN,
        double: r.chance(0.1)
      };
    } else if (roll < 0.42) {
      const chosen = Array.from({ length: pages }, (_, i) => i + 1).filter(() => r.chance(0.6));
      action = { kind: 'blind', device, pages: chosen, ms: r.int(0, 60) * MIN };
    } else if (roll < 0.46) {
      action = { kind: 'undo', device };
    } else if (roll < 0.51) {
      action = { kind: 'unread', device };
    } else if (roll < 0.54) {
      action = { kind: 'remove', device };
    } else if (roll < 0.68) {
      // Time Read set to 0, to a few minutes (below most credits' time), to
      // anything, or left alone (the save of a rename).
      const to = r.pick([0, r.int(0, 10), r.int(0, 180), 'same' as const]);
      action = { kind: 'edit', device, to, syncBeforeSave: r.chance(0.2) };
    } else if (roll < 0.76) {
      action = { kind: 'resetAll', device, syncBeforeSave: r.chance(0.2) };
    } else if (roll < 0.84) {
      // A v1.11.0 editor elsewhere: a time edit, a page edit's characters, or both.
      const shape = r.pick(['time', 'chars', 'both'] as const);
      action = {
        kind: 'old',
        time: shape === 'chars' ? 0 : r.int(-60, 60) * MIN,
        chars: shape === 'time' ? 0 : r.int(-size - 100, size)
      };
    } else if (roll < 0.88) {
      action = { kind: 'restart', device };
    } else {
      action = { kind: 'sync' };
    }
    actions.push({ ...action, t });
    // Reading takes its time: the next action starts after its views.
    if (action.kind === 'read') t += action.pages.length * 1000;
    if (action.kind === 'reread') t += pages * action.dwell;
  }

  // Reading from before history, its snapshot frozen at any point of the run.
  const record: BaselineSource = {};
  if (r.chance(0.5)) {
    const before = actions.length > 0 && r.chance(0.6) ? r.pick(actions).t + 1 : 1_000_000;
    record.archivedReads = archived;
    record.legacyStats = {
      time_ms: r.int(0, 60) * MIN,
      chars: cumulative(r.int(0, pages)) + sum(archived.map((a) => a.chars)),
      before
    };
  }
  return { pageChars, oldOcr, seed: events, record, actions };
}

/** One world: every device's events, and which of them each device holds. */
class World {
  readonly events: ReadingEvent[] = [];
  private readonly held = new Map<string, Set<ReadingEvent>>();
  private readonly seqs = new Map<string, number>();
  /** Each device's last mark, for its Undo. */
  private readonly lastMark = new Map<string, ReadingEvent[]>();

  constructor(
    readonly counts: boolean,
    seed: ReadingEvent[]
  ) {
    for (const device of [...APP_DEVICES, OLD_DEVICE]) this.held.set(device, new Set(seed));
    this.events.push(...seed);
  }

  /**
   * Credits and retracts take their `seq` from a range of their own, so that
   * every other event has the same `[device, seq, t]` in both worlds.
   */
  record(device: string, t: number, payload: EventPayload): ReadingEvent {
    const own = payload.kind === 'credit' || payload.kind === 'retract' ? 'credits' : 'events';
    const key = `${device}|${own}`;
    const seq = (this.seqs.get(key) ?? (own === 'credits' ? 1_000_000 : 0)) + 1;
    this.seqs.set(key, seq);
    const event = { device, seq, t, ...payload } as ReadingEvent;
    this.events.push(event);
    this.held.get(device)!.add(event);
    return event;
  }

  /** What `device` holds (`'all'`: the merged history), in recording order. */
  view(device: string): ReadingEvent[] {
    if (device === 'all') return this.events;
    const held = this.held.get(device)!;
    return this.events.filter((e) => held.has(e));
  }

  private readonly states = new Map<string, ReadingStatsState>();
  /** The stats over `view(device)`: events are only ever added, so their count names it. */
  state(device: string): ReadingStatsState {
    const size = device === 'all' ? this.events.length : this.held.get(device)!.size;
    const key = `${device}|${size}`;
    let state = this.states.get(key);
    if (!state) this.states.set(key, (state = stateOf(this.view(device))));
    return state;
  }

  sync() {
    for (const held of this.held.values()) for (const e of this.events) held.add(e);
  }

  mark(device: string, credits: ReadingEvent[]) {
    this.lastMark.set(device, credits);
  }

  takeMark(device: string): ReadingEvent[] {
    const credits = this.lastMark.get(device) ?? [];
    this.lastMark.delete(device);
    return credits;
  }
}

const isCreditEvent = (e: ReadingEvent) => e.kind === 'credit' || e.kind === 'retract';

/** What a save of the editor writes, as `updateVolumeStats` records it. */
function recordSave(w: World, device: string, t: number, save: EditorSave) {
  const delta = (save.timeRead.to - save.timeRead.from) * MIN;
  if (delta !== 0) {
    w.record(device, t, { kind: 'adjust', volume: VOLUME, time_delta_ms: delta, chars_delta: 0 });
  }
  if (save.reset) w.record(device, t + 1, { kind: 'reset', volume: VOLUME });
  save.retract.forEach((target, i) =>
    w.record(device, t + 2 + i, { kind: 'retract', volume: VOLUME, target })
  );
}

function retractAll(w: World, device: string, t: number, targets: Array<[string, number]>) {
  targets.forEach((target, i) =>
    w.record(device, t + i, { kind: 'retract', volume: VOLUME, target })
  );
}

/** One action in one world, as the app records it on the acting device. */
function apply(w: World, c: Case, a: Action & { t: number }) {
  const { pageChars, record } = c;
  const credit = (device: string, t: number, pages: number[], ms: number) =>
    w.record(device, t, {
      kind: 'credit',
      volume: VOLUME,
      pages,
      page_chars: pages.map((page) => pageChars[page - 1]),
      time_ms: ms,
      total_chars: sum(pageChars)
    });
  const view = (device: string, t: number, page: number, dwell: number, counts = pageChars) =>
    w.record(device, t, {
      kind: 'page',
      volume: VOLUME,
      first_page: page,
      last_page: page,
      page_chars: [counts[page - 1]],
      chars_before: sum(counts.slice(0, page - 1)),
      dwell_ms: dwell,
      layout: 'single',
      orientation: 'portrait',
      viewport: null
    });
  switch (a.kind) {
    case 'read':
      a.pages.forEach((page, i) =>
        view(a.device, a.t + i * 1000, page, a.dwell[i], a.oldOcr ? c.oldOcr : pageChars)
      );
      return;
    case 'reread': {
      let at = a.t;
      pageChars.forEach((_, i) => {
        view(a.device, at, i + 1, a.dwell);
        at += a.dwell;
      });
      return;
    }
    case 'restart':
      w.record(a.device, a.t, { kind: 'restart', volume: VOLUME });
      return;
    case 'old':
      w.record(OLD_DEVICE, a.t, {
        kind: 'adjust',
        volume: VOLUME,
        time_delta_ms: a.time,
        chars_delta: a.chars
      });
      return;
    case 'sync':
      w.sync();
      return;
    case 'mark': {
      // "Mark as read": A counts what the sheet offers; B answers Don't count.
      if (!w.counts) return;
      const state = w.state(a.device);
      const offered = pagesNotReadHere(state, VOLUME, pageChars, record);
      const chosen = offered.filter((page) => page <= a.upTo);
      if (chosen.length === 0) return;
      const made = [credit(a.device, a.t, chosen, a.ms)];
      if (a.double) made.push(credit(a.device, a.t + 1, chosen, a.ms));
      w.mark(a.device, made);
      return;
    }
    case 'blind':
      // A device that had not seen the rest counted any pages at all.
      if (w.counts && a.pages.length > 0) credit(a.device, a.t, a.pages, a.ms);
      return;
    case 'undo':
      retractAll(
        w,
        a.device,
        a.t,
        w.takeMark(a.device).map((e) => [e.device, e.seq])
      );
      return;
    case 'unread':
    case 'remove': {
      // Mark as unread and the editor's Remove: the current pass's credits.
      const state = w.state(a.device);
      const targets = currentPassCredits(state, VOLUME, record).map((credit): [string, number] => [
        credit.device,
        credit.seq
      ]);
      retractAll(w, a.device, a.t, targets);
      return;
    }
    case 'edit':
    case 'resetAll': {
      // The editor opens on what this device holds; a sync may land before Save.
      const shown = editorStats(w.state(a.device), VOLUME, record).minutes;
      if (a.syncBeforeSave) w.sync();
      const resetAll = a.kind === 'resetAll';
      const to = resetAll ? 0 : a.to === 'same' ? shown : a.to;
      const save = editorSave(w.state(a.device), VOLUME, record, {
        shownMinutes: shown,
        toMinutes: to,
        resetAll
      });
      recordSave(w, a.device, a.t, save);
      return;
    }
  }
}

/** World A and world B, as one device (or the merged history, `'all'`) holds them. */
function compare(c: Case, A: World, B: World, device: string) {
  const { record, pageChars } = c;
  const size = sum(pageChars);
  const credited = A.view(device);
  const plain = B.view(device);
  const a = A.state(device);
  const b = B.state(device);
  const fa = figuresFor(a, VOLUME, record);
  const fb = figuresFor(b, VOLUME, record);
  expect(fb.credit).toEqual({ timeMs: 0, chars: 0 });

  // Measured figures, and what the editor shows and edits, never hold a credit.
  const measured = measuredFigures(fa);
  expect(measured.timeMs).toBe(fb.timeMs);
  expect(measured.chars).toBe(fb.chars);
  const editorA = editorStats(a, VOLUME, record);
  const editorB = editorStats(b, VOLUME, record);
  expect(editorA.minutes).toBe(editorB.minutes);
  expect(editorA.passChars).toBe(editorB.passChars);
  // No credit counted: no trace of one.
  if (fa.credit.timeMs === 0 && fa.credit.chars === 0) {
    expect(fa.timeMs).toBe(fb.timeMs);
    expect(fa.chars).toBe(fb.chars);
  }
  expect(fa.credit.chars).toBeGreaterThanOrEqual(0);
  expect(fa.credit.timeMs).toBeGreaterThanOrEqual(-1e-6);

  const ta = a.byVolume.get(VOLUME)!;
  const tb = b.byVolume.get(VOLUME)!;
  expect(ta.passes.length).toBe(tb.passes.length);
  for (let pass = 0; pass < ta.passes.length; pass++) {
    const pa = passFiguresFor(a, VOLUME, record, pass);
    const pb = passFiguresFor(b, VOLUME, record, pass);
    expect(pa.chars - pa.credit.chars).toBe(pb.chars);
    if (pa.credit.chars === 0 && pa.credit.timeMs === 0) expect(pa.chars).toBe(pb.chars);
    // Credits never take a pass past the volume.
    expect(pa.credit.chars).toBeGreaterThanOrEqual(0);
    expect(pa.credit.chars).toBeLessThanOrEqual(Math.max(0, size - pb.chars));
    expect(pa.chars).toBeLessThanOrEqual(Math.max(size, pb.chars));
  }

  // Speed never sees a credit.
  expect(JSON.stringify(ta.samples)).toBe(JSON.stringify(tb.samples));
  expect(JSON.stringify(ta.pauses)).toBe(JSON.stringify(tb.pauses));

  // Structurally: every event but the credits' is the same in both worlds.
  expect(JSON.stringify(credited.filter((e) => !isCreditEvent(e)))).toBe(JSON.stringify(plain));
}

/** How often a run reached the shapes the sweep is for. */
interface Reached {
  /** A Time Read saved below the time a live credit of that pass counts. */
  editsBelowCredit: number;
  /** A Reset All that took a live credit back. */
  resetsOfCredits: number;
  /** A re-read after every credit was taken back. */
  rereadsAfterCredits: number;
}

function run(c: Case, reached: Reached) {
  const A = new World(true, c.seed);
  const B = new World(false, c.seed);
  for (const action of c.actions) {
    if (action.kind === 'edit' || action.kind === 'resetAll') {
      const counted = editorStats(A.state(action.device), VOLUME, c.record).counted;
      const to = action.kind === 'resetAll' ? 0 : action.to;
      if (counted && counted.ms > 0 && to !== 'same' && to * MIN < counted.ms) {
        reached.editsBelowCredit++;
      }
      if (action.kind === 'resetAll' && counted) reached.resetsOfCredits++;
    }
    // A re-read on a device whose credits were all taken back (retracted, or
    // in a pass Reset All ended): what it adds is what it adds without them.
    // (A live credit is not taken back: it fills whatever pages real reading
    // leaves — a look-up visit a later view reveals can un-read a page.)
    const before =
      action.kind === 'reread'
        ? (() => {
            const state = A.state(action.device);
            const passes = state.byVolume.get(VOLUME)?.passes ?? [];
            const live = creditsFor(state, VOLUME, c.record);
            return {
              idle: live.every((credit) => passes[credit.pass]?.reset),
              a: figuresFor(state, VOLUME, c.record),
              b: figuresFor(B.state(action.device), VOLUME, c.record)
            };
          })()
        : null;
    apply(A, c, action);
    apply(B, c, action);
    for (const device of [...APP_DEVICES, 'all']) compare(c, A, B, device);

    if (before?.idle && action.kind === 'reread') {
      if (A.events.some(isCreditEvent)) reached.rereadsAfterCredits++;
      const a = figuresFor(A.state(action.device), VOLUME, c.record);
      const b = figuresFor(B.state(action.device), VOLUME, c.record);
      expect(a.credit).toEqual(before.a.credit);
      expect(a.timeMs - before.a.timeMs).toBeCloseTo(b.timeMs - before.b.timeMs, 6);
      expect(a.chars - before.a.chars).toBe(b.chars - before.b.chars);
    }
    // Reset All, saved on what the device held when it opened: nothing of
    // the pass is left there, credits included, and no measured time. (Not
    // under a snapshot frozen after the save — a record merge from a device
    // that froze later: the old figure then still holds the time from before
    // the freeze, with or without credits alike.)
    const frozenBefore = (c.record.legacyStats?.before ?? -Infinity) <= action.t;
    if (action.kind === 'resetAll' && !action.syncBeforeSave && frozenBefore) {
      const state = A.state(action.device);
      const pass = passFiguresFor(state, VOLUME, c.record);
      expect(pass.chars).toBe(0);
      expect(pass.credit).toEqual({ timeMs: 0, chars: 0 });
      expect(currentPassCredits(state, VOLUME, c.record)).toEqual([]);
      expect(measuredFigures(figuresFor(state, VOLUME, c.record)).timeMs).toBeLessThan(MIN);
    }
  }
}

describe('credits never mix with edits: a sweep over interleavings (#224)', () => {
  it('holds for 1,500 random runs of credits, edits, resets, un-reads, removes, re-reads and syncs', () => {
    let resets = 0;
    let lowEdits = 0;
    let oldEdits = 0;
    const reached: Reached = { editsBelowCredit: 0, resetsOfCredits: 0, rereadsAfterCredits: 0 };
    for (let seed = 1; seed <= 1500; seed++) {
      const c = build(seed);
      resets += c.actions.filter((a) => a.kind === 'resetAll').length;
      lowEdits += c.actions.filter(
        (a) => a.kind === 'edit' && a.to !== 'same' && a.to <= 10
      ).length;
      oldEdits += c.actions.filter((a) => a.kind === 'old').length;
      try {
        run(c, reached);
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`, { cause: error });
      }
    }
    // The generator does reach the shapes it is for: a time saved below a
    // live credit's own time, a Reset All taking a credit back, a re-read
    // after every credit went (each was a review finding's path).
    expect(resets).toBeGreaterThan(500);
    expect(lowEdits).toBeGreaterThan(500);
    expect(oldEdits).toBeGreaterThan(500);
    expect(reached.editsBelowCredit).toBeGreaterThan(300);
    expect(reached.resetsOfCredits).toBeGreaterThan(200);
    expect(reached.rereadsAfterCredits).toBeGreaterThan(50);
  }, 120_000);
});
