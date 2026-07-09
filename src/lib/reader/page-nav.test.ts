import { describe, it, expect } from 'vitest';
import { calculateForwardTarget, calculateBackwardTarget, type PageNavContext } from './page-nav';
import type { Page } from '$lib/types';

const portrait = () => ({ img_width: 800, img_height: 1200 }) as Page;
const wide = () => ({ img_width: 2000, img_height: 1200 }) as Page;

function ctx(pages: Page[], overrides: Partial<PageNavContext> = {}): PageNavContext {
  return { pages, mode: 'dual', hasCover: false, fallbackStep: 2, ...overrides };
}

describe('calculateForwardTarget', () => {
  it('single mode advances one page', () => {
    const pages = [portrait(), portrait(), portrait(), portrait()];
    expect(calculateForwardTarget(1, ctx(pages, { mode: 'single' }))).toBe(2);
  });

  it('dual mode advances a full spread', () => {
    const pages = [portrait(), portrait(), portrait(), portrait(), portrait(), portrait()];
    expect(calculateForwardTarget(1, ctx(pages))).toBe(3);
  });

  it('cover page advances one to start spreads after it', () => {
    const pages = [portrait(), portrait(), portrait(), portrait()];
    expect(calculateForwardTarget(1, ctx(pages, { hasCover: true }))).toBe(2);
  });

  it('half-steps when the next spread would land mis-aligned on a wide page', () => {
    // Dual view [1,2]; pages[idx+3] (page 4) is wide → +1 so the wide page aligns.
    const pages = [portrait(), portrait(), portrait(), wide(), portrait(), portrait()];
    expect(calculateForwardTarget(1, ctx(pages))).toBe(2);
  });

  it('a current wide spread advances normally (no half-step from a wide view)', () => {
    const pages = [wide(), portrait(), portrait(), wide(), portrait(), portrait()];
    // current view shows the wide page alone (auto/single detection is the
    // caller's concern in dual mode the wide current page still advances +1
    // because shouldShowSinglePage('dual') is false and currentIsWide blocks
    // the half-step rule
    expect(calculateForwardTarget(1, ctx(pages))).toBe(3);
  });

  it('falls back to the provided step when out of range', () => {
    const pages = [portrait(), portrait()];
    expect(calculateForwardTarget(5, ctx(pages, { fallbackStep: 1 }))).toBe(6);
    expect(calculateForwardTarget(5, ctx(pages, { fallbackStep: 2 }))).toBe(7);
    expect(calculateForwardTarget(1, ctx([], { fallbackStep: 2 }))).toBe(3);
  });
});

describe('calculateBackwardTarget', () => {
  it('from page 1 goes to 0 (volume-boundary sentinel)', () => {
    const pages = [portrait(), portrait(), portrait()];
    expect(calculateBackwardTarget(1, ctx(pages))).toBe(0);
  });

  it('dual mode steps back a full spread', () => {
    const pages = [portrait(), portrait(), portrait(), portrait(), portrait(), portrait()];
    expect(calculateBackwardTarget(5, ctx(pages))).toBe(3);
  });

  it('single mode steps back one page (target shows single)', () => {
    const pages = [portrait(), portrait(), portrait(), portrait()];
    expect(calculateBackwardTarget(3, ctx(pages, { mode: 'single' }))).toBe(2);
  });

  it('half-steps backward when the previous chunk’s further page is wide', () => {
    // From dual view at page 4, pages[idx-2] (page 2) wide → -1.
    const pages = [portrait(), wide(), portrait(), portrait(), portrait(), portrait()];
    expect(calculateBackwardTarget(4, ctx(pages))).toBe(3);
  });

  it('steps back one when the target would display single (cover)', () => {
    // Views with a cover: [1], [2,3], ... From page 2, a full -2 would skip
    // past the cover; the single-display target makes it -1.
    const pages = [portrait(), portrait(), portrait(), portrait()];
    expect(calculateBackwardTarget(2, ctx(pages, { hasCover: true }))).toBe(1);
  });

  it('from page 2 without a cover returns 0 for changePage to clamp to 1', () => {
    const pages = [portrait(), portrait(), portrait()];
    expect(calculateBackwardTarget(2, ctx(pages))).toBe(0);
  });
});
