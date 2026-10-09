import { writable } from 'svelte/store';
import type { OpenView } from './view-tracker';

/**
 * The reader's open view, for the live timer (phase 3a, one clock): the time
 * read shown while reading is the counted history plus how long this view has
 * been on screen, never more than its cap — the same rule the stats apply
 * once the view ends.
 */
export const liveView = writable<OpenView | null>(null);

/**
 * "Pause" on the reader timer: the view ends (as a hidden tab does) and no
 * time counts until the next page turn or a second click.
 */
export const readingPaused = writable(false);

export function liveMinutes(
  countedMs: number,
  open: { since: number } | null,
  now: number,
  cap: number
): number {
  const live = open ? Math.min(Math.max(0, now - open.since), cap) : 0;
  return Math.floor((countedMs + live) / 60_000);
}
