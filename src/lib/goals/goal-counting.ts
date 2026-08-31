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
 * - The volume was ALREADY FINISHED BEFORE the period began. Paging back
 *   through a volume you completed last year is re-reading, not progress
 *   toward this year's goal — and `bucketVolumes` puts such a volume in no
 *   section at all, so credit granted here would show in the header with
 *   nothing on screen to account for it.
 *
 * The cutoff is the period's START, not "is it finished right now". A
 * date-blind check reads the volume's state at CALL time, and a snapshot is
 * built after its period has closed: a volume the user was 160 pages into on
 * 31 December and finished on 2 January would have had its December reading
 * erased from the frozen 2026 record — permanently, since nothing rewrites a
 * snapshot. A completion that happens after the period ended cannot
 * retroactively undo reading that happened inside it.
 *
 * A volume finished INSIDE the period never reaches here: the caller counts it
 * as a completion and returns first.
 */
export function partialProgressInPeriod(
  volumeData: VolumeData,
  pageCount: number,
  start: Date,
  end: Date,
  now = Date.now()
): number {
  if (pageCount <= 0) return 0;

  const startMs = start.getTime();
  const finishedBefore = completionEventsFor(volumeData, now).some(
    (stamp) => Date.parse(stamp) < startMs
  );
  if (finishedBefore) return 0;

  return calculatePartialVolumeProgressInPeriod(volumeData.recentPageTurns, start, end, pageCount);
}
