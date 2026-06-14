import { describe, it, expect } from 'vitest';
import { convertLevelAcrossBases, doubleTapTarget, pagedLevels } from './paged-zoom-session';

describe('pagedLevels', () => {
  it('is the standard ladder when the base already fits (floor 1, small fit scale)', () => {
    // fitToScreen base: baseScale === fitScale = 0.5 → floor 1, top = 2/0.5 = 4
    expect(pagedLevels(0.5, 0.5)).toEqual([1, 1.5, 2, 3, 4]);
  });

  it('adds a below-1 fit floor when the base overflows (zoomOriginal scans)', () => {
    // base 1:1, fit 0.6 → floor 0.6 keeps the whole-page escape hatch
    expect(pagedLevels(1, 0.6)).toEqual([0.6, 1, 1.5, 2, 3]);
  });

  it('keeps at least 2x native pixels reachable', () => {
    // phone-ish: fit 0.3 → top = 2/0.3 ≈ 6.67
    const levels = pagedLevels(0.3, 0.3);
    expect(levels[levels.length - 1]).toBeCloseTo(2 / 0.3, 6);
  });

  it('caps the ladder at 3 when the base is already large', () => {
    // zoomOriginal with base 1: top = max(3, 2) = 3
    expect(pagedLevels(1, 1)).toEqual([1, 1.5, 2, 3]);
  });

  it('dedupes when the floor or top collides with a standard level', () => {
    const levels = pagedLevels(2, 2); // top = max(3, 1) = 3, floor 1
    expect(levels).toEqual([1, 1.5, 2, 3]);
    expect(new Set(levels).size).toBe(levels.length);
  });
});

describe('doubleTapTarget', () => {
  it('resets to 1 when zoomed above level 1', () => {
    expect(doubleTapTarget(2, 0.6)).toBe(1);
    expect(doubleTapTarget(1.2, 1)).toBe(1);
  });

  it('drops to the fit floor from level 1 when the base overflows', () => {
    expect(doubleTapTarget(1, 0.6)).toBe(0.6);
  });

  it('zooms in to 2x from the fit floor or a fitting base', () => {
    expect(doubleTapTarget(0.6, 0.6)).toBe(2);
    expect(doubleTapTarget(1, 1)).toBe(2);
  });

  it('treats a pinched sub-1 level as "near the floor" sensibly', () => {
    // between floor and 1 → go to floor first (whole page), then 2x next tap
    expect(doubleTapTarget(0.8, 0.6)).toBe(0.6);
  });
});

describe('convertLevelAcrossBases', () => {
  it('preserves the effective on-screen scale across base changes', () => {
    // level 2 over base 0.9 → effective 1.8; new base 0.6 → level 3
    expect(convertLevelAcrossBases(2, 0.9, 0.6, 0.5, 4)).toBeCloseTo(3, 6);
  });

  it('clamps into the new floor/top range', () => {
    expect(convertLevelAcrossBases(4, 0.5, 2, 0.8, 3)).toBe(1); // 4*0.5/2 = 1
    expect(convertLevelAcrossBases(1, 2, 0.25, 1, 3)).toBe(3); // 8 → top
    expect(convertLevelAcrossBases(0.5, 0.5, 1, 0.7, 3)).toBe(0.7); // 0.25 → floor
  });

  it('guards degenerate bases', () => {
    expect(convertLevelAcrossBases(2, 0, 1, 1, 3)).toBe(1);
    expect(convertLevelAcrossBases(2, 1, 0, 1, 3)).toBe(1);
  });
});
