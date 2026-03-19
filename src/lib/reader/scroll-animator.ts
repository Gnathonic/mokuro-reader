/**
 * Animated scroll controller for a scroll container.
 *
 * Wraps two Animators (X + Y) that drive scrollLeft/scrollTop.
 * Setting a target smoothly scrolls there. Rapid target changes
 * redirect mid-animation — no stacking, no fighting.
 */

import { Animator } from './animator';

export class ScrollAnimator {
	private container: HTMLElement;
	private xAnim: Animator;
	private yAnim: Animator;

	constructor(container: HTMLElement, factor = 0.22) {
		this.container = container;

		this.xAnim = new Animator(container.scrollLeft, (v) => {
			container.scrollLeft = v;
		}, { factor, epsilon: 0.5 });

		this.yAnim = new Animator(container.scrollTop, (v) => {
			container.scrollTop = v;
		}, { factor, epsilon: 0.5 });
	}

	/**
	 * Call from the container's onscroll handler.
	 * Syncs animator state when the user scrolls manually (drag, wheel).
	 * Does NOT reset if the animator is actively running — that would
	 * cancel the animation (scroll events fire asynchronously from
	 * programmatic scrollLeft/scrollTop assignments).
	 */
	onScroll(): void {
		if (this.xAnim.isAnimating || this.yAnim.isAnimating) return;
		// User scrolled manually — sync animators to current position
		this.xAnim.current = this.container.scrollLeft;
		this.xAnim.target = this.container.scrollLeft;
		this.yAnim.current = this.container.scrollTop;
		this.yAnim.target = this.container.scrollTop;
	}

	/** Animate to absolute scroll position */
	scrollTo(x: number, y: number): void {
		this.xAnim.setTarget(x);
		this.yAnim.setTarget(y);
	}

	/** Animate by a relative offset from current target */
	scrollBy(dx: number, dy: number): void {
		this.xAnim.setTarget(this.xAnim.target + dx);
		this.yAnim.setTarget(this.yAnim.target + dy);
	}

	/** Jump immediately with no animation */
	snapTo(x: number, y: number): void {
		this.xAnim.snapTo(x);
		this.yAnim.snapTo(y);
	}

	/** Animate so that an element is centered in the viewport */
	scrollToElement(el: HTMLElement, inline: 'center' | 'start' = 'center', block: 'center' | 'start' = 'center'): void {
		const containerRect = this.container.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();

		let targetX = this.container.scrollLeft;
		let targetY = this.container.scrollTop;

		if (inline === 'center') {
			const elCenterX = elRect.left + elRect.width / 2;
			const viewCenterX = containerRect.left + containerRect.width / 2;
			targetX += elCenterX - viewCenterX;
		} else {
			targetX += elRect.left - containerRect.left;
		}

		if (block === 'center') {
			const elCenterY = elRect.top + elRect.height / 2;
			const viewCenterY = containerRect.top + containerRect.height / 2;
			targetY += elCenterY - viewCenterY;
		} else {
			targetY += elRect.top - containerRect.top;
		}

		this.scrollTo(targetX, targetY);
	}

	/** Animate to center the midpoint between two elements */
	scrollToPairCenter(el1: HTMLElement, el2: HTMLElement): void {
		const containerRect = this.container.getBoundingClientRect();
		const r1 = el1.getBoundingClientRect();
		const r2 = el2.getBoundingClientRect();

		const pairLeft = Math.min(r1.left, r2.left);
		const pairRight = Math.max(r1.right, r2.right);
		const pairTop = Math.min(r1.top, r2.top);
		const pairBottom = Math.max(r1.bottom, r2.bottom);

		const pairCenterX = (pairLeft + pairRight) / 2;
		const pairCenterY = (pairTop + pairBottom) / 2;
		const viewCenterX = containerRect.left + containerRect.width / 2;
		const viewCenterY = containerRect.top + containerRect.height / 2;

		this.scrollTo(
			this.container.scrollLeft + pairCenterX - viewCenterX,
			this.container.scrollTop + pairCenterY - viewCenterY
		);
	}

	get isAnimating(): boolean {
		return this.xAnim.isAnimating || this.yAnim.isAnimating;
	}

	destroy(): void {
		this.xAnim.destroy();
		this.yAnim.destroy();
	}
}
