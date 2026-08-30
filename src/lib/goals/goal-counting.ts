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
 * How many times this volume was FINISHED inside the period.
 *
 * Counts archived passes too, each dated when that pass actually finished, so
 * a series read twice in a year counts twice — and a volume finished in March
 * and restarted in December still counts for March.
 */
export function completionsInPeriod(
  volumeData: VolumeData,
  start: Date,
  end: Date,
  now = Date.now()
): number {
  return completionEventsFor(volumeData, now).filter((stamp) =>
    isDateWithinRange(stamp, start, end)
  ).length;
}

/**
 * Fractional volume credit for reading inside the period, for a volume that was
 * NOT finished in it.
 *
 * One implementation, called by both the live total and the snapshot builder.
 * They used to differ — the live branch additionally required `currentPage > 1`
 * — so a period's number jumped the moment it closed.
 *
 * Returns 0 when the page count is unknown (a volume whose pages are not on
 * this device and whose length no index has supplied): a fraction of an unknown
 * total is not a number we can stand behind, and inventing one would silently
 * inflate the goal.
 */
export function partialProgressInPeriod(
  volumeData: VolumeData,
  pageCount: number,
  start: Date,
  end: Date
): number {
  if (pageCount <= 0) return 0;
  return calculatePartialVolumeProgressInPeriod(volumeData.recentPageTurns, start, end, pageCount);
}
