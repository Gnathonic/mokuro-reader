// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PointerGestureTracker, type PointerTrackerConfig } from './pointer-tracker';

let clock = 0;

beforeEach(() => {
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a pointer-event-shaped Event (jsdom has no PointerEvent ctor). */
function pe(
  type: string,
  props: { id?: number; x?: number; y?: number; ptype?: string; button?: number; target?: Element }
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    pointerId: { value: props.id ?? 1 },
    clientX: { value: props.x ?? 0 },
    clientY: { value: props.y ?? 0 },
    pointerType: { value: props.ptype ?? 'mouse' },
    button: { value: props.button ?? 0 },
    ...(props.target ? { target: { value: props.target } } : {})
  });
  return e;
}

function makeWorld(config?: Partial<PointerTrackerConfig>) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const capture = vi.fn();
  const release = vi.fn();
  (element as any).setPointerCapture = capture;
  (element as any).releasePointerCapture = release;

  const calls: string[] = [];
  const events: any = {
    onPanMove: vi.fn(() => calls.push('panMove')),
    onPanEnd: vi.fn(() => calls.push('panEnd')),
    onPinchStart: vi.fn(() => calls.push('pinchStart')),
    onPinchMove: vi.fn(() => calls.push('pinchMove')),
    onPinchEnd: vi.fn(() => calls.push('pinchEnd'))
  };

  const tracker = new PointerGestureTracker({
    getElement: () => element,
    capturePolicy: 'deferred',
    ...events,
    ...config
  });
  tracker.attach();
  return { tracker, element, capture, release, events, calls };
}

const down = (el: Element, p: Parameters<typeof pe>[1]) => el.dispatchEvent(pe('pointerdown', p));
const move = (el: Element, p: Parameters<typeof pe>[1]) => el.dispatchEvent(pe('pointermove', p));
const upWin = (p: Parameters<typeof pe>[1]) => window.dispatchEvent(pe('pointerup', p));

