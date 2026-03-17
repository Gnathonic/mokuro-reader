/**
 * Virtual scroller: decides which spreads should be loaded based on
 * the camera's world-space viewport. Returns load/unload deltas.
 */

import type { SpreadLayoutResult } from './spread-layout';
import { findVisibleSpreads } from './spread-layout';

export interface ScrollUpdate {
	toLoad: number[];
	toUnload: number[];
}

export class VirtualScroller {
	private loaded = new Set<number>();
	private layout: SpreadLayoutResult;

	/** How far beyond the viewport (in world pixels) to preload */
	preloadMargin: number;
	/** How far beyond preload to keep loaded before unloading */
	unloadMargin: number;

	constructor(
		layout: SpreadLayoutResult,
		viewportHeight: number
	) {
		this.layout = layout;
		// Preload 2x viewport ahead, unload 4x viewport away
		this.preloadMargin = viewportHeight * 2;
		this.unloadMargin = viewportHeight * 4;
	}

	/**
	 * Update the layout (e.g., when spreads change due to settings).
	 */
	setLayout(layout: SpreadLayoutResult): void {
		this.layout = layout;
	}

	/**
	 * Update viewport margins when zoom or viewport size changes.
	 */
	setViewportHeight(viewportHeight: number): void {
		this.preloadMargin = viewportHeight * 2;
		this.unloadMargin = viewportHeight * 4;
	}

	/**
	 * Compute which spreads should be loaded/unloaded given the current
	 * camera position. Call on each camera movement or periodically.
	 *
	 * @param worldTop Top edge of the viewport in world-space
	 * @param worldBottom Bottom edge of the viewport in world-space
	 */
	update(worldTop: number, worldBottom: number): ScrollUpdate {
		// Find spreads in the preload zone
		const visible = new Set(
			findVisibleSpreads(
				this.layout,
				worldTop - this.preloadMargin,
				worldBottom + this.preloadMargin
			)
		);

		// Spreads to load: visible but not yet loaded
		const toLoad: number[] = [];
		for (const idx of visible) {
			if (!this.loaded.has(idx)) {
				toLoad.push(idx);
			}
		}

		// Spreads to unload: loaded but outside the unload zone
		const toUnload: number[] = [];
		for (const idx of this.loaded) {
			const item = this.layout.items[idx];
			if (!item) {
				toUnload.push(idx);
				continue;
			}
			const spreadBottom = item.y + item.height;
			const tooFarAbove = spreadBottom < worldTop - this.unloadMargin;
			const tooFarBelow = item.y > worldBottom + this.unloadMargin;
			if (tooFarAbove || tooFarBelow) {
				toUnload.push(idx);
			}
		}

		// Update loaded set
		for (const idx of toLoad) this.loaded.add(idx);
		for (const idx of toUnload) this.loaded.delete(idx);

		return { toLoad, toUnload };
	}

	/**
	 * Force unload all spreads (e.g., on destroy or volume change).
	 */
	clear(): void {
		this.loaded.clear();
	}

	/**
	 * Get the set of currently loaded spread indices.
	 */
	getLoaded(): ReadonlySet<number> {
		return this.loaded;
	}
}
