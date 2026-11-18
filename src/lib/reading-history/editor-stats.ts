import type { CreditTotals } from './stats-engine';
import {
  creditsFor,
  figuresFor,
  passFiguresFor,
  resetEndsPass,
  type BaselineSource,
  type ReadingStatsState
} from './stats-store';

/**
 * The volume editor's "Reading Progress" (#224), as numbers: what it shows,
 * and what a save of it records in reading history. Pure, so the editor's
 * arithmetic is tested as the editor runs it (`VolumeEditorModal.svelte`
 * only renders these and hands `editorSave` to `updateVolumeStats`).
 *
 * The editor shows and edits what the app MEASURED; what "mark as read"
 * counted is a line of its own, never part of a field. A time edit is
 * recorded as the difference from the figure shown, and the stats apply it
 * to the measured time only, clamped there (`figuresFor`) — so no later
 * change to a credit (Reset All, Mark as unread, Remove, Undo, another
 * device's credit or retract arriving) can meet an edit, and with the credit
 * gone the figures are exactly those of the same history without it. (An
 * edit from a figure holding a credit's time took that time off a second
 * time when the credit went, and a re-read came up short by it.) Shipped
 * v1.11.0 edits were made from measured figures — that build had no
 * credits — and keep their meaning.
 */

/** What credits count, summed — `null` when they count nothing. */
export interface CountedLine {
  ms: number;
  chars: number;
  pages: number;
}

export interface EditorStats {
  /** "Time Read", whole minutes measured: a time edit records the difference from this. */
  minutes: number;
  /** "Characters Read X / volume": the current pass, measured. */
  passChars: number;
  /** "Also counted when marked read": the current pass's credits (Remove takes these). */
  counted: CountedLine | null;
  /**
   * What credits of EARLIER passes (read-throughs before a restart) count:
   * on the card's lifetime figures like any credit, so shown beside them —
   * the editor accounts for every credit the card holds (`minutes` + both
   * lines' time = the card's time). Reset All takes these too; Remove and
   * Mark as unread are about this read-through only.
   */
  earlier: CountedLine | null;
}

function line(credits: CreditTotals[]): CountedLine | null {
  const ms = credits.reduce((n, c) => n + c.ms, 0);
  const chars = credits.reduce((n, c) => n + c.chars, 0);
  const pages = credits.reduce((n, c) => n + c.pages.length, 0);
  return ms > 0 || chars > 0 ? { ms, chars, pages } : null;
}

/** Every live credit of the volume, split into the current pass's and earlier ones. */
function creditsByPass(stats: ReadingStatsState, volume: string, record?: BaselineSource) {
  const totals = stats.byVolume.get(volume);
  const all = totals ? creditsFor(stats, volume, record) : [];
  const pass = totals?.pass ?? 0;
  return {
    all,
    current: all.filter((c) => c.pass === pass),
    earlier: all.filter((c) => c.pass !== pass)
  };
}

export function editorStats(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource
): EditorStats {
  const credits = creditsByPass(stats, volume, record);
  return {
    minutes: Math.floor(figuresFor(stats, volume, record).measured.timeMs / 60_000),
    passChars: passFiguresFor(stats, volume, record).measuredChars,
    counted: line(credits.current),
    earlier: line(credits.earlier)
  };
}

/** What a save of the editor's Reading Progress records in history. */
export interface EditorSave {
  /** The time edit: an `adjust` of `to − from` minutes, from the measured time shown. */
  timeRead: { from: number; to: number };
  /** Reset All ends the current pass (`reset`): only when it measured something. */
  reset: boolean;
  /** Credits to retract, `[device, seq]`: Reset All takes every live one, of any pass. */
  retract: Array<[device: string, seq: number]>;
}

/**
 * A save: `shownMinutes` is the "Time Read" the editor loaded
 * (`editorStats`), `toMinutes` what the field holds now, `resetAll` whether
 * Reset All waits for this save — read against `stats` as they are at the
 * save. Reset All is two independent things: the `reset` of what the pass
 * measured (`resetEndsPass`, which never looks at a credit) and the retract
 * of every credit the volume holds — the current pass's, as Remove does,
 * and earlier passes' too: Reset All takes the card's time to what the
 * field saved, and a credit's time cannot go without its characters. (An
 * earlier pass's MEASURED characters stay on the card, as in v1.11.0.)
 */
export function editorSave(
  stats: ReadingStatsState,
  volume: string,
  record: BaselineSource | undefined,
  edit: { shownMinutes: number; toMinutes: number; resetAll: boolean }
): EditorSave {
  return {
    timeRead: { from: edit.shownMinutes, to: edit.toMinutes },
    reset: edit.resetAll && resetEndsPass(stats, volume, record),
    retract: edit.resetAll
      ? creditsByPass(stats, volume, record).all.map((c): [string, number] => [c.device, c.seq])
      : []
  };
}
