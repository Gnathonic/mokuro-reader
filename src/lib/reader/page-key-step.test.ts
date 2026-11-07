import { describe, it, expect } from 'vitest';
import {
  PAGE_KEY_EPSILON_PX,
  PAGE_KEY_OVERLAP,
  alignDelta,
  pageKeyStep,
  readingSpan,
  type AxisSpan
} from './page-key-step';

const V = 1000; // viewport size
const STEP = V * (1 - PAGE_KEY_OVERLAP);
const view = (start: number): AxisSpan => ({ start, end: start + V });

describe('pageKeyStep — paged (one page or spread, no neighbours)', () => {
  it('turns when the content fits the viewport', () => {
    const current = { start: 100, end: 900 };
    expect(pageKeyStep({ direction: 'forward', view: view(0), current, enabled: true })).toEqual({
      kind: 'turn'
    });
    expect(pageKeyStep({ direction: 'backward', view: view(0), current, enabled: true })).toEqual({
      kind: 'turn'
    });
  });

  it('scrolls a screenful minus the overlap when the content continues below', () => {
    const current = { start: 0, end: 3000 };
    expect(pageKeyStep({ direction: 'forward', view: view(0), current, enabled: true })).toEqual({
      kind: 'scroll',
      by: STEP
    });
  });

  it('keeps the overlap: the new view starts inside the old one', () => {
    const step = pageKeyStep({
      direction: 'forward',
      view: view(0),
      current: { start: 0, end: 3000 },
      enabled: true
    });
    expect(step.kind).toBe('scroll');
    const by = step.kind === 'scroll' ? step.by : 0;
    expect(by).toBeLessThan(V);
    expect(V - by).toBeCloseTo(V * PAGE_KEY_OVERLAP);
  });

  it('clamps at the content edge: the view end lands on the page end', () => {
    const current = { start: 0, end: 1300 };
    expect(pageKeyStep({ direction: 'forward', view: view(0), current, enabled: true })).toEqual({
      kind: 'scroll',
      by: 300
    });
  });

  it('turns once the bottom edge is in view', () => {
    const current = { start: -300, end: 1000 };
    expect(pageKeyStep({ direction: 'forward', view: view(0), current, enabled: true })).toEqual({
      kind: 'turn'
    });
  });

  it('turns when the hidden overflow is within the epsilon', () => {
    const current = { start: 0, end: V + PAGE_KEY_EPSILON_PX };
    expect(pageKeyStep({ direction: 'forward', view: view(0), current, enabled: true })).toEqual({
      kind: 'turn'
    });
    const justOver = { start: 0, end: V + PAGE_KEY_EPSILON_PX + 1 };
    expect(
      pageKeyStep({ direction: 'forward', view: view(0), current: justOver, enabled: true })
    ).toEqual({ kind: 'scroll', by: PAGE_KEY_EPSILON_PX + 1 });
  });

  it('PageUp mirrors: scrolls up a screenful, clamped at the top, then turns', () => {
    const current = { start: 0, end: 3000 };
    expect(
      pageKeyStep({ direction: 'backward', view: view(2000), current, enabled: true })
    ).toEqual({ kind: 'scroll', by: -STEP });
    expect(pageKeyStep({ direction: 'backward', view: view(400), current, enabled: true })).toEqual(
      { kind: 'scroll', by: -400 }
    );
    expect(pageKeyStep({ direction: 'backward', view: view(0), current, enabled: true })).toEqual({
      kind: 'turn'
    });
    expect(
      pageKeyStep({
        direction: 'backward',
        view: view(PAGE_KEY_EPSILON_PX),
        current,
        enabled: true
      })
    ).toEqual({ kind: 'turn' });
  });

  it('walks a tall page in steps that end exactly on its bottom, then turns', () => {
    const current = { start: 0, end: 2600 };
    let start = 0;
    const steps: number[] = [];
    for (let i = 0; i < 10; i++) {
      const s = pageKeyStep({ direction: 'forward', view: view(start), current, enabled: true });
      if (s.kind === 'turn') break;
      steps.push(s.by);
      start += s.by;
    }
    expect(steps).toEqual([STEP, 1600 - STEP]);
    expect(start + V).toBe(current.end);
  });

  it('setting off always turns, whatever is hidden', () => {
    const current = { start: -2000, end: 3000 };
    for (const direction of ['forward', 'backward'] as const) {
      expect(pageKeyStep({ direction, view: view(0), current, enabled: false })).toEqual({
        kind: 'turn'
      });
    }
  });

  it('a degenerate viewport turns', () => {
    const current = { start: 0, end: 3000 };
    expect(
      pageKeyStep({ direction: 'forward', view: { start: 0, end: 0 }, current, enabled: true })
    ).toEqual({ kind: 'turn' });
  });
});

