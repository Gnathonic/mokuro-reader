import { describe, it, expect } from 'vitest';
import {
  PAGE_KEY_EPSILON_PX,
  PAGE_KEY_OVERLAP,
  alignDelta,
  pageKeyStep,
  readingSpan,
  stripPageKeyTarget,
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

describe('stripPageKeyTarget — which page a key acts on in a continuous strip', () => {
  // The review's geometry (1080 px screen, fill-width at 1920 px): a short
  // page P (1536 px), a webtoon page A (11520 px), a short page S (768 px,
  // fits), another short page T, 20 px gaps.
  const H = 1080;
  const P = { start: 0, end: 1536 };
  const A = { start: 1556, end: 13076 };
  const S = { start: 13096, end: 13864 };
  const T = { start: 13884, end: 15420 };
  const strip = [P, A, S, T];
  const fitsH = (i: number) => strip[i].end - strip[i].start <= H * 1.05;
  const at = (start: number): AxisSpan => ({ start, end: start + H });

  it('a tall page whose top is on the view top is the page being read, not the shorter page above', () => {
    // The page nearest the centre here is P (its centre 1220 px away, A's
    // 5220 px): acting on P turned to A, i.e. re-aligned A's top — a stall.
    expect(stripPageKeyTarget('forward', at(A.start), strip, fitsH)).toEqual({
      index: 1,
      within: true
    });
    // …and pageKeyStep then scrolls through it.
    expect(
      pageKeyStep({
        direction: 'forward',
        view: at(A.start),
        current: A,
        pages: strip,
        enabled: true
      })
    ).toEqual({ kind: 'scroll', by: H * (1 - PAGE_KEY_OVERLAP) });
  });

  it("a tall page's bottom in view with a short page below: turns onto the short page, not past it", () => {
    // A's end on the view's end, S below it. The page nearest the centre is
    // S (944 px away; A's centre is 5220 px away), and S fits — so the old
    // pick turned to S+1 and S was only ever partly seen.
    expect(stripPageKeyTarget('forward', at(A.end - H), strip, fitsH)).toEqual({
      index: 2,
      within: false
    });
  });

  it('a short page centred on screen with a tall page above: the next key turns onto the page below it', () => {
    // S centred: A's tail above, T's head below.
    const mid = (S.start + S.end) / 2 - H / 2;
    expect(stripPageKeyTarget('forward', at(mid), strip, fitsH)).toEqual({
      index: 3,
      within: false
    });
    // Backward from there: A's top is hidden above and A covers the view top
    // only — so the key turns onto A (its last screenful), never onto P.
    expect(stripPageKeyTarget('backward', at(mid), strip, fitsH)).toEqual({
      index: 1,
      within: false
    });
  });

  it('Page Up on a tall page scrolls up through it; at its top it turns onto the page above', () => {
    expect(stripPageKeyTarget('backward', at(A.end - H), strip, fitsH)).toEqual({
      index: 1,
      within: true
    });
    expect(stripPageKeyTarget('backward', at(A.start), strip, fitsH)).toEqual({
      index: 0,
      within: false
    });
  });

  it('a near-fit page covering the near edge counts as read', () => {
    // A centred page 4% taller than the screen hides 22 px each side.
    const near = { start: 0, end: H * 1.04 };
    const next = { start: near.end + 20, end: near.end + 20 + 2 * H };
    const pages = [near, next];
    const fits = (i: number) => i === 0;
    expect(stripPageKeyTarget('forward', at(H * 0.02), pages, fits)).toEqual({
      index: 1,
      within: false
    });
  });

  it('nothing hidden in the key direction: undefined (the strip end)', () => {
    expect(stripPageKeyTarget('forward', at(T.end - H), strip, fitsH)).toBeUndefined();
    expect(stripPageKeyTarget('backward', at(0), strip, fitsH)).toBeUndefined();
  });

  it('hidden content within the epsilon does not count; unmeasured pages are skipped', () => {
    const pages = [undefined, { start: 0, end: H + PAGE_KEY_EPSILON_PX }];
    expect(stripPageKeyTarget('forward', at(0), pages, () => false)).toBeUndefined();
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
