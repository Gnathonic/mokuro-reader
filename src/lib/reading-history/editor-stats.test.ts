import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/env', () => ({ browser: false }));
vi.mock('#lib/catalog/db.js', () => ({ db: {} }));

import { currentPassCredits } from './credit';
import { editorSave, editorStats } from './editor-stats';
import {
  DEFAULT_K,
  countVolume,
  prepareVolume,
  recentSpeed,
  type VolumeTotals
} from './stats-engine';
import { figuresFor, measuredFigures, passFiguresFor, type ReadingStatsState } from './stats-store';
import type { EventPayload, ReadingEvent } from './types';

/*
 * The volume editor's time and characters never mix with what "mark as read"
 * counted (#224). An edit is a difference from the figure the editor showed;
 * were that figure to hold a credit's time, any later change to the credit —
 * Reset All, Mark as unread, Remove, Undo — would take the credit's time off
 * a second time, and a re-read would count short. The editor shows and edits
 * what the app MEASURED; credits sit on top, on their own line.
 */

const MIN = 60_000;
const VOLUME = 'vol';
/** Six pages of 1,000 characters. */
const PAGE_CHARS = [1000, 1000, 1000, 1000, 1000, 1000];
const SIZE = 6000;

/** One volume's history on one device, written the way the app writes it. */
class History {
  events: ReadingEvent[] = [];
  private seq = 0;
  private t = 1_000_000;

  constructor(private readonly withCredits = true) {}

  /**
   * Credits and retracts land between the minutes, so every other event has
   * the same time with or without them.
   */
  add(payload: EventPayload) {
    const credit = payload.kind === 'credit' || payload.kind === 'retract';
    const t = credit ? this.t + 1 + (this.seq % 1000) : (this.t += MIN);
    this.events.push({ device: 'dev-a', seq: ++this.seq, t, ...payload } as ReadingEvent);
  }

  state(): ReadingStatsState {
    const totals = countVolume(prepareVolume(this.events), 100, { k: DEFAULT_K, overrideMs: null });
    return {
      ready: true,
      pace: 100,
      idle: { k: DEFAULT_K, overrideMs: null },
      byVolume: new Map<string, VolumeTotals>([[VOLUME, totals]]),
      recent: recentSpeed([totals])
    };
  }

  figures() {
    return figuresFor(this.state(), VOLUME);
  }

  /** Pages read here, `perPage` ms each. */
  read(pages: number[], perPage: number) {
    for (const page of pages) {
      this.add({
        kind: 'page',
        volume: VOLUME,
        first_page: page,
        last_page: page,
        page_chars: [PAGE_CHARS[page - 1]],
        chars_before: (page - 1) * 1000,
        dwell_ms: perPage,
        layout: 'single',
        orientation: 'portrait',
        viewport: null
      });
    }
  }

  /** "Mark as read" → Count them, at `ms` (nothing without credits: Don't count). */
  credit(pages: number[], ms: number) {
    if (!this.withCredits) return;
    this.add({
      kind: 'credit',
      volume: VOLUME,
      pages,
      page_chars: pages.map((page) => PAGE_CHARS[page - 1]),
      time_ms: ms,
      total_chars: SIZE
    });
  }

  /** "Mark as unread" / the editor's Remove: the current pass's credits retracted. */
  retractCurrentPass() {
    for (const c of currentPassCredits(this.state(), VOLUME)) {
      this.add({ kind: 'retract', volume: VOLUME, target: [c.device, c.seq] });
    }
  }

  /** The editor: opened, "Time Read" set to `to` minutes (or Reset All), saved. */
  editor(edit: { to: number } | 'reset all') {
    const resetAll = edit === 'reset all';
    const shown = editorStats(this.state(), VOLUME);
    const save = editorSave(this.state(), VOLUME, undefined, {
      shownMinutes: shown.minutes,
      toMinutes: resetAll ? 0 : edit.to,
      resetAll
    });
    const delta = (save.timeRead.to - save.timeRead.from) * MIN;
    if (delta !== 0) {
      this.add({ kind: 'adjust', volume: VOLUME, time_delta_ms: delta, chars_delta: 0 });
    }
    if (save.reset) this.add({ kind: 'reset', volume: VOLUME });
    for (const target of save.retract) this.add({ kind: 'retract', volume: VOLUME, target });
  }
}

