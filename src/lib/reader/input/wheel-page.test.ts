import { describe, expect, it } from 'vitest';
import { FINE_TURN_TRAVEL, WheelPageTurner, type VerticalEdges } from './wheel-page';
import { WheelStreamClassifier } from '../zoom-math';

const AT_REST: VerticalEdges = { canRevealUp: false, canRevealDown: false };
const ZOOMED_TOP: VerticalEdges = { canRevealUp: false, canRevealDown: true };

function wheel(deltaY: number, timeStamp: number, deltaX = 0, deltaMode = 0) {
  return { deltaX, deltaY, deltaMode, timeStamp };
}

/** Feed events through a real classifier, as PagedViewport does. */
function run(events: ReturnType<typeof wheel>[], edges: () => VerticalEdges = () => AT_REST) {
  const turner = new WheelPageTurner();
  const classifier = new WheelStreamClassifier();
  return events.map((e) => turner.step(e, classifier.classify(e), edges));
}

describe('WheelPageTurner', () => {
  it('a notched wheel turns one page per notch, down = forward', () => {
    expect(run([wheel(100, 0), wheel(100, 80), wheel(100, 160)])).toEqual([
      'forward',
      'forward',
      'forward'
    ]);
    expect(run([wheel(-120, 0)])).toEqual(['backward']);
  });

  it('Firefox line-mode notches are one page each', () => {
    expect(run([wheel(3, 0, 0, 1), wheel(6, 100, 0, 1)])).toEqual(['forward', 'forward']);
  });

  it('a trackpad stream with inertia turns exactly one page', () => {
    const events = [];
    let t = 0;
    for (let i = 0; i < 40; i++) events.push(wheel(i < 10 ? 4 : 25 - i / 2, (t += 16)));
    const out = run(events);
    expect(out.filter((a) => a === 'forward')).toHaveLength(1);
    expect(out.filter((a) => a === 'backward')).toHaveLength(0);
    // Below the travel threshold nothing turns (a resting finger's jitter).
    expect(run([wheel(2, 0), wheel(2, 16), wheel(-1, 32)])).not.toContain('forward');
    expect(FINE_TURN_TRAVEL).toBeGreaterThan(0);
  });

  it('a new stream after the idle gap turns again', () => {
    expect(run([wheel(100, 0), wheel(100, 1000)])).toEqual(['forward', 'forward']);
    const fine = run([wheel(30, 0), wheel(40, 16), wheel(30, 1000), wheel(40, 1016)]);
    expect(fine.filter((a) => a === 'forward')).toHaveLength(2);
  });

  it('a direction flip starts a new stream', () => {
    expect(run([wheel(30, 0), wheel(40, 16), wheel(-30, 32), wheel(-40, 48)])).toEqual([
      'hold',
      'forward',
      'hold',
      'backward'
    ]);
  });

  it('is edge-gated at stream start: a stream that could pan pans to its end', () => {
    let edges = ZOOMED_TOP;
    const turner = new WheelPageTurner();
    const fine = false;
    const atStart = turner.step(wheel(100, 0), fine, () => edges);
    // The pan reaches the bottom mid-stream — the stream still pans.
    edges = { canRevealUp: true, canRevealDown: false };
    const midStream = turner.step(wheel(100, 100), fine, () => edges);
    // After the idle gap a new stream sees the edge and turns.
    const nextStream = turner.step(wheel(100, 1000), fine, () => edges);
    expect([atStart, midStream, nextStream]).toEqual(['pan', 'pan', 'forward']);
    // Up from the bottom edge: content is hidden above, so it pans.
    expect(turner.step(wheel(-100, 2000), fine, () => edges)).toBe('pan');
  });

  it('reads the edges only when a stream starts', () => {
    let reads = 0;
    const turner = new WheelPageTurner();
    const edges = () => (reads++, AT_REST);
    turner.step(wheel(100, 0), false, edges);
    turner.step(wheel(100, 50), false, edges);
    turner.step(wheel(100, 100), false, edges);
    expect(reads).toBe(1);
  });

  it('a horizontal wheel still pans', () => {
    expect(run([wheel(0, 0, 100), wheel(10, 50, 80)])).toEqual(['pan', 'pan']);
  });
});
