import { writable } from 'svelte/store';
import { countedDwell } from './stats-engine';
import type { PauseCount } from './types';
import type { OpenView } from './view-tracker';

/**
 * The reader's open view, for the live timer (phase 3a, one clock): the time
 * read shown while reading is the counted history plus how long this view has
 * been on screen, counted by the same rule the stats apply once it ends. Its
 * `answer` is the standing default already attached to it (phase 3b), which
 * the live timer counts by.
 */
export const liveView = writable<OpenView | null>(null);

/**
 * "Pause" on the reader timer: the view ends (as a hidden tab does) and no
 * time counts until the next page turn or a second click.
 */
export const readingPaused = writable(false);

/**
 * Counted history plus the open view under `countedDwell`: its dwell up to
 * the cap, past it the typical time unless an answer says otherwise. Without
 * `typical`, a view past its cap counts the cap (the 3a rule).
 */
export function liveMinutes(
  countedMs: number,
  open: { since: number } | null,
  now: number,
  cap: number,
  typical: number = cap,
  answer: PauseCount | null = null
): number {
  const live = open ? countedDwell(Math.max(0, now - open.since), cap, typical, answer) : 0;
  return Math.floor((countedMs + live) / 60_000);
}
