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

		this.xAnimator = new Animator(0, frameHandler, { factor: 0.28 });
		this.yAnimator = new Animator(0, frameHandler, { factor: 0.28 });
		this.scaleAnimator = new Animator(1, frameHandler, {
			factor: 0.25,
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
		const bounds = this.getBounds(s);
		const newX = this.clamp(this.x - dx / s, bounds.minX, bounds.maxX);
		const newY = this.clamp(this.y - dy / s, bounds.minY, bounds.maxY);
		this.xAnimator.snapTo(newX);
		this.yAnimator.snapTo(newY);
	}

	/**
	 * Fling the camera with a screen-space velocity.
	 * The camera glides in the fling direction and decelerates via the Animator.
	 *
	 * @param vx Screen-space velocity in px/ms (positive = rightward content movement)
	 * @param vy Screen-space velocity in px/ms (positive = downward content movement)
	 */
	/**
	 * Fling the camera with a screen-space velocity.
	 * Uses velocity-based animation — starts at exactly the pointer speed
	 * and decelerates via friction. Never faster than the input velocity.
	 *
	 * @param vx Screen-space velocity in px/ms
	 * @param vy Screen-space velocity in px/ms
	 */
	fling(vx: number, vy: number): void {
		const s = this.scale || 1;

		// Convert screen velocity to world-space velocity (units/ms)
		// Negative because camera moves opposite to drag direction
		const worldVx = -vx / s;
		const worldVy = -vy / s;

		// Deceleration constant k (1/sec). iOS ≈ 2.0, Android ≈ 2.4.
		// Higher = stops faster. 3.0 gives a snappy but natural feel.
		const k = 3.0;
		this.xAnimator.flingWithVelocity(worldVx, k);
		this.yAnimator.flingWithVelocity(worldVy, k);
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
		const worldX = this.x + anchorScreenX / s;
		const worldY = this.y + anchorScreenY / s;

		let newX = worldX - anchorScreenX / targetScale;
		let newY = worldY - anchorScreenY / targetScale;

		// Clamp to final-scale bounds
		const finalBounds = this.getBounds(targetScale);
		newX = this.clamp(newX, finalBounds.minX, finalBounds.maxX);
		newY = this.clamp(newY, finalBounds.minY, finalBounds.maxY);

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

	/**
	 * Zoom with separate sample and placement points.
	 * Samples the world point at (fromScreenX, fromScreenY),
	 * then positions the camera so that world point ends up at
	 * (toScreenX, toScreenY) after the zoom.
	 */
	zoomToWithTarget(
		targetScale: number,
		fromScreenX: number,
		fromScreenY: number,
		toScreenX: number,
		toScreenY: number,
		animate = true
	): void {
		const s = this.scale || 1;
		// World-space point under the "from" position
		const worldX = this.x + fromScreenX / s;
		const worldY = this.y + fromScreenY / s;

		// Position camera so world point ends up at "to" screen position
		let newX = worldX - toScreenX / targetScale;
		let newY = worldY - toScreenY / targetScale;

		// Clamp targets to bounds at the FINAL scale so animators
		// converge to valid positions as the zoom animation progresses
		const finalBounds = this.getBounds(targetScale);
		newX = this.clamp(newX, finalBounds.minX, finalBounds.maxX);
		newY = this.clamp(newY, finalBounds.minY, finalBounds.maxY);

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
		const maxW = this.layout.maxWidth;

		// Center horizontally: spread center is at maxW/2 in world space
		// (all spreads are centered within maxW)
		const spreadCenterX = maxW / 2;
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
	 * Compute clamped camera bounds based on layout, viewport, and scale.
	 * Horizontal bounds use the dominant spread's width so narrow spreads
	 * get tight bounds (no huge empty margins).
	 */
	private getBounds(s: number): { minX: number; maxX: number; minY: number; maxY: number } {
		if (!this.layout || this.layout.items.length === 0) {
			return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
		}

		const viewW = this.viewportWidth / s;
		const viewH = this.viewportHeight / s;
		const contentH = this.layout.totalHeight;
		const maxW = this.layout.maxWidth;

		// Horizontal: use dominant spread's width for tight bounds
		const dominant = this.getDominantSpread();
		const item = dominant >= 0 ? this.layout.items[dominant] : null;
		const spreadW = item?.width ?? maxW;

		// Spread is centered in world space: left edge at (maxW - spreadW) / 2
		const spreadLeft = (maxW - spreadW) / 2;
		const spreadRight = spreadLeft + spreadW;

		let minX: number, maxX: number, minY: number, maxY: number;

		if (spreadW <= viewW) {
			// Spread fits in viewport — lock camera so spread is centered
			const centerX = spreadLeft + spreadW / 2 - viewW / 2;
			minX = maxX = centerX;
		} else {
			// Spread wider than viewport — allow panning within spread edges
			minX = spreadLeft;
			maxX = spreadRight - viewW;
		}

		// Vertical
		if (contentH <= viewH) {
			const centerY = (contentH - viewH) / 2;
			minY = maxY = centerY;
		} else {
			minY = 0;
			maxY = contentH - viewH;
		}

		return { minX, maxX, minY, maxY };
	}

	/**
	 * Clamp a value to [min, max].
	 */
	private clamp(value: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, value));
	}

	/**
	 * Apply current animator values to the PixiJS stage.
	 *
	 * During zoom animation: no hard-clamping. Position targets were
	 * pre-computed for the final scale, so they converge smoothly as
	 * scale grows and bounds widen. This gives the "animate into bounds"
	 * effect — the camera slides into valid range rather than snapping.
	 *
	 * When settled (not animating): hard-clamp to current bounds to
	 * prevent drift from drag/wheel past content edges.
	 */
	private applyToStage(): void {
		this.scale = this.scaleAnimator.current;

		this.x = this.xAnimator.current;
		this.y = this.yAnimator.current;

		// Only hard-clamp when NOT in a zoom animation
		if (!this.scaleAnimator.isAnimating) {
			const bounds = this.getBounds(this.scale);
			const clampedX = this.clamp(this.x, bounds.minX, bounds.maxX);
			const clampedY = this.clamp(this.y, bounds.minY, bounds.maxY);

			// If clamping changed the value, kill any fling velocity on that axis
			if (clampedX !== this.x) this.xAnimator.stopFling();
			if (clampedY !== this.y) this.yAnimator.stopFling();

			this.x = clampedX;
			this.y = clampedY;
			this.xAnimator.current = this.x;
			this.yAnimator.current = this.y;
		}

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
