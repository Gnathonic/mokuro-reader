/**
 * Single PixiJS Application that renders all visible manga spreads.
 *
 * Tiles are independent ImageBitmaps, each uploaded as its own small
 * GPU texture via Texture.from(bitmap). One tile per frame to avoid stalls.
 */

import { Application, Container, Sprite, Texture } from 'pixi.js';
import type { TileBitmap } from '$lib/reader/tile/tile-decoder';
import type { SpreadLayoutItem } from './spread-layout';

export class ViewportRenderer {
	app: Application;
	private spreadContainers = new Map<number, Container>();
	private _initialized = false;
	private _destroyed = false;
	tileSize: number;

	constructor(tileSize: number = 512) {
		this.app = new Application();
		this.tileSize = tileSize;
	}

	get initialized(): boolean {
		return this._initialized;
	}

	get stage(): Container {
		return this.app.stage;
	}

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
			resolution: window.devicePixelRatio || 1,
			eventMode: 'none',
			eventFeatures: {
				move: false,
				globalMove: false,
				click: false,
				wheel: false
			}
		});

		this._initialized = true;
	}

	resize(width: number, height: number): void {
		if (!this._initialized || this._destroyed) return;
		this.app.renderer.resize(width, height);
	}

	createSpread(
		spreadIndex: number,
		layoutItem: SpreadLayoutItem,
		maxWidth: number = 0
	): Container {
		if (this._destroyed) throw new Error('Renderer destroyed');
		this.removeSpread(spreadIndex);

		const container = new Container();
		container.x = maxWidth > 0 ? (maxWidth - layoutItem.width) / 2 : 0;
		container.y = layoutItem.y;

		this.spreadContainers.set(spreadIndex, container);
		this.app.stage.addChild(container);
		return container;
	}

	/**
	 * Upload a single tile ImageBitmap to the GPU as its own texture.
	 */
	uploadTile(container: Container, tile: TileBitmap, xOffset: number): void {
		if (this._destroyed) return;

		const texture = Texture.from(tile.bitmap);
		const sprite = new Sprite(texture);
		sprite.x = xOffset + tile.col * this.tileSize;
		sprite.y = tile.row * this.tileSize;
		container.addChild(sprite);
	}

	removeSpread(spreadIndex: number): void {
		const container = this.spreadContainers.get(spreadIndex);
		if (!container) return;

		for (const child of container.children) {
			if (child instanceof Sprite) {
				child.destroy({ texture: true, textureSource: false });
			}
		}

		container.removeFromParent();
		container.destroy();
		this.spreadContainers.delete(spreadIndex);
	}

	hasSpread(spreadIndex: number): boolean {
		return this.spreadContainers.has(spreadIndex);
	}

	clear(): void {
		for (const [idx] of this.spreadContainers) {
			this.removeSpread(idx);
		}
	}

	destroy(): void {
		if (this._destroyed) return;
		this._destroyed = true;
		this.clear();
		this.app.destroy(false);
	}
}
