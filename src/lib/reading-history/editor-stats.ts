import { currentPassCredits } from './credit';
import {
  figuresFor,
  minutesAfterReset,
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
 */

export interface EditorStats {
  /** "Time Read", whole minutes: a time edit records the difference from this. */
  minutes: number;
  /** "Characters Read X / volume": the current pass. */
  passChars: number;
  /** "Counted when marked read": what the current pass's credits count; `null` = nothing. */
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
    minutes: figuresFor(stats, volume, record).minutes,
    passChars: passFiguresFor(stats, volume, record).chars,
    counted: ms > 0 || chars > 0 ? { ms, chars, pages } : null
  };
}

/** What a save of the editor's Reading Progress records in history. */
export interface EditorSave {
  /** The time edit: an `adjust` of `to − from` minutes. */
  timeRead: { from: number; to: number };
  /** Reset All ends the current pass (`reset`). */
  reset: boolean;
  /** Credits to retract, `[device, seq]`. */
  retract: Array<[device: string, seq: number]>;
}

/**
 * A save: `shownMinutes` is the "Time Read" the editor loaded
 * (`editorStats`), `toMinutes` what the field holds now, `resetAll` whether
 * Reset All waits for this save.
 */
export function editorSave(
  stats: ReadingStatsState,
  volume: string,
  record: BaselineSource | undefined,
  edit: { shownMinutes: number; toMinutes: number; resetAll: boolean }
): EditorSave {
  const reset = edit.resetAll && resetEndsPass(stats, volume, record);
  const from = reset ? minutesAfterReset(stats, volume, record) : edit.shownMinutes;
  return { timeRead: { from, to: edit.toMinutes }, reset, retract: [] };
}
