import { READ_DWELL_MS, VISIT_GAP_MS } from '#lib/reading-history/visits.js';

/**
 * Utility functions for volume state and display logic
 */

/**
 * A record's ISO stamp (`lastProgressUpdate`, `forgotAt`, …) as epoch ms;
 * 0 for a missing or unparseable one, so callers compare with `>` and never
 * meet a NaN.
 */
export function stampMs(iso: string | undefined | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** The share of a volume's pages a fresh pass turns through (`hasFreshPassSince`). */
export const FRESH_PASS_MIN_SHARE = 0.25;

/**
 * The furthest a turn may move forward and still be the next page of the same
 * reading: one page, or one two-page spread. Anything further is a jump.
 */
export const PASS_MAX_STEP = 2;

/**
 * Did the reader start a NEW PASS through this volume after `sinceMs` — as
 * opposed to revisiting bits of one they had already finished?
 *
 * A pass is ONE STRETCH OF READING: consecutive pages turned forward in order
 * (each turn at most `PASS_MAX_STEP` on from the last), begun in the first half
 * of the volume (against a reference page — its length, or the page they have
 * just finished on), that has READ at least `FRESH_PASS_MIN_SHARE` of the
 * reference. A turn reads the pages it moved over (both of a spread) when the
 * reader stayed on it for `READ_DWELL_MS`; its dwell is the gap to the next
 * turn. Pages flipped past quicker than that stay part of the stretch without
 * counting, so a fight scene turned in a second a page does not break a
 * re-read.
 *
 * A stretch carries over to a later sitting (a gap over `VISIT_GAP_MS`
 * between turns) only by reading on from where it stopped: a re-read of 40
 * pages an evening is one pass. Skimming forward from there does not pick it
 * up, and a jump starts a new stretch. So looking scenes up (#304) — a jump
 * back, paging backwards to find it, a few pages read there, flipping forward
 * again to the end — never adds up to a pass, however often the user comes
 * back to the volume: each look-up is a stretch of its own. Distance alone (one
 * turn in the first half) re-dated a volume finished last year the moment
 * somebody checked something on page 30 and later went back to the end; pages
 * counted across every visit since the completion re-dated it after a few
 * separate look-ups.
 *
 * THE SAME QUESTION decides three things that must not disagree: whether a
 * completion gets a new date (`updateProgress`), whether a finished volume the
 * reader has paged back in is being read again (`updateProgress`, the flag),
 * and whether in-period reading earns fractional goal credit
 * (`partialProgressInPeriod`). All three ask it against the volume's page
 * count when it is known. When they used different rules, a re-read begun past
 * the halfway mark accrued credit while it was in progress and lost all of it
 * at the final page turn — reading more pages made the goal go DOWN. Reading
 * on only ever turns this from "no" to "yes": stretches only grow.
 *
 * @param pageTurns the volume's `recentPageTurns`, in time order
 * @param sinceMs epoch ms of the completion this pass would supersede
 * @param referencePage the volume's page count, or the completing page
 */
export function hasFreshPassSince(
  pageTurns: readonly (readonly [number, number, number])[],
  sinceMs: number,
  referencePage: number
): boolean {
  const needed = Math.max(1, Math.ceil(referencePage * FRESH_PASS_MIN_SHARE));
  /**
   * The stretches begun in the first half (no other can become a pass), by the
   * page each has reached: the most pages read by any stretch ending there,
   * and the sitting that last moved it.
   */
  const stretches = new Map<number, { read: number; sitting: number }>();
  let sitting = 0;
  let previousAt = -Infinity;
  for (let i = 0; i < pageTurns.length; i++) {
    const [timestamp, page] = pageTurns[i];
    if (!(timestamp > sinceMs)) continue;
    if (timestamp - previousAt > VISIT_GAP_MS) sitting++;
    previousAt = timestamp;
    const next = pageTurns[i + 1];
    const read = next !== undefined && next[0] - timestamp >= READ_DWELL_MS;

    // The next page of a stretch that reached just behind this one. Only
    // reading on picks up a stretch an earlier sitting left.
    let reached = -1;
    for (let from = page - PASS_MAX_STEP; from < page; from++) {
      const stretch = stretches.get(from);
      if (!stretch || (!read && stretch.sitting !== sitting)) continue;
      reached = Math.max(reached, stretch.read + (read ? page - from : 0));
      stretches.delete(from); // it has moved on to `page`
    }
    if (reached < 0) {
      if (page * 2 > referencePage) continue;
      // A new stretch. Its first page reads only when it was turned TO going
      // forward: paging backwards to find a scene reads nothing.
      const previous = pageTurns[i - 1];
      reached = read && (!previous || page > previous[1]) ? 1 : 0;
    }
    const there = stretches.get(page);
    if (!there || reached >= there.read) stretches.set(page, { read: reached, sitting });
    if (reached >= needed) return true;
  }
  return false;
}

/**
 * Is this volume read through?
 *
 * The reader can settle on the second-to-last page (a spread shows the last two at once),
 * so both of the last two pages count as finished. THE PAGE MUST BE A REAL ONE, though:
 * page 0 means nobody has opened this volume, and a volume with no page count is one
 * nothing is known about yet (a cloud share before it is downloaded). Without those two
 * guards a one-page volume read as finished on sight (`0 === 1 - 1`), and every bare cloud
 * placeholder sorted as if it had been read to the end.
 *
 * Callers pass the RAW current page — 0 when there is no progress record — not the
 * display default of 1.
 */
export function isVolumeComplete(currentPage: number, pageCount: number): boolean {
  if (!pageCount || currentPage <= 0) return false;
  return currentPage === pageCount || currentPage === pageCount - 1;
}

/**
 * One volume's stored reading state — a `$volumes[uuid]` record (`$lib/settings/
 * volume-data`), which lives in localStorage keyed by uuid and exists whether or not a
 * catalog row does. `undefined` means there is no record: nothing was ever read.
 */
export interface VolumeReadState {
  /** Raw current page; 0 or absent when the volume has never been opened. */
  progress?: number;
  /** Marked finished — by the reader reaching the end, by "mark as read", or by sync. */
  completed?: boolean;
}

/**
 * Just enough of a volume to judge whether it is finished. `page_count` is 0 on a bare
 * cloud placeholder: the listing knows the volume exists and nothing else about it.
 */
export interface CompletableVolume {
  volume_uuid: string;
  page_count?: number;
}

/**
 * Is this volume finished? THE app's answer — every surface that colours, sorts, hides or
 * counts by completion must ask this, so they cannot disagree.
 *
 * It is a UNION of the two things that can say so, because neither is sufficient alone:
 *
 * - THE STORED FLAG, which is what a volume the user MARKED finished has and may be all
 *   it has. "Reading history" is broader than page turns: a volume marked as finished
 *   counts as finished with no progress, no recorded time and no page turns at all. It is
 *   also the only evidence a BARE PLACEHOLDER can carry — progress synced from the device
 *   that actually read it, against a volume whose `page_count` is unknown here (0), for
 *   which the derivation below can only ever answer "no".
 * - THE DERIVATION from the raw page, which is what survives the flag being wrong. The
 *   flag is written by `updateProgress(volume, progress, chars?, completed = false)`, and
 *   callers that only mean to move the page (`Reader.toggleHasCover`, the page input in
 *   reader settings) pass two arguments — so an ordinary page change can store
 *   `completed: false` over a volume that IS read through. Deriving beats trusting.
 *
 * A `false` flag therefore never overrides a derived "yes"; it only ever fails to add one.
 * Anything that genuinely un-reads a volume (`markVolumeAsUnread`, "restart series")
 * clears the page as well as the flag, so both halves answer "no" together.
 */
export function isVolumeFinished(
  volume: CompletableVolume,
  state: VolumeReadState | undefined
): boolean {
  if (state?.completed) return true;
  return isVolumeComplete(state?.progress ?? 0, volume.page_count ?? 0);
}

/**
 * Is this SERIES finished — every volume of it read through?
 *
 * SCOPE IS THE WHOLE SERIES, cloud placeholders included, and it needs no catalog row for
 * any of them: read history is keyed by uuid and outlives the row. A series whose volumes
 * are all placeholders is exactly as finishable as one that is fully downloaded — the
 * catalog card used to require at least one local row here, which made "finished" FALSE BY
 * CONSTRUCTION for a cloud-only series and is why one would sort to the bottom (that
 * predicate counted every volume) while staying uncoloured (this one did not), then colour
 * itself the moment opening the series materialised rows.
 *
 * An EMPTY series is not a finished one — there is nothing to have read.
 *
 * @param volumes every volume of the series, of every kind
 * @param states the reading records by uuid — `$volumes`; a missing entry means "unread"
 */
export function isSeriesFinished(
  volumes: readonly CompletableVolume[],
  states: Record<string, VolumeReadState | undefined> | undefined
): boolean {
  if (volumes.length === 0) return false;
  return volumes.every((volume) => isVolumeFinished(volume, states?.[volume.volume_uuid]));
}

/**
 * Gets the current page for a volume from the progress store
 */
export function getCurrentPage(
  volumeUuid: string,
  progress: Record<string, number> | undefined
): number {
  return progress?.[volumeUuid] ?? 1;
}

/**
 * Formats the progress display string (e.g., "5 / 200")
 * Handles the edge case where page_count-1 should show as page_count
 */
export function getProgressDisplay(
  currentPage: number,
  pageCount: number,
  defaultPage: number = 1
): string {
  const displayPage = currentPage === pageCount - 1 ? pageCount : currentPage || defaultPage;
  return `${displayPage} / ${pageCount}`;
}
