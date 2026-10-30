import { derived } from 'svelte/store';
import { volumes } from '$lib/settings/volume-data';
import { figuresFor, readingStats } from './stats-store';

export interface TotalStats {
  completed: number;
  /** Position-based: pages up to each volume's current page, plus archived passes. */
  pagesRead: number;
  /** Read characters from history, plus each volume's pre-history baseline. */
  charsRead: number;
  /** Characters on pages only skimmed past — never counted as read. */
  charsSkipped: number;
  minutesRead: number;
}

/** Lifetime totals for Settings → Stats. */
export const totalStats = derived([volumes, readingStats], ([$volumes, $stats]) => {
  const totals: TotalStats = {
    completed: 0,
    pagesRead: 0,
    charsRead: 0,
    charsSkipped: 0,
    minutesRead: 0
  };
  for (const [id, record] of Object.entries($volumes)) {
    if (record.completed) totals.completed++;
    totals.pagesRead += record.progress;
    // Lifetime totals keep every archived pass (restart series never lowers them)
    for (const read of record.archivedReads) totals.pagesRead += read.pages;
    const figures = figuresFor($stats, id, record);
    totals.charsRead += figures.chars;
    totals.charsSkipped += figures.skippedChars;
    totals.minutesRead += figures.minutes;
  }
  return totals;
});
