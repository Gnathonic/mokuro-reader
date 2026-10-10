import { writable } from 'svelte/store';
import { countedDwell, typicalDwell, viewCap, type IdleSettings } from './stats-engine';
import type { PagePayload, PauseCount } from './types';
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
 * The view that just ended, with what the stats will count for it. It is
 * recorded, then counted on the stats' next pass; until then the live timer
 * adds it itself, so a page turn never dips and an answer that counts less
 * than the time on screen ("Don't count", "Count typical") shows at once.
 */
export interface EndedView {
  volume: string;
  ms: number;
}
export const endedView = writable<EndedView | null>(null);

/** What the stats will count for an ended view: `countedDwell` under its cap. */
export function endedViewMs(
  page: Pick<PagePayload, 'dwell_ms' | 'page_chars'>,
  answer: PauseCount | null,
  pace: number | null,
  idle: IdleSettings
): number {
  if (page.dwell_ms === null) return 0;
  const chars = page.page_chars.reduce((sum, c) => sum + c, 0);
  const cap = viewCap(chars, pace, idle);
  return countedDwell(page.dwell_ms, cap, typicalDwell(chars, pace, cap), answer);
}

/**
 * Counted history plus the open view: its dwell up to the cap. Past the cap
 * an answer decides (`countedDwell`); unanswered, the timer stops at the cap
 * while the prompt asks — the view counts typical time only once it ends
 * unanswered (`endedViewMs`).
 */
export function liveMinutes(
  countedMs: number,
  open: { since: number } | null,
  now: number,
  cap: number,
  typical: number = cap,
  answer: PauseCount | null = null
): number {
  const dwell = open ? Math.max(0, now - open.since) : 0;
  const live = !open
    ? 0
    : answer === null
      ? Math.min(dwell, cap)
      : countedDwell(dwell, cap, typical, answer);
  return Math.floor((countedMs + live) / 60_000);
}
