import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TapDiscriminator } from './tap';

describe('TapDiscriminator (deferred commit — scroll readers)', () => {
  let onTap: ReturnType<typeof vi.fn>;
  let onDoubleTap: ReturnType<typeof vi.fn>;
  let taps: TapDiscriminator;

  beforeEach(() => {
    vi.useFakeTimers();
    onTap = vi.fn();
    onDoubleTap = vi.fn();
    taps = new TapDiscriminator({ onTap, onDoubleTap });
  });

  afterEach(() => {
    taps.cancel();
    vi.useRealTimers();
  });

  it('commits a single tap only after the double-tap window closes', () => {
    taps.tap(100, 200);
    expect(onTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(onTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledWith(100, 200);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('two taps within the window fire onDoubleTap once and no onTap', () => {
    taps.tap(100, 200);
    vi.advanceTimersByTime(150);
    taps.tap(110, 205);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    expect(onDoubleTap).toHaveBeenCalledWith(110, 205);
    vi.advanceTimersByTime(1000);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('two taps slower than the window are two single taps', () => {
    taps.tap(100, 200);
    vi.advanceTimersByTime(400);
    taps.tap(300, 400);
    vi.advanceTimersByTime(400);
    expect(onTap).toHaveBeenCalledTimes(2);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('a tap right after a double-tap starts a fresh cycle', () => {
    taps.tap(100, 200);
    vi.advanceTimersByTime(100);
    taps.tap(100, 200); // double
    vi.advanceTimersByTime(100);
    taps.tap(100, 200); // fresh first tap, not a second double
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('swallows exactly one tap after a text-box interaction', () => {
    taps.noteTextBoxInteraction();
    taps.tap(100, 200); // dismissal tap — swallowed
    vi.advanceTimersByTime(1000);
    expect(onTap).not.toHaveBeenCalled();
    expect(onDoubleTap).not.toHaveBeenCalled();

    taps.tap(100, 200);
    vi.advanceTimersByTime(300);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('the swallowed tap does not arm a double-tap', () => {
    taps.noteTextBoxInteraction();
    taps.tap(100, 200); // swallowed
    vi.advanceTimersByTime(50);
    taps.tap(100, 200); // must be a fresh FIRST tap
    expect(onDoubleTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops a pending single tap', () => {
    taps.tap(100, 200);
    taps.cancel();
    vi.advanceTimersByTime(1000);
    expect(onTap).not.toHaveBeenCalled();
  });
});

describe("TapDiscriminator (immediate commit — paged mode's native-click feel)", () => {
  let onTap: ReturnType<typeof vi.fn>;
  let onDoubleTap: ReturnType<typeof vi.fn>;
  let taps: TapDiscriminator;

  beforeEach(() => {
    vi.useFakeTimers();
    onTap = vi.fn();
    onDoubleTap = vi.fn();
    taps = new TapDiscriminator({ commitPolicy: 'immediate', onTap, onDoubleTap });
  });

  afterEach(() => {
    taps.cancel();
    vi.useRealTimers();
  });

  it('commits every tap instantly', () => {
    taps.tap(100, 200);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledWith(100, 200);
  });

  it('a second tap within the window commits AND double-taps (native click/click/dblclick)', () => {
    taps.tap(100, 200);
    vi.advanceTimersByTime(150);
    taps.tap(110, 205);
    expect(onTap).toHaveBeenCalledTimes(2); // both taps committed — overlay toggles twice, net zero
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    expect(onDoubleTap).toHaveBeenCalledWith(110, 205);
  });

  it('slow second tap is just another single tap', () => {
    taps.tap(100, 200);
    vi.advanceTimersByTime(400);
    taps.tap(100, 200);
    expect(onTap).toHaveBeenCalledTimes(2);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('a third quick tap after a double-tap starts a fresh cycle', () => {
    taps.tap(0, 0);
    vi.advanceTimersByTime(100);
    taps.tap(0, 0); // double
    vi.advanceTimersByTime(100);
    taps.tap(0, 0); // fresh first tap
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledTimes(3);
  });
});

describe('TapDiscriminator — adversarial review fixes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('immediate: rejects distant second taps when maxDoubleTapDistancePx is set', () => {
    const onTap = vi.fn();
    const onDoubleTap = vi.fn();
    const taps = new TapDiscriminator({
      commitPolicy: 'immediate',
      maxDoubleTapDistancePx: 40,
      onTap,
      onDoubleTap
    });
    taps.tap(100, 100);
    vi.advanceTimersByTime(100);
    taps.tap(600, 100); // far away — NOT a double-tap
    expect(onDoubleTap).not.toHaveBeenCalled();
    expect(onTap).toHaveBeenCalledTimes(2);
    // and the distant tap re-arms: a third tap near IT does double
    vi.advanceTimersByTime(100);
    taps.tap(610, 105);
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    taps.cancel();
  });

  it('immediate: the swallowed dismissal tap still arms a double-tap (post-textbox dbltap zooms)', () => {
    const onTap = vi.fn();
    const onDoubleTap = vi.fn();
    const taps = new TapDiscriminator({ commitPolicy: 'immediate', onTap, onDoubleTap });
    taps.noteTextBoxInteraction();
    taps.tap(100, 100); // dismissal — no commit, but arms
    expect(onTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    taps.tap(105, 100);
    expect(onTap).toHaveBeenCalledTimes(1); // second tap commits (old: click2 toggled)
    expect(onDoubleTap).toHaveBeenCalledTimes(1); // and zooms (old: native dblclick)
    taps.cancel();
  });

  it('deferred: the swallowed dismissal tap does NOT arm (readers parity)', () => {
    const onTap = vi.fn();
    const onDoubleTap = vi.fn();
    const taps = new TapDiscriminator({ onTap, onDoubleTap });
    taps.noteTextBoxInteraction();
    taps.tap(100, 100); // dismissal
    vi.advanceTimersByTime(100);
    taps.tap(105, 100); // fresh FIRST tap
    expect(onDoubleTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onTap).toHaveBeenCalledTimes(1);
    taps.cancel();
  });
});
