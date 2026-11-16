import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeferredPlacement } from './deferred-placement';

describe('DeferredPlacement', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextId: number;

  beforeEach(() => {
    frames = new Map();
    nextId = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function runFrame() {
    const due = [...frames.values()];
    frames.clear();
    for (const cb of due) cb(performance.now());
  }

  it('places on the next frame', () => {
    const placement = new DeferredPlacement();
    const place = vi.fn();
    placement.schedule(place);
    expect(place).not.toHaveBeenCalled();
    expect(placement.pending).toBe(true);
    runFrame();
    expect(place).toHaveBeenCalledTimes(1);
    expect(placement.pending).toBe(false);
  });

  it('a flush before the frame places at once, and the frame does not place again', () => {
    const order: string[] = [];
    const placement = new DeferredPlacement();
    placement.schedule(() => order.push('place'));
    // Input arriving before the frame: the placement goes first, then the input.
    placement.flush();
    order.push('input');
    runFrame();
    expect(order).toEqual(['place', 'input']);
    expect(frames.size).toBe(0);
  });

  it('flush with nothing pending is a no-op, also when re-entered from the placement', () => {
    const placement = new DeferredPlacement();
    placement.flush();
    const place = vi.fn(() => placement.flush());
    placement.schedule(place);
    placement.flush();
    expect(place).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the placement', () => {
    const placement = new DeferredPlacement();
    const place = vi.fn();
    placement.schedule(place);
    placement.cancel();
    runFrame();
    placement.flush();
    expect(place).not.toHaveBeenCalled();
  });

  it('a new schedule replaces the pending one', () => {
    const placement = new DeferredPlacement();
    const first = vi.fn();
    const second = vi.fn();
    placement.schedule(first);
    placement.schedule(second);
    runFrame();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
