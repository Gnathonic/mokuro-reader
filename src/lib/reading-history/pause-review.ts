import { derived, type Readable } from 'svelte/store';
import type { Pause, VolumeTotals } from './stats-engine';
import { readingStats } from './stats-store';

/**
 * The "long pauses to review" list (phase 3b; spec: "Long pauses"): every
 * volume's pauses, flattened, newest first. A pause is a view left open past
 * its cap, plus any view that has been answered. Derived from
 * `readingStats`, so an answer recorded anywhere (the reader's prompt, this
 * list, another device) appears here once the stats recount.
 *
 * Unanswered pauses count typical time and are PROVISIONAL. `answered` is
 * also the "answered a few prompts" count that unlocks "Always do this". It
 * is derived rather than stored, so it syncs with the events themselves.
 */

export interface ReviewPause extends Pause {
  volume: string;
}

export interface PauseReview {
  pauses: ReviewPause[];
  unanswered: number;
  answered: number;
}

type TitleSource = { series_title?: string; volume_title?: string };

/**
 * One volume's rows, built once per `VolumeTotals` object. A page turn
 * recounts only its own volume and keeps every other volume's totals object
 * (`flushReadingStats`), so the other volumes' rows are reused.
 */
const rowsOf = new WeakMap<Pick<VolumeTotals, 'pauses'>, ReviewPause[]>();

/** A pause's identity: its page event's `[device, seq]`. */
export function pauseKey(p: Pick<Pause, 'device' | 'seq'>): string {
  return `${p.device}\u0000${p.seq}`;
}

export function reviewPauses(
  byVolume: ReadonlyMap<string, Pick<VolumeTotals, 'pauses'>>
): PauseReview {
  const pauses: ReviewPause[] = [];
  for (const [volume, totals] of byVolume) {
    if (totals.pauses.length === 0) continue;
    let rows = rowsOf.get(totals);
    if (!rows) {
      rows = totals.pauses.map((p) => ({ ...p, volume }));
      rowsOf.set(totals, rows);
    }
    for (const row of rows) pauses.push(row);
  }
  pauses.sort((a, b) => b.t - a.t || a.device.localeCompare(b.device) || b.seq - a.seq);
  let answered = 0;
  for (const p of pauses) if (p.answer !== null) answered++;
  return { pauses, unanswered: pauses.length - answered, answered };
}

/** "Series — Volume" from the catalog row, else the reading record. */
export function pauseVolumeTitle(
  volume: string,
  catalog: Record<string, TitleSource> | undefined,
  records: Record<string, TitleSource>
): string {
  const row = catalog?.[volume];
  const record = records[volume];
  const series = row?.series_title || record?.series_title;
  const title = row?.volume_title || record?.volume_title;
  const parts = [series, title && title !== series ? title : undefined].filter(
    (part): part is string => !!part
  );
  return parts.length > 0 ? parts.join(' — ') : 'Unknown volume';
}

export const pauseReview: Readable<PauseReview> = derived(readingStats, ($stats) =>
  reviewPauses($stats.byVolume)
);
