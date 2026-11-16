import { describe, it, expect, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { landscape, defaultMenuGlyphContext, provideMenuGlyphContext } from './menu-glyph-context';

function size(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
}

describe('menuGlyphContext outside the reader', () => {
  afterEach(() => provideMenuGlyphContext(null));

  it('follows resize and orientation changes, not only settings changes', () => {
    size(800, 1200);
    const seen: boolean[] = [];
    const unsub = landscape.subscribe((v) => seen.push(v));
    expect(get(landscape)).toBe(false);
    size(1200, 800);
    window.dispatchEvent(new Event('resize'));
    expect(get(landscape)).toBe(true);
    size(800, 1200);
    window.dispatchEvent(new Event('orientationchange'));
    expect(get(landscape)).toBe(false);
    unsub();
    expect(seen).toContain(true);
  });

  it('derives the default context from the live orientation', () => {
    const base = {
      continuousScroll: false,
      scrollMode: 'auto',
      singlePageView: 'auto',
      volumeDefaults: undefined
    } as never;
    expect(defaultMenuGlyphContext(base, false).hasSecondPage).toBe(false);
    expect(defaultMenuGlyphContext(base, true).hasSecondPage).toBe(true);
  });
});
