import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScrollAnimator } from './scroll-animator';

let rafMap = new Map<number, FrameRequestCallback>();
let rafSeq = 0;
let clock = 0;

function pump(frames = 200, dt = 16.67) {
  for (let i = 0; i < frames && rafMap.size > 0; i++) {
    clock += dt;
    const batch = [...rafMap];
    rafMap.clear();
    for (const [, cb] of batch) cb(clock);
  }
}

beforeEach(() => {
  rafMap = new Map();
  rafSeq = 0;
  clock = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = ++rafSeq;
    rafMap.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafMap.delete(id);
  });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function container() {
  return { scrollLeft: 0, scrollTop: 0 } as unknown as HTMLElement;
}

describe('ScrollAnimator.restingTarget (#283)', () => {
  it('mid-glide, reports where the glide will come to rest', () => {
    const el = container();
    const s = new ScrollAnimator(el);
    s.scrollBy(0, 900);
    pump(2);
    expect(el.scrollTop).toBeGreaterThan(0);
    expect(el.scrollTop).toBeLessThan(900);
    expect(s.restingTarget()).toEqual({ x: 0, y: 900 });
    // A chained step continues from the target, not from the live position.
    s.scrollBy(0, 900);
    pump();
    expect(el.scrollTop).toBeCloseTo(1800, 0);
  });

  it('idle, adopts the live position written behind its back', () => {
    const el = container();
    const s = new ScrollAnimator(el);
    // A programmatic write (zoom correction, scrollIntoView) whose scroll
    // event has not arrived yet: the animator still believes it is at 0.
    el.scrollTop = 500;
    expect(s.restingTarget()).toEqual({ x: 0, y: 500 });
    s.scrollBy(0, 100);
    pump();
    expect(el.scrollTop).toBeCloseTo(600, 0);
  });
});
