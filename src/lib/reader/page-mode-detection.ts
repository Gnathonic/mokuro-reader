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
 * Calculate the median width of all portrait-oriented pages.
 * This represents the "normal" page width for the volume.
 */
export function calculateMedianPageWidth(pages: Page[]): number {
  // Only consider portrait-oriented pages (typical manga pages)
  const portraitWidths = pages.filter((p) => p.img_height > p.img_width).map((p) => p.img_width);

  if (portraitWidths.length === 0) {
    // Fallback: use all pages if no portrait pages
    const allWidths = pages.map((p) => p.img_width);
    if (allWidths.length === 0) return 0;
    const sorted = [...allWidths].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const sorted = [...portraitWidths].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Checks if a page width is close to the median (within 15% tolerance)
 */
export function isNormalWidth(page: Page, medianWidth: number): boolean {
  if (medianWidth === 0) return true;
  const deviation = Math.abs(page.img_width - medianWidth) / medianWidth;
  return deviation <= 0.15;
}

/**
 * Checks if two pages have similar widths (within 20% of each other)
 * @deprecated Use isNormalWidth with median instead for more robust detection
 */
export function haveSimilarWidths(page1: Page | undefined, page2: Page | undefined): boolean {
  if (!page1 || !page2) return false;

  const width1 = page1.img_width;
  const width2 = page2.img_width;
  const maxWidth = Math.max(width1, width2);
  const minWidth = Math.min(width1, width2);

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
 * current page, next page, and screen orientation.
 *
 * Uses median page width to detect outliers (covers, wide spreads, trifolds).
 * Pages with width deviating >15% from median are shown as single.
 */
export function shouldShowSinglePage(
  mode: PageViewMode,
  currentPage: Page | undefined,
  nextPage: Page | undefined,
  _previousPage: Page | undefined, // Kept for API compatibility, no longer used
  isFirstPage: boolean = false,
  hasCover: boolean = false,
  pageIndex?: number, // Optional for logging
  medianWidth?: number // Median page width for the volume
): boolean {
  const log = (reason: string, result: boolean) => {
    if (pageIndex !== undefined) {
      const currentAR = currentPage
        ? (currentPage.img_width / currentPage.img_height).toFixed(2)
        : 'N/A';
      const nextAR = nextPage ? (nextPage.img_width / nextPage.img_height).toFixed(2) : 'N/A';
      const currentW = currentPage?.img_width ?? 'N/A';
      const nextW = nextPage?.img_width ?? 'N/A';
      const currentDev =
        currentPage && medianWidth
          ? ((Math.abs(currentPage.img_width - medianWidth) / medianWidth) * 100).toFixed(1) + '%'
          : 'N/A';
      const nextDev =
        nextPage && medianWidth
          ? ((Math.abs(nextPage.img_width - medianWidth) / medianWidth) * 100).toFixed(1) + '%'
          : 'N/A';
      console.log(
        `[PageMode] page=${pageIndex} → ${result ? 'SINGLE' : 'DUAL'} | reason: ${reason} | ` +
          `mode=${mode} isFirst=${isFirstPage} hasCover=${hasCover} medianW=${medianWidth ?? 'N/A'} | ` +
          `current(w=${currentW}, AR=${currentAR}, dev=${currentDev}) next(w=${nextW}, AR=${nextAR}, dev=${nextDev})`
      );
    }
    return result;
  };

  // Explicit single mode override
  if (mode === 'single') return log('mode=single', true);

  // First page with cover should always be single, regardless of mode
  // This ensures proper page pairing alignment for the entire volume
  if (isFirstPage && hasCover) {
    return log('first page with cover', true);
  }

  // Dual mode: pair all pages (except cover handled above)
  if (mode === 'dual') return log('mode=dual', false);

  // Auto mode logic
  if (mode === 'auto') {
    // Portrait orientation → single page
    if (isPortraitOrientation()) {
      return log('portrait orientation', true);
    }

    // Landscape orientation → check for wide spreads (aspect ratio > 1.2)
    if (currentPage && isWideSpread(currentPage)) {
      return log('current page is wide spread (AR > 1.2)', true);
    }

    if (nextPage && isWideSpread(nextPage)) {
      return log('next page is wide spread (AR > 1.2)', true);
    }

    // Check if pages deviate from median width (outliers like covers, trifolds)
    if (medianWidth && medianWidth > 0) {
      // Current page is an outlier - show as single
      if (currentPage && !isNormalWidth(currentPage, medianWidth)) {
        return log('current page width outlier (>15% from median)', true);
      }

      // Next page is an outlier - show current as single so next gets its own spread
      if (nextPage && !isNormalWidth(nextPage, medianWidth)) {
        return log('next page width outlier (>15% from median)', true);
      }
    }

    // Default to dual in landscape with normal pages
    return log('default dual', false);
  }

  // Fallback (should never reach here)
  return log('fallback', false);
}
