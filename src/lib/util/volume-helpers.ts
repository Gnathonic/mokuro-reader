/**
 * Utility functions for volume state and display logic
 */

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
