/**
 * Paged-mode navigation targets — where forward/backward actually lands.
 *
 * Not a simple ±1/±2: spread alignment makes this stateful-looking logic
 * pure. The "half-step" rules keep wide spreads (double-page images)
 * aligned with the dual view: when a full step would land a wide page in
 * the second slot of a pair, step one page instead so the spread gets the
 * whole view to itself. The same correction exists in both directions.
 *
 * Returned values may be out of range (0, or past the last page) — the
 * caller (Reader.changePage) clamps and interprets edge overshoot as
 * volume navigation.
 */

import type { Page } from '$lib/types';
import type { PageViewMode } from '$lib/settings';
import { isWideSpread, shouldShowSinglePage } from './page-mode-detection';
import { getCharCount } from '$lib/util/count-chars';

/**
 * Scroll readers' volume-boundary handling: navigating past either end
 * exits to the adjacent volume (marking the current one complete when
 * leaving forward). Returns true when the navigation was consumed.
 */
export function volumeEdgeNav(
  pageIdx: number,
  pages: Page[],
  onPageChange: (page: number, charCount: number, isComplete: boolean) => void,
  onVolumeNav: (direction: 'prev' | 'next') => void
): boolean {
  if (pageIdx >= pages.length) {
    const { charCount } = getCharCount(pages, pages.length);
    onPageChange(pages.length, charCount, true);
    onVolumeNav('next');
    return true;
  }
  if (pageIdx < 0) {
    onVolumeNav('prev');
    return true;
  }
  return false;
}

export interface PageNavContext {
  pages: Page[];
  /** settings.singlePageView */
  mode: PageViewMode;
  /** Volume's hasCover — the first page displays alone. */
  hasCover: boolean;
  /** Step used when currentPage is out of range (Reader's navAmount). */
  fallbackStep: number;
}

/**
 * Target page when navigating forward. Half-steps (+1) when the current
 * view is dual and the next spread's further page is a wide image.
 */
export function calculateForwardTarget(currentPage: number, ctx: PageNavContext): number {
  const { pages, mode, hasCover } = ctx;
  const currentIndex = currentPage - 1;

  if (!pages || currentIndex < 0 || currentIndex >= pages.length) {
    return currentPage + ctx.fallbackStep;
  }

  const currentPageData = pages[currentIndex];
  const nextPageData = pages[currentIndex + 1];
  const previousPageData = currentIndex > 0 ? pages[currentIndex - 1] : undefined;

  const currentIsSingle = shouldShowSinglePage(
    mode,
    currentPageData,
    nextPageData,
    previousPageData,
    currentIndex === 0,
    hasCover
  );

  if (currentIsSingle) {
    return currentPage + 1;
  }

  // Half-step correction for off-alignment spreads:
  // Current dual view is [N, N+1], next spread is [N+2, N+3].
  // The further page from current in forward direction is N+3.
  const forwardLookaheadPage = pages[currentIndex + 3];
  const lookaheadIsWide = forwardLookaheadPage !== undefined && isWideSpread(forwardLookaheadPage);

  if (currentPageData && nextPageData && !isWideSpread(currentPageData) && lookaheadIsWide) {
    return currentPage + 1;
  }

  return currentPage + 2;
}

/**
 * Target page when navigating backward, accounting for single-page
 * exceptions (covers, wide spreads) so the landing view stays aligned.
 */
export function calculateBackwardTarget(currentPage: number, ctx: PageNavContext): number {
  const { pages, mode, hasCover } = ctx;
  if (currentPage <= 1) return 0;

  const currentIndex = currentPage - 1;
  const currentPageData = pages?.[currentIndex];
  const currentNextPageData = pages?.[currentIndex + 1];
  const currentPreviousPageData = currentIndex > 0 ? pages?.[currentIndex - 1] : undefined;

  const currentShouldBeSingle = shouldShowSinglePage(
    mode,
    currentPageData,
    currentNextPageData,
    currentPreviousPageData,
    currentIndex === 0,
    hasCover
  );

  // Mirror of forward half-step fix:
  // when moving backward from a dual view, inspect the further page in the
  // previous spread chunk (currentPage - 2). If that page is wide, half-step.
  if (!currentShouldBeSingle) {
    const previousSpreadFurtherPage = pages?.[currentIndex - 2];
    if (previousSpreadFurtherPage && isWideSpread(previousSpreadFurtherPage)) {
      return currentPage - 1;
    }
  }

  const targetIndex = currentPage - 2;
  if (targetIndex < 0) {
    return currentPage - 1;
  }

  const targetPage = pages?.[targetIndex];
  const targetNextPage = pages?.[targetIndex + 1];
  const targetPreviousPage = targetIndex > 0 ? pages?.[targetIndex - 1] : undefined;

  const targetShouldBeSingle = shouldShowSinglePage(
    mode,
    targetPage,
    targetNextPage,
    targetPreviousPage,
    targetIndex === 0,
    hasCover
  );

  return targetShouldBeSingle ? currentPage - 1 : currentPage - 2;
}
