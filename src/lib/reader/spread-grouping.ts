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

// Minimum position for a "reference" spread (skip dust cover area: front, back, spine, flaps)
const DUST_COVER_ZONE = 4;

// Size tolerance for considering pages as "same type" (within 50%)
const SIZE_TOLERANCE = 0.5;

/**
 * Check if a page has consistent width (within tolerance).
 * Used to filter out dust covers, inserts, etc. when counting pages.
 */
function hasConsistentWidth(page: Page, refWidth: number): boolean {
	const widthRatio = page.img_width / refWidth;
	return widthRatio > 1 - SIZE_TOLERANCE && widthRatio < 1 + SIZE_TOLERANCE;
}

/**
 * Find the most common page width (typical content page width).
 * Excludes wide spreads since they have different aspect ratios.
 */
function getTypicalPageWidth(pages: Page[]): number | null {
	// Count occurrences of each width (rounded to avoid float issues)
	const widthCounts = new Map<number, number>();

	for (const page of pages) {
		if (isWideSpread(page)) continue; // Skip wide spreads

		// Round to nearest 10px to group similar widths
		const w = Math.round(page.img_width / 10) * 10;
		widthCounts.set(w, (widthCounts.get(w) || 0) + 1);
	}

	// Find most common width
	let mostCommonWidth: number | null = null;
	let maxCount = 0;
	for (const [width, count] of widthCounts.entries()) {
		if (count > maxCount) {
			maxCount = count;
			mostCommonWidth = width;
		}
	}

	return mostCommonWidth;
}

/**
 * Auto-detect breakpoints for a volume based on page characteristics.
 * This is called once when a volume is first loaded, then saved to settings.
 *
 * Wide spreads (pre-joined double pages) are natural breakpoints:
 * - They display as single pages
 * - Pages after a spread pair fresh: (spread), (N+1, N+2), (N+3, N+4)...
 *
 * A spread in the middle is a reliable anchor for detecting cover pages:
 * - The algorithm forces page N-1 single (before breakpoint at N)
 * - Pages before that need to pair evenly (only counting consistent-sized pages)
 * - If that count is odd, we need another single -> first content page is cover
 *
 * Dust covers can be anywhere in pages 0-3 (front, back, spine, flaps).
 * We skip this zone when looking for reference spreads.
 *
 * @param pages - Array of all pages in the volume
 * @returns Array of 0-indexed page numbers that should be breakpoints
 */
export function detectSpreadBreakpoints(pages: Page[]): number[] {
	if (!pages || pages.length === 0) return [];

	// Find all wide spreads
	const wideSpreads: number[] = [];
	for (let i = 0; i < pages.length; i++) {
		if (isWideSpread(pages[i])) {
			wideSpreads.push(i);
		}
	}

	if (wideSpreads.length === 0) {
		return []; // No reference points
	}

	const breakpoints: number[] = [...wideSpreads];

	// If page 0 is a wide spread (dust cover scan),
	// page 1 should also be a breakpoint (first content page after dust cover)
	if (wideSpreads.includes(0) && pages.length > 1) {
		breakpoints.push(1);
	}

	// Find the first "reference" spread - a wide spread past the dust cover zone
	// Dust covers at the start (pages 0-3) are unreliable for alignment detection
	const referenceSpread = wideSpreads.find((i) => i >= DUST_COVER_ZONE);

	if (referenceSpread !== undefined) {
		// Get typical page width for consistency checking
		const typicalWidth = getTypicalPageWidth(pages);

		// Determine where content starts (after any wide pages at the start)
		let contentStart = 0;
		for (let i = 0; i < Math.min(DUST_COVER_ZONE, pages.length); i++) {
			if (wideSpreads.includes(i)) {
				contentStart = i + 1;
			}
		}

		// Count consistent-width pages from contentStart to referenceSpread (exclusive)
		let consistentPageCount = 0;
		for (let i = contentStart; i < referenceSpread; i++) {
			// Skip pages that are already breakpoints (wide spreads)
			if (wideSpreads.includes(i)) continue;

			// Only count pages with consistent width (if we have a reference)
			if (typicalWidth && !hasConsistentWidth(pages[i], typicalWidth)) {
				continue;
			}

			consistentPageCount++;
		}

		// The grouping algorithm forces page (referenceSpread - 1) to be single.
		// The remaining pages need to pair evenly.
		// If the count is odd, we need one more single at contentStart (the cover).
		if (consistentPageCount % 2 === 1 && !breakpoints.includes(contentStart)) {
			breakpoints.push(contentStart);
		}
	}

	return breakpoints.sort((a, b) => a - b);
}

/**
 * Migrate legacy hasCover setting to spreadBreakpoints.
 * If hasCover was true and page 0 isn't already in breakpoints, add it.
 *
 * @param hasCover - Legacy hasCover setting
 * @param existingBreakpoints - Current breakpoints (may be from auto-detection)
 * @returns Updated breakpoints array
 */
