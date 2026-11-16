// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  // jsdom has no ResizeObserver: a stand-in whose reports the test sends.
  let observers: FakeResizeObserver[] = [];
  class FakeResizeObserver {
    targets = new Set<Element>();
    constructor(private cb: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(el: Element) {
      this.targets.add(el);
    }
    unobserve(el: Element) {
      this.targets.delete(el);
    }
    disconnect() {
      this.targets.clear();
    }
    /** What the browser does once a watched element changed size (or left). */
    report(el: Element) {
      if (!this.targets.has(el)) return;
      this.cb([{ target: el } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
  }
  const report = (el: Element) => observers.forEach((o) => o.report(el));

  beforeEach(() => {
    observers = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  /** A bottom overlay whose default (CSS) place is `rect`; `resize` changes its height. */
  function overlay(rect: Box) {
    const el = document.createElement('div');
    let height = rect.bottom - rect.top;
    // jsdom has no layout: report the default place, or the lifted one. A
    // bottom-anchored box grows upward; a removed one measures all zeros.
    el.getBoundingClientRect = () => {
      if (!el.isConnected) return new DOMRect(0, 0, 0, 0);
      const bottom = el.style.bottom
        ? window.innerHeight - parseFloat(el.style.bottom)
        : rect.bottom;
      const r = { ...rect, bottom, top: bottom - height };
      return {
        ...r,
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top
      } as DOMRect;
    };
    document.body.append(el);
    return Object.assign(el, {
      resize(h: number) {
        height = h;
        report(el);
      }
    });
  }

  it('the first one keeps its CSS place; the second stacks above it and never moves the first', () => {
    const h = window.innerHeight;
    const first = overlay(box(100, h - 120, 400, 100));
    const a = bottomOverlay(first);
    expect(first.hasAttribute(BOTTOM_OVERLAY_ATTR)).toBe(true);
    expect(first.style.bottom).toBe('');

    const second = overlay(box(100, h - 150, 400, 80));
    const b = bottomOverlay(second);
    const stacked = `${120 + BOTTOM_OVERLAY_GAP}px`;
    expect(second.style.bottom).toBe(stacked);
    expect(first.style.bottom).toBe('');
    // Observing reports the current size once: nothing moves.
    report(first);
    expect(second.style.bottom).toBe(stacked);

    // The first leaving does not drop the second down under the user's
    // pointer — not even when the browser reports the removed one's (zero) size.
    a.destroy();
    first.remove();
    report(first);
    expect(second.style.bottom).toBe(stacked);

    // A resize re-places it: now nothing is in the way.
    window.dispatchEvent(new Event('resize'));
    expect(second.style.bottom).toBe('');
    b.destroy();
  });

  it('a stacked one stays put when the one under it shrinks, and lifts only as far as it must when it grows', () => {
    const h = window.innerHeight;
    const under = overlay(box(100, h - 120, 400, 100));
    bottomOverlay(under);
    const over = overlay(box(100, h - 150, 400, 80));
    bottomOverlay(over);
    expect(over.style.bottom).toBe(`${120 + BOTTOM_OVERLAY_GAP}px`);

    under.resize(60);
    expect(over.style.bottom).toBe(`${120 + BOTTOM_OVERLAY_GAP}px`);
    under.resize(100);
    expect(over.style.bottom).toBe(`${120 + BOTTOM_OVERLAY_GAP}px`);
    // Grown into it (top now at h - 150): lifted just above, never further.
    under.resize(130);
    expect(over.style.bottom).toBe(`${150 + BOTTOM_OVERLAY_GAP}px`);
  });

  it('an overlay at its default place watches nothing and never moves', () => {
    const h = window.innerHeight;
    const first = overlay(box(100, h - 120, 400, 100));
    bottomOverlay(first);
    const second = overlay(box(100, h - 150, 400, 80));
    bottomOverlay(second);
    second.resize(400);
    expect(first.style.bottom).toBe('');
  });

  it('one arriving after the other left takes its own default place in the gap', () => {
    const h = window.innerHeight;
    const prompt = overlay(box(100, h - 120, 400, 100));
    const p = bottomOverlay(prompt);
    const panel = overlay(box(100, h - 150, 400, 80));
    bottomOverlay(panel);
    p.destroy();
    prompt.remove();
    const again = overlay(box(100, h - 120, 400, 100));
    bottomOverlay(again);
    expect(again.style.bottom).toBe('');
    expect(panel.style.bottom).toBe(`${120 + BOTTOM_OVERLAY_GAP}px`);
  });
});