describe('pageKeyStep — continuous (page boundaries)', () => {
  // A tall page, a short page, a tall page, 20px dividers.
  const pages: AxisSpan[] = [
    { start: 0, end: 2500 },
    { start: 2520, end: 3020 },
    { start: 3040, end: 5540 }
  ];

  it('scrolls a screenful while the current page continues below', () => {
    expect(
      pageKeyStep({ direction: 'forward', view: view(0), current: pages[0], pages, enabled: true })
    ).toEqual({ kind: 'scroll', by: STEP });
  });

  it('never carries the view past the next page start: lands exactly on it', () => {
    // The current (centre) page starts INSIDE the view and continues below it.
    expect(
      pageKeyStep({
        direction: 'forward',
        view: view(2200),
        current: pages[2],
        pages,
        enabled: true
      })
    ).toEqual({ kind: 'scroll', by: 2520 - 2200 });
  });

  it('turns when the current page bottom is already in view', () => {
    expect(
      pageKeyStep({
        direction: 'forward',
        view: view(1700),
        current: pages[0],
        pages,
        enabled: true
      })
    ).toEqual({ kind: 'turn' });
  });

  it('PageUp stays inside the current page: clamped at its top', () => {
    expect(
      pageKeyStep({
        direction: 'backward',
        view: view(3500),
        current: pages[2],
        pages,
        enabled: true
      })
    ).toEqual({ kind: 'scroll', by: -(3500 - 3040) });
  });

  it('PageUp never carries the view end above the previous page end', () => {
    // View [1700, 2700] — mostly the end of page 0, with page 1's top below.
    // Centre page is page 0; the step must stop where page 0's end meets the
    // view end rather than overshoot it.
    expect(
      pageKeyStep({
        direction: 'backward',
        view: view(1700),
        current: pages[0],
        pages,
        enabled: true
      })
    ).toEqual({ kind: 'scroll', by: -(2700 - 2500) });
  });

  it('PageUp at a page top turns', () => {
    expect(
      pageKeyStep({
        direction: 'backward',
        view: view(3040),
        current: pages[2],
        pages,
        enabled: true
      })
    ).toEqual({ kind: 'turn' });
  });

  it('pages above or level with the view never limit a forward step', () => {
    expect(
      pageKeyStep({
        direction: 'forward',
        view: view(3040),
        current: pages[2],
        pages,
        enabled: true
      })
    ).toEqual({ kind: 'scroll', by: STEP });
  });
});

describe('readingSpan', () => {
  it('is the identity when reading runs toward larger coordinates', () => {
    expect(readingSpan(10, 50, false)).toEqual({ start: 10, end: 50 });
  });

  it('mirrors a right-to-left axis', () => {
    expect(readingSpan(10, 50, true)).toEqual({ start: -50, end: -10 });
  });

  it('RTL: the page continuing to the LEFT of the view is hidden content ahead', () => {
    // Screen x: view [0, 1000], page [-1500, 1000] (its left part off screen).
    const step = pageKeyStep({
      direction: 'forward',
      view: readingSpan(0, 1000, true),
      current: readingSpan(-1500, 1000, true),
      enabled: true
    });
    expect(step).toEqual({ kind: 'scroll', by: STEP });
  });
});

describe('alignDelta', () => {
  it('aligns a target start with the view start (forward turn)', () => {
    expect(alignDelta(view(0), { start: 2520, end: 5000 }, 'start')).toBe(2520);
  });

  it('aligns a target end with the view end (backward turn)', () => {
    expect(alignDelta(view(3040), { start: 0, end: 2500 }, 'end')).toBe(2500 - 4040);
  });
});