/** The whole volume read again here: 4 min a page, 24 min, 6,000 characters, 250 / min. */
const REREAD_MS = 4 * MIN;

describe('the volume editor never edits a credit (#224)', () => {
  it('shows what the app measured; what marking read counted is a line of its own', () => {
    const h = new History();
    h.read([1, 2, 3, 4], MIN);
    h.credit([5, 6], 30 * MIN);
    expect(h.figures()).toMatchObject({ timeMs: 34 * MIN, chars: SIZE });
    expect(editorStats(h.state(), VOLUME)).toEqual({
      minutes: 4,
      passChars: 4000,
      counted: { ms: 30 * MIN, chars: 2000, pages: 2 },
      earlier: null
    });
  });

  /*
   * Review finding (LOW): an earlier read-through's credit is on the card,
   * but the editor showed only this read-through's, and Reset All left it —
   * the card kept its time after Time Read was saved at 0.
   */
  it("an earlier read-through's credit is shown, and Reset All takes the card's time to 0", () => {
    const h = new History();
    h.read([1, 2], MIN);
    h.credit([3, 4, 5, 6], 40 * MIN);
    h.add({ kind: 'restart', volume: VOLUME });
    h.read([1, 2], 1.5 * MIN);
    h.credit([3], 10 * MIN);
    const figures = h.figures();
    expect(figures).toMatchObject({ timeMs: 55 * MIN, chars: 9000 });
    const shown = editorStats(h.state(), VOLUME);
    expect(shown).toEqual({
      minutes: 5,
      passChars: 2000,
      counted: { ms: 10 * MIN, chars: 1000, pages: 1 },
      earlier: { ms: 40 * MIN, chars: 4000, pages: 4 }
    });
    // Every minute on the card is in the editor: measured, or one of its lines.
    expect(shown.minutes * MIN + shown.counted!.ms + shown.earlier!.ms).toBe(figures.timeMs);
    // Remove and Mark as unread are about this read-through only.
    expect(currentPassCredits(h.state(), VOLUME).map((c) => c.chars)).toEqual([1000]);
    h.editor('reset all');
    // The earlier pass's measured characters stay, as in v1.11.0; no credit does.
    expect(h.figures()).toMatchObject({ timeMs: 0, chars: 2000, credit: { timeMs: 0, chars: 0 } });
    expect(editorStats(h.state(), VOLUME)).toMatchObject({ counted: null, earlier: null });
  });

  it('a time edit below the credit edits the measured time; the credit stays as counted', () => {
    const h = new History();
    h.read([1, 2, 3, 4], 2.5 * MIN);
    h.credit([5, 6], 60 * MIN);
    h.editor({ to: 5 });
    const figures = h.figures();
    expect(measuredFigures(figures)).toEqual({ timeMs: 5 * MIN, chars: 4000 });
    expect(figures).toMatchObject({
      timeMs: 65 * MIN,
      chars: SIZE,
      credit: { timeMs: 60 * MIN, chars: 2000 }
    });
  });

  /*
   * Review finding (MEDIUM): credit 60 min / 6,000 chars, the editor's time
   * saved, Reset All, the volume read again in 24 min. Before: 0 min shown
   * for a time of 0, 4 min (1,500 / min "measured") for 40; 24 without the
   * credit.
   */
  for (const to of [0, 40]) {
    it(`a credit, Time Read saved at ${to}, Reset All: a 24-min re-read counts 24 min, as without the credit`, () => {
      const run = (withCredits: boolean) => {
        const h = new History(withCredits);
        h.credit([1, 2, 3, 4, 5, 6], 60 * MIN);
        h.editor({ to });
        h.editor('reset all');
        const reset = h.figures();
        h.read([1, 2, 3, 4, 5, 6], REREAD_MS);
        return { h, reset, again: h.figures() };
      };
      const credited = run(true);
      const plain = run(false);
      expect(credited.again).toEqual(plain.again);
      expect(credited.again.timeMs - credited.reset.timeMs).toBe(24 * MIN);
      expect(credited.again.chars - credited.reset.chars).toBe(SIZE);
      expect(credited.again.credit).toEqual({ timeMs: 0, chars: 0 });
      expect(passFiguresFor(credited.h.state(), VOLUME).chars).toBe(SIZE);
      // The volume's measured speed is the re-read's: 250 characters a minute.
      const measured = measuredFigures(credited.again);
      expect((measured.chars / measured.timeMs) * MIN).toBe(250);
      expect(credited.h.state().recent.charsPerMinute).toBe(250);
    });
  }

  /*
   * Review finding (LOW): credit 60 min, Time Read saved at 40, Mark as
   * unread, the volume read in 24 min. Before: 4 min shown, 6,000 measured
   * characters.
   */
  it('a credit, Time Read saved, Mark as unread: a re-read counts as it would without the credit', () => {
    const run = (withCredits: boolean) => {
      const h = new History(withCredits);
      h.credit([1, 2, 3, 4, 5, 6], 60 * MIN);
      h.editor({ to: 40 });
      h.retractCurrentPass();
      const unread = h.figures();
      h.read([1, 2, 3, 4, 5, 6], REREAD_MS);
      return { unread, again: h.figures() };
    };
    const credited = run(true);
    const plain = run(false);
    expect(credited.unread).toEqual(plain.unread);
    expect(credited.again).toEqual(plain.again);
    expect(credited.again.timeMs - credited.unread.timeMs).toBe(24 * MIN);
    expect(credited.again.chars - credited.unread.chars).toBe(SIZE);
  });

  it('Reset All of a pass holding only a credit retracts it and ends no pass', () => {
    const h = new History();
    h.credit([1, 2, 3, 4, 5, 6], 60 * MIN);
    const credit = h.events.at(-1)!;
    const save = editorSave(h.state(), VOLUME, undefined, {
      shownMinutes: editorStats(h.state(), VOLUME).minutes,
      toMinutes: 0,
      resetAll: true
    });
    // Nothing measured to end: the gate never looks at credits.
    expect(save).toEqual({
      timeRead: { from: 0, to: 0 },
      reset: false,
      retract: [[credit.device, credit.seq]]
    });
  });

  it('Reset All of a pass with reading in it ends it and retracts its credits', () => {
    const h = new History();
    h.read([1, 2], MIN);
    h.credit([3, 4, 5, 6], 60 * MIN);
    const credit = h.events.at(-1)!;
    h.editor('reset all');
    expect(h.events.slice(-3).map((e) => e.kind)).toEqual(['adjust', 'reset', 'retract']);
    expect(h.figures()).toMatchObject({ timeMs: 0, chars: 0, credit: { timeMs: 0, chars: 0 } });
    expect(h.events.at(-1)).toMatchObject({ target: [credit.device, credit.seq] });
  });
});

