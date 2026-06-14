import { describe, it, expect, vi } from 'vitest';
import { createKinetic } from './kinetic';

/**
 * Drives the kinetic tracker deterministically: a manual rAF queue and a
 * manual clock, so we can step the track loop and the decay loop frame by
 * frame the way panzoom's kinetic.js ran on real rAF + Date.now.
 */
function harness() {
  let clock = 0;
  const queue: Array<(t?: number) => void> = [];
  const raf = (cb: (t?: number) => void) => {
    queue.push(cb);
    return queue.length;
  };
  const caf = (id: number) => {
    queue[id - 1] = () => {};
  };
  const now = () => clock;
  let point = { x: 0, y: 0 };
  const scrolled: Array<{ x: number; y: number }> = [];
  const k = createKinetic(
    () => point,
    (x, y) => {
      // Mirror the real consumer: a scroll moves the surface, so getPoint()
      // reflects it on the next frame (the camera sets tx/ty here).
      point = { x, y };
      scrolled.push({ x, y });
    },
    { requestAnimationFrame: raf, cancelAnimationFrame: caf, now }
  );
  // Run exactly the callbacks queued right now (one "frame"), advancing the
  // clock first, the way the browser would before firing rAF callbacks.
  function frame(dtMs = 16) {
    clock += dtMs;
    const batch = queue.splice(0);
    for (const cb of batch) cb(clock);
  }
  return {
    k,
    frame,
    scrolled,
    setPoint: (x: number, y: number) => (point = { x, y }),
    get clock() {
      return clock;
    }
  };
}

