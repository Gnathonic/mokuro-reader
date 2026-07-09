/**
 * Kinetic ("inertial") panning — the momentum glide that follows a drag
 * release, restored from the `panzoom` library (v9.4.3) we removed in the
 * 1.7.0 paged-zoom rebuild. This is a faithful port of panzoom's kinetic.js,
 * so paged-mode flings feel exactly as they did before: the same Apple-style
 * exponential decay (amplitude 0.25 × velocity, time constant 342 ms,
 * minimum launch velocity 5).
 *
 * Like the original, it polls the SURFACE OFFSET (not the pointer) on its own
 * rAF "track" loop while a gesture is in progress, accumulating a smoothed
 * velocity. On `stop()` it launches a decaying "autoScroll" glide toward a
 * projected target. The consumer supplies getPoint()/scroll() over whatever
 * coordinate space it owns (here, the paged camera's translate).
 *
 * rAF/clock are injectable so the glide is deterministically testable.
 */

export interface KineticPoint {
  x: number;
  y: number;
}

export interface KineticControls {
  /** Begin tracking the surface offset (call at gesture start). */
  start(): void;
  /** Release: launch the momentum glide (or settle now if too slow). */
  stop(onDone?: () => void): void;
  /** Abort tracking and any glide immediately (no onDone). */
  cancel(): void;
}

export interface KineticOptions {
  minVelocity?: number;
  amplitude?: number;
  timeConstant?: number;
  requestAnimationFrame?: (cb: (t?: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
  now?: () => number;
}

export function createKinetic(
  getPoint: () => KineticPoint,
  scroll: (x: number, y: number) => void,
  options: KineticOptions = {}
): KineticControls {
  const minVelocity = options.minVelocity ?? 5;
  const amplitude = options.amplitude ?? 0.25;
  const timeConstant = options.timeConstant ?? 342;
  const raf = options.requestAnimationFrame ?? ((cb) => requestAnimationFrame(cb));
  const caf = options.cancelAnimationFrame ?? ((id) => cancelAnimationFrame(id));
  const now = options.now ?? (() => performance.now());

  let lastPoint: KineticPoint = { x: 0, y: 0 };
  let timestamp = 0;
  let vx = 0;
  let vy = 0;
  let ax = 0;
  let ay = 0;
  let targetX = 0;
  let targetY = 0;
  // Last position the glide actually reached (post-clamp) — used to detect a
  // pin against a bound and finish early.
  let lastScroll: KineticPoint = { x: 0, y: 0 };
  let ticker: number | null = null;
  let rafId: number | null = null;
  let done: (() => void) | null = null;

  function track(): void {
    const t = now();
    const elapsed = t - timestamp;
    timestamp = t;

    const current = getPoint();
    const dx = current.x - lastPoint.x;
    const dy = current.y - lastPoint.y;
    lastPoint = current;

    const dt = 1000 / (1 + elapsed);
    // exponential moving average of velocity (px per normalized frame)
    vx = 0.8 * dx * dt + 0.2 * vx;
    vy = 0.8 * dy * dt + 0.2 * vy;

    ticker = raf(track);
  }

  function autoScroll(): void {
    const elapsed = now() - timestamp;
    let moving = false;
    let dx = 0;
    let dy = 0;

    if (ax) {
      dx = -ax * Math.exp(-elapsed / timeConstant);
      if (dx > 0.5 || dx < -0.5) moving = true;
      else {
        dx = 0;
        ax = 0;
      }
    }
    if (ay) {
      dy = -ay * Math.exp(-elapsed / timeConstant);
      if (dy > 0.5 || dy < -0.5) moving = true;
      else {
        dy = 0;
        ay = 0;
      }
    }

    if (moving) {
      scroll(targetX + dx, targetY + dy);
      // The consumer clamps each frame, so a fling into a hard bound pins the
      // offset while the unclamped decay still claims movement. Without this
      // check the loop would spin the full ~2.5s decay writing an identical
      // transform every frame. Finish once every still-decaying axis is pinned
      // (a free axis keeps gliding — a diagonal fling into one wall continues
      // along the other).
      const after = getPoint();
      const pinnedX = !ax || Math.abs(after.x - lastScroll.x) < 0.01;
      const pinnedY = !ay || Math.abs(after.y - lastScroll.y) < 0.01;
      lastScroll = after;
      if (pinnedX && pinnedY) {
        rafId = null;
        const onDone = done;
        done = null;
        onDone?.();
        return;
      }
      rafId = raf(autoScroll);
    } else {
      rafId = null;
      const onDone = done;
      done = null;
      onDone?.();
    }
  }

  function start(): void {
    cancel();
    lastPoint = getPoint();
    ax = ay = vx = vy = 0;
    timestamp = now();
    ticker = raf(track);
  }

  function stop(onDone?: () => void): void {
    if (ticker !== null) {
      caf(ticker);
      ticker = null;
    }
    if (rafId !== null) {
      caf(rafId);
      rafId = null;
    }
    done = onDone ?? null;

    const current = getPoint();
    targetX = current.x;
    targetY = current.y;
    lastScroll = current;
    timestamp = now();
    ax = ay = 0;

    if (vx < -minVelocity || vx > minVelocity) {
      ax = amplitude * vx;
      targetX += ax;
    }
    if (vy < -minVelocity || vy > minVelocity) {
      ay = amplitude * vy;
      targetY += ay;
    }

    if (ax || ay) {
      rafId = raf(autoScroll);
    } else {
      // Too slow to fling — settle now (one fewer frame than the original,
      // which bounced through a no-op autoScroll tick).
      const onDoneNow = done;
      done = null;
      onDoneNow?.();
    }
  }

  function cancel(): void {
    if (ticker !== null) {
      caf(ticker);
      ticker = null;
    }
    if (rafId !== null) {
      caf(rafId);
      rafId = null;
    }
    done = null;
    vx = vy = ax = ay = 0;
  }

  return { start, stop, cancel };
}
