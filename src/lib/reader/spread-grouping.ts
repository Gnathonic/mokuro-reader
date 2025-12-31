import type { Page } from '$lib/types';
import type { PageViewMode } from '$lib/settings';
import { isWideSpread, isPortraitOrientation } from './page-mode-detection';

/**
 * Represents a spread (1 or 2 pages displayed together)
 */
export type PageSpread = {
  type: 'single' | 'dual';
  pages: Page[];
  pageIndices: number[]; // 0-indexed positions in the volume's pages array
};

/**
 * Determines if a page must be shown single (a "break point") based on its characteristics.
 */
function mustBeSingle(
  page: Page,
  pageIndex: number,
  pageViewMode: PageViewMode,
  hasCover: boolean,
  isPortrait?: boolean
): boolean {
  // Single mode: everything is single
  if (pageViewMode === 'single') return true;

  // Cover page is always single
  if (pageIndex === 0 && hasCover) return true;

  // Wide spreads are always single
  if (isWideSpread(page)) return true;

  // In auto mode, portrait orientation forces single pages
  // Use provided isPortrait if available, otherwise check window
  const portraitMode = isPortrait ?? isPortraitOrientation();
  if (pageViewMode === 'auto' && portraitMode) return true;

  return false;
}

/**
 * Groups pages into spreads, processing sequentially.
 *
 * Algorithm:
 * - Process pages sequentially
 * - Break points (wide spreads, covers, offset page) always single and reset pairing
 * - After a break point, the next non-break page starts fresh pairing
 *
 * @param pages - Array of all pages in the volume
 * @param pageViewMode - 'single', 'dual', or 'auto'
 * @param hasCover - Whether the first page is a cover (shown single)
 * @param rtl - Right-to-left reading direction (affects order within dual spreads)
 * @param isPortrait - Optional: whether screen is in portrait orientation (for reactive updates)
 * @param pairingOffsetParam - Optional: offset to shift page pairing (0 or 1)
 * @returns Array of PageSpread objects
 */
export function groupPagesIntoSpreads(
  pages: Page[],
  pageViewMode: PageViewMode,
  hasCover: boolean,
  rtl: boolean,
  isPortrait?: boolean,
  pairingOffsetParam?: number
): PageSpread[] {
  if (!pages || pages.length === 0) {
    return [];
  }

  let pairingOffset = pairingOffsetParam ?? 0;

  const spreads: PageSpread[] = [];
  let i = 0;

  while (i < pages.length) {
    const currentPage = pages[i];
    const nextPage = pages[i + 1];

    // Current is a break point → single
    if (mustBeSingle(currentPage, i, pageViewMode, hasCover, isPortrait)) {
      spreads.push({ type: 'single', pages: [currentPage], pageIndices: [i] });
      i += 1;
      continue;
    }

    // Apply pairing offset: first non-cover page after cover gets offset
    if (pairingOffset > 0 && i === (hasCover ? 1 : 0)) {
      spreads.push({ type: 'single', pages: [currentPage], pageIndices: [i] });
      i += 1;
      pairingOffset--;
      continue;
    }

    // No next page → single
    if (!nextPage) {
      spreads.push({ type: 'single', pages: [currentPage], pageIndices: [i] });
      i += 1;
      continue;
    }

    // Next is a break point → current is single (break point resets pairing)
    if (mustBeSingle(nextPage, i + 1, pageViewMode, hasCover, isPortrait)) {
      spreads.push({ type: 'single', pages: [currentPage], pageIndices: [i] });
      i += 1;
      continue;
    }

    // Both normal → pair
    spreads.push({ type: 'dual', pages: [currentPage, nextPage], pageIndices: [i, i + 1] });
    i += 2;
  }

  return spreads;
}

/**
 * Find which spread contains a given page index
 * @param spreads - Array of spreads
 * @param pageIndex - 0-indexed page number to find
 * @returns Spread index, or -1 if not found
 */
export function findSpreadForPage(spreads: PageSpread[], pageIndex: number): number {
  return spreads.findIndex((spread) => spread.pageIndices.includes(pageIndex));
}

/**
 * Get the first page index of a spread (useful for progress tracking)
 * @param spread - The spread to get the first page from
 * @returns The 1-indexed page number (for progress store compatibility)
 */
export function getSpreadFirstPage(spread: PageSpread): number {
  return spread.pageIndices[0] + 1; // Convert to 1-indexed
}

/**
 * Get all page indices covered by a spread (useful for character counting)
 * @param spread - The spread
 * @returns Array of 1-indexed page numbers
 */
export function getSpreadPageNumbers(spread: PageSpread): number[] {
  return spread.pageIndices.map((i) => i + 1);
}
