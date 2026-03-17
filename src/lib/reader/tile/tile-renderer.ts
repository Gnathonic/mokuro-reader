/**
 * PixiJS-based tile renderer for a single manga spread.
 *
 * Each spread gets its own TileRenderer instance, which manages a PixiJS
 * Application on a provided canvas element. Tiles are uploaded to the GPU
 * one-per-frame (or maxConcurrentUploads per frame) to avoid stutter.
 *
 * Text overlays sit in HTML above the canvas — PixiJS only handles images.
 */

import { Application, Container, Sprite, Texture, Rectangle } from 'pixi.js';
import type { TileConfig } from './tile-config';
import { buildTileConfig } from './tile-config';
import type { TileBitmap } from './tile-decoder';

export class TileRenderer {
	private app: Application | null = null;
	private container: Container | null = null;
	private config: TileConfig;
	private tileSprites = new Map<string, Sprite>();
	private uploadQueue: TileBitmap[] = [];
	private draining = false;
	private configListeners: Array<(c: TileConfig) => void> = [];
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private preferredScalingMode: TileConfig['scalingMode'];
	private _initialized = false;
	private _destroyed = false;

	constructor(config: TileConfig) {
		this.config = config;
		this.preferredScalingMode = config.scalingMode;
	}

	get initialized(): boolean {
		return this._initialized;
	}

	/**
	 * Initialize the PixiJS application on a canvas element.
	 * Must be called before setTiles().
	 */
	async init(canvas: HTMLCanvasElement, width: number, height: number): Promise<void> {
		if (this._destroyed) return;

		this.app = new Application();
		await this.app.init({
			canvas,
			width,
			height,
			backgroundAlpha: 0,
			antialias: false,
			// Use WebGL for broad compatibility
			preference: 'webgl'
		});

		this.container = new Container();
		this.app.stage.addChild(this.container);
		this._initialized = true;
	}

	/**
	 * Resize the renderer (e.g., on viewport change).
	 */
	resize(width: number, height: number): void {
		if (!this.app || this._destroyed) return;
		this.app.renderer.resize(width, height);
	}

	/**
	 * Stage tile bitmaps for GPU upload. Tiles are uploaded over multiple
	 * frames to avoid blocking the main thread.
	 */
	setTiles(tiles: TileBitmap[]): void {
		if (!this.app || !this.container || this._destroyed) return;

		// Clear existing sprites
		this.clearTiles();

		// Queue for staggered upload
		this.uploadQueue = [...tiles];
		this.drainUploadQueue();
	}

	/**
	 * Upload tiles to GPU, maxConcurrentUploads per animation frame.
	 */
	private async drainUploadQueue(): Promise<void> {
		if (this.draining || this._destroyed) return;
		this.draining = true;

		while (this.uploadQueue.length > 0 && !this._destroyed) {
			const batch = this.uploadQueue.splice(0, this.config.maxConcurrentUploads);

			for (const tile of batch) {
				if (this._destroyed) break;
				this.uploadTile(tile);
			}

			// Yield to next frame
			if (this.uploadQueue.length > 0) {
				await new Promise<void>((r) => requestAnimationFrame(() => r()));
			}
		}

		this.draining = false;
	}

	/**
	 * Create a sprite from a tile bitmap and add it to the stage.
	 * UV coordinates are set to render only the inner content region,
	 * excluding border padding.
	 */
	private uploadTile(tile: TileBitmap): void {
		if (!this.container || this._destroyed) return;

		const { col, row, bitmap } = tile;
		const { contentSize, borderPx, tileSize } = this.config;

		// Create texture from ImageBitmap
		const baseTexture = Texture.from(bitmap);

		// Create a trimmed texture that only shows the content region (excluding border)
		const frame = new Rectangle(borderPx, borderPx, contentSize, contentSize);
		const texture = new Texture({ source: baseTexture.source, frame });

		const sprite = new Sprite(texture);
		sprite.x = col * contentSize;
		sprite.y = row * contentSize;

		this.container.addChild(sprite);
		this.tileSprites.set(`${col}-${row}`, sprite);
	}

	/**
	 * Remove all tile sprites and destroy their textures.
	 */
	clearTiles(): void {
		for (const [key, sprite] of this.tileSprites) {
			sprite.destroy({ texture: true, textureSource: true });
		}
		this.tileSprites.clear();
		this.uploadQueue = [];
	}

	/**
	 * Update renderer config. Invalidates all tiles and triggers re-upload
	 * on next setTiles() call.
	 */
	updateConfig(patch: Partial<Omit<TileConfig, 'contentSize'>>): void {
		this.config = buildTileConfig({ ...this.config, ...patch });
		if (patch.scalingMode) {
			this.preferredScalingMode = patch.scalingMode;
		}
		this.clearTiles();
		this.configListeners.forEach((fn) => fn(this.config));
	}

	onConfigChange(fn: (c: TileConfig) => void): () => void {
		this.configListeners.push(fn);
		return () => {
			this.configListeners = this.configListeners.filter((l) => l !== fn);
		};
	}

	/**
	 * Called when user starts panning/zooming.
	 * Drops to bilinear for smooth interaction.
	 */
	onInteractionStart(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		// Bilinear is the GPU default — nothing to do for PixiJS sprites
		// Custom shader filters would be removed here
	}

	/**
	 * Called when user stops panning/zooming.
	 * Restores preferred scaling mode after idle delay.
	 */
	onInteractionEnd(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			// Restore preferred scaling mode
			// When custom shaders are added, they'd be re-applied here
			this.idleTimer = null;
		}, 150);
	}

	/**
	 * Get current config (read-only).
	 */
	getConfig(): Readonly<TileConfig> {
		return this.config;
	}

	/**
	 * Destroy the PixiJS application and free all resources.
	 */
	destroy(): void {
		if (this._destroyed) return;
		this._destroyed = true;

		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}

		this.clearTiles();
		this.configListeners = [];

		if (this.app) {
			this.app.destroy(false); // Don't remove canvas from DOM — Svelte manages that
			this.app = null;
		}
		this.container = null;
	}
}
