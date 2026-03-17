/**
 * Single PixiJS Application that renders all visible manga spreads.
 *
 * One Container per spread, each containing tile Sprites for its pages.
 * The stage acts as the camera: stage.position = pan, stage.scale = zoom.
 * Only loaded spreads have Containers on stage — VirtualScroller controls lifecycle.
 */

import { Application, Container, Sprite, Texture, Rectangle } from 'pixi.js';
import type { TileConfig } from '$lib/reader/tile/tile-config';
import type { TileBitmap, DecodeResult } from '$lib/reader/tile/tile-decoder';
import type { SpreadLayoutItem } from './spread-layout';

export class ViewportRenderer {
	app: Application;
	private spreadContainers = new Map<number, Container>();
	private config: TileConfig;
	private _initialized = false;
	private _destroyed = false;

	constructor(config: TileConfig) {
		this.app = new Application();
		this.config = config;
	}

	get initialized(): boolean {
		return this._initialized;
	}

	get stage(): Container {
		return this.app.stage;
	}

	/**
	 * Initialize the PixiJS application on a canvas element.
	 */
	async init(canvas: HTMLCanvasElement, width: number, height: number): Promise<void> {
		if (this._destroyed) return;

		await this.app.init({
			canvas,
			width,
			height,
			backgroundAlpha: 0,
			antialias: false,
			preference: 'webgl',
			autoDensity: true,
			resolution: window.devicePixelRatio || 1
		});

		this._initialized = true;
	}

	/**
	 * Resize the renderer (e.g., on viewport change).
	 */
	resize(width: number, height: number): void {
		if (!this._initialized || this._destroyed) return;
		this.app.renderer.resize(width, height);
	}

	/**
	 * Add a spread to the stage with decoded tile data.
	 *
	 * @param spreadIndex Index for tracking
	 * @param layoutItem World-space layout for positioning
	 * @param pageResults Decoded tiles per page, in pageEntry order
	 */
	addSpread(
		spreadIndex: number,
		layoutItem: SpreadLayoutItem,
		pageResults: Array<{ decodeResult: DecodeResult; xOffset: number }>
	): void {
		if (this._destroyed) return;

		// Remove existing if any
		this.removeSpread(spreadIndex);

		const container = new Container();
		container.x = 0; // Centered by camera, not by container x
		container.y = layoutItem.y;

		// Center the spread horizontally within a normalized width
		// (handled by the camera/overlay system, not here)

		for (const { decodeResult, xOffset } of pageResults) {
			for (const tile of decodeResult.tiles) {
				const { col, row, bitmap } = tile;
				const { contentSize, borderPx } = this.config;

				const baseTexture = Texture.from(bitmap);
				const frame = new Rectangle(borderPx, borderPx, contentSize, contentSize);
				const texture = new Texture({ source: baseTexture.source, frame });

				const sprite = new Sprite(texture);
				sprite.x = xOffset + col * contentSize;
				sprite.y = row * contentSize;

				container.addChild(sprite);
			}
		}

		this.spreadContainers.set(spreadIndex, container);
		this.app.stage.addChild(container);
	}

	/**
	 * Remove a spread from the stage and free its textures.
	 */
	removeSpread(spreadIndex: number): void {
		const container = this.spreadContainers.get(spreadIndex);
		if (!container) return;

		// Destroy all sprites and their textures
		for (const child of container.children) {
			if (child instanceof Sprite) {
				child.destroy({ texture: true, textureSource: true });
			}
		}

		container.removeFromParent();
		container.destroy();
		this.spreadContainers.delete(spreadIndex);
	}

	/**
	 * Check if a spread is currently on stage.
	 */
	hasSpread(spreadIndex: number): boolean {
		return this.spreadContainers.has(spreadIndex);
	}

	/**
	 * Update tile config. Existing spreads must be reloaded.
	 */
	updateConfig(config: TileConfig): void {
		this.config = config;
	}

	/**
	 * Remove all spreads from stage.
	 */
	clear(): void {
		for (const [idx] of this.spreadContainers) {
			this.removeSpread(idx);
		}
	}

	/**
	 * Destroy the application and free all resources.
	 */
	destroy(): void {
		if (this._destroyed) return;
		this._destroyed = true;
		this.clear();
		this.app.destroy(false); // Don't remove canvas from DOM
	}
}
