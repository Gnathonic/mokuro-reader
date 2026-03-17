/**
 * Frame-based value animator with exponential interpolation.
 *
 * Android-style: set a target, the animator converges toward it each frame.
 * Setting a new target mid-animation smoothly redirects — no stacking issues.
 * The render loop reads `current` on each frame to drive CSS/scroll updates.
 *
 * Uses exponential lerp: current += (target - current) * factor
 * This never overshoots and handles rapid target changes gracefully.
 */
export class Animator {
	current: number;
	target: number;
	private factor: number;
	private epsilon: number;
	private rafId: number | null = null;
	private running = false;
	private onFrame: (current: number) => void;
	private onSettle: (() => void) | null;

	/**
	 * @param initial Starting value
	 * @param onFrame Called each animation frame with the current interpolated value
	 * @param options.factor Convergence speed per frame (0-1). Higher = faster. Default 0.2 (~250ms to settle at 60fps)
	 * @param options.epsilon Threshold for "close enough". Default 0.001
	 * @param options.onSettle Called once when animation reaches target
	 */
	constructor(
		initial: number,
		onFrame: (current: number) => void,
		options?: {
			factor?: number;
			epsilon?: number;
			onSettle?: () => void;
		}
	) {
		this.current = initial;
		this.target = initial;
		this.onFrame = onFrame;
		this.factor = options?.factor ?? 0.2;
		this.epsilon = options?.epsilon ?? 0.001;
		this.onSettle = options?.onSettle ?? null;
	}

	/**
	 * Set a new target. Starts animating if not already running.
	 * If called mid-animation, smoothly redirects from current value.
	 */
	setTarget(target: number): void {
		this.target = target;
		if (!this.running) {
			this.running = true;
			this.rafId = requestAnimationFrame(this.step);
		}
	}

	/**
	 * Immediately jump to a value with no animation.
	 */
	snapTo(value: number): void {
		this.stop();
		this.current = value;
		this.target = value;
		this.onFrame(value);
	}

	/**
	 * Stop the animation loop without snapping to target.
	 */
	stop(): void {
		this.running = false;
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	/**
	 * Clean up. Call when the component unmounts.
	 */
	destroy(): void {
		this.stop();
	}

	get isAnimating(): boolean {
		return this.running;
	}

	private step = (): void => {
		if (!this.running) return;

		const diff = this.target - this.current;

		if (Math.abs(diff) < this.epsilon) {
			// Close enough — snap to target and stop
			this.current = this.target;
			this.running = false;
			this.rafId = null;
			this.onFrame(this.current);
			this.onSettle?.();
			return;
		}

		this.current += diff * this.factor;
		this.onFrame(this.current);
		this.rafId = requestAnimationFrame(this.step);
	};
}

/**
 * Multi-dimensional animator for coordinated animations.
 * All values converge at the same rate, useful for zoom + scroll anchoring.
 */
export class MultiAnimator {
	private animators: Map<string, Animator> = new Map();
	private frameCallback: (values: Record<string, number>) => void;
	private pendingFrame = false;
	private rafId: number | null = null;

	constructor(
		initial: Record<string, number>,
		onFrame: (values: Record<string, number>) => void,
		options?: { factor?: number; epsilon?: number }
	) {
		this.frameCallback = onFrame;

		for (const [key, value] of Object.entries(initial)) {
			this.animators.set(
				key,
				new Animator(value, () => this.scheduleFrame(), options)
			);
		}
	}

	setTarget(key: string, value: number): void {
		this.animators.get(key)?.setTarget(value);
	}

	setTargets(targets: Record<string, number>): void {
		for (const [key, value] of Object.entries(targets)) {
			this.animators.get(key)?.setTarget(value);
		}
	}

	snapTo(values: Record<string, number>): void {
		for (const [key, value] of Object.entries(values)) {
			const animator = this.animators.get(key);
			if (animator) {
				animator.stop();
				animator.current = value;
				animator.target = value;
			}
		}
		this.emitFrame();
	}

	getCurrent(key: string): number {
		return this.animators.get(key)?.current ?? 0;
	}

	getTarget(key: string): number {
		return this.animators.get(key)?.target ?? 0;
	}

	get isAnimating(): boolean {
		for (const animator of this.animators.values()) {
			if (animator.isAnimating) return true;
		}
		return false;
	}

	destroy(): void {
		for (const animator of this.animators.values()) {
			animator.destroy();
		}
		this.animators.clear();
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
		}
	}

	private scheduleFrame(): void {
		if (this.pendingFrame) return;
		this.pendingFrame = true;
		this.rafId = requestAnimationFrame(() => {
			this.pendingFrame = false;
			this.emitFrame();
		});
	}

	private emitFrame(): void {
		const values: Record<string, number> = {};
		for (const [key, animator] of this.animators) {
			values[key] = animator.current;
		}
		this.frameCallback(values);
	}
}
