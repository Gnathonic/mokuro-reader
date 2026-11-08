import { buildPageCharCounts } from '$lib/catalog/page-char-counts';
import type { RetractableCredit } from '$lib/settings/volume-data';
import type { ReadingSpeedResult } from '$lib/util/reading-speed';
import { seriesSpeed, type ReadingStatsState } from './stats-store';
import type { CreditTotals } from './stats-engine';
import type { ReadingEvent } from './types';

/**
 * Counting pages this app never saw read (#224; spec
 * `2026-11-07-mark-as-read-credit-design.md`): what each page holds, how long
 * they would have taken, and which credits "mark as unread" or the editor's
 * Remove take back. Pure — the stores are read by the callers.
 */

/** Just enough of a volume to count its pages' characters. */
export interface CountableVolume {
  page_count?: number;
  /** Cumulative characters through each page. */
  page_char_counts?: number[];
  character_count?: number;
}

/**
 * Each page's characters, 1-based page p at index p − 1: from the row's
 * cumulative `page_char_counts`; failing that from the OCR (`ocrPages`) with
 * the reader's own per-page count; failing that (a placeholder or a
 * materialized row) `character_count` spread evenly, its sum kept exact.
 */
export function pageCharsOf(volume: CountableVolume, ocrPages?: unknown[]): number[] {
  const pageCount = volume.page_count ?? 0;
  if (pageCount <= 0) return [];
  const cumulative =
    volume.page_char_counts?.length === pageCount
      ? volume.page_char_counts
      : ocrPages?.length === pageCount
        ? buildPageCharCounts(ocrPages).cumulative
        : null;
  if (cumulative) {
    return cumulative.map((through, i) => Math.max(0, through - (i > 0 ? cumulative[i - 1] : 0)));
  }
  const total = Math.max(0, Math.round(volume.character_count ?? 0));
  const base = Math.floor(total / pageCount);
  const extra = total - base * pageCount;
  // The remainder goes one each to the last pages, so the sum is exact.
  return Array.from({ length: pageCount }, (_, i) => base + (i >= pageCount - extra ? 1 : 0));
}

/** Where an estimate's speed came from. */
export interface CreditSpeed {
  charsPerMinute: number;
  source: 'series' | 'recent';
  /** The recent speed from under 4 hours of reading (`confidence: 'low'`). */
  rough: boolean;
}

/**
 * The speed a credit's time is estimated at: the series' own (an hour of its
 * recent counted reading), else the recent one once it is personalized at
 * all; `null` when there is not enough reading to say — never the default.
 */
export function creditSpeed(
  stats: ReadingStatsState,
  seriesVolumeIds: string[],
  recent: ReadingSpeedResult
): CreditSpeed | null {
  const own = seriesSpeed(stats, seriesVolumeIds);
  if (own && own.charsPerMinute > 0) {
    return { charsPerMinute: Math.round(own.charsPerMinute), source: 'series', rough: false };
  }
  if (recent.isPersonalized && recent.confidence !== 'none' && recent.charsPerMinute > 0) {
    return {
      charsPerMinute: recent.charsPerMinute,
      source: 'recent',
      rough: recent.confidence === 'low'
    };
  }
  return null;
}

/** Whole minutes at `speed`, rounded up; `null` without a speed. */
export function estimateMinutes(chars: number, speed: CreditSpeed | null): number | null {
  if (!speed) return null;
  if (chars <= 0) return 0;
  return Math.ceil(chars / speed.charsPerMinute);
}

/** The pages of `notRead` up to `upTo`, with their characters — what a credit records. */
export function creditPages(
  notRead: number[],
  pageChars: number[],
  upTo: number
): { pages: number[]; page_chars: number[]; chars: number } {
  const pages = notRead.filter((page) => page <= upTo);
  const page_chars = pages.map((page) => pageChars[page - 1] ?? 0);
  return { pages, page_chars, chars: page_chars.reduce((sum, c) => sum + c, 0) };
}

/**
 * One total time split across volumes in proportion to their characters,
 * whole milliseconds that sum to the total exactly (largest remainder).
 */
export function splitTime(totalMs: number, chars: number[]): number[] {
  const sum = chars.reduce((n, c) => n + c, 0);
  if (sum <= 0 || totalMs <= 0) return chars.map(() => 0);
  const exact = chars.map((c) => (totalMs * c) / sum);
  const parts = exact.map(Math.floor);
  let left = totalMs - parts.reduce((n, p) => n + p, 0);
  const order = exact
    .map((x, i) => [x - Math.floor(x), i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    parts[i]++;
    left--;
  }
  return parts;
}

/** The volume's live credits in its latest pass (what un-read and Remove take back). */
export function currentPassCredits(stats: ReadingStatsState, volume: string): CreditTotals[] {
  const totals = stats.byVolume.get(volume);
  if (!totals) return [];
  return totals.credits.filter((credit) => credit.pass === totals.pass);
}

/**
 * Those credits with their recorded fields (from the volume's events), so an
 * Undo can record the same credit again.
 */
export function retractable(credits: CreditTotals[], events: ReadingEvent[]): RetractableCredit[] {
  const byId = new Map<string, Extract<ReadingEvent, { kind: 'credit' }>>();
  for (const e of events) if (e.kind === 'credit') byId.set(`${e.device}\u0000${e.seq}`, e);
  return credits.flatMap((credit) => {
    const event = byId.get(`${credit.device}\u0000${credit.seq}`);
    if (!event) return [];
    return [
      {
        target: [event.device, event.seq] as [string, number],
        fields: { pages: event.pages, page_chars: event.page_chars, time_ms: event.time_ms }
      }
    ];
  });
}

/** "38 min", "1 h 5 min", "11 h". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `${h} h ${rest} min` : `${h} h`;
}
