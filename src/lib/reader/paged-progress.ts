/**
 * A page turn in paged mode, as the progress record sees it: the position
 * moves to `page` with the characters read up to it, and the volume counts as
 * finished on its last page or the one before (the left page of a closing
 * spread). One function, so the reader's page turns and the interop rig's
 * driver (`interop/rig-driver.ts`) cannot record a page differently.
 */
import type { Page } from '$lib/types';
import { updateProgress } from '$lib/settings/volume-data';
import { getCharCount } from '$lib/util/count-chars';
import { activityTracker } from '$lib/util/activity-tracker';

export function recordPagedPageView(volumeUuid: string, page: number, pages: Page[]): void {
  const { charCount } = getCharCount(pages, page);
  updateProgress(volumeUuid, page, charCount, page === pages.length || page === pages.length - 1);
  // Record activity for auto-timer and auto-sync
  activityTracker.recordActivity();
}
