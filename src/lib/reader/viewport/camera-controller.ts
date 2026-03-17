/**
 * Camera controller for the PixiJS viewport.
 *
 * Drives stage.position (pan) and stage.scale (zoom) via the Animator.
 * Each frame updates the PixiJS stage and syncs an HTML overlay div.
 * All coordinates are in world-space (native page pixels).
 *
 * The camera's "position" is the world-space point at the top-left of the viewport.
 * stage.position = -cameraPos * scale (PixiJS convention: stage moves opposite to camera).
 */

import type { Application, Container } from 'pixi.js';
import { Animator } from '$lib/reader/animator';
import type { SpreadLayoutResult } from './spread-layout';
import { findDominantSpread } from './spread-layout';

export interface CameraState {
	x: number; // World-space X of viewport left edge
	y: number; // World-space Y of viewport top edge
	scale: number; // Zoom level
}

export interface CameraCallbacks {
	/** Called every animation frame with current camera state */
	onFrame: (state: CameraState) => void;
	/** Called when all animators settle */
	onSettle: (state: CameraState) => void;
}

export class CameraController {
	private stage: Container;
	private xAnimator: Animator;
	private yAnimator: Animator;
	private scaleAnimator: Animator;
	private callbacks: CameraCallbacks;
	private viewportWidth: number;
	private viewportHeight: number;
	private layout: SpreadLayoutResult | null = null;

	// Live values (updated by animators, read by external code)
	x = 0;
	y = 0;
	scale = 1;

	constructor(
		stage: Container,
		viewportWidth: number,
		viewportHeight: number,
		callbacks: CameraCallbacks
	) {
		this.stage = stage;
		this.viewportWidth = viewportWidth;
		this.viewportHeight = viewportHeight;
		this.callbacks = callbacks;

		const frameHandler = () => this.applyToStage();

		this.xAnimator = new Animator(0, frameHandler, { factor: 0.2 });
		this.yAnimator = new Animator(0, frameHandler, { factor: 0.2 });
		this.scaleAnimator = new Animator(1, frameHandler, {
			factor: 0.18,
			onSettle: () => {
				this.callbacks.onSettle(this.getState());
			}
		});
	}

	/**
	 * Update viewport dimensions (on resize).
	 */
	setViewport(width: number, height: number): void {
		this.viewportWidth = width;
		this.viewportHeight = height;
	}

	/**
	 * Set the spread layout (for snap and bounds calculations).
	 */
	setLayout(layout: SpreadLayoutResult): void {
		this.layout = layout;
	}

	/**
	 * Get the current camera state.
	 */
	getState(): CameraState {
		return { x: this.x, y: this.y, scale: this.scale };
	}

	/**
	 * Get the world-space rectangle visible in the viewport.
	 */
	getWorldRect(): { top: number; bottom: number; left: number; right: number } {
		const s = this.scale || 1;
		return {
			top: this.y,
			bottom: this.y + this.viewportHeight / s,
			left: this.x,
			right: this.x + this.viewportWidth / s
		};
	}

	// ============================================================
	// Pan
	// ============================================================

	/**
	 * Immediately move camera by a pixel delta (for drag panning).
	 * Delta is in screen pixels, converted to world-space.
	 */
	panByScreen(dx: number, dy: number): void {
		const s = this.scale || 1;
		this.xAnimator.snapTo(this.x - dx / s);
		this.yAnimator.snapTo(this.y - dy / s);
	}

	/**
	 * Animate camera to a world-space position.
	 */
	panTo(worldX: number, worldY: number, animate = true): void {
		if (animate) {
			this.xAnimator.setTarget(worldX);
			this.yAnimator.setTarget(worldY);
		} else {
			this.xAnimator.snapTo(worldX);
			this.yAnimator.snapTo(worldY);
		}
	}

	/**
	 * Animate camera by a screen-pixel offset.
	 */
	panByScreenAnimated(dx: number, dy: number): void {
		const s = this.scale || 1;
		this.xAnimator.setTarget(this.xAnimator.target - dx / s);
		this.yAnimator.setTarget(this.yAnimator.target - dy / s);
	}

	// ============================================================
	// Zoom
	// ============================================================

	/**
	 * Zoom to a target scale, anchoring a screen-space point.
	 * The world-space point under (anchorScreenX, anchorScreenY)
	 * stays fixed on screen throughout the zoom.
	 */
	zoomTo(targetScale: number, anchorScreenX: number, anchorScreenY: number, animate = true): void {
		const s = this.scale || 1;
		// World-space point under the anchor
		const worldX = this.x + anchorScreenX / s;
		const worldY = this.y + anchorScreenY / s;

		// After zoom, we want the same world point under the same screen point:
		// newCameraX + anchorScreenX / newScale = worldX
		// newCameraX = worldX - anchorScreenX / newScale
		const newX = worldX - anchorScreenX / targetScale;
		const newY = worldY - anchorScreenY / targetScale;

		if (animate) {
			this.scaleAnimator.setTarget(targetScale);
			this.xAnimator.setTarget(newX);
			this.yAnimator.setTarget(newY);
		} else {
			this.scaleAnimator.snapTo(targetScale);
			this.xAnimator.snapTo(newX);
			this.yAnimator.snapTo(newY);
		}
	}

	// ============================================================
	// Snap to spread
	// ============================================================

	/**
	 * Animate camera to show a specific spread.
	 * Centers the spread horizontally, aligns top to viewport top.
	 */
	snapToSpread(spreadIndex: number, animate = true): void {
		if (!this.layout || spreadIndex < 0 || spreadIndex >= this.layout.items.length) return;

		const item = this.layout.items[spreadIndex];
		const s = this.scale || 1;

		// Center horizontally: camera X so the spread center aligns with viewport center
		const spreadCenterX = item.width / 2;
		const viewCenterX = this.viewportWidth / (2 * s);
		const targetX = spreadCenterX - viewCenterX;

		// Top-align vertically
		const targetY = item.y;

		if (animate) {
			this.xAnimator.setTarget(targetX);
			this.yAnimator.setTarget(targetY);
		} else {
			this.xAnimator.snapTo(targetX);
			this.yAnimator.snapTo(targetY);
		}
	}

	/**
	 * Find the spread closest to the viewport center.
	 */
	getDominantSpread(): number {
		if (!this.layout) return -1;
		const s = this.scale || 1;
		const worldCenterY = this.y + this.viewportHeight / (2 * s);
		return findDominantSpread(this.layout, worldCenterY);
	}

	// ============================================================
	// Internal
	// ============================================================

	/**
	 * Apply current animator values to the PixiJS stage.
	 * Called by animators on each frame.
	 */
	private applyToStage(): void {
		this.x = this.xAnimator.current;
		this.y = this.yAnimator.current;
		this.scale = this.scaleAnimator.current;

		// PixiJS convention: stage moves opposite to camera
		this.stage.position.set(-this.x * this.scale, -this.y * this.scale);
		this.stage.scale.set(this.scale, this.scale);

		this.callbacks.onFrame(this.getState());
	}

	get isAnimating(): boolean {
		return (
			this.xAnimator.isAnimating ||
			this.yAnimator.isAnimating ||
			this.scaleAnimator.isAnimating
		);
	}

	destroy(): void {
		this.xAnimator.destroy();
		this.yAnimator.destroy();
		this.scaleAnimator.destroy();
	}
}
