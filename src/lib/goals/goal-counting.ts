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

import { isVolumeFinished } from '$lib/util/volume-helpers';
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
 * - The volume is ALREADY FINISHED, and finished outside this period. Paging
 *   back through a volume you completed last year is re-reading, not progress
 *   toward this year's goal — and crucially `bucketVolumes` puts such a volume
 *   in no section at all, so credit granted here would show up in the header
 *   with nothing on screen to account for it. A volume finished INSIDE the
 *   period never reaches this function: the caller counts it as a completion
 *   and returns first.
 */
export function partialProgressInPeriod(
  volumeData: VolumeData,
  pageCount: number,
  start: Date,
  end: Date
): number {
  if (pageCount <= 0) return 0;
  if (isVolumeFinished({ volume_uuid: '', page_count: pageCount }, volumeData)) return 0;
  return calculatePartialVolumeProgressInPeriod(volumeData.recentPageTurns, start, end, pageCount);
}
