/**
 * The ONE set of rules for what a goal period counts.
 *
 * These lived in three places that disagreed: the live branch of
 * `activeGoalProgress`, `createSnapshotForPeriod`, and the section split in
 * `ProgressTrackerView`. So the header could say a volume was finished while
 * the Completed list below it did not list that volume, and a period's total
 * changed the moment it closed and switched from the live branch to its
 * snapshot.
 */

import { isVolumeComplete, isVolumeFinished } from '$lib/util/volume-helpers';
import type { VolumeData } from '$lib/settings/volume-data';
import { completionEventsFor } from './completed-at';
import { calculatePartialVolumeProgressInPeriod } from './goal-math';
import { isDateWithinRange } from './periods';

/**
 * Is this volume finished, by THE app's predicate?
 *
 * `isVolumeFinished` is the union of the stored flag and the derivation from
 * the page count, and every surface that colours, sorts, hides or counts by
 * completion is required to use it — a second transcription is how the header
 * and the list came to disagree. A volume whose pages are not on this device
 * has `page_count` 0 here, and the flag is then the only evidence: that is
 * exactly the case the union exists for.
 */
export function isFinished(volumeId: string, volumeData: VolumeData, pageCount: number): boolean {
  return isVolumeFinished({ volume_uuid: volumeId, page_count: pageCount }, volumeData);
}

/**
 * Was this volume finished inside the period?
 *
 * Reads archived passes too, each dated when that pass actually finished, so a
 * volume finished in March and restarted in December still counts for March.
 *
 * ONE VOLUME COUNTS ONCE, however many times it was finished in the period.
 * The unit has to match everywhere: the frozen snapshot stores
 * `completed: Record<volumeId, string>` and the Completed list renders one card
 * per volume, so counting EVENTS in the live branch made the header read 20
 * while the list below it showed 10 cards — and then the header dropped to 10
 * the moment the period closed and switched to the snapshot, permanently,
 * because nothing rewrites a snapshot.
 */
export function isCompletedInPeriod(
  volumeData: VolumeData,
  start: Date,
  end: Date,
  now = Date.now()
): boolean {
  return completionEventsFor(volumeData, now).some((stamp) => isDateWithinRange(stamp, start, end));
}

/**
 * The page the reader was on at a given instant, from the turn history.
 *
 * Falls back to the volume's current page when no turn precedes the instant
 * (nothing recorded yet) or when the instant is in the future (the period is
 * still running, so "then" is "now").
 */
export function pageAsOf(volumeData: VolumeData, at: Date): number {
  const atMs = at.getTime();
  let page: number | null = null;
  let latest = -Infinity;

  for (const [timestamp, pageNumber] of volumeData.recentPageTurns) {
    if (timestamp < atMs && timestamp > latest) {
      latest = timestamp;
      page = pageNumber;
    }
  }

  // No turn before the instant: either nothing was recorded, or every turn came
  // after. The stored progress is the best available answer for the former and
  // is what the live view uses for the latter.
  return page ?? volumeData.progress ?? 0;
}

/**
 * Fractional volume credit for reading inside the period, for a volume that was
 * NOT finished in it.
 *
 * One implementation, called by the live total, the snapshot builder and the
 * section split alike. They used to differ — the live branch additionally
 * required `currentPage > 1` — so a period's number jumped the moment it closed.
 *
 * Returns 0 in two cases:
 *
 * - The page count is unknown (a volume whose pages are not on this device and
 *   whose length no index has supplied). A fraction of an unknown total is not
 *   a number we can stand behind, and inventing one would silently inflate the
 *   goal.
 * - The volume was ALREADY READ THROUGH AS OF THE END OF THIS PERIOD. Paging
 *   back and forth near the end of a book you have finished is not progress,
 *   and `bucketVolumes` puts such a volume in no section at all, so credit
 *   granted here would show in the header with nothing on screen to account
 *   for it.
 *
 * "As of the period end", not "right now" and not "has it ever been finished".
 * Both of those were tried and both were wrong:
 *
 * - "Right now" is evaluated when the SNAPSHOT is built, which is after the
 *   period closed. A volume the user was 160 pages into on 31 December and
 *   finished on 2 January had December's reading erased from the frozen record.
 * - "Has it ever been finished" excluded every volume with an older completion,
 *   including one the user restarted and is actively re-reading — the header
 *   read 0.00 over a list showing that same book at 80%.
 *
 * The page the reader was on at the period's end answers the question directly,
 * out of data we already keep.
 */
export function partialProgressInPeriod(
  volumeData: VolumeData,
  pageCount: number,
  start: Date,
  end: Date
): number {
  if (pageCount <= 0) return 0;
  if (isVolumeComplete(pageAsOf(volumeData, end), pageCount)) return 0;
  return calculatePartialVolumeProgressInPeriod(volumeData.recentPageTurns, start, end, pageCount);
}