describe('credits sit on top of the measured figures (#224)', () => {
  /** A shipped v1.11.0 editor's Reset All: the record's characters as a negative edit. */
  const v111Reset = (h: History, chars: number) =>
    h.events.push({
      device: 'dev-old',
      seq: 1,
      t: 1_000_000 + 30 * MIN,
      kind: 'adjust',
      volume: VOLUME,
      time_delta_ms: 0,
      chars_delta: -chars
    });

  it('a v1.11.0 negative characters edit holds the measured figure at 0, never a credit', () => {
    const h = new History();
    h.read([1, 2, 3, 4], MIN);
    v111Reset(h, SIZE);
    h.credit([5, 6], 20 * MIN);
    const figures = h.figures();
    expect(measuredFigures(figures)).toEqual({ timeMs: 4 * MIN, chars: 0 });
    expect(figures).toMatchObject({
      timeMs: 24 * MIN,
      chars: 2000,
      credit: { timeMs: 20 * MIN, chars: 2000 }
    });
    // The pass: nothing measured, the credit on top — never past the volume.
    expect(passFiguresFor(h.state(), VOLUME)).toMatchObject({
      chars: 2000,
      credit: { chars: 2000 }
    });
  });

  it('a time edit below zero holds the measured time at 0; the credit counts in full', () => {
    const h = new History();
    h.read([1], 10 * MIN);
    // Two devices both took the same 10 min off.
    for (const device of ['dev-b', 'dev-c']) {
      h.events.push({
        device,
        seq: 1,
        t: 1_000_000 + 2 * MIN,
        kind: 'adjust',
        volume: VOLUME,
        time_delta_ms: -10 * MIN,
        chars_delta: 0
      });
    }
    h.credit([2, 3], 30 * MIN);
    expect(h.figures()).toMatchObject({ timeMs: 30 * MIN, credit: { timeMs: 30 * MIN } });
    expect(measuredFigures(h.figures()).timeMs).toBe(0);
  });
});