describe('createKinetic', () => {
  it('does not fling when the surface was held still before release (below minVelocity)', () => {
    const h = harness();
    const onDone = vi.fn();
    h.setPoint(100, 100); // resting offset before the gesture
    h.k.start();
    // pressed and held: the offset never changes, so velocity stays ~0
    for (let i = 0; i < 5; i++) {
      h.setPoint(100, 100);
      h.frame();
    }
    h.k.stop(onDone);
    expect(h.scrolled.length).toBe(0); // no glide
    expect(onDone).toHaveBeenCalledTimes(1); // settles immediately, no autoScroll
  });

  it('flings past the release point and decays to a stop, then signals done', () => {
    const h = harness();
    const onDone = vi.fn();
    h.k.start();
    // fast drag: 40px/frame to the right for 5 frames → release at x=200
    for (let i = 1; i <= 5; i++) {
      h.setPoint(i * 40, 0);
      h.frame();
    }
    const releaseX = 200;
    h.k.stop(onDone);

    let maxX = releaseX;
    for (let i = 0; i < 200 && onDone.mock.calls.length === 0; i++) {
      h.frame();
      if (h.scrolled.length) maxX = Math.max(maxX, h.scrolled[h.scrolled.length - 1].x);
    }
    // glided forward past the release point
    expect(maxX).toBeGreaterThan(releaseX + 10);
    // and came to rest (done fired)
    expect(onDone).toHaveBeenCalledTimes(1);
    // monotonic decay: each glide step moves less than (or equal to) the prior
    const steps = h.scrolled.map((s) => s.x);
    for (let i = 2; i < steps.length; i++) {
      expect(steps[i] - steps[i - 1]).toBeLessThanOrEqual(steps[i - 1] - steps[i - 2] + 1e-6);
    }
  });

  it('flings on both axes independently', () => {
    const h = harness();
    h.k.start();
    for (let i = 1; i <= 5; i++) {
      h.setPoint(i * 30, i * -50);
      h.frame();
    }
    h.k.stop();
    h.frame();
    expect(h.scrolled.length).toBeGreaterThan(0);
    const last = h.scrolled[h.scrolled.length - 1];
    expect(last.x).toBeGreaterThan(150); // glided right
    expect(last.y).toBeLessThan(-250); // glided up
  });

  it('cancel() stops an in-flight glide and fires no further scrolls', () => {
    const h = harness();
    const onDone = vi.fn();
    h.k.start();
    for (let i = 1; i <= 5; i++) {
      h.setPoint(i * 40, 0);
      h.frame();
    }
    h.k.stop(onDone);
    h.frame(); // one glide frame
    const countAfterOne = h.scrolled.length;
    h.k.cancel();
    h.frame();
    h.frame();
    expect(h.scrolled.length).toBe(countAfterOne); // no more scrolls
    expect(onDone).not.toHaveBeenCalled(); // cancel is not a natural finish
  });

  it('a fresh start() resets accumulated velocity (no carryover fling)', () => {
    const h = harness();
    h.k.start();
    for (let i = 1; i <= 5; i++) {
      h.setPoint(i * 40, 0);
      h.frame();
    }
    // new gesture begins without releasing the old one
    h.k.start();
    h.setPoint(200, 0); // held still relative to the restart
    h.frame();
    h.setPoint(200, 0);
    h.frame();
    const onDone = vi.fn();
    h.k.stop(onDone);
    h.frame();
    expect(h.scrolled.length).toBe(0); // stale velocity did not carry over
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('createKinetic — clamp early-out', () => {
  it('stops the glide promptly when the consumer pins it at a bound', () => {
    let clock = 0;
    const queue: Array<(t?: number) => void> = [];
    const raf = (cb: (t?: number) => void) => {
      queue.push(cb);
      return queue.length;
    };
    const caf = (id: number) => {
      queue[id - 1] = () => {};
    };
    let point = { x: 0, y: 0 };
    const BOUND = 100; // the consumer refuses to scroll past x=100
    const scrolled: number[] = [];
    const k = createKinetic(
      () => point,
      (x) => {
        const cx = Math.min(BOUND, x); // clamp like the camera does
        point = { x: cx, y: 0 };
        scrolled.push(cx);
      },
      { requestAnimationFrame: raf, cancelAnimationFrame: caf, now: () => clock }
    );
    function frame(dt = 16) {
      clock += dt;
      const batch = queue.splice(0);
      for (const cb of batch) cb(clock);
    }
    k.start();
    // hard fast fling to the right — would project well past the bound
    for (let i = 1; i <= 5; i++) {
      point = { x: i * 40, y: 0 };
      frame();
    }
    point = { x: 100, y: 0 }; // already sitting at the bound on release
    const onDone = vi.fn();
    k.stop(onDone);
    let frames = 0;
    for (let i = 0; i < 200 && onDone.mock.calls.length === 0; i++) {
      frame();
      frames++;
    }
    expect(onDone).toHaveBeenCalledTimes(1);
    // pinned at the bound, it must finish in a handful of frames, not the
    // full ~150-frame (~2.5s) decay
    expect(frames).toBeLessThan(10);
    // never reported a position past the bound
    expect(Math.max(...scrolled)).toBeLessThanOrEqual(BOUND);
  });

  it('a diagonal fling keeps gliding on the free axis after one axis pins', () => {
    let clock = 0;
    const queue: Array<(t?: number) => void> = [];
    const raf = (cb: (t?: number) => void) => {
      queue.push(cb);
      return queue.length;
    };
    const caf = (id: number) => {
      queue[id - 1] = () => {};
    };
    let point = { x: 0, y: 0 };
    const X_BOUND = 60;
    const seen: Array<{ x: number; y: number }> = [];
    const k = createKinetic(
      () => point,
      (x, y) => {
        point = { x: Math.min(X_BOUND, x), y };
        seen.push({ ...point });
      },
      { requestAnimationFrame: raf, cancelAnimationFrame: caf, now: () => clock }
    );
    function frame(dt = 16) {
      clock += dt;
      const batch = queue.splice(0);
      for (const cb of batch) cb(clock);
    }
    k.start();
    for (let i = 1; i <= 5; i++) {
      point = { x: i * 40, y: i * 40 };
      frame();
    }
    point = { x: 60, y: 200 }; // x already at bound, y free
    k.stop();
    for (let i = 0; i < 200 && queue.length; i++) frame();
    // y kept gliding past the release value even though x was pinned
    expect(seen[seen.length - 1].y).toBeGreaterThan(220);
    expect(Math.max(...seen.map((s) => s.x))).toBeLessThanOrEqual(X_BOUND);
  });
});
