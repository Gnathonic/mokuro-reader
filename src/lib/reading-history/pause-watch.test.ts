import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { NO_DATA_CAP_MS, type IdleSettings } from './stats-engine';
import type { OpenView, ViewDescriptor } from './view-tracker';
import { AWAY_AFTER_MS, PauseWatch, livePause, livePauseFor, type LivePause } from './pause-watch';

const T0 = Date.UTC(2026, 9, 10, 12, 0);
const MIN = 60_000;
/** 1000 characters at 100 ms/char: expected 100 s, cap 3 × 100 s = 5 min. */
const PACE = 100;
const IDLE: IdleSettings = { k: 3, overrideMs: null };

function view(first: number, extra: Partial<ViewDescriptor> = {}): ViewDescriptor {
  return {
    volume: 'vol-1',
    first_page: first,
    last_page: first,
    page_chars: [1000],
    chars_before: (first - 1) * 1000,
    layout: 'single',
    orientation: 'portrait',
    viewport: { w: 400, h: 800 },
    ...extra
  };
}

function open(since: number, first = 1, extra: Partial<ViewDescriptor> = {}): OpenView {
  return { view: view(first, extra), since, answer: null };
}

function setup() {
  const onCap = vi.fn<(p: LivePause) => void>();
  const onClear = vi.fn<() => void>();
  const watch = new PauseWatch(onCap, onClear);
  return { watch, onCap, onClear };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('livePauseFor', () => {
  it('describes the open view with the cap and typical time the engine uses', () => {
    expect(livePauseFor(open(T0), PACE, IDLE)).toEqual({
      volume: 'vol-1',
      since: T0,
      chars: 1000,
      cap: 5 * MIN,
      typical: 100_000
    });
  });

  it('sums every page on screen (a spread)', () => {
    const spread = open(T0, 1, { last_page: 2, page_chars: [400, 600], layout: 'double' });
    expect(livePauseFor(spread, PACE, IDLE).chars).toBe(1000);
  });

  it('takes the override, or the no-data cap before there is a pace', () => {
    expect(livePauseFor(open(T0), PACE, { k: 3, overrideMs: MIN }).cap).toBe(MIN);
    expect(livePauseFor(open(T0), null, IDLE).cap).toBe(NO_DATA_CAP_MS);
  });
});

describe('PauseWatch', () => {
  it('starts with no live pause and a two-minute away threshold', () => {
    expect(get(livePause)).toBeNull();
    expect(AWAY_AFTER_MS).toBe(2 * MIN);
  });

  it('fires at since + cap, not before', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(5 * MIN - 1);
    expect(onCap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap).toHaveBeenCalledWith({
      volume: 'vol-1',
      since: T0,
      chars: 1000,
      cap: 5 * MIN,
      typical: 100_000
    });
  });

  it('fires on the next tick, never inside update, when the cap is already behind', () => {
    const { watch, onCap } = setup();
    vi.setSystemTime(T0 + 7 * MIN);
    watch.update(open(T0), PACE, IDLE);
    expect(onCap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(onCap).toHaveBeenCalledTimes(1);
  });

  it('keeps its deadline when the same view and cap are reported again', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(4 * MIN);
    watch.update(open(T0, 1, { viewport: { w: 800, h: 400 } }), PACE, IDLE);
    vi.advanceTimersByTime(MIN);
    expect(onCap).toHaveBeenCalledTimes(1);
  });

  it('re-arms when the cap grows before it is reached', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(4 * MIN);
    watch.update(open(T0), PACE, { k: 6, overrideMs: null });
    vi.advanceTimersByTime(5 * MIN);
    expect(onCap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap.mock.calls[0][0].cap).toBe(10 * MIN);
  });

  it('re-arms when the cap shrinks, firing at once if the new cap is already behind', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(2 * MIN);
    watch.update(open(T0), PACE, { k: 3, overrideMs: MIN });
    vi.advanceTimersByTime(0);
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap.mock.calls[0][0].cap).toBe(MIN);
  });

  it('never fires after the view ends', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(MIN);
    watch.update(null, PACE, IDLE);
    vi.advanceTimersByTime(60 * MIN);
    expect(onCap).not.toHaveBeenCalled();
  });

  it('times a new view from its own since', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(4 * MIN);
    watch.update(open(T0 + 4 * MIN, 2), PACE, IDLE);
    vi.advanceTimersByTime(4 * MIN);
    expect(onCap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap.mock.calls[0][0].since).toBe(T0 + 4 * MIN);
  });

  it('fires once per since, even when a smaller change to the cap arrives after', () => {
    const { watch, onCap, onClear } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(7 * MIN);
    watch.update(open(T0), PACE, IDLE);
    watch.update(open(T0), PACE, { k: 4, overrideMs: null });
    vi.advanceTimersByTime(60 * MIN);
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('fires again for the continuation view a split opens', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(6 * MIN);
    // "Still reading": the same pages reopen at the answer time with a wider cap.
    watch.update(open(T0 + 6 * MIN), PACE, { k: 6, overrideMs: null });
    vi.advanceTimersByTime(10 * MIN);
    expect(onCap).toHaveBeenCalledTimes(2);
    expect(onCap.mock.calls[1][0]).toMatchObject({ since: T0 + 6 * MIN, cap: 10 * MIN });
  });

  it('withdraws a fired pause when its view ends or another opens', () => {
    const { watch, onClear } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(6 * MIN);
    watch.update(open(T0 + 6 * MIN, 2), PACE, IDLE);
    expect(onClear).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * MIN);
    watch.update(null, PACE, IDLE);
    expect(onClear).toHaveBeenCalledTimes(2);
  });

  it('does not withdraw what never fired', () => {
    const { watch, onClear } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(MIN);
    watch.update(open(T0 + MIN, 2), PACE, IDLE);
    watch.update(null, PACE, IDLE);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('withdraws a fired pause when the cap grows past the time so far, then waits again', () => {
    const { watch, onCap, onClear } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(6 * MIN);
    expect(onCap).toHaveBeenCalledTimes(1);
    watch.update(open(T0), PACE, { k: 9, overrideMs: null });
    expect(onClear).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9 * MIN - 1);
    expect(onCap).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onCap).toHaveBeenCalledTimes(2);
    expect(onCap.mock.calls[1][0].cap).toBe(15 * MIN);
  });

  it('stops for good on dispose', () => {
    const { watch, onCap, onClear } = setup();
    watch.update(open(T0), PACE, IDLE);
    watch.dispose();
    vi.advanceTimersByTime(60 * MIN);
    expect(onCap).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });
});