describe('PointerGestureTracker — pan lifecycle', () => {
  it('starts a pan only past the drag threshold, with incremental and total deltas', () => {
    const { element, events } = makeWorld();
    down(element, { x: 100, y: 100 });
    move(element, { x: 102, y: 102 }); // below threshold
    expect(events.onPanMove).not.toHaveBeenCalled();

    move(element, { x: 110, y: 100 });
    expect(events.onPanMove).toHaveBeenCalledTimes(1);
    const [, deltas] = events.onPanMove.mock.calls[0];
    expect(deltas.dx).toBe(10);
    expect(deltas.totalDx).toBe(10);

    move(element, { x: 115, y: 90 });
    const [, d2] = events.onPanMove.mock.calls[1];
    expect(d2.dx).toBe(5);
    expect(d2.dy).toBe(-10);
    expect(d2.totalDx).toBe(15);
    expect(d2.totalDy).toBe(-10);
  });

  it('ends the pan with a gesture summary (start, end, duration, type)', () => {
    const { element, events } = makeWorld();
    down(element, { x: 100, y: 100, ptype: 'touch' });
    clock += 250;
    move(element, { x: 200, y: 110, ptype: 'touch' });
    clock += 100;
    upWin({ x: 220, y: 112, ptype: 'touch' });

    expect(events.onPanEnd).toHaveBeenCalledTimes(1);
    const [summary] = events.onPanEnd.mock.calls[0];
    expect(summary.panned).toBe(true);
    expect(summary.startX).toBe(100);
    expect(summary.endX).toBe(220);
    expect(summary.durationMs).toBe(350);
    expect(summary.pointerType).toBe('touch');
  });

  it('reports an unpanned summary for a plain press-release (tap)', () => {
    const { element, events } = makeWorld();
    down(element, { x: 100, y: 100 });
    upWin({ x: 101, y: 101 });
    const [summary] = events.onPanEnd.mock.calls[0];
    expect(summary.panned).toBe(false);
  });

  it('defers capture until the threshold (deferred policy)', () => {
    const { element, capture } = makeWorld({ capturePolicy: 'deferred' });
    down(element, { x: 100, y: 100 });
    expect(capture).not.toHaveBeenCalled(); // gutter buttons / selection safe
    move(element, { x: 120, y: 100 });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('captures on pan start immediately under the immediate policy', () => {
    const { element, capture } = makeWorld({ capturePolicy: 'immediate' });
    down(element, { x: 100, y: 100 });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('suppressPan vetoes panning but the pointer still counts (pinch from a text box)', () => {
    const { tracker, element, events } = makeWorld({
      suppressPan: () => true
    });
    down(element, { x: 100, y: 100 });
    move(element, { x: 200, y: 100 });
    expect(events.onPanMove).not.toHaveBeenCalled();
    expect(tracker.pointerCount).toBe(1);

    down(element, { id: 2, x: 300, y: 100 });
    expect(events.onPinchStart).toHaveBeenCalledTimes(1); // pinch always allowed
  });

  it('ignores non-primary buttons for panning but never leaks them', () => {
    const { tracker, element, events } = makeWorld();
    down(element, { x: 100, y: 100, button: 2 });
    move(element, { x: 200, y: 100, button: 2 });
    expect(events.onPanMove).not.toHaveBeenCalled();
    expect(tracker.pointerCount).toBe(1);
    upWin({ x: 200, y: 100, button: 2 });
    expect(tracker.pointerCount).toBe(0);
  });
});

describe('PointerGestureTracker — leak-proof lifecycle (the bug class)', () => {
  it('cleans the map when an uncaptured release lands outside the element', () => {
    const { tracker, element } = makeWorld({ suppressPan: () => true });
    down(element, { x: 100, y: 100 }); // suppressed: no capture ever
    expect(tracker.pointerCount).toBe(1);
    // release over an overlay — reaches the window, never the element
    upWin({ x: 500, y: 500 });
    expect(tracker.pointerCount).toBe(0);

    // and the next press must NOT be misread as a pinch
    const { events } = (() => {
      return { events: undefined as any };
    })();
    down(element, { id: 7, x: 100, y: 100 });
    expect(tracker.pointerCount).toBe(1);
  });

  it('cleans up on pointercancel', () => {
    const { tracker, element } = makeWorld();
    down(element, { x: 100, y: 100 });
    window.dispatchEvent(pe('pointercancel', { x: 100, y: 100 }));
    expect(tracker.pointerCount).toBe(0);
  });

  it('detach removes the window listeners', () => {
    const { tracker, element } = makeWorld();
    down(element, { x: 100, y: 100 });
    tracker.detach();
    expect(tracker.pointerCount).toBe(0); // detach clears state
  });
});

describe('PointerGestureTracker — pinch lifecycle', () => {
  it('upgrades pan to pinch when a second pointer lands, ending the pan', () => {
    const { element, events, calls } = makeWorld();
    down(element, { x: 100, y: 100 });
    move(element, { x: 130, y: 100 }); // panning
    down(element, { id: 2, x: 300, y: 100 });

    expect(events.onPinchStart).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('panEnd')).toBeLessThan(calls.indexOf('pinchStart'));
    const [points] = events.onPinchStart.mock.calls[0];
    expect(points).toHaveLength(2);
  });

  it('re-baselines on pointer-set changes (third finger down, back to two)', () => {
    const { element, events } = makeWorld();
    down(element, { x: 100, y: 100 });
    down(element, { id: 2, x: 300, y: 100 });
    down(element, { id: 3, x: 200, y: 300 });
    expect(events.onPinchStart).toHaveBeenCalledTimes(2); // re-baselined on 3rd

    upWin({ id: 3, x: 200, y: 300 });
    expect(events.onPinchStart).toHaveBeenCalledTimes(3); // re-baselined on the remaining pair
    expect(events.onPinchEnd).not.toHaveBeenCalled();
  });

  it('downgrades to a fresh pan with the remaining pointer', () => {
    const { element, events } = makeWorld({ pinchSurvivorPans: true });
    down(element, { x: 100, y: 100 });
    down(element, { id: 2, x: 300, y: 100 });
    upWin({ id: 2, x: 300, y: 100 });

    expect(events.onPinchEnd).toHaveBeenCalledTimes(1);
    const [remaining] = events.onPinchEnd.mock.calls[0];
    expect(remaining?.id).toBe(1);

    // the survivor pans from its current position
    move(element, { x: 100, y: 100 });
    move(element, { x: 130, y: 100 });
    expect(events.onPanMove).toHaveBeenCalled();
  });

  it('ignores the pinch survivor when pinchSurvivorPans is off (default)', () => {
    const { tracker, element, events } = makeWorld();
    down(element, { x: 100, y: 100 });
    down(element, { id: 2, x: 300, y: 100 });
    upWin({ id: 1, x: 100, y: 100 });
    expect(events.onPinchEnd).toHaveBeenCalledTimes(1);

    // The survivor moving does NOT start a pan — absolute-baseline surfaces
    // require a fresh press after a pinch.
    move(element, { id: 2, x: 330, y: 100 });
    move(element, { id: 2, x: 360, y: 100 });
    expect(events.onPanMove).not.toHaveBeenCalled();
    expect(events.onPanMove).not.toHaveBeenCalled();

    upWin({ id: 2, x: 360, y: 100 });
    expect(events.onPanEnd).not.toHaveBeenCalled();
    expect(tracker.pointerCount).toBe(0);
  });

  it('ends the pinch once, handing off to the survivor, then ends cleanly', () => {
    const { tracker, element, events } = makeWorld({ pinchSurvivorPans: true });
    down(element, { x: 100, y: 100 });
    down(element, { id: 2, x: 300, y: 100 });
    upWin({ id: 1, x: 100, y: 100 });
    expect(events.onPinchEnd).toHaveBeenCalledTimes(1);
    expect(events.onPinchEnd.mock.calls[0][0]?.id).toBe(2); // the survivor

    upWin({ id: 2, x: 300, y: 100 });
    expect(events.onPinchEnd).toHaveBeenCalledTimes(1); // no double end
    expect(tracker.pointerCount).toBe(0);
    const [summary] = events.onPanEnd.mock.calls.at(-1);
    expect(summary.panned).toBe(false); // survivor never moved past threshold
  });

  it('resurrects a consumer-lost pinch on the next move (mid-gesture reset)', () => {
    let alive = true;
    const { element, events } = makeWorld({ isPinchAlive: () => alive });
    down(element, { x: 100, y: 100 });
    down(element, { id: 2, x: 300, y: 100 });
    expect(events.onPinchStart).toHaveBeenCalledTimes(1);

    alive = false; // a base re-application killed the consumer's pinch
    move(element, { id: 2, x: 310, y: 100 });
    expect(events.onPinchStart).toHaveBeenCalledTimes(2); // re-baselined
    alive = true;
    move(element, { id: 2, x: 320, y: 100 });
    expect(events.onPinchStart).toHaveBeenCalledTimes(2); // no spurious restarts
  });

  it('exposes pinch participation since the last press (swipe suppression)', () => {
    const { tracker, element } = makeWorld();
    down(element, { x: 100, y: 100, ptype: 'touch' });
    down(element, { id: 2, x: 300, y: 100, ptype: 'touch' });
    upWin({ id: 2, x: 300, y: 100, ptype: 'touch' });
    upWin({ id: 1, x: 100, y: 100, ptype: 'touch' });
    expect(tracker.wasPinch).toBe(true);

    down(element, { id: 3, x: 100, y: 100, ptype: 'touch' });
    expect(tracker.wasPinch).toBe(false); // reset on a fresh single press
  });
});

describe('PointerGestureTracker — wasDrag (click suppression)', () => {
  it('is true after panning or pinching until the next single press', () => {
    const { tracker, element } = makeWorld();
    expect(tracker.wasDrag).toBe(false);
    down(element, { x: 100, y: 100 });
    move(element, { x: 130, y: 100 });
    expect(tracker.wasDrag).toBe(true);
    upWin({ x: 130, y: 100 });
    expect(tracker.wasDrag).toBe(true); // survives until the next press (click fires after up)

    down(element, { id: 5, x: 100, y: 100 });
    expect(tracker.wasDrag).toBe(false);
  });
});

describe('PointerGestureTracker — onPress and Safari gestures', () => {
  it('fires onPress for eligible presses only', () => {
    const onPress = vi.fn();
    const { element } = makeWorld({ onPress, suppressPan: (e) => (e as any).clientX === 999 });
    down(element, { x: 100, y: 100 });
    expect(onPress).toHaveBeenCalledTimes(1);
    upWin({ x: 100, y: 100 });
    down(element, { id: 2, x: 999, y: 100 }); // suppressed
    expect(onPress).toHaveBeenCalledTimes(1);
    upWin({ id: 2, x: 999, y: 100 });
    down(element, { id: 3, x: 100, y: 100, button: 2 }); // non-primary
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('routes Safari gesture events when configured', () => {
    const safari = { start: vi.fn(), change: vi.fn(), end: vi.fn() };
    const { element } = makeWorld({ safariGestures: safari });
    element.dispatchEvent(new Event('gesturestart', { cancelable: true }));
    element.dispatchEvent(new Event('gesturechange', { cancelable: true }));
    element.dispatchEvent(new Event('gestureend', { cancelable: true }));
    expect(safari.start).toHaveBeenCalledTimes(1);
    expect(safari.change).toHaveBeenCalledTimes(1);
    expect(safari.end).toHaveBeenCalledTimes(1);
  });
});

describe('PointerGestureTracker — cancelPan', () => {
  it('ends an engaged pan and ignores further moves, but the release still cleans the map', () => {
    const { tracker, element, events } = makeWorld();
    down(element, { x: 100, y: 100 });
    move(element, { x: 130, y: 100 });
    expect(tracker.isPanning).toBe(true);

    tracker.cancelPan();
    expect(tracker.isPanning).toBe(false);
    expect(events.onPanEnd).toHaveBeenCalledTimes(1);
    expect(events.onPanEnd.mock.calls[0][0].panned).toBe(true);

    move(element, { x: 200, y: 100 });
    expect(events.onPanMove).toHaveBeenCalledTimes(1); // only the pre-cancel move

    upWin({ x: 200, y: 100 });
    expect(tracker.pointerCount).toBe(0);
    expect(events.onPanEnd).toHaveBeenCalledTimes(1); // no double end
  });

  it('drops pan candidacy of a pressed-but-unengaged pointer without firing onPanEnd', () => {
    const { tracker, element, events } = makeWorld();
    down(element, { x: 100, y: 100 });

    tracker.cancelPan();
    move(element, { x: 200, y: 100 });
    expect(events.onPanMove).not.toHaveBeenCalled();
    expect(events.onPanEnd).not.toHaveBeenCalled();
  });

  it('is safe to call from onPinchStart — the pinch stays alive', () => {
    let world: ReturnType<typeof makeWorld>;
    world = makeWorld({
      onPinchStart: () => world.tracker.cancelPan()
    });
    const { tracker, element, events } = world;
    down(element, { x: 100, y: 100 });
    down(element, { id: 2, x: 300, y: 100 });
    expect(tracker.isPinching).toBe(true);

    move(element, { id: 2, x: 320, y: 100 });
    expect(events.onPinchMove).toHaveBeenCalledTimes(1);
  });
});

const cancelWin = (p: Parameters<typeof pe>[1]) => window.dispatchEvent(pe('pointercancel', p));

describe('PointerGestureTracker — adversarial review fixes', () => {
  it('sets wasPinch BEFORE the upgrade onPanEnd fires (no swipe at pinch start)', () => {
    let wasPinchAtPanEnd: boolean | null = null;
    const world = makeWorld({
      onPanEnd: vi.fn(() => {
        wasPinchAtPanEnd = world.tracker.wasPinch;
      })
    });
    const { element } = world;
    // fast swipe-shaped touch pan...
    down(element, { x: 300, y: 100, ptype: 'touch' });
    move(element, { x: 140, y: 100, ptype: 'touch' });
    // ...then a second finger lands: pan upgrades to pinch
    down(element, { id: 2, x: 400, y: 200, ptype: 'touch' });
    expect(wasPinchAtPanEnd).toBe(true);
  });

  it('marks cancelled pans in the summary, using the last-known pan position', () => {
    const { element, events } = makeWorld();
    down(element, { x: 300, y: 100, ptype: 'touch' });
    move(element, { x: 150, y: 100, ptype: 'touch' });
    cancelWin({ x: 0, y: 0, ptype: 'touch' }); // browsers may report 0,0 on cancel
    expect(events.onPanEnd).toHaveBeenCalledTimes(1);
    const [summary] = events.onPanEnd.mock.calls[0];
    expect(summary.cancelled).toBe(true);
    expect(summary.endX).toBe(150); // last move, not the cancel's bogus coords
  });

  it('a normal release reports cancelled: false', () => {
    const { element, events } = makeWorld();
    down(element, { x: 100, y: 100 });
    move(element, { x: 150, y: 100 });
    upWin({ x: 150, y: 100 });
    expect(events.onPanEnd.mock.calls[0][0].cancelled).toBe(false);
  });

  it('evaluates suppressPan for non-primary buttons (right-click arms textbox dismissal)', () => {
    const suppressPan = vi.fn(() => true);
    const { element } = makeWorld({ suppressPan });
    down(element, { x: 100, y: 100, button: 2 });
    expect(suppressPan).toHaveBeenCalledTimes(1);
    upWin({ x: 100, y: 100, button: 2 });
  });

  it('does not hand the pinch-survivor pan to a suppressed pointer', () => {
    const { element, events } = makeWorld({
      suppressPan: (e) => (e as any).clientX === 999, // pointer at x=999 is on a "textbox"
      pinchSurvivorPans: true
    });
    down(element, { x: 999, y: 100 }); // suppressed (selection drag)
    down(element, { id: 2, x: 300, y: 100 }); // pinch
    upWin({ id: 2, x: 300, y: 100 }); // survivor = suppressed pointer
    move(element, { x: 950, y: 100 });
    move(element, { x: 900, y: 100 });
    expect(events.onPanMove).not.toHaveBeenCalled();
    upWin({ x: 900, y: 100 });
  });

  it('a suppressed press that moves past the threshold still counts as a drag (click suppression)', () => {
    const { tracker, element } = makeWorld({ suppressPan: () => true });
    down(element, { x: 100, y: 100 });
    move(element, { x: 160, y: 100 }); // selection drag, not a pan
    expect(tracker.isPanning).toBe(false);
    expect(tracker.wasDrag).toBe(true); // but the ensuing click must not count as a tap
    upWin({ x: 160, y: 100 });
    expect(tracker.wasDrag).toBe(true);
  });
});
