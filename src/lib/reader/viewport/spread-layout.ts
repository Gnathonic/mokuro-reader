/**
 * Computes world-space layout positions for spreads in a vertical strip.
 *
 * Each spread is positioned at its native pixel dimensions.
 * The camera (PixiJS stage) handles zoom/pan on top of this layout.
 */

import type { PageSpread } from '$lib/reader/spread-grouping';

/** Gap between spreads in world-space pixels */
const SPREAD_GAP = 20;

export interface SpreadLayoutItem {
	spreadIndex: number;
	/** World-space Y position of this spread's top edge */
	y: number;
	/** Native width of the spread (sum of page widths for dual) */
	width: number;
	/** Native height of the spread (max page height for dual) */
	height: number;
	/** Per-page offsets within the spread, accounting for RTL */
	pageEntries: Array<{
		page: PageSpread['pages'][number];
		pageIndex: number;
		xOffset: number;
	}>;
}

export interface SpreadLayoutResult {
	items: SpreadLayoutItem[];
	/** Total height of all spreads + gaps */
	totalHeight: number;
	/** Maximum width of any spread */
	maxWidth: number;
	/** Sorted Y positions for binary search */
	yPositions: number[];
}

/**
 * Compute world-space layout for all spreads.
 */
export function computeSpreadLayout(
	spreads: PageSpread[],
	rtl: boolean,
	gap: number = SPREAD_GAP
): SpreadLayoutResult {
	const items: SpreadLayoutItem[] = [];
	const yPositions: number[] = [];
	let y = 0;
	let maxWidth = 0;

	for (let i = 0; i < spreads.length; i++) {
		const spread = spreads[i];

		const width =
			spread.type === 'dual'
				? spread.pages[0].img_width + spread.pages[1].img_width
				: spread.pages[0].img_width;

		const height =
			spread.type === 'dual'
				? Math.max(spread.pages[0].img_height, spread.pages[1].img_height)
				: spread.pages[0].img_height;

		const pageEntries = computePageEntries(spread, rtl);

		items.push({
			spreadIndex: i,
			y,
			width,
			height,
			pageEntries
		});

		if (width > maxWidth) maxWidth = width;
		yPositions.push(y);
		y += height + gap;
	}

	return {
		items,
		totalHeight: y > 0 ? y - gap : 0,
		maxWidth,
		yPositions
	};
}

function computePageEntries(spread: PageSpread, rtl: boolean) {
	if (spread.type === 'dual') {
		const [p0, p1] = spread.pages;
		const [i0, i1] = spread.pageIndices;
		return rtl
			? [
					{ page: p1, pageIndex: i1, xOffset: 0 },
					{ page: p0, pageIndex: i0, xOffset: p1.img_width }
				]
			: [
					{ page: p0, pageIndex: i0, xOffset: 0 },
					{ page: p1, pageIndex: i1, xOffset: p0.img_width }
				];
	}
	return [{ page: spread.pages[0], pageIndex: spread.pageIndices[0], xOffset: 0 }];
}

/**
 * Binary search for the first spread whose bottom edge is >= worldY.
 * Returns the index of the first spread that could be visible at worldY.
 */
export function findFirstVisibleSpread(
	layout: SpreadLayoutResult,
	worldY: number
): number {
	const { items, yPositions } = layout;
	if (items.length === 0) return -1;

	let lo = 0;
	let hi = items.length - 1;

	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const bottomEdge = yPositions[mid] + items[mid].height;
		if (bottomEdge < worldY) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}

	return lo;
}

/**
 * Find all spread indices visible in a world-space Y range.
 */
export function findVisibleSpreads(
	layout: SpreadLayoutResult,
	worldTop: number,
	worldBottom: number
): number[] {
	if (layout.items.length === 0) return [];

	const first = findFirstVisibleSpread(layout, worldTop);
	const result: number[] = [];

	for (let i = first; i < layout.items.length; i++) {
		const item = layout.items[i];
		if (item.y > worldBottom) break;
		result.push(i);
	}

	return result;
}

/**
 * Find the spread whose center is closest to a world-space Y coordinate.
 */
export function findDominantSpread(
	layout: SpreadLayoutResult,
	worldCenterY: number
): number {
	if (layout.items.length === 0) return -1;

	let bestIdx = 0;
	let bestDist = Infinity;

	for (let i = 0; i < layout.items.length; i++) {
		const item = layout.items[i];
		const center = item.y + item.height / 2;
		const dist = Math.abs(center - worldCenterY);
		if (dist < bestDist) {
			bestDist = dist;
			bestIdx = i;
		} else {
			// Past the closest — distances are increasing
			break;
		}
	}

	return bestIdx;
}
