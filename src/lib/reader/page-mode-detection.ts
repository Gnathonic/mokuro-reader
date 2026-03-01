import type { Page } from '$lib/types';
import type { PageViewMode } from '$lib/settings';

/**
 * Detects if a page is a wide spread (2-page spread in one image)
 * Uses aspect ratio threshold of 1.2 (landscape images wider than 6:5 ratio)
 */
export function isWideSpread(page: Page): boolean {
  const aspectRatio = page.img_width / page.img_height;
  return aspectRatio > 1.2;
}

/**
 * Checks if two pages have similar widths (within 20% of each other)
 * This helps detect when pages should be paired together
 */
export function haveSimilarWidths(page1: Page | undefined, page2: Page | undefined): boolean {
  if (!page1 || !page2) return false;

  const width1 = page1.img_width;
  const width2 = page2.img_width;
  const maxWidth = Math.max(width1, width2);
  const minWidth = Math.min(width1, width2);

  // Pages are similar if they're within 20% of each other
  return (maxWidth - minWidth) / maxWidth <= 0.2;
}

/**
 * Checks if the screen is in portrait orientation
 */
export function isPortraitOrientation(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth <= window.innerHeight;
}

/**
 * Determines if the reader should show a single page based on the mode,
 * current page, next page, previous page, and screen orientation.
 *
 * For portrait-oriented pages in dual mode, ensures they have similar widths
 * to avoid misalignment with covers, trifolds, and other oddities.
 */
export function shouldShowSinglePage(
  mode: PageViewMode,
  currentPage: Page | undefined,
  nextPage: Page | undefined,
  previousPage: Page | undefined,
  isFirstPage: boolean = false,
  hasCover: boolean = false
): boolean {
  // Explicit mode overrides
  if (mode === 'single') return true;

  // Cover page is always displayed alone regardless of mode
  if (isFirstPage && hasCover) {
    return true;
  }

  if (mode === 'dual') return false;

  // Auto mode logic
  if (mode === 'auto') {

    // Portrait orientation → single page
    if (isPortraitOrientation()) {
      return true;
    }

    // Landscape orientation → check for wide spreads
    if (currentPage && isWideSpread(currentPage)) {
      return true;
    }

    // For portrait-oriented pages, check width consistency
    // Only pair pages if they have similar widths (within 20%)
    if (currentPage && nextPage) {
      const currentIsPortrait = currentPage.img_height > currentPage.img_width;
      const nextIsPortrait = nextPage.img_height > nextPage.img_width;

      // Both pages are portrait-oriented
      if (currentIsPortrait && nextIsPortrait) {
        // Check if current and next pages have similar widths
        if (!haveSimilarWidths(currentPage, nextPage)) {
          return true; // Don't pair pages with different widths
        }
      }
    }

    // Default to dual in landscape with normal pages
    return false;
  }

  // Fallback (should never reach here)
  return false;
}
