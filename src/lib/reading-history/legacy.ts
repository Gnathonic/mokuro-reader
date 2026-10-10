import { legacyDeviceFor } from './paths';
import type { ReadingEvent } from './types';

/**
 * Convert one volume's legacy `volume-data.json` reading state into events
 * (spec: Migration and compatibility). Deterministic and stateless: every
 * device converting the same turns produces the same events under the same
 * keys (`legacy:<volume>`, seq = the turn's time), so their union dedupes.
 * Which turns a native view already covers is decided when turns are
 * projected (`projectTurns`), never here.
 *
 * - A turn `[t, page, cumulativeChars]` is a single-page view at `t`; its
 *   chars through that page ride as `chars_before` with `page_chars: [0]`
 *   (per-page counts are unknown). A 2-tuple turn (no chars) gets
 *   `page_chars: []`, and projects back as a 2-tuple.
 * - Dwell runs to the next turn of the same volume; the last one is unknown.
 * - One event per timestamp; the last turn listed at that time wins.
 * - Each archived read is a `restart` at its `at`.
 */
export function convertLegacyRecord(
  volume: string,
  record: { recentPageTurns?: number[][]; archivedReads?: { at: number }[] }
): ReadingEvent[] {
  const device = legacyDeviceFor(volume);
  const byTime = new Map<number, number[]>();
  for (const turn of record.recentPageTurns ?? []) {
    if (!Array.isArray(turn) || !Number.isSafeInteger(turn[0]) || !Number.isFinite(turn[1])) {
      continue;
    }
    byTime.set(turn[0], turn);
  }
  const turns = [...byTime.values()].sort((a, b) => a[0] - b[0]);

  const events: ReadingEvent[] = turns.map((turn, i) => {
    const next = turns[i + 1];
    const hasChars = turn.length >= 3 && Number.isFinite(turn[2]);
    return {
      device,
      seq: turn[0],
      t: turn[0],
      kind: 'page',
      volume,
      first_page: turn[1],
      last_page: turn[1],
      page_chars: hasChars ? [0] : [],
      chars_before: hasChars ? turn[2] : 0,
      dwell_ms: next ? next[0] - turn[0] : null,
      layout: 'unknown',
      orientation: 'unknown',
      viewport: null
    };
  });

  for (const read of record.archivedReads ?? []) {
    if (!Number.isSafeInteger(read?.at)) continue;
    events.push({ device, seq: read.at, t: read.at, kind: 'restart', volume });
  }
  return events;
}
