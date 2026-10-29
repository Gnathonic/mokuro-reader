import { describe, expect, it } from 'vitest';
import {
  PAGE_ADJUST_DEFAULT,
  PAGE_ADJUST_MAX,
  PAGE_ADJUST_MIN,
  clampPageAdjust,
  pageFilterCss
} from './page-filter';

describe('clampPageAdjust', () => {
  it('keeps an in-range value', () => {
    expect(clampPageAdjust(130)).toBe(130);
  });

  it('clamps to the range', () => {
    expect(clampPageAdjust(10)).toBe(PAGE_ADJUST_MIN);
    expect(clampPageAdjust(999)).toBe(PAGE_ADJUST_MAX);
  });

  it('rounds to whole percent', () => {
    expect(clampPageAdjust(112.6)).toBe(113);
  });

  it('falls back to the default for anything that is not a finite number', () => {
    for (const bad of [undefined, null, NaN, Infinity, '130', {}, true]) {
      expect(clampPageAdjust(bad)).toBe(PAGE_ADJUST_DEFAULT);
    }
  });
});

describe('pageFilterCss', () => {
  it('is none at 100/100 — no filter, no stacking context', () => {
    expect(pageFilterCss(100, 100)).toBe('none');
  });

  it('is none for missing values (profiles predating the setting)', () => {
    expect(pageFilterCss(undefined, undefined)).toBe('none');
  });

  it('emits brightness then contrast as percentages', () => {
    expect(pageFilterCss(130, 150)).toBe('brightness(130%) contrast(150%)');
  });

  it('emits both functions when only one is changed', () => {
    expect(pageFilterCss(80, 100)).toBe('brightness(80%) contrast(100%)');
    expect(pageFilterCss(100, 120)).toBe('brightness(100%) contrast(120%)');
  });

  it('clamps out-of-range values', () => {
    expect(pageFilterCss(0, 1000)).toBe(
      `brightness(${PAGE_ADJUST_MIN}%) contrast(${PAGE_ADJUST_MAX}%)`
    );
  });

  it('is none when out-of-range garbage clamps back to identity', () => {
    expect(pageFilterCss('x', NaN)).toBe('none');
  });
});
