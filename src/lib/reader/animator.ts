/**
 * Clock-based value animator with exponential interpolation.
 *
 * Android-style: set a target, the animator converges toward it each frame.
 * Setting a new target mid-animation smoothly redirects — no stacking issues.
 * The render loop reads `current` on each frame to drive transforms.
 *
 * Uses time-corrected exponential lerp so animation speed is consistent
 * regardless of frame rate:
 *   alpha = 1 - (1 - factor)^(dt / 16.67)
 *   current += (target - current) * alpha
 *
 * At 60fps (dt=16.67ms), alpha equals factor exactly.
 * At 30fps (dt=33.33ms), alpha is larger — covers more distance per frame
 * to arrive at the same visual speed.
 */

/** Reference frame time: 60fps */
const REF_DT = 1000 / 60;

export class Animator {
	current: number;
	target: number;
	private factor: number;
	private epsilon: number;
	private rafId: number | null = null;
	private running = false;
	private lastTime: number = 0;
	private onFrame: (current: number) => void;
	private onSettle: (() => void) | null;

	// Velocity-based fling state (iOS-style exponential decay)
	// v(t) = v0 × e^(-k×t), position integrated analytically
	private velocity: number = 0;
	private flinging = false;
	private flingK: number = 3.0; // Deceleration constant (1/sec). iOS ≈ 2.0, ours slightly faster

	/**
	 * @param initial Starting value
	 * @param onFrame Called each animation frame with the current interpolated value
	 * @param options.factor Convergence speed at 60fps (0-1). Higher = faster. Default 0.2 (~250ms to settle)
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
		this.flinging = false; // Cancel any active fling
		this.velocity = 0;
		if (!this.running) {
			this.running = true;
			this.lastTime = performance.now();
			this.rafId = requestAnimationFrame(this.step);
		}
	}

	/**
	 * Change the convergence factor (e.g., for fling deceleration).
	 */
	setFactor(factor: number): void {
		this.factor = factor;
	}

	/**
	 * Register a one-shot settle callback (fires once then clears).
	 */
	onSettleOnce(fn: () => void): void {
		const original = this.onSettle;
		this.onSettle = () => {
			this.onSettle = original;
			fn();
			original?.();
		};
	}

	/**
	 * Start a velocity-based fling using iOS-style exponential decay.
	 * v(t) = v0 × e^(-k×t), position integrated analytically.
	 * Starts at exactly the given speed — never faster.
	 *
	 * @param velocity Initial velocity in value-units per millisecond
	 * @param k Deceleration constant in 1/second. Higher = stops faster.
	 *          iOS ≈ 2.0, default 3.0 (slightly snappier).
	 */
	flingWithVelocity(velocity: number, k?: number): void {
		this.velocity = velocity;
		this.flinging = true;
		if (k !== undefined) this.flingK = k;
		this.target = this.current;
		if (!this.running) {
			this.running = true;
			this.lastTime = performance.now();
			this.rafId = requestAnimationFrame(this.step);
		}
	}

	/**
	 * Immediately jump to a value with no animation.
	 */
	snapTo(value: number): void {
		this.stop();
		this.flinging = false;
		this.velocity = 0;
		this.current = value;
		this.target = value;
		this.onFrame(value);
	}

	/**
	 * Stop any active fling (kill velocity) without stopping the animation loop.
	 */
	stopFling(): void {
		this.velocity = 0;
		this.flinging = false;
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

	private step = (now: number): void => {
		if (!this.running) return;

		const dt = Math.min(now - this.lastTime, 100); // Cap at 100ms
		this.lastTime = now;

		if (this.flinging) {
			// iOS-style exponential decay with analytical integration.
			// v(t) = v0 × e^(-k×t)
			// Δx = (v0/k_ms) × (1 - e^(-k_ms×dt))  — exact integral, no Euler error
			const k_ms = this.flingK / 1000; // Convert 1/sec to 1/ms
			const decay = Math.exp(-k_ms * dt);
			const dx = (this.velocity / k_ms) * (1 - decay);
			this.current += dx;
			this.velocity *= decay;
			this.target = this.current;

			if (Math.abs(this.velocity * 1000) < 3) {
				// Velocity negligible (< 3 units/sec) — stop
				this.velocity = 0;
				this.flinging = false;
				this.running = false;
				this.rafId = null;
				this.onFrame(this.current);
				this.onSettle?.();
				return;
			}

			this.onFrame(this.current);
			this.rafId = requestAnimationFrame(this.step);
			return;
		}

		// Target-based lerp: time-corrected exponential interpolation
		const alpha = 1 - Math.pow(1 - this.factor, dt / REF_DT);
		const diff = this.target - this.current;

		if (Math.abs(diff) < this.epsilon) {
			this.current = this.target;
			this.running = false;
			this.rafId = null;
			this.onFrame(this.current);
			this.onSettle?.();
			return;
		}

		this.current += diff * alpha;
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
			this.animators.set(key, new Animator(value, () => this.scheduleFrame(), options));
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
