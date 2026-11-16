import { afterEach, describe, expect, it } from 'vitest';
import { pointInRect, pointOverPage, screenStripTurns } from './page-turn-zones';

describe('screenStripTurns (#54)', () => {
  it('over the page: the page-edge control, so it turns either way', () => {
    expect(screenStripTurns(true, true)).toBe(true);
    expect(screenStripTurns(true, false)).toBe(true);
  });

  it('over the background: only with the background toggle on', () => {
    expect(screenStripTurns(false, true)).toBe(true);
    expect(screenStripTurns(false, false)).toBe(false);
  });
});

describe('pointInRect', () => {
  const r = { left: 10, right: 20, top: 5, bottom: 15 };
  it.each([
    [10, 5, true],
    [20, 15, true],
    [15, 10, true],
    [9.9, 10, false],
    [15, 15.1, false]
  ])('(%s, %s) → %s', (x, y, expected) => expect(pointInRect(x, y, r)).toBe(expected));
});

describe('pointOverPage', () => {
  afterEach(() => document.getElementById('manga-panel')?.remove());

  it('is false with no paged panel', () => {
    expect(pointOverPage(5, 5)).toBe(false);
  });

  it("tests the panel's client rect", () => {
    const panel = document.createElement('div');
    panel.id = 'manga-panel';
    panel.getBoundingClientRect = () => ({ left: 100, right: 700, top: 0, bottom: 900 }) as DOMRect;
    document.body.appendChild(panel);
    expect(pointOverPage(100, 450)).toBe(true);
    expect(pointOverPage(99, 450)).toBe(false);
    expect(pointOverPage(701, 450)).toBe(false);
  });
});
