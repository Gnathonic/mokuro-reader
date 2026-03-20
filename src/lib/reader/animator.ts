/**
 * Clock-based value animator with exponential interpolation.
 *
 * Set a target, the animator converges toward it each frame.
 * Setting a new target mid-animation smoothly redirects — no stacking.
 *
 * Time-corrected: consistent speed regardless of frame rate.
 *   alpha = 1 - (1 - factor)^(dt / 16.67)
 */

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
    this.epsilon = options?.epsilon ?? 0.5;
    this.onSettle = options?.onSettle ?? null;
  }

  setTarget(target: number): void {
    this.target = target;
    if (!this.running) {
      this.running = true;
      this.lastTime = performance.now();
      this.rafId = requestAnimationFrame(this.step);
    }
  }

  snapTo(value: number): void {
    this.stop();
    this.current = value;
    this.target = value;
    this.onFrame(value);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  destroy(): void {
    this.stop();
  }

  get isAnimating(): boolean {
    return this.running;
  }

  private step = (now: number): void => {
    if (!this.running) return;

    const dt = Math.min(now - this.lastTime, 100);
    this.lastTime = now;
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