export function migrateHasCoverToBreakpoints(
	hasCover: boolean,
	existingBreakpoints: number[]
): number[] {
	if (!hasCover) return existingBreakpoints;

	// If hasCover was true, ensure page 0 is a breakpoint
	if (!existingBreakpoints.includes(0)) {
		return [0, ...existingBreakpoints].sort((a, b) => a - b);
	}

	return existingBreakpoints;
}

/**
 * Toggle a page's breakpoint status.
 * If the page is a breakpoint, remove it. If not, add it.
 *
 * @param pageIndex - 0-indexed page number
 * @param currentBreakpoints - Current breakpoints array
 * @returns Updated breakpoints array
 */
export function toggleBreakpoint(pageIndex: number, currentBreakpoints: number[]): number[] {
	const index = currentBreakpoints.indexOf(pageIndex);
	if (index >= 0) {
		// Remove breakpoint
		return currentBreakpoints.filter((i) => i !== pageIndex);
	} else {
		// Add breakpoint
		return [...currentBreakpoints, pageIndex].sort((a, b) => a - b);
	}
}

/**
 * Groups pages into spreads.
 *
 * When an anchor is provided, pairing is determined relative to the anchor:
 * the anchor page is always the first in its spread, and pairing radiates
 * outward (forward and backward) from there. This means the user's current
 * page determines the pairing, not page 0.
 *
 * Without an anchor, pairing is sequential from page 0 using breakpoints.
 *
 * Wide spreads are always shown single regardless of anchor or breakpoints.
 *
 * @param pages - Array of all pages in the volume
 * @param pageViewMode - 'single', 'dual', or 'auto'
 * @param rtl - Right-to-left reading direction
 * @param isPortrait - Whether screen is in portrait orientation
 * @param breakpoints - Array of page indices that are breakpoints
 * @param anchor - Page index that must be the first in its spread
 * @returns Array of PageSpread objects
 */
export function groupPagesIntoSpreads(
	pages: Page[],
	pageViewMode: PageViewMode,
	rtl: boolean,
	isPortrait: boolean,
	breakpoints: number[] = [],
	anchor?: number
): PageSpread[] {
	if (!pages || pages.length === 0) {
		return [];
	}

	// Single mode or portrait auto: everything is single
	if (pageViewMode === 'single' || (pageViewMode === 'auto' && isPortrait)) {
		return pages.map((page, i) => ({
			type: 'single' as const,
			pages: [page],
			pageIndices: [i]
		}));
	}

	// Build set of pages that must be shown single
	const singleSet = new Set(breakpoints);
	for (let i = 0; i < pages.length; i++) {
		if (isWideSpread(pages[i])) {
			singleSet.add(i);
		}
	}

	if (anchor !== undefined) {
		return groupFromAnchor(pages, singleSet, anchor);
	}

	return groupSequential(pages, singleSet);
}

/**
 * Group pages sequentially from page 0 (default behavior).
 */
function groupSequential(pages: Page[], singleSet: Set<number>): PageSpread[] {
	const spreads: PageSpread[] = [];
	let i = 0;

	while (i < pages.length) {
		const currentPage = pages[i];
		const nextPage = pages[i + 1];

		if (singleSet.has(i) || !nextPage || singleSet.has(i + 1)) {
			spreads.push({ type: 'single', pages: [currentPage], pageIndices: [i] });
			i += 1;
			continue;
		}

		spreads.push({
			type: 'dual',
			pages: [currentPage, nextPage],
			pageIndices: [i, i + 1]
		});
		i += 2;
	}

	return spreads;
}

/**
 * Group pages outward from an anchor page.
 * The anchor is always the first page of its spread.
 * Pairing radiates forward and backward from the anchor.
 */
function groupFromAnchor(pages: Page[], singleSet: Set<number>, anchor: number): PageSpread[] {
	// Clamp anchor to valid range
	anchor = Math.max(0, Math.min(anchor, pages.length - 1));

	// Forward from anchor: pair [anchor, anchor+1], [anchor+2, anchor+3]...
	const forward: PageSpread[] = [];
	let i = anchor;
	while (i < pages.length) {
		const currentPage = pages[i];
		const nextPage = pages[i + 1];

		if (singleSet.has(i) || !nextPage || singleSet.has(i + 1)) {
			forward.push({ type: 'single', pages: [currentPage], pageIndices: [i] });
			i += 1;
			continue;
		}

		forward.push({
			type: 'dual',
			pages: [currentPage, nextPage],
			pageIndices: [i, i + 1]
		});
		i += 2;
	}

	// Backward from anchor: pair [anchor-2, anchor-1], [anchor-4, anchor-3]...
	const backward: PageSpread[] = [];
	i = anchor - 1;
	while (i >= 0) {
		const currentPage = pages[i];
		const prevPage = pages[i - 1];

		if (singleSet.has(i) || !prevPage || singleSet.has(i - 1)) {
			backward.push({ type: 'single', pages: [currentPage], pageIndices: [i] });
			i -= 1;
			continue;
		}

		// Pair with previous page: [i-1, i]
		backward.push({
			type: 'dual',
			pages: [prevPage, currentPage],
			pageIndices: [i - 1, i]
		});
		i -= 2;
	}

	// Combine: backward (reversed to maintain page order) + forward
	backward.reverse();
	return [...backward, ...forward];
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
