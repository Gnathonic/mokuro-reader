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
