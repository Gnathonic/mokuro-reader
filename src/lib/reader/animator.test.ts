import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Animator, setInstantAnimations } from './animator';

let rafQueue: FrameRequestCallback[] = [];

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  setInstantAnimations(false);
  vi.unstubAllGlobals();
});

describe('Animator instant mode (disable-animations setting)', () => {
  it('applies setTarget in a single frame and settles immediately', () => {
    setInstantAnimations(true);
    const frames: number[] = [];
    const settled = vi.fn();
    const a = new Animator(1, (v) => frames.push(v), { onSettle: settled });

    a.setTarget(2);

    expect(a.current).toBe(2);
    expect(frames).toEqual([2]);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(a.isAnimating).toBe(false);
    expect(rafQueue.length).toBe(0); // nothing scheduled
  });

  it('animates normally when instant mode is off', () => {
    setInstantAnimations(false);
    const a = new Animator(1, () => {});
    a.setTarget(2);
    expect(a.current).toBe(1); // not applied yet — a frame was scheduled
    expect(a.isAnimating).toBe(true);
    expect(rafQueue.length).toBe(1);
  });
});
