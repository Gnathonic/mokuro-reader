import { currentPassCredits } from './credit';
import {
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

export interface EditorStats {
  /** "Time Read", whole minutes measured: a time edit records the difference from this. */
  minutes: number;
  /** "Characters Read X / volume": the current pass, measured. */
  passChars: number;
  /** "Also counted when marked read": the current pass's credits; `null` = nothing. */
  counted: { ms: number; chars: number; pages: number } | null;
}

export function editorStats(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource
): EditorStats {
  const credits = currentPassCredits(stats, volume, record);
  const ms = credits.reduce((n, c) => n + c.ms, 0);
  const chars = credits.reduce((n, c) => n + c.chars, 0);
  const pages = credits.reduce((n, c) => n + c.pages.length, 0);
  return {
    minutes: Math.floor(figuresFor(stats, volume, record).measured.timeMs / 60_000),
    passChars: passFiguresFor(stats, volume, record).measuredChars,
    counted: ms > 0 || chars > 0 ? { ms, chars, pages } : null
  };
}

/** What a save of the editor's Reading Progress records in history. */
export interface EditorSave {
  /** The time edit: an `adjust` of `to − from` minutes, from the measured time shown. */
  timeRead: { from: number; to: number };
  /** Reset All ends the current pass (`reset`): only when it measured something. */
  reset: boolean;
  /** Credits to retract, `[device, seq]`: Reset All takes the current pass's. */
  retract: Array<[device: string, seq: number]>;
}

/**
 * A save: `shownMinutes` is the "Time Read" the editor loaded
 * (`editorStats`), `toMinutes` what the field holds now, `resetAll` whether
 * Reset All waits for this save — read against `stats` as they are at the
 * save. Reset All is two independent things: the `reset` of what the pass
 * measured (`resetEndsPass`, which never looks at a credit) and the retract
 * of what it counted when marked read, as Remove does.
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
      ? currentPassCredits(stats, volume, record).map((c): [string, number] => [c.device, c.seq])
      : []
  };
}
