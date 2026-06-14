import { describe, it, expect } from 'vitest';
import { classifySwipe, type SwipeContext } from './swipe';

function ctx(overrides: Partial<SwipeContext> = {}): SwipeContext {
  return {
    summary: {
      panned: true,
      cancelled: false,
      startX: 500,
      startY: 400,
      endX: 500,
      endY: 400,
      durationMs: 200,
      pointerType: 'touch'
    },
    wasPinch: false,
    viewport: { width: 1000, height: 800 },
    thresholdPercent: 50,
    canRevealLeftAtStart: false,
    canRevealRightAtStart: false,
    ...overrides
  };
}

function swipe(dx: number, dy = 0, overrides: Partial<SwipeContext> = {}) {
  const base = ctx(overrides);
  return classifySwipe({
    ...base,
    summary: { ...base.summary, endX: base.summary.startX + dx, endY: base.summary.startY + dy }
  });
}

describe('classifySwipe', () => {
  it('rightward swipe past threshold flips toward the left page', () => {
    expect(swipe(600)).toBe('left');
  });

  it('leftward swipe past threshold flips toward the right page', () => {
    expect(swipe(-600)).toBe('right');
  });

  it('a swipe short of the threshold does not flip (50% of 1000px = 500px)', () => {
    expect(swipe(450)).toBe(null);
    expect(swipe(-450)).toBe(null);
  });

  it('threshold scales with the setting', () => {
    expect(swipe(300, 0, { thresholdPercent: 25 })).toBe('left');
  });

  it('non-touch pointers never swipe', () => {
    const base = ctx();
    expect(
      classifySwipe({
        ...base,
        summary: { ...base.summary, endX: base.summary.startX + 600, pointerType: 'mouse' }
      })
    ).toBe(null);
  });

  it('a gesture that pinched is not a swipe', () => {
    expect(swipe(600, 0, { wasPinch: true })).toBe(null);
  });

  it('slow gestures (>=500ms) are pans, not swipes', () => {
    const base = ctx();
    expect(
      classifySwipe({
        ...base,
        summary: { ...base.summary, endX: base.summary.startX + 600, durationMs: 500 }
      })
    ).toBe(null);
  });

  it('too much vertical travel disqualifies (min(200, 30% of height))', () => {
    // height 800 → vertical threshold min(200, 240) = 200
    expect(swipe(600, 250)).toBe(null);
    expect(swipe(600, -250)).toBe(null);
    expect(swipe(600, 150)).toBe('left');
  });

  it('edge gating (#186): hidden content in the swipe direction means pan, not flip', () => {
    expect(swipe(600, 0, { canRevealLeftAtStart: true })).toBe(null);
    expect(swipe(-600, 0, { canRevealRightAtStart: true })).toBe(null);
    // the opposite edge does not gate
    expect(swipe(600, 0, { canRevealRightAtStart: true })).toBe('left');
  });
});

describe('classifySwipe — cancelled gestures', () => {
  it('a cancelled pan never flips, however swipe-shaped it is', () => {
    const base = ctx();
    expect(
      classifySwipe({
        ...base,
        summary: { ...base.summary, endX: base.summary.startX + 600, cancelled: true }
      })
    ).toBe(null);
  });
});
