// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOTTOM_OVERLAY_ATTR,
  BOTTOM_OVERLAY_GAP,
  bottomOverlay,
  clearancePlacement,
  type Box
} from './bottom-overlay';

const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  right: left + width,
  top,
  bottom: top + height
});

describe('clearancePlacement', () => {
  // A 1920x1080 screen: the long-pause prompt at bottom-16, the panel at bottom-3.
  const prompt = box(688, 932, 544, 84);
  const panel = box(752, 954, 416, 114);

  it('keeps the default place when nothing is in the way', () => {
    expect(clearancePlacement(panel, [], 1080)).toBeNull();
    expect(clearancePlacement(panel, [box(0, 0, 100, 40)], 1080)).toBeNull();
    // Side by side, or one wholly above the other: no overlap.
    expect(clearancePlacement(panel, [box(1300, 950, 200, 100)], 1080)).toBeNull();
    expect(clearancePlacement(panel, [box(752, 700, 416, 200)], 1080)).toBeNull();
  });

  it('stacks the newcomer above the one already there, a gap apart', () => {
    // Panel opened over a waiting prompt: its bottom edge goes gap px above the prompt.
    expect(clearancePlacement(panel, [prompt], 1080)).toBe(1080 - 932 + BOTTOM_OVERLAY_GAP);
    // Prompt arriving over the open panel.
    expect(clearancePlacement(prompt, [panel], 1080)).toBe(1080 - 954 + BOTTOM_OVERLAY_GAP);
  });

  it('keeps lifting until it clears every overlay it would land on', () => {
    const higher = box(752, 830, 416, 90);
    // Clearing the prompt (top 932) lands on `higher` (830–920): it goes above that too.
    expect(clearancePlacement(panel, [prompt, higher], 1080)).toBe(1080 - 830 + BOTTOM_OVERLAY_GAP);
  });
});

describe('bottomOverlay action', () => {
  afterEach(() => document.body.replaceChildren());

  function overlay(rect: Box): HTMLElement {
    const el = document.createElement('div');
    // jsdom has no layout: report the default place, or the lifted one.
    el.getBoundingClientRect = () => {
      const lift = el.style.bottom ? window.innerHeight - parseFloat(el.style.bottom) : null;
      const r =
        lift === null ? rect : { ...rect, bottom: lift, top: lift - (rect.bottom - rect.top) };
      return {
        ...r,
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top
      } as DOMRect;
    };
    document.body.append(el);
    return el;
  }

  it('the first one keeps its CSS place; the second stacks above it and never moves the first', () => {
    const h = window.innerHeight;
    const first = overlay(box(100, h - 120, 400, 100));
    const a = bottomOverlay(first);
    expect(first.hasAttribute(BOTTOM_OVERLAY_ATTR)).toBe(true);
    expect(first.style.bottom).toBe('');

    const second = overlay(box(100, h - 150, 400, 80));
    const b = bottomOverlay(second);
    expect(second.style.bottom).toBe(`${120 + BOTTOM_OVERLAY_GAP}px`);
    expect(first.style.bottom).toBe('');

    // The first leaving does not drop the second down under the user's pointer.
    a.destroy();
    first.remove();
    window.dispatchEvent(new Event('scroll'));
    expect(second.style.bottom).toBe(`${120 + BOTTOM_OVERLAY_GAP}px`);
    // A resize re-places it: now nothing is in the way.
    window.dispatchEvent(new Event('resize'));
    expect(second.style.bottom).toBe('');
    b.destroy();
  });
});
